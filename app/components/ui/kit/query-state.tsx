"use client";
import * as React from "react";

/**
 * QueryState — one place to resolve the four states every data view has:
 * loading, error, empty, and populated. Replaces the copy-pasted
 * `isLoading ? <Skeleton/> : !items.length ? <Empty/> : <List/>` ladder so
 * every screen handles edge cases the same way.
 *
 * It's decoupled from any data library: pass the flags and the array. Works
 * with React Query, SWR, useEffect, anything.
 *
 * @example
 * const q = useQuery({ queryKey: ["devices"], queryFn: api.devices });
 * <QueryState
 *   data={q.data?.items} isLoading={q.isLoading} isError={q.isError}
 *   error={q.error} onRetry={q.refetch}
 *   empty={<EmptyState title="No sensors yet" body="Add your first sensor." />}
 * >
 *   {(devices) => devices.map((d) => <SensorRow key={d.eui} device={d} />)}
 * </QueryState>
 */
export interface QueryStateProps<T> {
  /** The collection to render. Typically `query.data?.items`. */
  data: T[] | undefined;
  isLoading: boolean;
  isError?: boolean;
  error?: unknown;
  /** Rendered only when there is at least one item. */
  children: (items: T[]) => React.ReactNode;
  /** Custom loading UI. Defaults to skeleton rows. */
  loading?: React.ReactNode;
  /** Custom empty UI. Defaults to a neutral empty state. */
  empty?: React.ReactNode;
  /** Custom error UI. Receives the error and the retry handler if provided. */
  errorState?: (error: Error, retry?: () => void) => React.ReactNode;
  onRetry?: () => void;
  /** Override the emptiness test (e.g. paginated or grouped data). */
  isEmpty?: (items: T[]) => boolean;
  /** Number of skeleton rows in the default loading state. */
  skeletonRows?: number;
  className?: string;
}

export function QueryState<T>({
  data, isLoading, isError, error, children,
  loading, empty, errorState, onRetry, isEmpty, skeletonRows = 3, className,
}: QueryStateProps<T>) {
  // Error wins over a stale/empty cache so a failed refetch is never hidden.
  if (isError) {
    const e = error instanceof Error ? error : new Error("Something went wrong");
    return <>{errorState ? errorState(e, onRetry) : <DefaultError error={e} onRetry={onRetry} />}</>;
  }
  // Only show the skeleton on the *first* load (no data yet), not on background
  // refetches — otherwise the screen flickers on every poll.
  if (isLoading && !data) return <>{loading ?? <SkeletonList rows={skeletonRows} className={className} />}</>;

  const items = data ?? [];
  const blank = isEmpty ? isEmpty(items) : items.length === 0;
  if (blank) return <>{empty ?? <DefaultEmpty />}</>;

  return <>{children(items)}</>;
}

/* ── sensible defaults (override via props) ─────────────────────────────── */

export function SkeletonList({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={className ?? "space-y-2"} role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-lg bg-[var(--surface-muted)]"
          style={{ opacity: 1 - i * 0.12 }} />
      ))}
    </div>
  );
}

function DefaultEmpty() {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-[var(--border)] p-10 text-center">
      <p className="font-medium">Nothing here yet</p>
      <p className="mt-1 max-w-sm text-sm text-[var(--muted)]">When there's data to show, it'll appear here.</p>
    </div>
  );
}

function DefaultError({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div role="alert" className="grid place-items-center rounded-xl border border-red-500/25 bg-red-500/[0.04] p-10 text-center">
      <p className="font-medium text-red-700 dark:text-red-300">Couldn't load this</p>
      <p className="mt-1 max-w-sm text-sm text-[var(--muted)]">{error.message}</p>
      {onRetry && (
        <button onClick={onRetry}
          className="mt-4 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
          Try again
        </button>
      )}
    </div>
  );
}
