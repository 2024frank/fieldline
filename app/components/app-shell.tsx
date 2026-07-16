"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Bell, Boxes, ChevronDown, Database, Gauge, LogOut, Menu, Moon, PlugZap, RadioTower, Settings, Sun, Users, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button, Skeleton } from "@/components/ui/primitives";
import { Brand } from "@/components/brand";

const nav = [
  { href: "/", label: "Overview", icon: Gauge },
  { href: "/gateways", label: "Gateways", icon: RadioTower },
  { href: "/sensors", label: "Sensors", icon: Activity },
  { href: "/device-types", label: "Device types", icon: Boxes },
  { href: "/data", label: "Readings", icon: Database },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/integrations", label: "Integrations", icon: PlugZap, adminOnly: true },
  { href: "/users", label: "People", icon: Users, adminOnly: true },
  { href: "/settings", label: "Settings", icon: Settings, adminOnly: true },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [token, setToken] = useState<string | null>();
  useEffect(() => { const stored = localStorage.getItem("fieldline_token"); setToken(stored); if (!stored) router.replace("/login"); }, [router]);
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, enabled: Boolean(token) });
  // first login: no wandering off until the temporary password is changed
  useEffect(() => { if (me.data?.mustChangePassword && pathname !== "/onboarding") router.replace("/onboarding"); }, [me.data, pathname, router]);
  const alerts = useQuery({ queryKey: ["alerts"], queryFn: api.alerts, enabled: Boolean(token), refetchInterval: 60_000 });
  const alertCount = alerts.data?.items.length ?? 0;
  useEffect(() => { const value = localStorage.getItem("fieldline_theme") === "dark"; setDark(value); document.documentElement.classList.toggle("dark", value); document.documentElement.classList.toggle("light", !value); }, []);

  function toggleTheme() { const next = !dark; setDark(next); localStorage.setItem("fieldline_theme", next ? "dark" : "light"); document.documentElement.classList.toggle("dark", next); document.documentElement.classList.toggle("light", !next); }
  async function logout() { await api.logout().catch(() => null); localStorage.removeItem("fieldline_token"); router.replace("/login"); }
  if (!token) return null;

  const sidebar = <>
    <div className="flex h-16 items-center gap-3 border-b px-5">
      <Brand/>
      <button className="ml-auto lg:hidden" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><X size={20}/></button>
    </div>
    <nav className="flex-1 space-y-1 p-3" aria-label="Primary navigation">
      {nav.filter(item => !item.adminOnly || me.data?.role === "admin").map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return <Link key={href} href={href} onClick={() => setMobileOpen(false)} className={cn("flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors", active ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]")}><Icon size={17}/>{label}{label === "Alerts" && alertCount > 0 && <span className="ml-auto rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] text-white">{alertCount}</span>}</Link>;
      })}
    </nav>
    <div className="border-t p-3">
      <Link href="/onboarding" className="mb-2 flex items-center gap-3 rounded-lg border border-dashed p-3 text-xs text-[var(--muted)] hover:bg-[var(--surface-muted)]"><RadioTower size={17}/><span><strong className="block text-[var(--foreground)]">Setup guide</strong>Add a gateway or sensor</span></Link>
      <button onClick={logout} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"><LogOut size={17}/>Sign out</button>
    </div>
  </>;

  return <div className="min-h-screen bg-[var(--background)]">
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r bg-[var(--surface)] lg:flex">{sidebar}</aside>
    {mobileOpen && <div className="fixed inset-0 z-50 lg:hidden"><button className="absolute inset-0 bg-black/40" aria-label="Close navigation" onClick={() => setMobileOpen(false)}/><aside className="relative flex h-full w-72 flex-col bg-[var(--surface)]">{sidebar}</aside></div>}
    <div className="lg:pl-60">
      <header className="sticky top-0 z-30 flex h-16 items-center border-b bg-[color:var(--background)]/90 px-4 backdrop-blur-xl sm:px-7">
        <button className="mr-3 lg:hidden" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={21}/></button>
        <div className="min-w-0"><p className="truncate text-sm font-medium">{me.data?.orgName || "Oberlin Campus Network"}</p><p className="text-xs text-[var(--muted)]">Private LoRaWAN · US915</p></div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="icon" aria-label="Toggle color theme" onClick={toggleTheme}>{dark ? <Sun size={17}/> : <Moon size={17}/>}</Button>
          <div className="hidden items-center gap-3 border-l pl-4 sm:flex">
            {me.isLoading ? <Skeleton className="h-8 w-28"/> : <><div className="grid h-8 w-8 place-items-center rounded-full bg-[var(--accent-soft)] text-xs font-semibold text-[var(--accent)]">{me.data?.name.split(" ").map(v => v[0]).join("").slice(0, 2)}</div><div className="text-xs"><p className="font-medium">{me.data?.name}</p><p className="capitalize text-[var(--muted)]">{me.data?.role}</p></div><ChevronDown size={14} className="text-[var(--muted)]"/></>}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1440px] p-4 sm:p-7 lg:p-9">{children}</main>
    </div>
  </div>;
}
