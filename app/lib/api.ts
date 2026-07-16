export type Role = "admin" | "manager" | "viewer";
export type Status = "online" | "offline" | "never" | "active";
export type User = { id: string; name: string; email: string; role: Role; lastActiveAt?: string; mustChangePassword?: boolean };
export type Gateway = { eui: string; name: string; status: "online" | "offline" | "never"; lastSeenAt: string | null; location: { lat: number; lng: number } | null; metrics?: { uplinks: MetricPoint[]; downlinks: MetricPoint[] } };
export type DeviceType = { id: string; name: string; region: string; lorawanVersion: string; class: string; measurements: { name: string; unit: string }[] };
export type Latest = { measurements: Record<string, number>; time: string };
export type Device = { eui: string; name: string; typeId: string; typeName: string; status: string; lastSeenAt: string | null; battery: number | null; latest: Latest | null; gatewayEui?: string | null; rssi?: number | null; snr?: number | null; enabled?: boolean; config?: Record<string, unknown>; margin?: number | null; lastJoinAt?: string | null; lastError?: { code: string; description: string; time: string } | null };
export type Reading = { time: string; measurements: Record<string, number>; rssi: number; snr: number };
export type Alert = { id: string; type: "sensor_offline" | "gateway_offline" | "low_battery" | "network_error"; target: string; message: string; time: string };
export type ApiToken = { id: string; name: string; createdAt?: string; lastUsedAt?: string | null; token?: string };
export type IntegrationType = "webhook" | "mqtt" | "aws_iot" | "azure_event_grid" | "thingsboard" | "datadog";
export type IntegrationAuth = "none" | "bearer" | "api_key" | "basic" | "oauth2" | "hmac";
export type Integration = {
  id: string; name: string; type: IntegrationType; endpoint: string; authType: IntegrationAuth;
  status: "healthy" | "degraded" | "paused"; events: string[]; createdAt: string; lastDeliveryAt: string | null;
  successRate: number; deliveries24h: number; signingEnabled: boolean; retryPolicy: "standard" | "aggressive";
};
export type IntegrationInput = Omit<Integration, "id" | "status" | "createdAt" | "lastDeliveryAt" | "successRate" | "deliveries24h"> & {
  secret?: string; username?: string; headerName?: string; clientId?: string; clientSecret?: string; tokenUrl?: string;
};
export type MetricPoint = { time: string; value: number };
type List<T> = { items: T[] };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

function authToken() {
  return typeof window === "undefined" ? null : window.localStorage.getItem("fieldline_token");
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = authToken();
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "Request failed" })) as { error?: string };
    throw new ApiError(payload.error || "Request failed", response.status);
  }
  return response.json() as Promise<T>;
}

export const api = {
  login: (body: { email: string; password: string }) => request<{ token: string; user: User }>("/auth/login", { method: "POST", body: JSON.stringify(body) }),
  me: () => request<User & { orgId: string; orgName: string }>("/auth/me"),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  changePassword: (body: { currentPassword: string; newPassword: string }) => request<{ ok: true }>("/auth/change-password", { method: "POST", body: JSON.stringify(body) }),
  completeOnboarding: (body: { orgName: string }) => request<{ ok: true; orgName: string }>("/auth/onboarding", { method: "POST", body: JSON.stringify(body) }),
  testIntegrationById: (id: string) => request<{ ok: true; latencyMs: number; message: string }>(`/integrations/${id}/test`, { method: "POST" }),
  users: () => request<List<User>>("/users"),
  createUser: (body: { name: string; email: string; role: Role; password: string }) => request<User>("/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (id: string, role: Role) => request<User>(`/users/${id}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  deleteUser: (id: string) => request<{ ok: true }>(`/users/${id}`, { method: "DELETE" }),
  gateways: () => request<List<Gateway>>("/gateways"),
  gateway: (eui: string) => request<Gateway>(`/gateways/${eui}`),
  createGateway: (body: { eui: string; name: string; location?: { lat: number; lng: number } }) => request<Gateway>("/gateways", { method: "POST", body: JSON.stringify(body) }),
  deleteGateway: (eui: string) => request<{ ok: true }>(`/gateways/${eui}`, { method: "DELETE" }),
  deviceTypes: () => request<List<DeviceType>>("/device-types"),
  createDeviceType: (body: { name: string; region?: string; lorawanVersion?: string; class?: string; description?: string; decoderScript?: string }) => request<DeviceType>("/device-types", { method: "POST", body: JSON.stringify(body) }),
  devices: () => request<List<Device>>("/devices"),
  device: (eui: string) => request<Device>(`/devices/${eui}`),
  createDevice: (body: { name: string; eui: string; typeId: string; joinEui?: string }) => request<{ device: Device; appKey: string }>("/devices", { method: "POST", body: JSON.stringify(body) }),
  updateDevice: (eui: string, body: { name?: string; enabled?: boolean }) => request<Device>(`/devices/${eui}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteDevice: (eui: string) => request<{ ok: true }>(`/devices/${eui}`, { method: "DELETE" }),
  latestReadings: () => request<List<{ eui: string; name: string; time: string; measurements: Record<string, number> }>>("/readings/latest"),
  readings: (eui: string, params: { from?: string; to?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => value != null && query.set(key, String(value)));
    return request<List<Reading>>(`/devices/${eui}/readings?${query}`);
  },
  readingsCsvUrl: (eui: string, from?: string, to?: string) => `${API_BASE}/devices/${eui}/readings.csv?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`,
  setReportingInterval: (eui: string, minutes: number) => request<{ queued: true; note: string }>(`/devices/${eui}/commands/reporting-interval`, { method: "POST", body: JSON.stringify({ minutes }) }),
  alerts: () => request<List<Alert>>("/alerts"),
  tokens: () => request<List<ApiToken>>("/tokens"),
  createToken: (name: string) => request<ApiToken>("/tokens", { method: "POST", body: JSON.stringify({ name }) }),
  deleteToken: (id: string) => request<{ ok: true }>(`/tokens/${id}`, { method: "DELETE" }),
  integrations: () => request<List<Integration>>("/integrations"),
  createIntegration: (body: IntegrationInput) => request<Integration>("/integrations", { method: "POST", body: JSON.stringify(body) }),
  deleteIntegration: (id: string) => request<{ ok: true }>(`/integrations/${id}`, { method: "DELETE" }),
  testIntegration: (body: Pick<IntegrationInput, "type" | "endpoint" | "authType" | "secret">) => request<{ ok: true; latencyMs: number; message: string }>("/integrations/test", { method: "POST", body: JSON.stringify(body) }),
};

export { API_BASE };
