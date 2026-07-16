// Fieldline backend v3: multi-tenant. Each organization (school) maps to one
// ChirpStack tenant; users carry orgId and every endpoint is scoped to the
// caller's org. Platform admins (the operator) onboard new orgs with POST
// /orgs, which creates the tenant, its application, clones the sensor-type
// catalog, and provisions the first admin user with a temporary password.
import "dotenv/config";
import crypto from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import jwt from "jsonwebtoken";
import { cs, verifyCredentials } from "./chirpstack.js";
import { store, save, hashPassword, verifyPassword, sha256, randomId, randomHex, type AppUser } from "./store.js";
import { sendMail, welcomeOrgEmail, addedUserEmail, operatorEmail } from "./mailer.js";

const PORT = Number(process.env.PORT ?? 4000);
const SECRET = process.env.JWT_SECRET ?? "dev-secret";
const READINGS_URL = process.env.READINGS_URL ?? "http://datastore:8000/readings";
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? "your.server.ip";
const PLATFORM_ADMINS = (process.env.PLATFORM_ADMINS ?? "admin").split(",").map(s => s.trim().toLowerCase());

const app = new Hono();
app.use("*", cors());

// ---------- org (tenant) context ----------
let defaultTenantCache: { id: string; at: number } | null = null;
async function defaultTenant(): Promise<string> {
  if (defaultTenantCache && Date.now() - defaultTenantCache.at < 300_000) return defaultTenantCache.id;
  const t = (await cs<any>("GET", "/api/tenants?limit=1")).result[0];
  defaultTenantCache = { id: t.id, at: Date.now() };
  return t.id;
}
type Org = { tenantId: string; tenantName: string; appId: string };
const orgCache = new Map<string, { org: Org; at: number }>();
async function tenantInfo(tenantId: string): Promise<Org> {
  const hit = orgCache.get(tenantId);
  if (hit && Date.now() - hit.at < 60_000) return hit.org;
  const t = (await cs<any>("GET", `/api/tenants/${tenantId}`)).tenant;
  let apps = (await cs<any>("GET", `/api/applications?limit=1&tenantId=${tenantId}`)).result ?? [];
  if (!apps.length) {
    const created = await cs<any>("POST", "/api/applications", { application: { name: "fieldline", tenantId, description: "Created by Fieldline" } });
    apps = [{ id: created.id }];
  }
  const org = { tenantId, tenantName: t.name, appId: apps[0].id };
  orgCache.set(tenantId, { org, at: Date.now() });
  return org;
}
async function orgOf(user: AppUser): Promise<Org> {
  if (!user.orgId) {
    user.orgId = await defaultTenant();
    const u = store.get().users.find(x => x.id === user.id);
    if (u) { u.orgId = user.orgId; save(); }
  }
  return tenantInfo(user.orgId);
}
function isPlatformAdmin(u: AppUser) { return Boolean(u.platformAdmin) || PLATFORM_ADMINS.includes(u.email); }

// org's device EUIs (for scoping readings), cached briefly
const euiCache = new Map<string, { euis: Set<string>; at: number }>();
async function orgEuis(appId: string): Promise<Set<string>> {
  const hit = euiCache.get(appId);
  if (hit && Date.now() - hit.at < 60_000) return hit.euis;
  const devs = (await cs<any>("GET", `/api/devices?limit=100&applicationId=${appId}`)).result ?? [];
  const euis = new Set<string>(devs.map((d: any) => d.devEui.toLowerCase()));
  euiCache.set(appId, { euis, at: Date.now() });
  return euis;
}

// ---------- auth ----------
function sign(email: string, role: string) { return jwt.sign({ sub: email, role }, SECRET, { expiresIn: "12h" }); }
function authUser(c: any): AppUser | null {
  const h = c.req.header("authorization") ?? "";
  try {
    const p = jwt.verify(h.replace(/^Bearer /, ""), SECRET) as any;
    const u = store.get().users.find(x => x.email === p.sub);
    return u ?? { id: p.sub, email: p.sub, name: p.sub.split("@")[0], role: p.role, mustChangePassword: false, source: "chirpstack", createdAt: new Date(0).toISOString() };
  } catch { return null; }
}
function pub(u: AppUser) { return { id: u.id, name: u.name, email: u.email, role: u.role, lastActiveAt: u.lastActiveAt, mustChangePassword: u.mustChangePassword, platformAdmin: isPlatformAdmin(u) }; }

app.post("/auth/login", async (c) => {
  const { email, password } = await c.req.json();
  const norm = String(email ?? "").trim().toLowerCase();
  const db = store.get();
  let user = db.users.find(u => u.email === norm);
  if (user?.passwordHash) {
    if (!verifyPassword(password, user.passwordHash)) return c.json({ error: "Wrong email or password" }, 401);
  } else if (await verifyCredentials(norm, password)) {
    if (!user) {
      user = { id: randomId(), email: norm, name: norm.split("@")[0], role: "admin", mustChangePassword: false, source: "chirpstack", createdAt: new Date().toISOString(), orgId: await defaultTenant(), platformAdmin: PLATFORM_ADMINS.includes(norm) };
      db.users.push(user);
    }
  } else {
    return c.json({ error: "Wrong email or password" }, 401);
  }
  user.lastActiveAt = new Date().toISOString(); save();
  return c.json({ token: sign(user.email, user.role), user: pub(user) });
});

app.post("/auth/change-password", async (c) => {
  const me = authUser(c); if (!me) return c.json({ error: "unauthorized" }, 401);
  const { currentPassword, newPassword } = await c.req.json();
  if (!newPassword || String(newPassword).length < 8) return c.json({ error: "New password must be at least 8 characters" }, 400);
  const db = store.get();
  const user = db.users.find(u => u.email === me.email);
  if (!user) return c.json({ error: "unknown user" }, 400);
  const ok = user.passwordHash ? verifyPassword(currentPassword ?? "", user.passwordHash) : await verifyCredentials(user.email, currentPassword ?? "");
  if (!ok) return c.json({ error: "Current password is incorrect" }, 400);
  user.passwordHash = hashPassword(newPassword);
  user.mustChangePassword = false;
  save();
  return c.json({ ok: true });
});

app.post("/auth/onboarding", async (c) => {
  const me = authUser(c); if (!me) return c.json({ error: "unauthorized" }, 401);
  const { orgName } = await c.req.json();
  const name = String(orgName ?? "").trim();
  if (name.length < 2) return c.json({ error: "Enter your organization's name" }, 400);
  const org = await orgOf(me);
  const t = (await cs<any>("GET", `/api/tenants/${org.tenantId}`)).tenant;
  t.name = name;
  await cs("PUT", `/api/tenants/${org.tenantId}`, { tenant: t });
  orgCache.delete(org.tenantId);
  return c.json({ ok: true, orgName: name });
});

app.get("/auth/me", async (c) => {
  const u = authUser(c); if (!u) return c.json({ error: "unauthorized" }, 401);
  let orgId = "default", orgName = "";
  try { const org = await orgOf(u); orgId = org.tenantId; orgName = org.tenantName; } catch { /* blank */ }
  return c.json({ ...pub(u), orgId, orgName });
});
app.post("/auth/logout", (c) => c.json({ ok: true }));

// ---------- public data endpoint (token-authed, scoped to the token's org) ----------
app.get("/public/readings", async (c) => {
  const key = c.req.header("x-api-key") ?? c.req.query("api_key") ?? "";
  const db = store.get();
  const tok = db.tokens.find(t => t.hash === sha256(key));
  if (!key || !tok) return c.json({ error: "invalid or missing API token (x-api-key header)" }, 401);
  tok.lastUsedAt = new Date().toISOString(); save();
  const org = await tenantInfo(tok.orgId ?? await defaultTenant());
  const euis = await orgEuis(org.appId);
  const qs = new URLSearchParams();
  for (const k of ["latest", "device", "history", "limit"]) { const v = c.req.query(k); if (v) qs.set(k, v); }
  if (!qs.toString()) qs.set("latest", "1");
  const dev = qs.get("device")?.toLowerCase();
  if (dev && !euis.has(dev)) return c.json({ error: "unknown device" }, 404);
  const r = await fetch(`${READINGS_URL}?${qs}`);
  const data = await r.json() as any;
  return c.json(Array.isArray(data) ? data.filter((x: any) => !x.devEui || euis.has(x.devEui)) : data);
});

// ---------- guard everything below ----------
app.use("/*", async (c, next) => {
  const p = c.req.path;
  if (p.startsWith("/auth") || p === "/health" || p.startsWith("/public") || p.endsWith("/readings.csv")) return next();
  if (!authUser(c)) return c.json({ error: "unauthorized" }, 401);
  return next();
});

// ---------- helpers ----------
async function latestByEui(euis: Set<string>): Promise<Record<string, { measurements: Record<string, number>; time: string; rssi?: number; snr?: number }>> {
  try {
    const r = await fetch(`${READINGS_URL}?latest=1`); const arr = (await r.json()) as any[];
    const out: Record<string, any> = {};
    for (const x of arr) if (euis.has(x.devEui)) out[x.devEui] = { measurements: x.data ?? {}, time: x.time, rssi: x.rssi, snr: x.snr };
    return out;
  } catch { return {}; }
}
function statusFrom(lastSeenAt: string | null): "online" | "offline" | "never" {
  if (!lastSeenAt) return "never";
  return Date.now() - new Date(lastSeenAt).getTime() < 60 * 60 * 1000 ? "online" : "offline";
}
function battery(d: any): number | null {
  const b = d?.deviceStatus?.batteryLevel;
  return typeof b === "number" && b >= 0 && b <= 100 ? b : null;
}
const err400 = (c: any, e: unknown, fallback: string) => {
  const msg = String((e as Error)?.message ?? "");
  return c.json({ error: msg.startsWith("chirpstack ") || !msg ? fallback : msg }, 400);
};
// fetch a device and confirm it belongs to the caller's org (else null)
async function ownedDevice(eui: string, org: Org): Promise<any | null> {
  try {
    const d = await cs<any>("GET", `/api/devices/${eui}`);
    return d.device.applicationId === org.appId ? d : null;
  } catch { return null; }
}

// ---------- orgs (platform operator only) ----------
app.get("/orgs", async (c) => {
  const me = authUser(c)!; if (!isPlatformAdmin(me)) return c.json({ error: "platform admins only" }, 403);
  const r = await cs<any>("GET", "/api/tenants?limit=100");
  const users = store.get().users;
  return c.json({ items: (r.result ?? []).map((t: any) => ({ id: t.id, name: t.name, createdAt: t.createdAt, users: users.filter(u => u.orgId === t.id).length })) });
});
app.post("/orgs", async (c) => {
  const me = authUser(c)!; if (!isPlatformAdmin(me)) return c.json({ error: "platform admins only" }, 403);
  try {
    const { orgName, adminName, adminEmail, tempPassword, sendEmail } = await c.req.json();
    const email = String(adminEmail ?? "").trim().toLowerCase();
    if (!orgName || !email) return c.json({ error: "orgName and adminEmail are required" }, 400);
    const db = store.get();
    if (db.users.some(u => u.email === email)) return c.json({ error: "A user with this email already exists" }, 400);
    // 1. tenant
    const tid = (await cs<any>("POST", "/api/tenants", { tenant: {
      name: orgName, description: "Created by Fieldline",
      canHaveGateways: true, maxGatewayCount: 0, maxDeviceCount: 0,
      privateGatewaysUp: true, privateGatewaysDown: true,
    } })).id;
    // 2. application
    await cs("POST", "/api/applications", { application: { name: "fieldline", tenantId: tid, description: "Created by Fieldline" } });
    // 3. clone the sensor-type catalog from the template (first) tenant
    const template = await defaultTenant();
    const profiles = (await cs<any>("GET", `/api/device-profiles?limit=100&tenantId=${template}`)).result ?? [];
    let cloned = 0;
    for (const p of profiles) {
      try {
        const full = (await cs<any>("GET", `/api/device-profiles/${p.id}`)).deviceProfile;
        delete full.id;
        full.tenantId = tid;
        await cs("POST", "/api/device-profiles", { deviceProfile: full });
        cloned++;
      } catch { /* skip one bad profile */ }
    }
    // 4. first admin user, forced to change password
    const pass = tempPassword || `Welcome-${randomHex(3)}`;
    const user: AppUser = { id: randomId(), email, name: adminName || email.split("@")[0], role: "admin", passwordHash: hashPassword(pass), mustChangePassword: true, source: "app", createdAt: new Date().toISOString(), orgId: tid };
    db.users.push(user); save();
    let emailSent = false, emailError: string | undefined;
    if (sendEmail) {
      const m = welcomeOrgEmail({ orgName, name: user.name, email, tempPassword: pass });
      const r = await sendMail(email, m.subject, m.html, m.text);
      emailSent = r.ok; emailError = r.error;
    }
    return c.json({ org: { id: tid, name: orgName }, admin: pub(user), tempPassword: pass, sensorTypesCloned: cloned, emailSent, emailError });
  } catch (e) { return err400(c, e, "Could not create the organization"); }
});

// ---------- platform operators (who can onboard schools) ----------
const ADMIN_URL = process.env.ADMIN_URL ?? "https://your-admin-domain";
app.get("/operators", (c) => {
  const me = authUser(c)!; if (!isPlatformAdmin(me)) return c.json({ error: "platform admins only" }, 403);
  const items = store.get().users.filter(isPlatformAdmin).map(u => ({ ...pub(u), builtIn: PLATFORM_ADMINS.includes(u.email) }));
  return c.json({ items });
});
app.post("/operators", async (c) => {
  const me = authUser(c)!; if (!isPlatformAdmin(me)) return c.json({ error: "platform admins only" }, 403);
  const { name, email, sendEmail } = await c.req.json();
  const norm = String(email ?? "").trim().toLowerCase();
  if (!norm) return c.json({ error: "email is required" }, 400);
  const db = store.get();
  let user = db.users.find(u => u.email === norm);
  let tempPassword: string | undefined;
  if (user) {
    if (isPlatformAdmin(user)) return c.json({ error: "They are already an operator" }, 400);
    user.platformAdmin = true;
    if (user.role !== "admin") user.role = "admin";
  } else {
    tempPassword = `Welcome-${randomHex(3)}`;
    user = { id: randomId(), email: norm, name: name || norm.split("@")[0], role: "admin", passwordHash: hashPassword(tempPassword), mustChangePassword: true, source: "app", createdAt: new Date().toISOString(), orgId: await defaultTenant(), platformAdmin: true };
    db.users.push(user);
  }
  save();
  let emailSent = false, emailError: string | undefined;
  if (sendEmail) {
    const m = operatorEmail({ name: user.name, email: norm, tempPassword, adminUrl: ADMIN_URL });
    const r = await sendMail(norm, m.subject, m.html, m.text);
    emailSent = r.ok; emailError = r.error;
  }
  return c.json({ ...pub(user), tempPassword, emailSent, emailError });
});
app.delete("/operators/:id", (c) => {
  const me = authUser(c)!; if (!isPlatformAdmin(me)) return c.json({ error: "platform admins only" }, 403);
  const u = store.get().users.find(x => x.id === c.req.param("id"));
  if (!u || !u.platformAdmin) return c.json({ error: "not found" }, 404);
  if (u.email === me.email) return c.json({ error: "You can't remove yourself" }, 400);
  u.platformAdmin = false; save();
  return c.json({ ok: true });
});

// ---------- users (scoped to caller's org) ----------
app.get("/users", async (c) => {
  const me = authUser(c)!;
  const org = await orgOf(me);
  const dflt = await defaultTenant(); // legacy org-less users belong to the FIRST tenant, never the caller's
  const all = store.get().users;
  const items = isPlatformAdmin(me) ? all : all.filter(u => (u.orgId ?? dflt) === org.tenantId);
  return c.json({ items: items.map(pub) });
});
app.post("/users", async (c) => {
  const me = authUser(c)!; if (me.role !== "admin") return c.json({ error: "admins only" }, 403);
  const { name, email, role, password, orgId, sendEmail } = await c.req.json();
  const norm = String(email ?? "").trim().toLowerCase();
  if (!norm || !name || !password) return c.json({ error: "name, email and a temporary password are required" }, 400);
  const db = store.get();
  if (db.users.some(u => u.email === norm)) return c.json({ error: "A user with this email already exists" }, 400);
  // platform admins may target any org; everyone else stays in their own
  const targetOrgId = orgId && isPlatformAdmin(me) ? orgId : (await orgOf(me)).tenantId;
  const user: AppUser = { id: randomId(), email: norm, name, role: role ?? "viewer", passwordHash: hashPassword(password), mustChangePassword: true, source: "app", createdAt: new Date().toISOString(), orgId: targetOrgId };
  db.users.push(user); save();
  let emailSent = false, emailError: string | undefined;
  if (sendEmail) {
    try {
      const orgName = (await tenantInfo(targetOrgId)).tenantName;
      const m = addedUserEmail({ orgName, name, email: norm, tempPassword: password, role: user.role });
      const r = await sendMail(norm, m.subject, m.html, m.text);
      emailSent = r.ok; emailError = r.error;
    } catch (e) { emailError = String((e as Error).message); }
  }
  return c.json({ ...pub(user), emailSent, emailError });
});
app.patch("/users/:id", async (c) => {
  const me = authUser(c)!; if (me.role !== "admin") return c.json({ error: "admins only" }, 403);
  const { role } = await c.req.json();
  const org = await orgOf(me);
  const dflt = await defaultTenant();
  const u = store.get().users.find(x => x.id === c.req.param("id"));
  if (!u || (!isPlatformAdmin(me) && (u.orgId ?? dflt) !== org.tenantId)) return c.json({ error: "not found" }, 404);
  u.role = role; save();
  return c.json(pub(u));
});
app.delete("/users/:id", async (c) => {
  const me = authUser(c)!; if (me.role !== "admin") return c.json({ error: "admins only" }, 403);
  const db = store.get();
  const org = await orgOf(me);
  const dflt = await defaultTenant();
  const u = db.users.find(x => x.id === c.req.param("id"));
  if (!u || (!isPlatformAdmin(me) && (u.orgId ?? dflt) !== org.tenantId)) return c.json({ error: "not found" }, 404);
  if (u.email === me.email) return c.json({ error: "You can't remove your own account" }, 400);
  db.users = db.users.filter(x => x.id !== u.id); save();
  return c.json({ ok: true });
});

// ---------- gateways (org-scoped) ----------
function mapGateway(g: any) {
  return {
    eui: g.gatewayId, name: g.name, status: statusFrom(g.lastSeenAt ?? null), lastSeenAt: g.lastSeenAt ?? null,
    location: g.location ? { lat: g.location.latitude, lng: g.location.longitude } : null,
  };
}
app.get("/gateways", async (c) => {
  const org = await orgOf(authUser(c)!);
  const r = await cs<any>("GET", `/api/gateways?limit=100&tenantId=${org.tenantId}`);
  return c.json({ items: (r.result ?? []).map(mapGateway) });
});
app.get("/gateways/:eui", async (c) => {
  const org = await orgOf(authUser(c)!);
  const eui = c.req.param("eui").toLowerCase();
  const g = await cs<any>("GET", `/api/gateways/${eui}`);
  if (g.gateway.tenantId !== org.tenantId) return c.json({ error: "not found" }, 404);
  const base = { ...mapGateway({ ...g.gateway, lastSeenAt: g.lastSeenAt }), metrics: undefined as any };
  try {
    const end = new Date(); const start = new Date(end.getTime() - 24 * 3600e3);
    const m = await cs<any>("GET", `/api/gateways/${eui}/metrics?start=${start.toISOString()}&end=${end.toISOString()}&aggregation=HOUR`);
    const pts = (metric: any) => (metric?.timestamps ?? []).map((t: string, i: number) => ({ time: t, value: Number(metric.datasets?.[0]?.data?.[i] ?? 0) }));
    base.metrics = { uplinks: pts(m.rxPackets), downlinks: pts(m.txPackets) };
  } catch { /* metrics optional */ }
  return c.json(base);
});
app.post("/gateways", async (c) => {
  try {
    const org = await orgOf(authUser(c)!);
    const { eui, name, location } = await c.req.json();
    await cs("POST", "/api/gateways", { gateway: {
      gatewayId: String(eui).toLowerCase(), name, tenantId: org.tenantId, statsInterval: 30,
      description: "Registered via Fieldline",
      location: location ? { latitude: location.lat, longitude: location.lng } : undefined,
    } });
    return c.json({
      eui: String(eui).toLowerCase(), name, status: "never", lastSeenAt: null, location: location ?? null,
      setup: {
        serverAddress: PUBLIC_HOST, port: 1883, protocol: "MQTT (ChirpStack v4 forwarder)",
        credentials: "none — leave username/password blank",
        steps: [
          "In the gateway's web console open Packet Forwarder settings.",
          `Point the ChirpStack-V4 / MQTT forwarder at ${PUBLIC_HOST}, port 1883.`,
          "Disable the gateway's Embedded Network Server — it will otherwise answer sensors locally and nothing reaches the cloud.",
          "Set the radio to your region's sub-band (US915: vendor Sub-band 2 = channels 8-15).",
          "Click Save AND Apply — unsaved settings look connected but are not.",
        ],
      },
    });
  } catch (e) { return err400(c, e, "ChirpStack rejected this gateway (is the EUI already registered?)"); }
});
app.delete("/gateways/:eui", async (c) => {
  const org = await orgOf(authUser(c)!);
  const eui = c.req.param("eui").toLowerCase();
  const g = await cs<any>("GET", `/api/gateways/${eui}`).catch(() => null);
  if (!g || g.gateway.tenantId !== org.tenantId) return c.json({ error: "not found" }, 404);
  await cs("DELETE", `/api/gateways/${eui}`);
  return c.json({ ok: true });
});

// ---------- device types (org-scoped ChirpStack device profiles) ----------
app.get("/device-types", async (c) => {
  const org = await orgOf(authUser(c)!);
  const r = await cs<any>("GET", `/api/device-profiles?limit=100&tenantId=${org.tenantId}`);
  const items = await Promise.all((r.result ?? []).map(async (p: any) => {
    const full = (await cs<any>("GET", `/api/device-profiles/${p.id}`)).deviceProfile;
    const meas = Object.values(full.measurements ?? {}).map((m: any) => ({ name: m.name, unit: "" }));
    return { id: p.id, name: p.name, region: full.region, lorawanVersion: full.macVersion, class: full.supportsClassC ? "C" : "A", measurements: meas, hasDecoder: Boolean(full.payloadCodecScript), description: full.description ?? "" };
  }));
  return c.json({ items });
});
app.post("/device-types", async (c) => {
  try {
    const org = await orgOf(authUser(c)!);
    const body = await c.req.json();
    const r = await cs<any>("POST", "/api/device-profiles", { deviceProfile: {
      name: body.name, tenantId: org.tenantId, region: body.region ?? "US915",
      macVersion: "LORAWAN_1_0_3", regParamsRevision: "A",
      supportsOtaa: true, uplinkInterval: 1200, adrAlgorithmId: "default",
      description: "Created via Fieldline",
    } });
    return c.json({ id: r.id, name: body.name, region: body.region ?? "US915", lorawanVersion: "LORAWAN_1_0_3", class: "A", measurements: [] });
  } catch (e) { return err400(c, e, "Could not create the device type"); }
});

// ---------- sensors (org-scoped devices) ----------
app.get("/devices", async (c) => {
  const org = await orgOf(authUser(c)!);
  const euis = await orgEuis(org.appId);
  const latest = await latestByEui(euis);
  const devs = (await cs<any>("GET", `/api/devices?limit=100&applicationId=${org.appId}`)).result ?? [];
  const items = devs.map((d: any) => ({
    eui: d.devEui, name: d.name, typeId: d.deviceProfileId, typeName: d.deviceProfileName,
    status: statusFrom(d.lastSeenAt ?? null), lastSeenAt: d.lastSeenAt ?? null,
    battery: battery(d), latest: latest[d.devEui] ?? null,
  }));
  return c.json({ items });
});
app.get("/devices/:eui", async (c) => {
  const org = await orgOf(authUser(c)!);
  const eui = c.req.param("eui").toLowerCase();
  const d = await ownedDevice(eui, org);
  if (!d) return c.json({ error: "not found" }, 404);
  const latest = (await latestByEui(new Set([eui])))[eui] ?? null;
  return c.json({
    eui, name: d.device.name, typeId: d.device.deviceProfileId, typeName: "",
    status: statusFrom(d.lastSeenAt ?? null), lastSeenAt: d.lastSeenAt ?? null,
    battery: battery(d), latest, enabled: !d.device.isDisabled,
    rssi: latest?.rssi ?? null, snr: latest?.snr ?? null,
  });
});
app.post("/devices", async (c) => {
  try {
    const org = await orgOf(authUser(c)!);
    const { name, eui, typeId } = await c.req.json();
    const devEui = String(eui).toLowerCase();
    await cs("POST", "/api/devices", { device: { devEui, name, applicationId: org.appId, deviceProfileId: typeId, description: "Created via Fieldline" } });
    const appKey = randomHex(16); // 32 hex chars
    // LoRaWAN 1.0.x: the AppKey must go in the nwkKey field (ChirpStack quirk)
    await cs("POST", `/api/devices/${devEui}/keys`, { deviceKeys: { devEui, nwkKey: appKey, appKey: "" } });
    euiCache.delete(org.appId);
    return c.json({ device: { eui: devEui, name, typeId, typeName: "", status: "never", lastSeenAt: null, battery: null, latest: null }, appKey });
  } catch (e) { return err400(c, e, "ChirpStack rejected this sensor — is the hardware ID already registered?"); }
});
app.patch("/devices/:eui", async (c) => {
  const org = await orgOf(authUser(c)!);
  const eui = c.req.param("eui").toLowerCase();
  const owned = await ownedDevice(eui, org);
  if (!owned) return c.json({ error: "not found" }, 404);
  const body = await c.req.json();
  const d = owned.device;
  if (body.name != null) d.name = body.name;
  if (body.enabled != null) d.isDisabled = !body.enabled; // toggle is inverted in ChirpStack
  await cs("PUT", `/api/devices/${eui}`, { device: d });
  return c.json({ eui, name: d.name, enabled: !d.isDisabled, typeId: d.deviceProfileId, typeName: "", status: "offline", lastSeenAt: null, battery: null, latest: null });
});
app.delete("/devices/:eui", async (c) => {
  const org = await orgOf(authUser(c)!);
  const eui = c.req.param("eui").toLowerCase();
  if (!(await ownedDevice(eui, org))) return c.json({ error: "not found" }, 404);
  await cs("DELETE", `/api/devices/${eui}`);
  euiCache.delete(org.appId);
  return c.json({ ok: true });
});

// ---------- readings (org-scoped) ----------
app.get("/readings/latest", async (c) => {
  const org = await orgOf(authUser(c)!);
  const euis = await orgEuis(org.appId);
  const r = await fetch(`${READINGS_URL}?latest=1`); const arr = (await r.json()) as any[];
  return c.json({ items: arr.filter((x: any) => euis.has(x.devEui)).map((x: any) => ({ eui: x.devEui, name: x.device, time: x.time, measurements: x.data ?? {} })) });
});
app.get("/devices/:eui/readings", async (c) => {
  const org = await orgOf(authUser(c)!);
  const eui = c.req.param("eui").toLowerCase();
  if (!(await orgEuis(org.appId)).has(eui)) return c.json({ error: "not found" }, 404);
  const limit = c.req.query("limit") ?? "500";
  const r = await fetch(`${READINGS_URL}?device=${eui}&history=1&limit=${limit}`);
  let rows = (await r.json()) as any[];
  const from = c.req.query("from"), to = c.req.query("to");
  if (from) rows = rows.filter(x => x.time >= from);
  if (to) rows = rows.filter(x => x.time <= to);
  return c.json({ items: rows.map(x => ({ time: x.time, measurements: x.data ?? {}, rssi: x.rssi ?? 0, snr: x.snr ?? 0 })) });
});
// CSV export rides an <a href> (no auth header) — reachable by EUI only.
app.get("/devices/:eui/readings.csv", async (c) => {
  const eui = c.req.param("eui").toLowerCase();
  const r = await fetch(`${READINGS_URL}?device=${eui}&csv=1&limit=2000`);
  c.header("Content-Type", "text/csv");
  c.header("Content-Disposition", `attachment; filename=${eui}.csv`);
  return c.body(await r.text());
});

// ---------- downlink commands ----------
app.post("/devices/:eui/commands/reporting-interval", async (c) => {
  try {
    const org = await orgOf(authUser(c)!);
    const eui = c.req.param("eui").toLowerCase();
    if (!(await ownedDevice(eui, org))) return c.json({ error: "not found" }, 404);
    const { minutes } = await c.req.json();
    const secs = Math.max(60, Math.min(64800, Math.round(Number(minutes) * 60)));
    // Milesight downlink: channel 0xFF, type 0x03, uint16 LE seconds, fPort 85
    const payload = Buffer.from([0xff, 0x03, secs & 0xff, (secs >> 8) & 0xff]);
    await cs("POST", `/api/devices/${eui}/queue`, { queueItem: { fPort: 85, confirmed: false, data: payload.toString("base64") } });
    return c.json({ queued: true, note: "Queued. Class A sensors apply it at their next check-in (up to one reporting interval)." });
  } catch (e) { return err400(c, e, "Could not queue the command"); }
});

// ---------- alerts (computed, org-scoped) ----------
app.get("/alerts", async (c) => {
  const org = await orgOf(authUser(c)!);
  const [gws, devs] = await Promise.all([
    cs<any>("GET", `/api/gateways?limit=100&tenantId=${org.tenantId}`),
    cs<any>("GET", `/api/devices?limit=100&applicationId=${org.appId}`),
  ]);
  const alerts: any[] = [];
  for (const g of gws.result ?? []) {
    if (g.lastSeenAt && statusFrom(g.lastSeenAt) === "offline")
      alerts.push({ id: `gw:${g.gatewayId}`, type: "gateway_offline", target: g.name, message: `${g.name} has not connected since ${new Date(g.lastSeenAt).toLocaleString()}`, time: g.lastSeenAt });
  }
  for (const d of devs.result ?? []) {
    if (d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() > 2 * 3600e3)
      alerts.push({ id: `dev:${d.devEui}`, type: "sensor_offline", target: d.name, message: `${d.name} last reported ${new Date(d.lastSeenAt).toLocaleString()}`, time: d.lastSeenAt });
    const b = battery(d);
    if (b != null && b <= 15)
      alerts.push({ id: `bat:${d.devEui}`, type: "low_battery", target: d.name, message: `${d.name} battery at ${b}%`, time: d.lastSeenAt ?? new Date().toISOString() });
  }
  return c.json({ items: alerts.sort((a, b) => (b.time > a.time ? 1 : -1)) });
});

// ---------- API tokens (org-scoped) ----------
app.get("/tokens", async (c) => {
  const org = await orgOf(authUser(c)!);
  const dflt = await defaultTenant();
  const items = store.get().tokens.filter(t => (t.orgId ?? dflt) === org.tenantId)
    .map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }));
  return c.json({ items });
});
app.post("/tokens", async (c) => {
  const org = await orgOf(authUser(c)!);
  const { name } = await c.req.json();
  const value = `flt_${randomHex(24)}`;
  const t = { id: randomId(), name: name || "API token", hash: sha256(value), prefix: value.slice(0, 8), createdAt: new Date().toISOString(), lastUsedAt: null, orgId: org.tenantId };
  store.get().tokens.push(t); save();
  return c.json({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: null, token: value });
});
app.delete("/tokens/:id", async (c) => {
  const org = await orgOf(authUser(c)!);
  const dflt = await defaultTenant();
  const db = store.get();
  db.tokens = db.tokens.filter(t => !(t.id === c.req.param("id") && (t.orgId ?? dflt) === org.tenantId)); save();
  return c.json({ ok: true });
});

// ---------- integrations (org-scoped webhooks, actually delivered) ----------
function pubIntegration(i: any) {
  const total = i.delivered + i.failed;
  return {
    id: i.id, name: i.name, type: i.type, endpoint: i.endpoint, authType: i.authType,
    status: total === 0 || i.delivered / total > 0.9 ? "healthy" : "degraded",
    events: i.events, createdAt: i.createdAt, lastDeliveryAt: i.lastDeliveryAt,
    successRate: total ? Math.round((i.delivered / total) * 1000) / 10 : 100,
    deliveries24h: i.day === new Date().toISOString().slice(0, 10) ? i.deliveries24h : 0,
    signingEnabled: i.signingEnabled, retryPolicy: i.retryPolicy,
  };
}
app.get("/integrations", async (c) => {
  const org = await orgOf(authUser(c)!);
  const dflt = await defaultTenant();
  return c.json({ items: store.get().integrations.filter(i => (i.orgId ?? dflt) === org.tenantId).map(pubIntegration) });
});
app.post("/integrations", async (c) => {
  const org = await orgOf(authUser(c)!);
  const b = await c.req.json();
  if (b.type !== "webhook") return c.json({ error: "Webhook delivery is live today; other destination types are on the roadmap." }, 400);
  if (!/^https?:\/\//.test(b.endpoint ?? "")) return c.json({ error: "Enter a valid http(s) endpoint" }, 400);
  const i = {
    id: randomId(), name: b.name, type: b.type, endpoint: b.endpoint, authType: b.authType ?? "none",
    orgId: org.tenantId,
    secret: b.secret, username: b.username, headerName: b.headerName,
    events: b.events?.length ? b.events : ["uplink.received"], createdAt: new Date().toISOString(),
    lastDeliveryAt: null, delivered: 0, failed: 0, day: new Date().toISOString().slice(0, 10), deliveries24h: 0,
    signingEnabled: Boolean(b.signingEnabled), retryPolicy: b.retryPolicy ?? "standard", lastSent: {},
  };
  store.get().integrations.push(i as any); save();
  return c.json(pubIntegration(i));
});
app.delete("/integrations/:id", async (c) => {
  const org = await orgOf(authUser(c)!);
  const dflt = await defaultTenant();
  const db = store.get();
  db.integrations = db.integrations.filter(i => !(i.id === c.req.param("id") && (i.orgId ?? dflt) === org.tenantId)); save();
  return c.json({ ok: true });
});

function authHeaders(i: { authType?: string; secret?: string; username?: string; headerName?: string; signingEnabled?: boolean }, body: string) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (i.authType === "bearer" && i.secret) h["Authorization"] = `Bearer ${i.secret}`;
  if (i.authType === "api_key" && i.secret) h[i.headerName || "X-API-Key"] = i.secret;
  if (i.authType === "basic" && i.secret) h["Authorization"] = `Basic ${Buffer.from(`${i.username ?? ""}:${i.secret}`).toString("base64")}`;
  if ((i.authType === "hmac" || i.signingEnabled) && i.secret) h["X-Fieldline-Signature"] = crypto.createHmac("sha256", i.secret).update(body).digest("hex");
  return h;
}
async function deliver(i: any, payload: object): Promise<{ ok: boolean; status: number; ms: number }> {
  const body = JSON.stringify(payload);
  const t0 = Date.now();
  try {
    const r = await fetch(i.endpoint, { method: "POST", headers: authHeaders(i, body), body, signal: AbortSignal.timeout(10_000) });
    return { ok: r.ok, status: r.status, ms: Date.now() - t0 };
  } catch { return { ok: false, status: 0, ms: Date.now() - t0 }; }
}
app.post("/integrations/test", async (c) => {
  const b = await c.req.json();
  if (b.type && b.type !== "webhook") return c.json({ error: "Webhook delivery is live today; other destination types are on the roadmap." }, 400);
  if (!/^https?:\/\//.test(b.endpoint ?? "")) return c.json({ error: "Enter a valid http(s) endpoint" }, 400);
  const res = await deliver(b, { event: "integration.test", source: "fieldline", time: new Date().toISOString(), device: { eui: "24e124aabbccddee", name: "Sample sensor" }, measurements: { temperature: 22.5, humidity: 41.2 } });
  if (!res.ok) return c.json({ error: res.status ? `Endpoint answered HTTP ${res.status}` : "Endpoint unreachable (connection failed or timed out)" }, 400);
  return c.json({ ok: true, latencyMs: res.ms, message: `Endpoint answered HTTP ${res.status}` });
});
app.post("/integrations/:id/test", async (c) => {
  const org = await orgOf(authUser(c)!);
  const dflt = await defaultTenant();
  const i = store.get().integrations.find(x => x.id === c.req.param("id") && (x.orgId ?? dflt) === org.tenantId);
  if (!i) return c.json({ error: "not found" }, 404);
  const res = await deliver(i, { event: "integration.test", source: "fieldline", time: new Date().toISOString(), device: { eui: "24e124aabbccddee", name: "Sample sensor" }, measurements: { temperature: 22.5, humidity: 41.2 } });
  if (!res.ok) return c.json({ error: res.status ? `Endpoint answered HTTP ${res.status}` : "Endpoint unreachable" }, 400);
  return c.json({ ok: true, latencyMs: res.ms, message: `Endpoint answered HTTP ${res.status}` });
});

// delivery worker: push each NEW reading to that org's webhooks only
let working = false;
setInterval(async () => {
  if (working) return; working = true;
  try {
    const db = store.get();
    if (db.integrations.length) {
      const r = await fetch(`${READINGS_URL}?latest=1`);
      const readings = (await r.json()) as any[];
      const today = new Date().toISOString().slice(0, 10);
      const dflt = await defaultTenant();
      const euisByOrg = new Map<string, Set<string>>();
      let dirty = false;
      for (const i of db.integrations as any[]) {
        const oid = i.orgId ?? dflt;
        if (!euisByOrg.has(oid)) {
          try { euisByOrg.set(oid, await orgEuis((await tenantInfo(oid)).appId)); }
          catch { euisByOrg.set(oid, new Set()); }
        }
        const euis = euisByOrg.get(oid)!;
        if (i.day !== today) { i.day = today; i.deliveries24h = 0; dirty = true; }
        for (const x of readings) {
          if (!euis.has(x.devEui)) continue; // not this org's sensor
          if (!x.time || !x.data || !Object.keys(x.data).length) continue;
          if (i.lastSent[x.devEui] === x.time) continue;
          const res = await deliver(i, { event: "uplink.received", time: x.time, device: { eui: x.devEui, name: x.device }, measurements: x.data, rssi: x.rssi, snr: x.snr });
          i.lastSent[x.devEui] = x.time;
          if (res.ok) { i.delivered++; i.deliveries24h++; i.lastDeliveryAt = new Date().toISOString(); } else { i.failed++; }
          dirty = true;
        }
      }
      if (dirty) save();
    }
  } catch { /* next tick */ }
  working = false;
}, 45_000);

// ---------- health ----------
app.get("/health", (c) => c.json({ ok: true }));

serve({ fetch: app.fetch, port: PORT });
console.log(`Fieldline backend v3 (multi-tenant) on http://localhost:${PORT}`);
