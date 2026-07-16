"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Card, CardContent, Input, Label } from "@/components/ui/primitives";
import { Brand } from "@/components/brand";

const schema = z.object({ email: z.string().email("Enter a valid email"), password: z.string().min(1, "Enter your password") });
type Form = z.infer<typeof schema>;

export default function LoginPage() {
  const router = useRouter();
  useEffect(() => { if (localStorage.getItem("fieldline_token")) router.replace("/"); }, [router]);
  const form = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });
  const login = useMutation({ mutationFn: api.login, onSuccess: ({ token, user }) => { localStorage.setItem("fieldline_token", token); router.replace(user.mustChangePassword ? "/onboarding" : "/"); }, onError: (error: Error) => form.setError("root", { message: error.message }) });
  return <main className="grid min-h-screen lg:grid-cols-[1.05fr_.95fr]">
    <section className="relative hidden overflow-hidden bg-[#07140e] p-12 text-white lg:flex lg:flex-col">
      <div className="absolute inset-0 bg-cover bg-center opacity-30 mix-blend-luminosity" style={{ backgroundImage: "url('/og.png')" }}/><div className="absolute inset-0 bg-[linear-gradient(90deg,#07140e_5%,rgba(7,20,14,.72)_55%,rgba(7,20,14,.35))]"/><div className="absolute inset-0 [background-image:radial-gradient(circle_at_30%_30%,rgba(32,184,121,.28),transparent_36%)]"/>
      <Brand inverse className="relative"/>
      <div className="relative my-auto max-w-xl"><div className="mb-6 inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1.5 text-xs font-medium text-emerald-200"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300"/>Enterprise LoRaWAN operations</div><h1 className="text-5xl font-semibold leading-[1.04] tracking-[-.055em]">Every signal.<br/>One command center.</h1><p className="mt-6 max-w-lg text-lg leading-8 text-white/65">Operate gateways, provision sensors, automate downlinks, and route trusted telemetry into every system your organization depends on.</p><div className="mt-10 grid grid-cols-3 gap-3"><div className="rounded-xl border border-white/10 bg-black/20 p-4 backdrop-blur"><p className="text-2xl font-semibold">US915</p><p className="mt-1 text-xs text-white/55">LoRaWAN region</p></div><div className="rounded-xl border border-white/10 bg-black/20 p-4 backdrop-blur"><p className="text-2xl font-semibold">AES-128</p><p className="mt-1 text-xs text-white/55">Encrypted end to end</p></div><div className="rounded-xl border border-white/10 bg-black/20 p-4 backdrop-blur"><p className="text-2xl font-semibold">24/7</p><p className="mt-1 text-xs text-white/55">Network health</p></div></div></div>
      <p className="relative flex items-center gap-2 text-xs text-white/40"><ShieldCheck size={14}/>Private by design · Credentials stay on the server</p>
    </section>
    <section className="flex items-center justify-center p-5 sm:p-10"><div className="w-full max-w-md"><Brand className="mb-10 lg:hidden"/><div className="mb-7"><p className="text-sm font-medium text-[var(--accent)]">Secure operations console</p><h2 className="mt-2 text-3xl font-semibold tracking-[-.045em]">Welcome back</h2><p className="mt-2 text-sm text-[var(--muted)]">Sign in to manage your organization’s LoRaWAN network.</p></div><Card className="shadow-[0_20px_55px_rgba(20,45,31,.08)]"><CardContent className="pt-6"><form className="space-y-4" onSubmit={form.handleSubmit(values => login.mutate(values))}><div><Label htmlFor="email">Work email</Label><Input id="email" type="email" autoComplete="email" {...form.register("email")}/>{form.formState.errors.email && <p className="mt-1 text-xs text-red-600">{form.formState.errors.email.message}</p>}</div><div><div className="flex justify-between"><Label htmlFor="password">Password</Label><button type="button" className="mb-1.5 text-xs font-medium text-[var(--accent)]" onClick={() => toast.info("Password resets are handled by your administrator — ask them to issue you a new temporary password.")}>Forgot password?</button></div><Input id="password" type="password" autoComplete="current-password" {...form.register("password")}/>{form.formState.errors.password && <p className="mt-1 text-xs text-red-600">{form.formState.errors.password.message}</p>}</div>{form.formState.errors.root && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-700">{form.formState.errors.root.message}</p>}<Button className="w-full" disabled={login.isPending}>{login.isPending ? "Signing in…" : "Sign in to Fieldline One"}<ArrowRight size={16}/></Button></form><div className="mt-5 flex items-start gap-2 border-t pt-4 text-xs leading-5 text-[var(--muted)]"><ShieldCheck size={16} className="mt-0.5 shrink-0 text-[var(--accent)]"/>Sign in with the account your administrator gave you. Credentials are checked against your live network.</div></CardContent></Card><p className="mt-6 text-center text-xs text-[var(--muted)]">Enterprise SSO · Audit logging · Role-based access</p></div></section>
  </main>;
}
