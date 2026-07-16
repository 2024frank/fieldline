// Shared cache + coordination for a stateless API tier.
//
// The MVP backend kept tenant context, device lists, and hot state in in-process
// Maps. That's fine on one box and fatal the moment you run a second replica:
// each has its own view and its own invalidation gaps. Moving that state to Redis
// makes every API pod interchangeable, so the tier scales by adding pods behind a
// load balancer. Redis also gives us rate limiting and idempotency for free.

import { createClient } from "redis";

const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (e) => console.error("redis", e));
await redis.connect();

// ── cache-aside ──────────────────────────────────────────────────────────────
// Read-through with a jittered TTL (jitter prevents a thundering-herd expiry when
// many keys were warmed at once). Writers call invalidate() on mutation, so reads
// are fresh-enough without waiting for TTL.

const jitter = (ttl: number) => ttl + Math.floor(Math.random() * (ttl * 0.2));

export async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = await redis.get(key);
  if (hit !== null) return JSON.parse(hit) as T;
  const value = await load();
  // NX so a concurrent writer that already invalidated isn't clobbered by a stale read
  await redis.set(key, JSON.stringify(value), { EX: jitter(ttl), NX: true });
  return value;
}

export async function invalidate(...keys: string[]): Promise<void> {
  if (keys.length) await redis.del(keys);
}

// Namespaced key builders keep invalidation honest and greppable.
export const K = {
  tenant:  (orgId: string) => `org:${orgId}:tenant`,      // org -> ChirpStack tenant/app ids
  devices: (orgId: string) => `org:${orgId}:devices`,     // device list for a tenant
  latest:  (orgId: string) => `org:${orgId}:latest`,      // latest reading per device
};

// ── sliding-window rate limit ────────────────────────────────────────────────
// Per API key / per IP. Atomic INCR+EXPIRE so counters can't leak across replicas.

export async function rateLimit(id: string, limit: number, windowSec: number): Promise<boolean> {
  const key = `rl:${id}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSec);
  return n <= limit;
}

// ── idempotency ──────────────────────────────────────────────────────────────
// A client retry of "provision sensor" must not create two devices. First writer
// wins the key; retries within the window get the cached response.

export async function idempotent<T>(idemKey: string, run: () => Promise<T>): Promise<T> {
  const k = `idem:${idemKey}`;
  const prior = await redis.get(k);
  if (prior !== null) return JSON.parse(prior) as T;
  const result = await run();
  await redis.set(k, JSON.stringify(result), { EX: 86400 });
  return result;
}

export { redis };
