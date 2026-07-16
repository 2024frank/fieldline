import { RadioTower } from "lucide-react";
import { cn } from "@/lib/utils";

export function Brand({ compact = false, inverse = false, className }: { compact?: boolean; inverse?: boolean; className?: string }) {
  return <div className={cn("flex items-center gap-3", className)}>
    <div className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-[13px] bg-[linear-gradient(145deg,#20b879,#08734d)] text-white shadow-[0_10px_24px_rgba(13,132,87,.25)]">
      <div className="absolute inset-px rounded-[12px] border border-white/20"/>
      <RadioTower size={20} strokeWidth={2.2}/>
    </div>
    {!compact && <div className="leading-none"><div className={cn("text-[17px] font-semibold tracking-[-.045em]", inverse && "text-white")}>Fieldline<span className="text-emerald-400"> One</span></div><div className={cn("mt-1.5 text-[9px] font-semibold uppercase tracking-[.19em] text-[var(--muted)]", inverse && "text-white/50")}>LoRaWAN operations</div></div>}
  </div>;
}
