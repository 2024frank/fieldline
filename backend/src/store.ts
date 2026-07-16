// Tiny JSON-file store for app-level state that doesn't belong in ChirpStack:
// our own users (with forced-password-change flags), API tokens, and webhook
// integrations. Lives on a Docker volume so it survives rebuilds.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_PATH = process.env.DATA_PATH ?? "/data/fieldline.json";

export type Role = "admin" | "manager" | "viewer";
export type AppUser = {
  id: string; email: string; name: string; role: Role;
  passwordHash?: string;           // absent for ChirpStack-backed accounts until first change
  mustChangePassword: boolean;
  source: "app" | "chirpstack";
  createdAt: string; lastActiveAt?: string;
  orgId?: string;                  // ChirpStack tenant id; missing = default (first) tenant
  platformAdmin?: boolean;         // operator: can create orgs, sees across orgs
};
export type ApiToken = { id: string; name: string; hash: string; prefix: string; createdAt: string; lastUsedAt: string | null; orgId?: string };
export type Integration = {
  id: string; name: string; type: string; endpoint: string; authType: string;
  orgId?: string;                  // owning tenant; missing = default (first) tenant
  secret?: string; username?: string; headerName?: string;
  events: string[]; createdAt: string; lastDeliveryAt: string | null;
  delivered: number; failed: number; day: string; deliveries24h: number;
  signingEnabled: boolean; retryPolicy: string;
  lastSent: Record<string, string>; // devEui -> last reading time delivered
};

type Db = { users: AppUser[]; tokens: ApiToken[]; integrations: Integration[] };

let db: Db | null = null;

function load(): Db {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(DATA_PATH, "utf8")); }
  catch { db = { users: [], tokens: [], integrations: [] }; }
  db!.users ??= []; db!.tokens ??= []; db!.integrations ??= [];
  return db!;
}
export function save() {
  if (!db) return;
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  const tmp = DATA_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_PATH);
  emailIndex = null;  // membership changed -> rebuild lazily
}
export const store = { get: load, save };

// O(1) auth lookup. Every authenticated request resolves a user by email; a
// linear array.find() is fine at 3 users and a hot loop at 30,000. The Map is
// rebuilt lazily only when the user set actually changes (on save()).
let emailIndex: Map<string, AppUser> | null = null;
export function userByEmail(email: string): AppUser | undefined {
  if (!emailIndex) emailIndex = new Map(load().users.map(u => [u.email, u]));
  return emailIndex.get(email);
}

// ---- password + token hashing ----
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const dk = crypto.scryptSync(pw, salt, 32).toString("hex");
  return `s1$${salt}$${dk}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [v, salt, dk] = stored.split("$");
  if (v !== "s1" || !salt || !dk) return false;
  const cand = crypto.scryptSync(pw, salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(dk));
}
export function sha256(s: string): string { return crypto.createHash("sha256").update(s).digest("hex"); }
export function randomId(): string { return crypto.randomBytes(8).toString("hex"); }
export function randomHex(bytes: number): string { return crypto.randomBytes(bytes).toString("hex"); }
