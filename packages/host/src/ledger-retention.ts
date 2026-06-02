/**
 * Route B P0-M3 (M3-M4) — boot-time usage-ledger retention.
 *
 * The usage ledger (`usage_ledger`, identity SQLite) is append-only — one row
 * per LLM call — and grows without bound. M3-M4a gave the store the *mechanism*
 * (`pruneLedger({before})`, a `DELETE … WHERE ts < ?`); this is the
 * operator-facing policy that drives it. At boot the host deletes ledger rows
 * older than AIPE_LEDGER_KEEP_DAYS so the billing table stays a bounded working
 * set instead of an ever-growing one.
 *
 * Two boundaries make this safe to delete (rather than cold-archive):
 *   - The RETAINED window stays fully exportable via the Phase 17 CSV/JSONL
 *     routes + the admin 用量 dashboard, so operators who need a longer audit
 *     trail set a longer keep window (or stream exports out) — the ledger is a
 *     working set, not the system of record.
 *   - `audit_log` is a SEPARATE table that this never touches. Security/identity
 *     forensics live there and keep their own (uncapped) retention.
 *
 * Retention is OFF by default: with no env set, `parseLedgerRetention` returns
 * undefined and the host prunes nothing, so a boot is byte-identical to the
 * pre-M3-M4 behaviour. A set-but-malformed value throws so the boot fails
 * loudly rather than silently keeping everything — matching the house style for
 * misconfigured env (pricing.json, run/transcript retention).
 */

/** Delete usage-ledger rows older than this many days. */
export const LEDGER_KEEP_DAYS_ENV = 'AIPE_LEDGER_KEEP_DAYS'

const MS_PER_DAY = 86_400_000

/** Minimal env shape (a plain record); `process.env` satisfies it. */
export type RetentionEnv = Record<string, string | undefined>

export interface LedgerRetentionPolicy {
  /**
   * Epoch-ms cutoff: ledger rows with `ts` strictly before this are pruned.
   * Half-open — a row exactly at the cutoff is kept (matches
   * `LedgerStore.prune`).
   */
  before: number
}

/**
 * Parse the retention env into a {@link LedgerRetentionPolicy}, or undefined
 * when no policy is configured. `now` (epoch ms) anchors the age cutoff. Throws
 * on a set-but-malformed value so a typo'd retention config fails the boot
 * instead of silently doing nothing.
 */
export function parseLedgerRetention(
  env: RetentionEnv,
  now: number,
): LedgerRetentionPolicy | undefined {
  const daysRaw = env[LEDGER_KEEP_DAYS_ENV]
  if (daysRaw === undefined || daysRaw === '') return undefined
  const d = Number(daysRaw)
  if (!Number.isFinite(d) || d <= 0) {
    throw new Error(`${LEDGER_KEEP_DAYS_ENV} must be a positive number of days; got '${daysRaw}'`)
  }
  return { before: now - d * MS_PER_DAY }
}

/** A store that can prune the ledger — `IdentityStore` satisfies this. */
export interface LedgerRetentionStore {
  pruneLedger(opts: { before: number }): number
}

export interface ApplyLedgerRetentionResult {
  /** Number of ledger rows deleted this boot (possibly zero). */
  pruned: number
}

/**
 * Apply a retention policy to a ledger store. Thin wrapper over `pruneLedger`
 * so the caller can log how many rows moved. The caller owns the best-effort
 * error handling — pruning must never block boot.
 */
export function applyLedgerRetention(
  store: LedgerRetentionStore,
  policy: LedgerRetentionPolicy,
): ApplyLedgerRetentionResult {
  const pruned = store.pruneLedger({ before: policy.before })
  return { pruned }
}
