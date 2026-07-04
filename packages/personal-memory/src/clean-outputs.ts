/**
 * clean-outputs.ts — the "清输出" pass of the 6h maintenance heartbeat (MR4 ②).
 *
 * # What it cleans
 *
 * Scratch / tool-output `working` entries that have gone STALE. `working` is the
 * ephemeral kind (a turn's in-flight notes, a tool's raw dump) — useful for a few
 * turns, noise forever. This pass forgets `working` entries older than a TTL so
 * the namespace doesn't accumulate dead scratch over a long-lived butler's life.
 *
 * It is age-gated, not wholesale: a FRESH `working` entry is the live context the
 * next turn may still need, so only entries past `staleMs` are dropped. (Set
 * `staleMs: 0` to clear all of the target kinds outright — an explicit "wipe
 * scratch now" mode.)
 *
 * # Why it is its own reviewer (not folded into budget)
 *
 * The 6h maintenance pass composes BOTH `cleanOutputsReviewer` and
 * `budgetReviewer`. They do disjoint jobs: this one prunes EPHEMERAL scratch by
 * AGE regardless of pressure (housekeeping); the budget reviewer evicts the
 * least-valuable DURABLE memory only when over a byte ceiling (backstop). Keeping
 * them separate means clearing scratch never competes with the budget's
 * priority order, and a butler that hangs no `working` at all simply gets a no-op
 * here (the butler's in-flight state lives on the suspend, not in memory — see
 * `personal-butler-memory`), with the budget still doing its thing.
 *
 * No LLM: which scratch is stale is a pure age test, so this stays
 * framework-friendly (北极星: 框架不跑 LLM) and trivially deterministic.
 */

import type { MemoryEntry, MemoryHandle, MemoryKind } from '@gotong/services-sdk'

import type { MemoryReviewer, ReviewContext, ReviewOutcome } from './review.js'

/** The ephemeral kind cleaned by default — scratch / raw tool output. */
export const DEFAULT_CLEAN_KINDS: readonly MemoryKind[] = ['working']

/** Default staleness before scratch is pruned — one maintenance cadence (6h). */
export const DEFAULT_CLEAN_STALE_MS = 6 * 60 * 60 * 1000

/** How many entries per target kind a clean scan pulls (generous; scratch is small). */
export const CLEAN_SCAN_LIMIT = 10_000

export interface CleanOutputsOptions {
  /** The memory to tidy. */
  memory: MemoryHandle
  /** Clock for the staleness test (the reviewer wires `ctx.now`). */
  now: number
  /** Kinds treated as ephemeral output. Default {@link DEFAULT_CLEAN_KINDS} (`['working']`). */
  kinds?: readonly MemoryKind[]
  /**
   * Age (ms) past which a target entry is stale and pruned. Default
   * {@link DEFAULT_CLEAN_STALE_MS}. `0` prunes every target entry regardless of age
   * (explicit wipe-scratch mode). Negative is clamped to 0.
   */
  staleMs?: number
  /** Scope to one namespace (per-user no-leak) — only matched entries are touched. */
  filter?: (entry: MemoryEntry) => boolean
  /** Cap pruned per sweep (anti-runaway). Default unbounded. */
  max?: number
}

export interface CleanOutputsResult {
  /** How many stale outputs were forgotten. */
  readonly pruned: number
  /** How many target-kind entries were scanned. */
  readonly scanned: number
}

/**
 * Forget stale `working` (or other configured) entries. Pure age test + best-effort
 * `forget`; never touches `episodic` / `semantic` (the truth + the durable profile).
 * Returns counts; safe on any `MemoryHandle`.
 */
export async function cleanOutputs(opts: CleanOutputsOptions): Promise<CleanOutputsResult> {
  const kinds = opts.kinds && opts.kinds.length > 0 ? opts.kinds : DEFAULT_CLEAN_KINDS
  const staleMs = Math.max(0, Math.floor(opts.staleMs ?? DEFAULT_CLEAN_STALE_MS))
  const cutoff = opts.now - staleMs // entries with ts <= cutoff are stale
  const max = typeof opts.max === 'number' && opts.max >= 0 ? Math.floor(opts.max) : Infinity

  let scanned = 0
  let pruned = 0
  for (const kind of kinds) {
    const raw = await opts.memory.list({ kind, limit: CLEAN_SCAN_LIMIT })
    const scoped = opts.filter ? raw.filter((e) => opts.filter!(e)) : raw
    scanned += scoped.length
    // Oldest first so a `max` cap drops the stalest scratch, keeping the freshest.
    const stale = scoped.filter((e) => e.ts <= cutoff).sort((a, b) => a.ts - b.ts)
    for (const e of stale) {
      if (pruned >= max) break
      try {
        await opts.memory.forget(e.id)
        pruned++
      } catch {
        // already gone / racing forget — skip; it is no longer scratch we hold
      }
    }
  }
  return { pruned, scanned }
}

export type CleanOutputsReviewerOptions = Omit<CleanOutputsOptions, 'memory' | 'now'>

/**
 * Adapt {@link cleanOutputs} to a {@link MemoryReviewer} so the 6h maintenance
 * heartbeat tidies scratch each tick. Returns a one-line summary when something
 * was pruned, or `{}` (idle / `HEARTBEAT_OK`) when there was no stale output —
 * the common case for a butler that hangs no `working` kind.
 */
export function cleanOutputsReviewer(opts: CleanOutputsReviewerOptions = {}): MemoryReviewer {
  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    const r = await cleanOutputs({ ...opts, memory: ctx.memory, now: ctx.now })
    if (r.pruned === 0) return {}
    return { summary: `cleaned ${r.pruned} stale output${r.pruned === 1 ? '' : 's'}` }
  }
}
