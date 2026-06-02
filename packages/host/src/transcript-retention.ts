/**
 * Route B P0-M2 (M3b) — boot-time transcript retention.
 *
 * Segmentation (M2a) + archive (M2b) gave `FileStorage` the *mechanism* to
 * bound the boot load; this is the operator-facing policy that drives it.
 * Before the Hub constructs its FileStorage and loads the transcript, the host
 * moves old sealed segments into `archive/` so this boot — and every boot after
 * — loads only the retained tail (O(tail)) instead of the full history
 * (O(all)). The archived bytes are never lost: they stay on disk in `archive/`
 * and remain reachable via `FileStorage.loadAll()` for audit / export.
 *
 * Retention is OFF by default: with no env set, `parseTranscriptRetention`
 * returns undefined and the host skips archiving entirely, so a boot is
 * byte-identical to the pre-M3b behaviour. A set-but-malformed value throws so
 * the boot fails loudly rather than silently keeping everything — matching the
 * house style for misconfigured env (pricing.json, boot-security).
 *
 * # Ordering (why the host runs this, not the Hub)
 *
 * This MUST run before `new Hub({space})`: the Hub's FileStorage caches its
 * high-water seq at construction (M3a), so the checkpoint that archiving writes
 * has to already be on disk when the Hub reads it. The host applies the policy
 * to a throwaway FileStorage over the same path; archiving is a filesystem
 * move, so the Hub's own FileStorage sees the post-archive layout (and the
 * persisted high-water seq) when it loads.
 */

import type { ArchiveOptions, FileStorage } from '@aipehub/core'

/** Keep this many of the newest sealed segments in the active load path. */
export const TRANSCRIPT_KEEP_SEGMENTS_ENV = 'AIPE_TRANSCRIPT_KEEP_SEGMENTS'
/** Archive sealed segments whose newest entry is older than this many days. */
export const TRANSCRIPT_ARCHIVE_DAYS_ENV = 'AIPE_TRANSCRIPT_ARCHIVE_DAYS'

const MS_PER_DAY = 86_400_000

/** Minimal env shape (a plain record); `process.env` satisfies it. */
export type RetentionEnv = Record<string, string | undefined>

/**
 * Parse the retention env into an {@link ArchiveOptions}, or undefined when no
 * policy is configured. `now` (epoch ms) anchors the age cutoff for
 * archive-days. Throws on a set-but-malformed value so a typo'd retention
 * config fails the boot instead of silently doing nothing.
 *
 * Both knobs may be combined: `archiveSegments` archives a segment only when it
 * is both unprotected (by keepLast) AND fully older than the cutoff.
 */
export function parseTranscriptRetention(
  env: RetentionEnv,
  now: number,
): ArchiveOptions | undefined {
  const policy: ArchiveOptions = {}
  let configured = false

  const keepRaw = env[TRANSCRIPT_KEEP_SEGMENTS_ENV]
  if (keepRaw !== undefined && keepRaw !== '') {
    const n = Number(keepRaw)
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `${TRANSCRIPT_KEEP_SEGMENTS_ENV} must be a non-negative integer; got '${keepRaw}'`,
      )
    }
    policy.keepLast = n
    configured = true
  }

  const daysRaw = env[TRANSCRIPT_ARCHIVE_DAYS_ENV]
  if (daysRaw !== undefined && daysRaw !== '') {
    const d = Number(daysRaw)
    if (!Number.isFinite(d) || d <= 0) {
      throw new Error(
        `${TRANSCRIPT_ARCHIVE_DAYS_ENV} must be a positive number of days; got '${daysRaw}'`,
      )
    }
    policy.before = now - d * MS_PER_DAY
    configured = true
  }

  return configured ? policy : undefined
}

export interface ApplyRetentionResult {
  /** Segment filenames moved into `archive/` this run (possibly empty). */
  moved: string[]
}

/**
 * Apply a retention policy to a transcript FileStorage. Thin wrapper over
 * `archiveSegments` so the caller can log / count what moved. The caller owns
 * the best-effort error handling — archiving must never block boot.
 */
export async function applyTranscriptRetention(
  storage: Pick<FileStorage, 'archiveSegments'>,
  policy: ArchiveOptions,
): Promise<ApplyRetentionResult> {
  const moved = await storage.archiveSegments(policy)
  return { moved }
}
