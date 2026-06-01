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
 * a COUNT(*) (Phase 19 P3-M1); the run tally from a capped run-file scan.
 */

import { type BusinessMetrics } from './metrics.js'

/** Narrow projection of a run summary — only the status axis is needed here. */
export interface MetricsRunSummary {
  status: string
}

/** Narrow projection of `WorkflowSurface` — just the run lister. */
export interface MetricsWorkflowSource {
  listRuns(opts?: { workflowId?: string; limit?: number }): Promise<MetricsRunSummary[]>
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

/**
 * Bound the per-scrape run-file walk. `listRuns` reads every matching run file;
 * a host with 100k+ run records would make /metrics slow. We cap the scan and
 * flag `workflowRunsCapped` so a dashboard knows the tally became a sample.
 */
export const RUN_SCAN_CAP = 2000

/** The canonical workflow run statuses — seeded so a gauge series always exists. */
const RUN_STATUSES = ['running', 'done', 'failed', 'cancelled'] as const

export async function collectBusinessMetrics(sources: {
  workflows?: MetricsWorkflowSource
  identity?: MetricsIdentitySource
}): Promise<BusinessMetrics> {
  const out: BusinessMetrics = {}

  // --- workflow runs by status (capped scan, best-effort) ------------------
  const wf = sources.workflows
  if (wf && typeof wf.listRuns === 'function') {
    try {
      const runs = await wf.listRuns({ limit: RUN_SCAN_CAP })
      const byStatus: Record<string, number> = {}
      for (const s of RUN_STATUSES) byStatus[s] = 0 // seed zeros
      for (const r of runs) {
        byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
      }
      out.workflowRuns = byStatus
      out.workflowRunsCapped = runs.length >= RUN_SCAN_CAP
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
