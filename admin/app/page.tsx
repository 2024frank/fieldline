"use client";

import { useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:4000";
const APP_URL = "https://your-app-domain";

type Org = { id: string; name: string; createdAt: string; users: number };
type Me = { email: string; name: string; platformAdmin?: boolean };
type Operator = { id: string; name: string; email: string; builtIn?: boolean };

function tempPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return "Welcome-" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function req(path: string, token: string | null, init: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data;
}

const card = "rounded-2xl border border-emerald-100/10 bg-[#101b16] p-6";
const input = "w-full rounded-lg border border-emerald-100/15 bg-[#0b1210] px-3 py-2 text-sm outline-none focus:border-emerald-400/60";
const label = "mb-1 block text-xs font-medium text-emerald-100/50";
const btn = "rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-[#04150c] hover:bg-emerald-400 disabled:opacity-40";
const btnGhost = "rounded-lg border border-emerald-100/15 px-3 py-1.5 text-xs text-emerald-100/70 hover:bg-emerald-100/5";

function Header({ me, onLogout }: { me: Me | null; onLogout: () => void }) {
  return (
    <header className="mb-8 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <img src="/favicon.svg" alt="" className="h-10 w-10 rounded-xl"/>
        <div>
          <div className="text-lg font-semibold tracking-tight">Fieldline <span className="text-emerald-400">Operator</span></div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-emerald-100/40">Platform console</div>
        </div>
      </div>
      {me && <div className="flex items-center gap-3 text-sm text-emerald-100/60">{me.email}<button className={btnGhost} onClick={onLogout}>Sign out</button></div>}
    </header>
  );
}

function Login({ onToken }: { onToken: (t: string, me: Me) => void }) {
  const [email, setEmail] = useState("you@example.com");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const d = await req("/auth/login", null, { method: "POST", body: JSON.stringify({ email, password }) }) as { token: string; user: Me & { mustChangePassword?: boolean } };
      if (!d.user.platformAdmin) throw new Error("This console is for platform operators only.");
      if (d.user.mustChangePassword) throw new Error(`First set your own password in the main app: ${APP_URL}`);
      onToken(d.token, d.user);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className={`${card} mx-auto mt-16 max-w-sm`}>
      <h1 className="mb-1 text-xl font-semibold">Operator sign in</h1>
      <p className="mb-5 text-sm text-emerald-100/50">Onboard organizations and provision their people.</p>
      <label className={label}>Email</label>
      <input className={input} value={email} onChange={e => setEmail(e.target.value)} autoComplete="username"/>
      <label className={`${label} mt-4`}>Password</label>
      <input className={input} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password"/>
      {err && <p className="mt-3 rounded-lg bg-red-500/10 p-2.5 text-xs text-red-300">{err}</p>}
      <button className={`${btn} mt-5 w-full`} disabled={busy || !password}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

function Result({ r, onClose }: { r: { title: string; email: string; tempPassword?: string; emailSent?: boolean; emailError?: string }; onClose: () => void }) {
  return (
    <div className="mt-4 rounded-xl border border-emerald-400/30 bg-emerald-400/5 p-4 text-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-semibold text-emerald-300">{r.title}</p>
          <p className="mt-2 text-emerald-100/70">Login: <span className="font-mono">{r.email}</span></p>
          {r.tempPassword && <p className="text-emerald-100/70">Temporary password: <span className="font-mono font-bold">{r.tempPassword}</span></p>}
          <p className="mt-2 text-xs text-emerald-100/50">
            {r.emailSent ? "✓ Welcome email delivered — they have everything they need." :
              r.emailError ? `Email failed (${r.emailError}) — hand them the login above yourself.` :
              "No email sent — hand them the login above yourself."}
          </p>
        </div>
        <button className={btnGhost} onClick={onClose}>Dismiss</button>
      </div>
    </div>
  );
}

export default function OperatorConsole() {
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [err, setErr] = useState("");
  // create-org form
  const [org, setOrg] = useState({ name: "", adminName: "", adminEmail: "", sendEmail: true });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ title: string; email: string; tempPassword: string; emailSent?: boolean; emailError?: string } | null>(null);
  // add-user form (per org)
  const [userOrg, setUserOrg] = useState<string | null>(null);
  const [nu, setNu] = useState({ name: "", email: "", role: "viewer", sendEmail: true });
  // operators
  const [ops, setOps] = useState<Operator[]>([]);
  const [no, setNo] = useState({ name: "", email: "", sendEmail: true });

  const loadOrgs = useCallback(async (t: string) => {
    try {
      setOrgs(((await req("/orgs", t)) as { items: Org[] }).items);
      setOps(((await req("/operators", t)) as { items: Operator[] }).items);
      setErr("");
    }
    catch (e) { setErr((e as Error).message); }
  }, []);

  useEffect(() => {
    const t = localStorage.getItem("fieldline_operator_token");
    const m = localStorage.getItem("fieldline_operator_me");
    if (t && m) { setToken(t); setMe(JSON.parse(m)); loadOrgs(t); }
    setReady(true);
  }, [loadOrgs]);

  function onToken(t: string, m: Me) {
    localStorage.setItem("fieldline_operator_token", t);
    localStorage.setItem("fieldline_operator_me", JSON.stringify(m));
    setToken(t); setMe(m); loadOrgs(t);
  }
  function logout() { localStorage.removeItem("fieldline_operator_token"); localStorage.removeItem("fieldline_operator_me"); setToken(null); setMe(null); }

  async function createOrg(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const d = await req("/orgs", token, { method: "POST", body: JSON.stringify({ orgName: org.name, adminName: org.adminName, adminEmail: org.adminEmail, sendEmail: org.sendEmail }) }) as { org: { name: string }; admin: { email: string }; tempPassword: string; emailSent?: boolean; emailError?: string };
      setResult({ title: `${d.org.name} onboarded — 12 sensor types ready`, email: d.admin.email, tempPassword: d.tempPassword, emailSent: d.emailSent, emailError: d.emailError });
      setOrg({ name: "", adminName: "", adminEmail: "", sendEmail: true });
      await loadOrgs(token!);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function addOperator(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const d = await req("/operators", token, { method: "POST", body: JSON.stringify(no) }) as { email: string; tempPassword?: string; emailSent?: boolean; emailError?: string };
      setResult({ title: `${no.name || d.email} can now onboard schools`, email: d.email, tempPassword: d.tempPassword, emailSent: d.emailSent, emailError: d.emailError });
      setNo({ name: "", email: "", sendEmail: true });
      await loadOrgs(token!);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function removeOperator(id: string) {
    setBusy(true); setErr("");
    try { await req(`/operators/${id}`, token, { method: "DELETE" }); await loadOrgs(token!); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function addUser(e: React.FormEvent, orgId: string, orgName: string) {
    e.preventDefault(); setBusy(true); setErr("");
    const pass = tempPassword();
    try {
      const d = await req("/users", token, { method: "POST", body: JSON.stringify({ name: nu.name, email: nu.email, role: nu.role, password: pass, orgId, sendEmail: nu.sendEmail }) }) as { email: string; emailSent?: boolean; emailError?: string };
      setResult({ title: `${nu.name} added to ${orgName} (${nu.role})`, email: d.email, tempPassword: pass, emailSent: d.emailSent, emailError: d.emailError });
      setNu({ name: "", email: "", role: "viewer", sendEmail: true }); setUserOrg(null);
      await loadOrgs(token!);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (!ready) return null;
  return (
    <main className="mx-auto max-w-3xl px-5 py-8">
      <Header me={me} onLogout={logout}/>
      {!token || !me ? <Login onToken={onToken}/> : (
        <>
          {err && <p className="mb-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{err}</p>}
          {result && <Result r={result} onClose={() => setResult(null)}/>}

          <section className={`${card} mt-6`}>
            <h2 className="text-lg font-semibold">Onboard a new organization</h2>
            <p className="mt-1 text-sm text-emerald-100/50">Creates their private workspace, installs the 12 sensor types, and provisions their admin. First sign-in forces a password change.</p>
            <form onSubmit={createOrg} className="mt-5 grid gap-4 sm:grid-cols-2">
              <div><label className={label}>Organization name</label><input className={input} required value={org.name} onChange={e => setOrg({ ...org, name: e.target.value })} placeholder="Kenyon College"/></div>
              <div><label className={label}>Admin name</label><input className={input} required value={org.adminName} onChange={e => setOrg({ ...org, adminName: e.target.value })} placeholder="Jane Smith"/></div>
              <div className="sm:col-span-2"><label className={label}>Admin email</label><input className={input} type="email" required value={org.adminEmail} onChange={e => setOrg({ ...org, adminEmail: e.target.value })} placeholder="sensors@kenyon.edu"/></div>
              <label className="flex items-center gap-2 text-sm text-emerald-100/70 sm:col-span-2">
                <input type="checkbox" checked={org.sendEmail} onChange={e => setOrg({ ...org, sendEmail: e.target.checked })} className="h-4 w-4 accent-emerald-500"/>
                Send them the welcome email (login + temporary password)
              </label>
              <div className="sm:col-span-2"><button className={btn} disabled={busy}>{busy ? "Creating…" : "Create organization"}</button></div>
            </form>
          </section>

          <section className="mt-6">
            <h2 className="mb-3 text-lg font-semibold">Organizations</h2>
            <div className="space-y-3">
              {orgs.map(o => (
                <div key={o.id} className={card}>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="font-semibold">{o.name}</p>
                      <p className="mt-0.5 text-xs text-emerald-100/40">{o.users} user{o.users === 1 ? "" : "s"} · since {new Date(o.createdAt).toLocaleDateString()}</p>
                    </div>
                    <button className={btnGhost} onClick={() => setUserOrg(userOrg === o.id ? null : o.id)}>{userOrg === o.id ? "Cancel" : "Add user"}</button>
                  </div>
                  {userOrg === o.id && (
                    <form onSubmit={e => addUser(e, o.id, o.name)} className="mt-4 grid gap-3 border-t border-emerald-100/10 pt-4 sm:grid-cols-3">
                      <div><label className={label}>Name</label><input className={input} required value={nu.name} onChange={e => setNu({ ...nu, name: e.target.value })}/></div>
                      <div><label className={label}>Email</label><input className={input} type="email" required value={nu.email} onChange={e => setNu({ ...nu, email: e.target.value })}/></div>
                      <div><label className={label}>Role</label>
                        <select className={input} value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value })}>
                          <option value="admin">admin</option><option value="manager">manager</option><option value="viewer">viewer</option>
                        </select>
                      </div>
                      <label className="flex items-center gap-2 text-sm text-emerald-100/70 sm:col-span-2">
                        <input type="checkbox" checked={nu.sendEmail} onChange={e => setNu({ ...nu, sendEmail: e.target.checked })} className="h-4 w-4 accent-emerald-500"/>
                        Email them their login
                      </label>
                      <div className="sm:col-span-1 sm:text-right"><button className={btn} disabled={busy}>{busy ? "Adding…" : "Add user"}</button></div>
                    </form>
                  )}
                </div>
              ))}
              {!orgs.length && <p className="text-sm text-emerald-100/40">No organizations yet.</p>}
            </div>
          </section>

          <section className={`${card} mt-6`}>
            <h2 className="text-lg font-semibold">Platform operators</h2>
            <p className="mt-1 text-sm text-emerald-100/50">Operators can onboard schools and manage this console. Give this only to people you fully trust.</p>
            <div className="mt-4 space-y-2">
              {ops.map(o => (
                <div key={o.id} className="flex items-center justify-between rounded-lg border border-emerald-100/10 px-4 py-2.5">
                  <div>
                    <span className="text-sm font-medium">{o.name}</span>
                    <span className="ml-2 text-xs text-emerald-100/40">{o.email}</span>
                    {o.builtIn && <span className="ml-2 rounded bg-emerald-400/10 px-1.5 py-0.5 text-[10px] text-emerald-300">built-in</span>}
                  </div>
                  {!o.builtIn && me && o.email !== me.email && <button className={btnGhost} disabled={busy} onClick={() => removeOperator(o.id)}>Remove</button>}
                </div>
              ))}
            </div>
            <form onSubmit={addOperator} className="mt-4 grid gap-3 border-t border-emerald-100/10 pt-4 sm:grid-cols-2">
              <div><label className={label}>Name</label><input className={input} required value={no.name} onChange={e => setNo({ ...no, name: e.target.value })} placeholder="Trusted teammate"/></div>
              <div><label className={label}>Email</label><input className={input} type="email" required value={no.email} onChange={e => setNo({ ...no, email: e.target.value })}/></div>
              <label className="flex items-center gap-2 text-sm text-emerald-100/70">
                <input type="checkbox" checked={no.sendEmail} onChange={e => setNo({ ...no, sendEmail: e.target.checked })} className="h-4 w-4 accent-emerald-500"/>
                Email them the console invite
              </label>
              <div className="sm:text-right"><button className={btn} disabled={busy}>{busy ? "Adding…" : "Make operator"}</button></div>
            </form>
          </section>

          <p className="mt-8 text-center text-xs text-emerald-100/30">Main app: <a className="text-emerald-400/70 hover:underline" href={APP_URL}>{APP_URL.replace("https://", "")}</a></p>
        </>
      )}
    </main>
  );
}
