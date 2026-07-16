-- Fieldline production schema.
-- Two stores, one Postgres cluster:
--   * control plane  : orgs, users, devices, gateways, keys  (small, relational, strongly consistent)
--   * telemetry plane: readings, events                      (the firehose — TimescaleDB hypertables)
--
-- Rationale: the control plane is kilobytes per tenant and needs joins + constraints.
-- Telemetry is billions of rows/year and needs time-partitioning, compression, and
-- pre-aggregation. TimescaleDB gives both from one Postgres, so ops stays simple until
-- scale genuinely forces a split.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ─────────────────────────────────────────────  CONTROL PLANE  ──

CREATE TABLE orgs (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          TEXT NOT NULL,
    cs_tenant_id  UUID NOT NULL UNIQUE,          -- maps 1:1 to a ChirpStack tenant
    plan          TEXT NOT NULL DEFAULT 'pilot', -- pilot | school | district
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id                UUID REFERENCES orgs(id) ON DELETE CASCADE,
    email                 CITEXT NOT NULL UNIQUE,
    name                  TEXT NOT NULL,
    role                  TEXT NOT NULL DEFAULT 'viewer',  -- admin | manager | viewer
    password_hash         TEXT,                            -- scrypt; null = federated
    must_change_password  BOOLEAN NOT NULL DEFAULT true,
    platform_admin        BOOLEAN NOT NULL DEFAULT false,
    last_active_at        TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON users (org_id);

CREATE TABLE devices (
    dev_eui        TEXT PRIMARY KEY,               -- 16 hex chars, globally unique
    org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    type_id        UUID NOT NULL,                  -- device profile / catalog type
    gateway_eui    TEXT,                           -- last gateway that heard it
    last_seen_at   TIMESTAMPTZ,
    battery        SMALLINT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON devices (org_id);

CREATE TABLE api_keys (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    hash         TEXT NOT NULL,                    -- sha256(token); the token is shown once
    prefix       TEXT NOT NULL,                    -- first 8 chars, for display
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON api_keys (hash);                   -- O(1) auth lookup

-- Defence in depth: even a bug in the API layer can't cross tenants once RLS is on.
ALTER TABLE devices  ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON devices
    USING (org_id = current_setting('app.org_id')::uuid);

-- ────────────────────────────────────────────  TELEMETRY PLANE  ──

CREATE TABLE readings (
    time      TIMESTAMPTZ  NOT NULL,
    org_id    UUID         NOT NULL,
    dev_eui   TEXT         NOT NULL,
    gateway   TEXT,
    rssi      SMALLINT,
    snr       REAL,
    data      JSONB        NOT NULL           -- decoded measurements: {co2, temperature, ...}
);
SELECT create_hypertable('readings', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX ON readings (org_id, dev_eui, time DESC);

-- Network events: joins, status (battery/margin), and errors (bad key, framing).
CREATE TABLE events (
    time     TIMESTAMPTZ NOT NULL,
    org_id   UUID        NOT NULL,
    dev_eui  TEXT        NOT NULL,
    kind     TEXT        NOT NULL,            -- join | status | log
    code     TEXT,                            -- e.g. UPLINK_MIC
    level    TEXT,                            -- INFO | WARNING | ERROR
    detail   JSONB
);
SELECT create_hypertable('events', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX ON events (org_id, dev_eui, time DESC);

-- Compress chunks older than 7 days: telemetry is write-once, read-mostly-recent.
-- Typically 10-20x on sensor JSON, so a year of data stays cheap.
ALTER TABLE readings SET (timescaledb.compress, timescaledb.compress_segmentby = 'org_id, dev_eui');
SELECT add_compression_policy('readings', INTERVAL '7 days');
SELECT add_retention_policy('readings', INTERVAL '2 years');   -- tune per plan

-- Continuous aggregate: dashboards read pre-rolled 5-minute buckets, not raw rows.
-- A "last 24h" chart becomes ~288 rows instead of a full scan of the firehose.
CREATE MATERIALIZED VIEW readings_5m
    WITH (timescaledb.continuous) AS
SELECT time_bucket('5 minutes', time) AS bucket,
       org_id, dev_eui,
       count(*)                                          AS samples,
       avg((data->>'temperature')::float)               AS temperature,
       avg((data->>'co2')::float)                        AS co2,
       last(data, time)                                  AS latest
FROM readings
GROUP BY bucket, org_id, dev_eui
WITH NO DATA;

SELECT add_continuous_aggregate_policy('readings_5m',
    start_offset => INTERVAL '1 hour',
    end_offset   => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes');
