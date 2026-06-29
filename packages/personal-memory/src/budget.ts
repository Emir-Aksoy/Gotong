/**
 * budget.ts — disk-budget auto-management (decision B / 用户 Q2「按设置的可用
 * 文件夹大小自动管理记忆文件大小」).
 *
 * # Why this exists
 *
 * `consolidate` / `consolidateTiered` bound growth PER LAYER (per-profile and
 * per-digest hard caps + episodic byte/entry triggers). Nothing keeps the WHOLE
 * namespace under a single configured ceiling, so a long-lived butler's memory
 * can still creep up over months. MemGPT / Letta page memory in and out against
 * a fixed budget; this module is the deterministic **eviction** half of that:
 * given a byte budget, when the namespace is over it, drop the least valuable
 * entries until it fits.
 *
 * # Two-stage (the reviewer composes them)
 *
 * The heartbeat first runs consolidation (an LLM pass that compresses
 * episodic → digest → profile and reclaims space NON-destructively), THEN
 * `enforceBudget` as the hard, deterministic backstop. The eviction DECISION
 * needs no LLM — it is a pure priority over (level, importance, recency) — so
 * this stays framework-friendly (北极星: 框架不跑 LLM) and trivially testable.
 *
 * # Eviction priority (evicted FIRST → LAST)
 *
 *   [expired history]  →  episodic (raw)  →  ad-hoc semantic  →  digest  →  profile
 *
 * within one rank: lowest importance first, then oldest first. The most recent
 * N episodic entries (the live working context the next turn needs) are
 * PROTECTED from eviction — they go last, only if the budget is so tight that
 * nothing else is left.
 *
 * The leading `[expired history]` band is opt-in (decision D, D-M3): with
 * `evictExpiredFirst` set, entries whose validity interval already closed in the
 * past (a `validTo <= now` — dead history a bitemporal supersession left behind)
 * are evicted BEFORE anything live, since they no longer hold. Off by default →
 * byte-identical to the four-rank order above.
 *
 * # Backend-agnostic
 *
 * Usage is measured from the entries themselves by default (UTF-8 bytes of
 * `text` + `meta`), so it works on ANY `MemoryHandle`. The host — which knows
 * the on-disk path — can inject a real folder-`du` `measure` so the budget
 * tracks actual disk size (jsonl overhead included), without this leaf module
 * touching the filesystem.
 */

import type { MemoryEntry, MemoryHandle } from '@aipehub/services-sdk'

import { isExpired } from './bitemporal.js'
import type { MemoryReviewer, ReviewContext, ReviewOutcome } from './review.js'
import { effectiveSalience, type SalienceOptions } from './salience.js'
import { DEFAULT_TIERS, isClusterProfile, isDigest, type TierConfig } from './tiers.js'

/** How many entries a budget scan pulls. Generous — a consolidated butler holds
 *  far fewer; an over-this namespace is itself the problem the budget bounds. */
export const BUDGET_SCAN_LIMIT = 10_000

/** Recent episodic entries never evicted (the live working context). */
export const DEFAULT_PROTECT_RECENT_EPISODIC = 8

/** Measure current namespace usage from the (already-scoped) entries. */
export type MemoryUsageMeasure = (entries: readonly MemoryEntry[]) => number | Promise<number>

export interface EnforceBudgetOptions {
  /** The memory to bound. */
  memory: MemoryHandle
  /** Hard ceiling in bytes for this namespace. At/under it nothing happens. */
  budgetBytes: number
  /**
   * Scope every read/evict to one namespace (per-user no-leak). Only entries
   * the predicate accepts are counted or evicted — another user's memory is
   * never touched.
   */
  filter?: (entry: MemoryEntry) => boolean
  /** Cluster catalog (to read level). Default {@link DEFAULT_TIERS}. */
  config?: TierConfig
  /**
   * How to measure usage. Default = sum of UTF-8 bytes of each entry's `text` +
   * `meta`. The host can inject a real folder `du` so the budget tracks actual
   * on-disk size.
   */
  measure?: MemoryUsageMeasure
  /**
   * Don't evict the most recent N episodic entries even under pressure — they
   * are what the next turn needs. Default {@link DEFAULT_PROTECT_RECENT_EPISODIC}.
   */
  protectRecentEpisodic?: number
  /**
   * Decay / reinforcement for eviction keep-value (decision F). Omit → within a
   * level entries are evicted by plain importance-then-recency (byte-identical to
   * pre-F). With it set (and `now` provided) a faded low-importance entry is
   * evicted before a reinforced or fresher one of the same level. See
   * {@link effectiveSalience}.
   */
  salience?: SalienceOptions
  /**
   * Opt-in (decision D, D-M3): evict EXPIRED entries first — those whose
   * bitemporal interval already closed in the past (`validTo <= now`), i.e. dead
   * history a supersession left behind. They drop before any live entry of any
   * level. Requires {@link now}; without it this is a no-op. Off by default →
   * byte-identical eviction order to pre-D (a not-yet-valid future fact is NOT
   * expired and is never preferentially evicted).
   */
  evictExpiredFirst?: boolean
  /**
   * Clock injection. Used when {@link salience} (to age entries) or
   * {@link evictExpiredFirst} (to test expiry) is set; the reviewer wires
   * `() => ctx.now` so the heartbeat's clock drives both.
   */
  now?: () => number
}

export interface EnforceBudgetResult {
  /** Measured usage before eviction. */
  readonly startBytes: number
  /** Measured usage after eviction. */
  readonly finalBytes: number
  /** Configured ceiling. */
  readonly budgetBytes: number
  /** How many entries were evicted. */
  readonly evicted: number
  /** Approximate bytes reclaimed (sum of evicted entries' own bytes). */
  readonly evictedBytes: number
  /** True if STILL over budget after evicting everything eligible (budget is
   *  smaller than the protected/irreducible remainder — an operator should see
   *  this). */
  readonly stillOverBudget: boolean
}

/**
 * Enforce the byte budget by deterministic eviction. Returns `null` when usage
 * is already at/under budget (nothing to do). Never evicts the most recent
 * `protectRecentEpisodic` episodic entries unless they are literally all that
 * is left and still over budget.
 *
 * No LLM, no summarizer — pure priority eviction. Pair with a consolidation
 * pass (run it FIRST, non-destructive) via {@link budgetReviewer} or the
 * tiered reviewer's `budgetBytes` option.
 */
export async function enforceBudget(
  opts: EnforceBudgetOptions,
): Promise<EnforceBudgetResult | null> {
  const config = opts.config ?? DEFAULT_TIERS
  const budget = Math.max(0, Math.floor(opts.budgetBytes))
  const measure = opts.measure ?? defaultMeasure
  const protectRecent = clampNonNeg(opts.protectRecentEpisodic, DEFAULT_PROTECT_RECENT_EPISODIC)

  const raw = await opts.memory.list({ limit: BUDGET_SCAN_LIMIT })
  const scoped = opts.filter ? raw.filter((e) => opts.filter!(e)) : raw

  const startBytes = await measure(scoped)
  if (startBytes <= budget) return null

  // Protect the freshest episodic — the live context. They sort to the very end
  // of the eviction order anyway; pinning them by id makes that explicit so a
  // custom `measure` or a tie can't accidentally reorder them in.
  const protectedIds = new Set(
    scoped
      .filter((e) => e.kind === 'episodic')
      .sort((a, b) => b.ts - a.ts)
      .slice(0, protectRecent)
      .map((e) => e.id),
  )

  // Eviction order: lowest keep-value first.
  //   [expired band (opt-in)] → level rank (episodic 0 → ad-hoc semantic 1 →
  //   digest 2 → profile 3) → lowest salience → oldest.
  // `effectiveSalience` with no `salience` option IS importance (an integer), so
  // this is byte-identical to the pre-F "importance then recency" ordering until
  // a host opts decay/reinforcement in. The expired band needs `now`; without it
  // (or with the flag off) `expiredRank` is constant → ordering unchanged.
  const nowMs = opts.now?.()
  const evictExpiredFirst = opts.evictExpiredFirst === true && nowMs !== undefined
  const expiredRank = (e: MemoryEntry): number =>
    evictExpiredFirst && isExpired(e, nowMs!) ? 0 : 1
  const salienceOf = (e: MemoryEntry): number => effectiveSalience(e, nowMs, opts.salience)
  const candidates = scoped
    .filter((e) => !protectedIds.has(e.id))
    .sort((a, b) => {
      const x = expiredRank(a) - expiredRank(b)
      if (x !== 0) return x
      const r = levelRank(a, config) - levelRank(b, config)
      if (r !== 0) return r
      const s = salienceOf(a) - salienceOf(b)
      if (s !== 0) return s
      return a.ts - b.ts
    })

  // Track usage by subtracting each evicted entry's own bytes. Exact for the
  // default measure; a close proxy for an injected `du` (we re-measure the
  // truth once at the end for `finalBytes` / `stillOverBudget`).
  let running = startBytes
  let evicted = 0
  let evictedBytes = 0
  const evictedIds = new Set<string>()
  for (const e of candidates) {
    if (running <= budget) break
    try {
      await opts.memory.forget(e.id)
    } catch {
      // straggler (already gone) — skip; it no longer counts against the budget
      continue
    }
    const b = entryBytes(e)
    running -= b
    evictedBytes += b
    evicted++
    evictedIds.add(e.id)
  }

  const remaining = scoped.filter((e) => !evictedIds.has(e.id))
  const finalBytes = await measure(remaining)

  return {
    startBytes,
    finalBytes,
    budgetBytes: budget,
    evicted,
    evictedBytes,
    stillOverBudget: finalBytes > budget,
  }
}

/**
 * Adapt {@link enforceBudget} to a {@link MemoryReviewer} so the heartbeat
 * (Stream D) enforces the budget on each tick. Returns a one-line summary when
 * something was evicted, or `{}` (idle / `HEARTBEAT_OK`) otherwise. Wire it
 * AFTER a consolidation reviewer so compaction reclaims space first and eviction
 * is the backstop — or use the tiered reviewer's `budgetBytes` option which does
 * both in one pass.
 */
export function budgetReviewer(
  opts: Omit<EnforceBudgetOptions, 'memory' | 'now'>,
): MemoryReviewer {
  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    const r = await enforceBudget({ ...opts, memory: ctx.memory, now: () => ctx.now })
    if (!r || r.evicted === 0) return {}
    return {
      summary: `budget: evicted ${r.evicted} ${r.evicted === 1 ? 'entry' : 'entries'} (${
        r.evictedBytes
      } bytes)${r.stillOverBudget ? ' — STILL over budget' : ''}`,
    }
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Keep-value rank: lower = evicted first. */
function levelRank(e: MemoryEntry, _config: TierConfig): number {
  if (e.kind === 'episodic') return 0
  if (isClusterProfile(e) || isFlatProfile(e)) return 3
  if (isDigest(e)) return 2
  return 1 // ad-hoc semantic fact (model `remember`'d, no tier/level)
}

function isFlatProfile(e: MemoryEntry): boolean {
  return (e.meta as { profile?: unknown } | undefined)?.profile === true
}

/** UTF-8 bytes of an entry's payload (text + meta) — the on-disk-ish footprint. */
function entryBytes(e: MemoryEntry): number {
  return Buffer.byteLength(e.text ?? '', 'utf8') + Buffer.byteLength(safeMetaJson(e.meta), 'utf8')
}

function safeMetaJson(meta: unknown): string {
  if (meta === undefined || meta === null) return ''
  try {
    return JSON.stringify(meta)
  } catch {
    return ''
  }
}

function defaultMeasure(entries: readonly MemoryEntry[]): number {
  let sum = 0
  for (const e of entries) sum += entryBytes(e)
  return sum
}

function clampNonNeg(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback
}
