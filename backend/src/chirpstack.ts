// Thin ChirpStack client: logs in as admin (gRPC-web), then calls the REST proxy
// with the JWT. Caches the token and re-logs-in on 401.
const GRPC = process.env.CHIRPSTACK_GRPC ?? "http://chirpstack:8080";
const REST = process.env.CHIRPSTACK_REST ?? "http://chirpstack-rest-api:8090";
const USER = process.env.CHIRPSTACK_ADMIN_USER ?? "admin";
const PASS = process.env.CHIRPSTACK_ADMIN_PASS ?? "";

let cachedJwt: string | null = null;

function strField(num: number, s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([Buffer.from([(num << 3) | 2, b.length]), b]); // len<128 for creds
}
function readVarint(b: Buffer, i: number): [number, number] {
  let shift = 0, res = 0;
  for (;;) { const byte = b[i++]; res |= (byte & 0x7f) << shift; if (!(byte & 0x80)) return [res, i]; shift += 7; }
}

export async function login(email = USER, password = PASS): Promise<string> {
  const msg = Buffer.concat([strField(1, email), strField(2, password)]);
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(msg.length);
  const frame = Buffer.concat([Buffer.from([0]), lenBuf, msg]);
  const res = await fetch(`${GRPC}/api.InternalService/Login`, {
    method: "POST",
    headers: { "Content-Type": "application/grpc-web-text", "Accept": "application/grpc-web-text", "x-grpc-web": "1" },
    body: frame.toString("base64"),
  });
  const raw = Buffer.from(await res.text(), "base64");
  let i = 0;
  while (i < raw.length) {
    const flag = raw[i]; const len = raw.readUInt32BE(i + 1); const payload = raw.subarray(i + 5, i + 5 + len); i += 5 + len;
    if (flag === 0 && payload[0] === 0x0a) { const [length, j] = readVarint(payload, 1); return payload.subarray(j, j + length).toString("utf8"); }
  }
  throw new Error("chirpstack login failed");
}

// REST call against ChirpStack proxy, auto-refreshing the admin token.
export async function cs<T = any>(method: string, path: string, body?: unknown, jwt?: string): Promise<T> {
  const token = jwt ?? (cachedJwt ?? (cachedJwt = await login()));
  const doFetch = (t: string) => fetch(`${REST}${path}`, {
    method,
    headers: { "Authorization": `Bearer ${t}`, "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let r = await doFetch(token);
  if (r.status === 401 && !jwt) { cachedJwt = await login(); r = await doFetch(cachedJwt); }
  if (!r.ok) throw new Error(`chirpstack ${method} ${path} -> ${r.status}`);
  const text = await r.text();
  return (text ? JSON.parse(text) : {}) as T;
}

// Verify a user's ChirpStack credentials (used by /auth/login).
export async function verifyCredentials(email: string, password: string): Promise<boolean> {
  try { await login(email, password); return true; } catch { return false; }
}

export async function tenantId(): Promise<string> {
  const r = await cs<any>("GET", "/api/tenants?limit=1");
  return r.result[0].id;
}
