/**
 * Route B P0-M3 (M3-M2) — boot-time workflow-run retention.
 *
 * The run archive (M3-M1) gave `RunStore` the *mechanism* to bound the active
 * scan; this is the operator-facing policy that drives it. At boot, before the
 * controller's resume scan walks the run history, the host moves old TERMINAL
 * runs into `runs/archive/` so this boot — and every boot after — scans only
 * the retained tail (O(tail)) instead of the full history (O(all)). The
 * archived runs are never lost: they stay on disk in `runs/archive/` and remain
 * reachable via `RunStore.readArchived` / `listArchivedRunIds` for audit.
 *
 * Retention is OFF by default: with no env set, `parseRunRetention` returns
 * undefined and the host skips archiving entirely, so a boot is byte-identical
 * to the pre-M3-M2 behaviour. A set-but-malformed value throws so the boot
 * fails loudly rather than silently keeping everything — matching the house
 * style for misconfigured env (pricing.json, transcript retention).
 *
 * # Why the host runs this, not the controller
 *
 * Archiving is pure filesystem work that doesn't depend on the Hub, WS, or
 * agents being up — and a `running` run (the only thing resume cares about) is
 * never archived (M3-M1 safety invariant), so pruning terminal runs strictly
 * shrinks what the later resume scan reads without changing what it resumes.
 * The host applies the policy through the controller's own `RunStore`, so the
 * resume scan that runs afterwards sees the post-archive layout.
 */

import type { ArchiveRunsOptions } from '@aipehub/workflow'

/** Keep this many of the newest TERMINAL runs on the active scan path. */
export const RUN_KEEP_ENV = 'AIPE_RUN_KEEP'
/** Archive terminal runs that ended more than this many days ago. */
export const RUN_ARCHIVE_DAYS_ENV = 'AIPE_RUN_ARCHIVE_DAYS'

const MS_PER_DAY = 86_400_000

/** Minimal env shape (a plain record); `process.env` satisfies it. */
export type RetentionEnv = Record<string, string | undefined>

/**
 * Parse the retention env into an {@link ArchiveRunsOptions}, or undefined when
 * no policy is configured. `now` (epoch ms) anchors the age cutoff for
 * archive-days. Throws on a set-but-malformed value so a typo'd retention
 * config fails the boot instead of silently doing nothing.
 *
 * Both knobs may be combined: a run is archived only when it is BOTH
 * unprotected (by keepLast) AND ended before the cutoff.
 */
export function parseRunRetention(env: RetentionEnv, now: number): ArchiveRunsOptions | undefined {
  const policy: ArchiveRunsOptions = {}
  let configured = false

  const keepRaw = env[RUN_KEEP_ENV]
  if (keepRaw !== undefined && keepRaw !== '') {
    const n = Number(keepRaw)
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`${RUN_KEEP_ENV} must be a non-negative integer; got '${keepRaw}'`)
    }
    policy.keepLast = n
    configured = true
  }

  const daysRaw = env[RUN_ARCHIVE_DAYS_ENV]
  if (daysRaw !== undefined && daysRaw !== '') {
    const d = Number(daysRaw)
    if (!Number.isFinite(d) || d <= 0) {
      throw new Error(`${RUN_ARCHIVE_DAYS_ENV} must be a positive number of days; got '${daysRaw}'`)
    }
    policy.before = now - d * MS_PER_DAY
    configured = true
  }

  return configured ? policy : undefined
}

/** A store that can archive runs — `RunStore` satisfies this structurally. */
export interface RunRetentionStore {
  archiveRuns(opts: ArchiveRunsOptions): Promise<string[]>
}

export interface ApplyRunRetentionResult {
  /** Run ids moved into `runs/archive/` this run (possibly empty). */
  archived: string[]
}

/**
 * Apply a retention policy to a run store. Thin wrapper over `archiveRuns` so
 * the caller can log / count what moved. The caller owns the best-effort error
 * handling — archiving must never block boot.
 */
export async function applyRunRetention(
  store: RunRetentionStore,
  policy: ArchiveRunsOptions,
): Promise<ApplyRunRetentionResult> {
  const archived = await store.archiveRuns(policy)
  return { archived }
}
