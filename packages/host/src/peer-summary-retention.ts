/**
 * v5 Stream F — boot-time control-plane snapshot retention.
 *
 * The `peer_summary_snapshots` table (identity SQLite) is append-only — one
 * counts-only row per `peer.summary` refresh — and grows without bound. F-M1
 * gave the store the mechanism (`prunePeerSummarySnapshots({before})`, a
 * `DELETE … WHERE captured_at < ?`); this is the operator-facing policy that
 * drives it. At boot the host deletes snapshots older than
 * AIPE_PEER_SUMMARY_KEEP_DAYS so the trend history stays a bounded working set.
 *
 * Mirrors `ledger-retention.ts` exactly (same env shape, same throw-on-malformed
 * house style). OFF by default: no env ⇒ `parsePeerSummaryRetention` returns
 * undefined and the host prunes nothing, so a boot keeps full history. A
 * set-but-malformed value throws so a typo fails the boot loudly.
 */

import type { RetentionEnv } from './ledger-retention.js'

/** Delete control-plane snapshots older than this many days. */
export const PEER_SUMMARY_KEEP_DAYS_ENV = 'AIPE_PEER_SUMMARY_KEEP_DAYS'

const MS_PER_DAY = 86_400_000

export interface PeerSummaryRetentionPolicy {
  /**
   * Epoch-ms cutoff: snapshots with `captured_at` strictly before this are
   * pruned. Half-open — a row exactly at the cutoff is kept (matches
   * `PeerSummarySnapshotStore.prune`).
   */
  before: number
}

/**
 * Parse the retention env into a {@link PeerSummaryRetentionPolicy}, or
 * undefined when no policy is configured. `now` (epoch ms) anchors the age
 * cutoff. Throws on a set-but-malformed value.
 */
export function parsePeerSummaryRetention(
  env: RetentionEnv,
  now: number,
): PeerSummaryRetentionPolicy | undefined {
  const daysRaw = env[PEER_SUMMARY_KEEP_DAYS_ENV]
  if (daysRaw === undefined || daysRaw === '') return undefined
  const d = Number(daysRaw)
  if (!Number.isFinite(d) || d <= 0) {
    throw new Error(
      `${PEER_SUMMARY_KEEP_DAYS_ENV} must be a positive number of days; got '${daysRaw}'`,
    )
  }
  return { before: now - d * MS_PER_DAY }
}

/** A store that can prune snapshots — `IdentityStore` satisfies this. */
export interface PeerSummaryRetentionStore {
  prunePeerSummarySnapshots(opts: { before: number }): number
}

export interface ApplyPeerSummaryRetentionResult {
  /** Number of snapshot rows deleted this boot (possibly zero). */
  pruned: number
}

/**
 * Apply a retention policy to a snapshot store. Thin wrapper over
 * `prunePeerSummarySnapshots`; the caller owns the best-effort error handling
 * (pruning must never block boot).
 */
export function applyPeerSummaryRetention(
  store: PeerSummaryRetentionStore,
  policy: PeerSummaryRetentionPolicy,
): ApplyPeerSummaryRetentionResult {
  const pruned = store.prunePeerSummarySnapshots({ before: policy.before })
  return { pruned }
}
