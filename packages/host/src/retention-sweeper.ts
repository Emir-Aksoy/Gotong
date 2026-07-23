/**
 * Perf audit A⑤ — run-time periodic retention.
 *
 * All three retention families (transcript segments, workflow runs, identity
 * tables) were boot-time only: a long-lived host — the design goal is exactly
 * a host that ISN'T restarted — never re-applied its configured policies, so
 * disk kept growing despite the knobs being set. This sweeper re-applies the
 * SAME policies on a fixed cadence.
 *
 * Boundaries (unchanged from the boot path):
 *   - OFF by default. No retention env configured ⇒ `arm()` returns null and
 *     no timer exists — byte-identical to today. The sweep is not a new knob:
 *     the operator already opted in by setting the retention env; "older than
 *     N days" plainly means continuously, not only at boot.
 *   - Archive, not delete, for transcript + runs (bytes move to `archive/`,
 *     reachable via loadAll / readArchived). Identity prunes ARE deletes —
 *     same as boot, same tables, same half-open cutoff.
 *   - Best-effort everywhere: a failing family logs and never blocks the
 *     others or the process. Cutoffs are re-anchored to `now()` every tick
 *     (reusing the boot-parsed policy would freeze `before` at boot time).
 *
 * Run-time safety (why re-applying while the hub is live is sound):
 *   - Transcript: the sweep constructs a THROWAWAY FileStorage over the same
 *     path (exactly what boot does). `archiveSegments` moves only SEALED
 *     segments — never the active file the live storage appends to — and
 *     `flushHighWaterSeq` recomputes from the FULL on-disk history first, so
 *     the checkpoint always dominates every archived seq. The live Hub's
 *     in-memory transcript is untouched (tasks() replay / state snapshot keep
 *     working); what shrinks is the NEXT boot's load path.
 *   - Runs: `archiveRuns` never touches a `running` run (RunStore invariant)
 *     and `RunStore` scans the directory per call, so moved terminal runs
 *     simply stop appearing in the active list (still readable via
 *     readArchived) — the same effect boot archiving already has.
 *   - Identity: synchronous SQL DELETEs on the in-process connection.
 */

import type { FileStorage, Logger } from '@gotong/core'

import {
  applyRetentionPolicies,
  parseRetentionPolicies,
  type RetentionEnv,
  type RetentionStore,
} from './retention.js'
import { applyRunRetention, parseRunRetention, type RunRetentionStore } from './run-retention.js'
import { applyTranscriptRetention, parseTranscriptRetention } from './transcript-retention.js'

/** Fixed cadence — the house 6h maintenance rhythm; policies are day-grained. */
export const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface RetentionSweeperOptions {
  /** Usually `process.env`; read fresh every tick. */
  env: RetentionEnv
  /** Throwaway-storage factory over the live transcript path (`space.storage`). */
  storage: () => Pick<FileStorage, 'archiveSegments'>
  /** The workflow controller (satisfies `RunRetentionStore` structurally). */
  runs: RunRetentionStore
  /** Identity store, or null on a degraded (no-identity) host. */
  identity: RetentionStore | null
  log: Logger
  /** Injectable clock (tests). */
  now?: () => number
  /** Injectable cadence (tests only — NOT an operator knob). */
  intervalMs?: number
}

export interface RetentionSweepResult {
  archivedSegments: number
  archivedRuns: number
  prunedRows: number
}

/** True when any of the three retention families is configured in `env`. */
export function retentionConfigured(env: RetentionEnv, now: number): boolean {
  // Boot already ran these parses and failed loudly on malformed values, so by
  // arm time they can only return a policy or undefined/empty.
  return (
    parseTranscriptRetention(env, now) !== undefined ||
    parseRunRetention(env, now) !== undefined ||
    parseRetentionPolicies(env, now).length > 0
  )
}

/**
 * One sweep: re-parse each family against a fresh `now` and re-apply. Each
 * family is independently best-effort; the summary is for logs/tests.
 */
export async function retentionSweepOnce(
  opts: RetentionSweeperOptions,
): Promise<RetentionSweepResult> {
  const now = (opts.now ?? Date.now)()
  const result: RetentionSweepResult = { archivedSegments: 0, archivedRuns: 0, prunedRows: 0 }

  try {
    const policy = parseTranscriptRetention(opts.env, now)
    if (policy) {
      const { moved } = await applyTranscriptRetention(opts.storage(), policy)
      result.archivedSegments = moved.length
      if (moved.length > 0) {
        opts.log.info('transcript retention applied (runtime sweep)', { archived: moved.length })
      }
    }
  } catch (err) {
    opts.log.warn('runtime transcript retention failed — keeping segments', { err })
  }

  try {
    const policy = parseRunRetention(opts.env, now)
    if (policy) {
      const { archived } = await applyRunRetention(opts.runs, policy)
      result.archivedRuns = archived.length
      if (archived.length > 0) {
        opts.log.info('workflow run retention applied (runtime sweep)', {
          archived: archived.length,
        })
      }
    }
  } catch (err) {
    opts.log.warn('runtime run retention failed — keeping run history', { err })
  }

  try {
    const policies = parseRetentionPolicies(opts.env, now)
    if (policies.length > 0 && opts.identity) {
      for (const r of applyRetentionPolicies(opts.identity, policies)) {
        if (r.error !== undefined) {
          opts.log.warn('runtime retention failed — keeping the full table', {
            table: r.table,
            err: r.error,
          })
        } else {
          result.prunedRows += r.pruned ?? 0
          if ((r.pruned ?? 0) > 0) {
            opts.log.info('retention applied (runtime sweep)', { table: r.table, pruned: r.pruned })
          }
        }
      }
    }
  } catch (err) {
    opts.log.warn('runtime identity retention failed', { err })
  }

  return result
}

export interface RetentionSweeperHandle {
  stop(): void
}

/**
 * Arm the periodic sweep, or return null when no retention env is configured
 * (zero timers — byte-identical to the pre-A⑤ host). First tick fires one
 * interval in: boot just applied the same policies synchronously, so an
 * immediate tick would be a no-op re-scan.
 */
export function armRetentionSweeper(opts: RetentionSweeperOptions): RetentionSweeperHandle | null {
  const now = (opts.now ?? Date.now)()
  if (!retentionConfigured(opts.env, now)) return null

  let running = false
  const timer = setInterval(() => {
    if (running) return // a slow archive pass must never overlap itself
    running = true
    void retentionSweepOnce(opts)
      .catch((err) => opts.log.warn('retention sweep tick failed', { err }))
      .finally(() => {
        running = false
      })
  }, opts.intervalMs ?? RETENTION_SWEEP_INTERVAL_MS)
  timer.unref?.()

  return {
    stop() {
      clearInterval(timer)
    },
  }
}
