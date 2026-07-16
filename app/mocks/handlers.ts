import { delay, http, HttpResponse } from "msw";
import type { Alert, ApiToken, Device, DeviceType, Gateway, Integration, IntegrationInput, Reading, Role, User } from "@/lib/api";

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

let gateways: Gateway[] = [
  { eui: "24E124FFFEFE2354", name: "AJLC Roof Gateway", status: "online", lastSeenAt: iso(1), location: { lat: 41.2942, lng: -82.2217 } },
  { eui: "24E124FFFE003119", name: "Science Center Pilot", status: "never", lastSeenAt: null, location: { lat: 41.2928, lng: -82.2179 } },
];

let deviceTypes: DeviceType[] = [
  { id: "type-am308", name: "AM308 Air Quality", region: "US915", lorawanVersion: "1.0.3", class: "A", measurements: [{ name: "temperature", unit: "°C" }, { name: "co2", unit: "ppm" }, { name: "humidity", unit: "%" }, { name: "pm2_5", unit: "µg/m³" }] },
  { id: "type-ct103", name: "CT103 Current Sensor", region: "US915", lorawanVersion: "1.0.3", class: "A", measurements: [{ name: "current", unit: "A" }] },
  { id: "type-ni601", name: "NI601 Air Monitor", region: "US915", lorawanVersion: "1.0.3", class: "A", measurements: [{ name: "temperature", unit: "°C" }, { name: "co2", unit: "ppm" }] },
];

let devices: Device[] = [
  { eui: "24e124707e041853", name: "Community Hub Air", typeId: "type-am308", typeName: "AM308 Air Quality", status: "active", lastSeenAt: iso(4), battery: 92, gatewayEui: "24E124FFFEFE2354", rssi: -78, snr: 9.1, enabled: true, config: { reportingIntervalMinutes: 10, region: "US915", activation: "Over the air" }, latest: { time: iso(4), measurements: { temperature: 22.4, co2: 612, humidity: 47.8, pm2_5: 7.2 } } },
  { eui: "24e124746f502257", name: "Main Panel Current", typeId: "type-ct103", typeName: "CT103 Current Sensor", status: "active", lastSeenAt: iso(7), battery: 78, gatewayEui: "24E124FFFEFE2354", rssi: -84, snr: 7.4, enabled: true, config: { reportingIntervalMinutes: 15, region: "US915", activation: "Over the air" }, latest: { time: iso(7), measurements: { current: 18.7 } } },
  { eui: "24e124850f025225", name: "Greenhouse Air", typeId: "type-ni601", typeName: "NI601 Air Monitor", status: "offline", lastSeenAt: iso(760), battery: 19, gatewayEui: "24E124FFFE003119", rssi: -109, snr: -2.1, enabled: true, config: { reportingIntervalMinutes: 10, region: "US915", activation: "Over the air" }, latest: { time: iso(760), measurements: { temperature: 24.1, co2: 844 } } },
];

let users: User[] = [
  { id: "u1", name: "Maya Chen", email: "admin@oberlin.edu", role: "admin", lastActiveAt: iso(2) },
  { id: "u2", name: "Dr. Jonas Reed", email: "jreed@oberlin.edu", role: "manager", lastActiveAt: iso(48) },
  { id: "u3", name: "Nia Brooks", email: "nbrooks@oberlin.edu", role: "viewer", lastActiveAt: iso(320) },
  { id: "u4", name: "Facilities Team", email: "facilities@oberlin.edu", role: "viewer", lastActiveAt: iso(2_800) },
];

let tokens: ApiToken[] = [{ id: "t1", name: "Campus dashboard", createdAt: iso(43_200), lastUsedAt: iso(6) }];
let integrations: Integration[] = [
  { id: "int-1", name: "Facilities data lake", type: "webhook", endpoint: "https://data.oberlin.edu/lorawan/events", authType: "hmac", status: "healthy", events: ["uplink.received", "device.status", "alert.created"], createdAt: iso(86_400), lastDeliveryAt: iso(2), successRate: 99.97, deliveries24h: 18420, signingEnabled: true, retryPolicy: "standard" },
  { id: "int-2", name: "Building telemetry broker", type: "mqtt", endpoint: "mqtts://telemetry.oberlin.edu:8883", authType: "basic", status: "healthy", events: ["uplink.received"], createdAt: iso(129_600), lastDeliveryAt: iso(1), successRate: 99.91, deliveries24h: 6140, signingEnabled: false, retryPolicy: "aggressive" },
];
const alerts: Alert[] = [
  { id: "a1", type: "sensor_offline", target: "Greenhouse Air", message: "No reading received for more than 12 hours", time: iso(40) },
  { id: "a2", type: "low_battery", target: "Greenhouse Air", message: "Battery level has fallen below 20%", time: iso(180) },
  { id: "a3", type: "gateway_offline", target: "Science Center Pilot", message: "Gateway has not connected yet", time: iso(1_440) },
];

function readingsFor(eui: string): Reading[] {
  const device = devices.find((item) => item.eui === eui) || devices[0];
  return Array.from({ length: 72 }, (_, index) => {
    const age = (71 - index) * 30;
    const wave = Math.sin(index / 5);
    const measurements: Record<string, number> = device.typeId === "type-ct103"
      ? { current: Number((16.5 + wave * 4 + (index % 8) * 0.15).toFixed(2)) }
      : device.typeId === "type-ni601"
        ? { temperature: Number((23.2 + wave * 1.4).toFixed(1)), co2: Math.round(790 + wave * 90) }
        : { temperature: Number((21.8 + wave * 1.2).toFixed(1)), co2: Math.round(590 + wave * 75), humidity: Number((46 + wave * 4).toFixed(1)), pm2_5: Number((7 + Math.abs(wave) * 3).toFixed(1)) };
    return { time: iso(age), measurements, rssi: -78 - (index % 6), snr: Number((8.5 + wave * 2).toFixed(1)) };
  });
}

const ok = async () => { await delay(180); };

export const handlers = [
  http.post("*/api/auth/login", async ({ request }) => { await ok(); const body = await request.json() as { email?: string; password?: string }; if (!body.email || !body.password) return HttpResponse.json({ error: "Email and password are required" }, { status: 400 }); return HttpResponse.json({ token: "demo-token-fieldline", user: users[0] }); }),
  http.get("*/api/auth/me", async () => { await ok(); return HttpResponse.json({ ...users[0], orgId: "org-oberlin", orgName: "Oberlin Campus Network" }); }),
  http.post("*/api/auth/logout", () => HttpResponse.json({ ok: true })),
  http.get("*/api/users", async () => { await ok(); return HttpResponse.json({ items: users }); }),
  http.post("*/api/users", async ({ request }) => { const body = await request.json() as { name: string; email: string; role: Role }; const user: User = { ...body, id: crypto.randomUUID(), lastActiveAt: new Date().toISOString() }; users = [user, ...users]; return HttpResponse.json(user, { status: 201 }); }),
  http.patch("*/api/users/:id", async ({ params, request }) => { const { role } = await request.json() as { role: Role }; users = users.map((user) => user.id === params.id ? { ...user, role } : user); return HttpResponse.json(users.find((user) => user.id === params.id)); }),
  http.delete("*/api/users/:id", ({ params }) => { users = users.filter((user) => user.id !== params.id); return HttpResponse.json({ ok: true }); }),
  http.get("*/api/gateways", async () => { await ok(); return HttpResponse.json({ items: gateways }); }),
  http.post("*/api/gateways", async ({ request }) => { const body = await request.json() as { eui: string; name: string; location?: { lat: number; lng: number } }; const gateway: Gateway = { ...body, location: body.location || null, status: "never", lastSeenAt: null }; gateways = [...gateways, gateway]; return HttpResponse.json(gateway, { status: 201 }); }),
  http.get("*/api/gateways/:eui", async ({ params }) => { await ok(); const gateway = gateways.find((item) => item.eui === params.eui); if (!gateway) return HttpResponse.json({ error: "Gateway not found" }, { status: 404 }); const uplinks = Array.from({ length: 24 }, (_, i) => ({ time: iso((23 - i) * 60), value: 28 + (i % 7) * 5 })); const downlinks = uplinks.map((point, i) => ({ ...point, value: 2 + (i % 4) })); return HttpResponse.json({ ...gateway, metrics: { uplinks, downlinks } }); }),
  http.delete("*/api/gateways/:eui", ({ params }) => { gateways = gateways.filter((item) => item.eui !== params.eui); return HttpResponse.json({ ok: true }); }),
  http.get("*/api/device-types", async () => { await ok(); return HttpResponse.json({ items: deviceTypes }); }),
  http.post("*/api/device-types", async ({ request }) => { const body = await request.json() as Omit<DeviceType, "id">; const type = { ...body, id: crypto.randomUUID() }; deviceTypes = [...deviceTypes, type]; return HttpResponse.json(type, { status: 201 }); }),
  http.get("*/api/devices", async () => { await ok(); return HttpResponse.json({ items: devices }); }),
  http.post("*/api/devices", async ({ request }) => { const body = await request.json() as { name: string; eui: string; typeId: string }; const type = deviceTypes.find((item) => item.id === body.typeId)!; const device: Device = { ...body, typeName: type.name, status: "never", lastSeenAt: null, battery: null, latest: null, gatewayEui: gateways.find(g => g.status === "online")?.eui || null, rssi: null, snr: null, enabled: true, config: { reportingIntervalMinutes: 10, region: type.region, activation: "Over the air" } }; devices = [...devices, device]; return HttpResponse.json({ device, appKey: "8F4A1C7D93E206B54AF9C4201178D3EE" }, { status: 201 }); }),
  http.get("*/api/readings/latest", async () => { await ok(); return HttpResponse.json({ items: devices.filter((item) => item.latest).map((item) => ({ eui: item.eui, name: item.name, ...item.latest! })) }); }),
  http.get("*/api/devices/:eui/readings.csv", ({ params }) => { const rows = readingsFor(String(params.eui)); const keys = Object.keys(rows[0].measurements); const csv = [["time", ...keys, "rssi", "snr"].join(","), ...rows.map((row) => [row.time, ...keys.map((key) => row.measurements[key]), row.rssi, row.snr].join(","))].join("\n"); return new HttpResponse(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${params.eui}-readings.csv"` } }); }),
  http.get("*/api/devices/:eui/readings", async ({ params, request }) => { await ok(); const limit = Number(new URL(request.url).searchParams.get("limit") || 100); return HttpResponse.json({ items: readingsFor(String(params.eui)).slice(-limit) }); }),
  http.post("*/api/devices/:eui/commands/reporting-interval", async ({ request }) => { const { minutes } = await request.json() as { minutes: number }; if (minutes < 1 || minutes > 1_440) return HttpResponse.json({ error: "Interval must be between 1 and 1,440 minutes" }, { status: 400 }); return HttpResponse.json({ queued: true, note: "Command queued. It will be delivered after the sensor's next report." }); }),
  http.get("*/api/devices/:eui", async ({ params }) => { await ok(); const device = devices.find((item) => item.eui === params.eui); return device ? HttpResponse.json(device) : HttpResponse.json({ error: "Sensor not found" }, { status: 404 }); }),
  http.patch("*/api/devices/:eui", async ({ params, request }) => { const body = await request.json() as Partial<Device>; devices = devices.map((item) => item.eui === params.eui ? { ...item, ...body, status: body.enabled === false ? "disabled" : item.status } : item); return HttpResponse.json(devices.find((item) => item.eui === params.eui)); }),
  http.delete("*/api/devices/:eui", ({ params }) => { devices = devices.filter((item) => item.eui !== params.eui); return HttpResponse.json({ ok: true }); }),
  http.get("*/api/alerts", async () => { await ok(); return HttpResponse.json({ items: alerts }); }),
  http.get("*/api/tokens", async () => { await ok(); return HttpResponse.json({ items: tokens }); }),
  http.post("*/api/tokens", async ({ request }) => { const { name } = await request.json() as { name: string }; const token: ApiToken = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString(), lastUsedAt: null, token: `fl_live_${crypto.randomUUID().replaceAll("-", "")}` }; tokens = [{ ...token, token: undefined }, ...tokens]; return HttpResponse.json(token, { status: 201 }); }),
  http.delete("*/api/tokens/:id", ({ params }) => { tokens = tokens.filter((item) => item.id !== params.id); return HttpResponse.json({ ok: true }); }),
  http.get("*/api/integrations", async () => { await ok(); return HttpResponse.json({ items: integrations }); }),
  http.post("*/api/integrations/test", async ({ request }) => { await delay(650); const body = await request.json() as { endpoint?: string }; if (!body.endpoint?.includes("://")) return HttpResponse.json({ error: "Enter a valid HTTPS or MQTT endpoint" }, { status: 400 }); return HttpResponse.json({ ok: true, latencyMs: 142, message: "Endpoint authenticated and accepted a signed test event" }); }),
  http.post("*/api/integrations", async ({ request }) => { const body = await request.json() as IntegrationInput; const integration: Integration = { id: crypto.randomUUID(), name: body.name, type: body.type, endpoint: body.endpoint, authType: body.authType, events: body.events, signingEnabled: body.signingEnabled, retryPolicy: body.retryPolicy, status: "healthy", createdAt: new Date().toISOString(), lastDeliveryAt: null, successRate: 100, deliveries24h: 0 }; integrations = [integration, ...integrations]; return HttpResponse.json(integration, { status: 201 }); }),
  http.delete("*/api/integrations/:id", ({ params }) => { integrations = integrations.filter((item) => item.id !== params.id); return HttpResponse.json({ ok: true }); }),
];
