"use client";
import * as React from "react";

/**
 * MetricCard — a single KPI tile. Handles its own loading skeleton and renders a
 * trend that is legible without colour: the direction is an arrow glyph plus a
 * screen-reader sentence, and the semantic tone is applied on top.
 *
 * Edge cases handled: a missing value shows an em dash, long values wrap instead
 * of overflowing, and the number uses tabular figures so a row of cards aligns.
 *
 * @example
 * <MetricCard label="Sensors reporting" value="2 / 3" icon={<Activity/>}
 *   trend={{ direction: "down", label: "1 went quiet", tone: "bad" }} />
 * @example
 * <MetricCard label="Uplinks today" value={count} isLoading={q.isLoading} />
 */
export interface MetricTrend {
  direction: "up" | "down" | "flat";
  label: string;
  /** Semantic meaning of the movement — up isn't always good. */
  tone?: "good" | "bad" | "neutral";
}

export interface MetricCardProps {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  hint?: string;
  trend?: MetricTrend;
  isLoading?: boolean;
  className?: string;
}

const ARROW = { up: "↑", down: "↓", flat: "→" } as const;
const TONE = {
  good: "text-emerald-600 dark:text-emerald-400",
  bad: "text-red-600 dark:text-red-400",
  neutral: "text-[var(--muted)]",
} as const;

export function MetricCard({ label, value, icon, hint, trend, isLoading, className }: MetricCardProps) {
  return (
    <div className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 ${className ?? ""}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--muted)]">{label}</p>
        {icon && <span className="rounded-lg bg-[var(--surface-muted)] p-2 text-[var(--accent)]" aria-hidden="true">{icon}</span>}
      </div>

      {isLoading ? (
        <div className="mt-3 h-8 w-24 animate-pulse rounded bg-[var(--surface-muted)]" role="status" aria-label={`${label} loading`} />
      ) : (
        <p className="mt-3 break-words text-3xl font-semibold tracking-[-0.02em] tabular-nums">
          {value ?? <span className="text-[var(--muted)]">—</span>}
        </p>
      )}

      {!isLoading && (trend || hint) && (
        <div className="mt-1 flex items-center gap-2 text-xs">
          {trend && (
            <span className={`inline-flex items-center gap-0.5 font-medium ${TONE[trend.tone ?? "neutral"]}`}>
              <span aria-hidden="true">{ARROW[trend.direction]}</span>
              <span>{trend.label}</span>
              <span className="sr-only">
                {trend.direction === "up" ? "up" : trend.direction === "down" ? "down" : "unchanged"}
              </span>
            </span>
          )}
          {hint && <span className="text-[var(--muted)]">{hint}</span>}
        </div>
      )}
    </div>
  );
}
