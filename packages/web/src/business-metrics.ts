/**
 * business-metrics.ts — Phase 19 P3-M1.
 *
 * Gathers a point-in-time business-metrics snapshot for `/metrics` from the
 * host-injected surfaces (workflow run store + identity ledger / suspended
 * tasks). Web keeps its zero-runtime-dep posture: the source interfaces here
 * are narrow duck types that `ctx.workflows` / `ctx.identity` satisfy
 * structurally, never imports of @aipehub/workflow or @aipehub/identity.
 *
 * Everything is best-effort. A source the host didn't wire, a method it
 * doesn't carry (older host), or a call that throws → that metric family is
 * simply omitted from the returned snapshot; the hub-derived metrics in
 * renderMetrics still render. The /metrics scrape must never 500 because a
 * counter couldn't be read.
 *
 * Collection is read-only: no new bookkeeping, no writes. The ledger numbers
 * come from the append-only usage_ledger (Phase 17); the suspended count from
 * a COUNT(*) (Phase 19 P3-M1); the run tally from an exact by-status count over
 * the active run set (Route B P0-M3-M3 — replaces the old fixed-cap sample).
 */

import { type BusinessMetrics } from './metrics.js'

/**
 * Narrow projection of `WorkflowSurface` — just the exact run counter. The scan
 * is O(active), which run retention (Route B P0-M3-M2) bounds to O(tail), so
 * the tally is exact rather than the old 2000-row sample.
 */
export interface MetricsWorkflowSource {
  countRuns(opts?: { workflowId?: string }): Promise<{ total: number; byStatus: Record<string, number> }>
}

/** Narrow projection of one `aggregateLedger` row (mirrors the ledger DTO). */
export interface MetricsLedgerRow {
  key: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costMicros: number
}

/** Narrow projection of `IdentityStore` — the two read methods we sample. */
export interface MetricsIdentitySource {
  countSuspendedTasks?(): number
  aggregateLedger?(query: {
    groupBy: 'model'
    since?: number
    until?: number
  }): MetricsLedgerRow[]
}

/** The canonical workflow run statuses — seeded so a gauge series always exists. */
const RUN_STATUSES = ['running', 'done', 'failed', 'cancelled'] as const

export async function collectBusinessMetrics(sources: {
  workflows?: MetricsWorkflowSource
  identity?: MetricsIdentitySource
}): Promise<BusinessMetrics> {
  const out: BusinessMetrics = {}

  // --- workflow runs by status (exact count over active set, best-effort) --
  const wf = sources.workflows
  if (wf && typeof wf.countRuns === 'function') {
    try {
      const { byStatus } = await wf.countRuns()
      const seeded: Record<string, number> = {}
      for (const s of RUN_STATUSES) seeded[s] = 0 // ensure all four series exist
      for (const [status, n] of Object.entries(byStatus)) seeded[status] = n
      out.workflowRuns = seeded
    } catch {
      // omit the family — a scan error must not fail the whole scrape
    }
  }

  // --- identity-backed gauges/counters (synchronous; better-sqlite3) -------
  const id = sources.identity
  if (id) {
    if (typeof id.countSuspendedTasks === 'function') {
      try {
        out.suspendedTasks = id.countSuspendedTasks()
      } catch {
        // omit
      }
    }
    if (typeof id.aggregateLedger === 'function') {
      try {
        const rows = id.aggregateLedger({ groupBy: 'model' })
        out.llmByModel = rows.map((r) => ({
          model: r.key,
          calls: r.calls,
          tokens:
            r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens,
          costMicros: r.costMicros,
        }))
      } catch {
        // omit
      }
    }
  }

  return out
}
