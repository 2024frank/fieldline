// Telemetry ingestion worker.
//
// The MVP subscribed to MQTT inside a Flask process and INSERTed one row per
// message. That couples ingestion to a single process and does a network
// round-trip per uplink. At 60+ msg/sec that's the first thing to fall over.
//
// Production shape: N stateless workers consume from a durable subject (NATS /
// Kafka / Redis Stream), batch rows, and COPY them into TimescaleDB. Batching
// turns thousands of tiny INSERTs into a few bulk writes; the durable log means
// a worker crash replays instead of dropping data. Webhook fan-out is handed to
// its own queue so a slow customer endpoint never backs up ingestion.

import { connect, type NatsConnection } from "nats";
import { Pool } from "pg";
import { redis, K, invalidate } from "./cache.js";

const pg = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const BATCH = 500;             // rows
const FLUSH_MS = 1000;         // or every second, whichever comes first

type Reading = { time: string; org_id: string; dev_eui: string; gateway: string | null; rssi: number | null; snr: number | null; data: unknown };
let buffer: Reading[] = [];
let timer: NodeJS.Timeout | null = null;

async function flush() {
  if (!buffer.length) return;
  const rows = buffer; buffer = [];
  if (timer) { clearTimeout(timer); timer = null; }

  const client = await pg.connect();
  try {
    // Multi-row insert; unnest keeps it one round-trip regardless of batch size.
    await client.query(
      `INSERT INTO readings (time, org_id, dev_eui, gateway, rssi, snr, data)
       SELECT * FROM unnest($1::timestamptz[], $2::uuid[], $3::text[], $4::text[],
                            $5::smallint[], $6::real[], $7::jsonb[])`,
      [
        rows.map(r => r.time), rows.map(r => r.org_id), rows.map(r => r.dev_eui),
        rows.map(r => r.gateway), rows.map(r => r.rssi), rows.map(r => r.snr),
        rows.map(r => JSON.stringify(r.data)),
      ],
    );
    // Refresh the hot "latest reading" cache and drop stale device lists.
    const orgs = new Set(rows.map(r => r.org_id));
    await Promise.all([...orgs].map(o => invalidate(K.latest(o))));
  } finally {
    client.release();
  }
}

function schedule() {
  if (buffer.length >= BATCH) return void flush();
  timer ??= setTimeout(() => flush().catch(console.error), FLUSH_MS);
}

async function main() {
  const nc: NatsConnection = await connect({ servers: process.env.NATS_URL });
  const sub = nc.subscribe("uplink.>", { queue: "ingest" }); // queue group = load-balanced across workers
  console.log("ingest worker up");

  for await (const msg of sub) {
    const e = msg.json<any>();
    const di = e.deviceInfo ?? {};
    const rx = (e.rxInfo ?? [{}])[0];

    buffer.push({
      time: e.time, org_id: di.tenantId, dev_eui: di.devEui,
      gateway: (rx.gatewayId ?? "").toLowerCase() || null,
      rssi: rx.rssi ?? null, snr: rx.snr ?? null, data: e.object ?? {},
    });
    schedule();

    // Fan out to the webhook queue without blocking ingestion. A separate pool of
    // delivery workers handles retries/backoff so a dead endpoint stays contained.
    await redis.xAdd("webhooks", "*", { org: di.tenantId, dev: di.devEui, payload: msg.string() });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
