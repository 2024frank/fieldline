# Fieldline — systems architecture

How Fieldline scales from the single-node MVP in this repo to a production platform
running hundreds of schools. This is a design brief, not a description of the current
running system: it names where things stand today and the target each grows into.

The reference implementations referenced below live in [`reference/`](reference/).

## The shape of the problem

Fieldline is a telemetry SaaS. Its load has a specific asymmetry that drives every
decision here:

| | |
|---|---|
| Sensors at target | ~20,000 (500 orgs × ~40) |
| Sustained uplinks | ~67/sec (5-minute reporting) |
| Readings/day | ~5.8 M (~2.1 B/year) |
| Raw/year | ~40 GB (~3–4 GB compressed 10×) |
| Rows for a 24 h chart | ~288 (via 5-min rollups, not a scan) |

Sixty writes a second is trivial. The risk is letting a dashboard read scan a
two-billion-row table. So the architecture optimizes for **cheap appends, pre-rolled
reads**.

## Four planes

```
                 CDN + Load balancer          (TLS, routing, static cache, WAF)
                          │
   ┌──────────────────────┴──────────────────────┐   Application tier — stateless
   │   API pods ×N     ingest workers    webhook workers │   scale by adding pods
   └──────────────────────┬──────────────────────┘
                          │
   Postgres (control)   TimescaleDB (telemetry)   Redis   Durable log   Object store
                          │
             ChirpStack cluster · MQTT · gateway fleet   LoRaWAN plane (never exposed)
```

1. **Edge** — CDN and load balancer. TLS, routing, static caching, WAF.
2. **Application tier** — stateless, autoscaled. API pods, ingestion workers, webhook
   workers. No local state, so it scales horizontally by adding pods.
3. **Data & coordination** — Postgres control plane, TimescaleDB telemetry plane,
   Redis, a durable log (NATS/Kafka), object storage.
4. **LoRaWAN plane** — ChirpStack, MQTT, the gateway fleet. Tenants never touch it.

## Components

| Component | Responsibility | Scales on | State |
|---|---|---|---|
| `api` | Auth, tenant scoping, CRUD, onboarding, tokens | Request rate | Stateless |
| `ingest` | Consume uplinks, batch-write telemetry, refresh cache | Message rate | Stateless |
| `webhooks` | Deliver readings to customer endpoints, retry | Fan-out | Stateless |
| `app` / `admin` | School + operator consoles (SPA) | CDN | Static |
| `chirpstack` | LoRaWAN network server | Gateway count | Clustered |

## Data flow

**Ingest ▸ write.** Radio → gateway → ChirpStack (tags the org's tenant id) → MQTT →
durable log (the buffer; a worker crash replays) → ingest workers batch ~500 rows or
one second and bulk-insert to TimescaleDB → fan out to the webhook stream and
invalidate the "latest reading" cache. Slow customer endpoints never back up ingestion.

**Request ▸ read.** Browser → edge → any API pod → tenant context and device list from
Redis (short TTL) → charts read the 5-minute continuous aggregate, not the raw firehose.

## API design

Versioned REST under `/v1`. Every path is implicitly scoped to the caller's org.

- **Auth**: JWT for people, hashed API keys for machines.
- **Pagination**: opaque cursors, never `OFFSET`.
- **Idempotency**: `Idempotency-Key` on every create (Redis, 24 h).
- **Rate limit**: per key + per IP, sliding window.
- **Errors**: one envelope `{ error: "actionable message" }`; raw network-server errors
  are translated before they leave the API.

## Database schema

One Postgres cluster, two planes — see [`reference/schema.sql`](reference/schema.sql).

- **Control plane**: `orgs`, `users`, `devices`, `api_keys`. Small, relational,
  row-level security keyed on a session `app.org_id` so a bug can't cross tenants.
- **Telemetry plane**: `readings` and `events` TimescaleDB hypertables, partitioned by
  day, compressed after 7 days (~10–20× on sensor JSON), 2-year retention.
- **Continuous aggregate** `readings_5m`: dashboards read pre-rolled buckets, turning a
  24 h chart into ~288 rows instead of a firehose scan.

## Caching strategy

See [`reference/cache.ts`](reference/cache.ts). The point is not raw speed — it is
letting the API tier stay stateless so it can scale out.

| Layer | Holds | Strategy | TTL |
|---|---|---|---|
| CDN | SPA bundles | Immutable, hashed names | 1 y |
| Redis — tenant ctx | org → tenant/app | Cache-aside | 5 m |
| Redis — device list | Per-org sensors | Cache-aside, invalidate on write | 60 s |
| Redis — latest | Newest reading/device | Write-through from ingest | 30 s |
| Redis — counters | Rate limit, idempotency | Atomic `INCR` / `SET NX` | window |
| Timescale — rollups | 5-min / 1-h aggregates | Continuous aggregate | auto |

## Scaling roadmap

Not a rewrite — an ordered sequence, each step earning its keep.

| Concern | Today · 1 node | Next · <50 orgs | Production · 500 orgs |
|---|---|---|---|
| Compute | 1 droplet | 2–3 API pods + LB | Autoscaled, multi-AZ |
| Control DB | JSON file | Postgres | Managed + read replica |
| Telemetry | SQLite | TimescaleDB | + compression, rollups, retention |
| Cache | In-proc maps | Redis | Redis cluster |
| Ingestion | `setInterval` | Batched worker | Durable log + worker pool |
| Webhooks | In-proc loop | Redis stream | Dedicated delivery fleet |
| Observability | Logs | Metrics + alerts | Traces + SLOs + on-call |
| Region | Single | Single + backups | Multi-region DR |

The MVP was written in this shape on purpose: each step is a migration of one service
at a time, live, with the durable log absorbing anything in flight.
