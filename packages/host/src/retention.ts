/**
 * Boot-time retention for the identity store's append-only tables.
 *
 * Four tables grow one row per event forever (usage_ledger per LLM call,
 * audit_log per audited action, peer_summary_snapshots per control-plane
 * refresh, peer_summary_alert_firings per breach). Each store already owns
 * its prune mechanism (`DELETE … WHERE <ts> < cutoff`, half-open — a row
 * exactly at the cutoff is kept; firings additionally never prune OPEN rows);
 * this module is the single operator-facing policy that drives all of them,
 * replacing the per-table copies that grew one module at a time
 * (ledger-retention.ts, peer-summary-retention.ts).
 *
 * Retention is OFF by default, per table: with no env set the host prunes
 * nothing and a boot is byte-identical to before. A set-but-malformed value
 * throws so a typo'd config fails the boot loudly rather than silently
 * keeping everything — the house style for misconfigured env (pricing.json,
 * run/transcript retention). The retained window of every table stays fully
 * exportable via the Phase 17 CSV/JSONL routes, so pruning never costs the
 * audit you kept; operators who need a longer trail set a longer window or
 * stream exports out.
 */

/** Minimal env shape (a plain record); `process.env` satisfies it. */
export type RetentionEnv = Record<string, string | undefined>

const MS_PER_DAY = 86_400_000

/**
 * The prunable surface of `IdentityStore`. Each method deletes rows strictly
 * older than `before` and returns the count removed.
 */
export interface RetentionStore {
  pruneLedger(opts: { before: number }): number
  pruneAuditLog(opts: { before: number }): number
  prunePeerSummarySnapshots(opts: { before: number }): number
  prunePeerSummaryAlertFirings(opts: { before: number }): number
}

export interface RetentionTableSpec {
  /** Operator knob: keep rows newer than this many days. */
  env: string
  /** Table name, for logs. */
  table: string
  prune(store: RetentionStore, before: number): number
}

export const RETENTION_TABLES: readonly RetentionTableSpec[] = [
  {
    env: 'AIPE_LEDGER_KEEP_DAYS',
    table: 'usage_ledger',
    prune: (s, before) => s.pruneLedger({ before }),
  },
  {
    env: 'AIPE_AUDIT_KEEP_DAYS',
    table: 'audit_log',
    prune: (s, before) => s.pruneAuditLog({ before }),
  },
  {
    env: 'AIPE_PEER_SUMMARY_KEEP_DAYS',
    table: 'peer_summary_snapshots',
    prune: (s, before) => s.prunePeerSummarySnapshots({ before }),
  },
  {
    env: 'AIPE_ALERT_FIRINGS_KEEP_DAYS',
    table: 'peer_summary_alert_firings',
    prune: (s, before) => s.prunePeerSummaryAlertFirings({ before }),
  },
]

export interface RetentionPolicy {
  spec: RetentionTableSpec
  /**
   * Epoch-ms cutoff: rows strictly older than this are pruned. Half-open —
   * a row exactly at the cutoff is kept (matches every store prune).
   */
  before: number
}

/**
 * Parse the retention env into per-table policies (empty array = nothing
 * configured). `now` (epoch ms) anchors the age cutoffs. Throws on any
 * set-but-malformed value so the boot fails loudly.
 */
export function parseRetentionPolicies(env: RetentionEnv, now: number): RetentionPolicy[] {
  const policies: RetentionPolicy[] = []
  for (const spec of RETENTION_TABLES) {
    const raw = env[spec.env]
    if (raw === undefined || raw === '') continue
    const d = Number(raw)
    if (!Number.isFinite(d) || d <= 0) {
      throw new Error(`${spec.env} must be a positive number of days; got '${raw}'`)
    }
    policies.push({ spec, before: now - d * MS_PER_DAY })
  }
  return policies
}

export interface RetentionResult {
  table: string
  before: number
  /** Rows deleted; absent when the prune itself failed. */
  pruned?: number
  /** Per-table failure — pruning is best-effort and must never block boot. */
  error?: unknown
}

/**
 * Apply parsed policies to the store, one table at a time. A failing table
 * never blocks the others (or the boot) — the caller logs each result.
 */
export function applyRetentionPolicies(
  store: RetentionStore,
  policies: RetentionPolicy[],
): RetentionResult[] {
  return policies.map(({ spec, before }) => {
    try {
      return { table: spec.table, before, pruned: spec.prune(store, before) }
    } catch (error) {
      return { table: spec.table, before, error }
    }
  })
}
