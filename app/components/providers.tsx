"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Toaster } from "sonner";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } }));
  const [ready, setReady] = useState(Boolean(process.env.NEXT_PUBLIC_API_BASE) || process.env.NEXT_PUBLIC_ENABLE_MOCKS === "false");
  useEffect(() => {
    if (ready) return;
    import("@/mocks/browser").then(({ worker }) => worker.start({ onUnhandledRequest: "bypass" })).then(() => setReady(true));
  }, [ready]);
  if (!ready) return <div className="min-h-screen bg-[var(--background)] p-6"><div className="mx-auto max-w-7xl animate-pulse"><div className="h-8 w-36 rounded bg-[var(--surface-muted)]"/><div className="mt-24 grid gap-4 md:grid-cols-3"><div className="h-32 rounded-xl bg-[var(--surface-muted)]"/><div className="h-32 rounded-xl bg-[var(--surface-muted)]"/><div className="h-32 rounded-xl bg-[var(--surface-muted)]"/></div></div></div>;
  return <QueryClientProvider client={client}>{children}<Toaster richColors position="top-right" /></QueryClientProvider>;
}
