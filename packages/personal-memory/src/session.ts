/**
 * `MemorySession` — the frozen-block memoizer.
 *
 * Pairs with {@link renderFrozenBlock} (the byte-stable renderer) to deliver
 * Hermes-style prefix-cache preservation:
 *
 *   - The frozen block is computed on the first task (a `list` of the frozen
 *     kinds, default `semantic` only) and CACHED.
 *   - Every later task reuses the exact same bytes until {@link refresh} drops
 *     the cache — never, by default (one session == one stable prefix); before
 *     every message for an always-on butler (`frozenRefreshPerTask`).
 *   - Re-reading is not changing: the renderer is a pure function of the entry
 *     SET, so a refreshed block only moves when its CONTENTS moved.
 *
 * That last point is why {@link MemorySessionOptions.volatileKinds} exists. A
 * kind written every turn (episodic turn captures) changes the contents every
 * message, so with per-message refresh it would shift the stable block — and
 * every byte of system prompt after it — on each message. Opted-in kinds are
 * kept OUT of the stable block and rendered into a separate RECENT block
 * ({@link renderRecentMemoryBlock}), which the agent places in the volatile
 * system tail. Default: no volatile kinds, behaviour byte-identical to before.
 *
 * Raw `episodic` history not shown in either block stays reachable on demand
 * via the `recall` tool.
 */

import type { MemoryEntry, MemoryHandle, MemoryKind } from '@gotong/services-sdk'

import {
  renderClusteredFrozenBlock,
  renderFrozenBlock,
  renderRecentMemoryBlock,
} from './frozen-block.js'
import { compareByImportanceThenRecency } from './importance.js'
import type { TierConfig } from './tiers.js'

export interface MemorySessionOptions {
  /** The (already per-owner-scoped) memory handle this session reads. */
  memory: MemoryHandle
  /** Heading label for the rendered block (typically the agent id). */
  label?: string
  /** Kinds that seed the frozen block. Default `['semantic']`. */
  frozenKinds?: readonly MemoryKind[]
  /**
   * Opt-in: kinds rendered into a separate RECENT block (see
   * {@link MemorySession.volatileBlockSync}) instead of the stable one — and
   * removed from {@link frozenKinds} if listed there. Meant for kinds written
   * every turn (`episodic`) under per-message {@link MemorySession.refresh}, so
   * they stop invalidating the stable block's prompt cache. Default `[]`
   * (no recent block; byte-identical to before).
   */
  volatileKinds?: readonly MemoryKind[]
  /** Soft char cap for the recent block body. Default 1500 (`DEFAULT_RECENT_MAX_CHARS`). */
  volatileMaxChars?: number
  /** Max entries KEPT in the block, chosen by (importance, recency). Default 100. */
  frozenK?: number
  /**
   * How many candidate entries to pull from disk BEFORE selecting the top
   * `frozenK` by (importance, recency). Larger than `frozenK` so a high-importance
   * pin isn't evicted just for being old — see {@link DEFAULT_FROZEN_CANDIDATE_K}.
   */
  frozenCandidateK?: number
  /** Soft char cap for the rendered block body. Default 4000. */
  frozenMaxChars?: number
  /**
   * Cluster catalog (decision ③). When set, the frozen block is rendered
   * GROUPED BY CLUSTER (`renderClusteredFrozenBlock`) instead of one flat list.
   * Omit for the flat block (unchanged default — zero regression for callers
   * that don't use tiering).
   */
  tierConfig?: TierConfig
  /**
   * Opt-in (decision D): show only facts in effect NOW — drop closed time-edges
   * and not-yet-valid facts, so the always-on block reflects CURRENT truth. The
   * `now` is captured ONCE at construction (a frozen number, not a clock) so the
   * block stays byte-identical for the session. Pass {@link now} to pin it for a
   * deterministic test; otherwise it is sampled at construction. Default off.
   */
  activeOnly?: boolean
  /**
   * Opt-in (decision E): append ` (related: id, …)` tails listing intra-block
   * links — the block becomes a navigable graph. Byte-identical to off when no
   * entry carries links. Default off.
   */
  showLinks?: boolean
  /**
   * Opt-in (decision G): lift recorded procedures into a "Things I know how to
   * do" section. Byte-identical to off when no procedures are present. Default off.
   */
  showProcedures?: boolean
  /** Max procedures listed when {@link showProcedures} is on. */
  maxProcedures?: number
  /**
   * The session's frozen "now" (ms) for {@link activeOnly}. A NUMBER, not a
   * clock. When `activeOnly` is on and this is omitted, it is sampled ONCE at
   * construction (`Date.now()`) and held for the session. Supply it for
   * deterministic tests.
   */
  now?: number
}

const DEFAULT_FROZEN_KINDS: readonly MemoryKind[] = ['semantic']
/**
 * Max entries KEPT in the always-on block. A DELIBERATE CEILING, not a growth
 * bound: `semantic` can hold more, and the block keeps the top `frozenK` by
 * (importance, recency), noting the rest as "(N lower-priority … omitted)". The
 * omitted tail is NOT lost — it stays on disk, reachable via the `recall` tool.
 * See docs/zh/ledger/MEMORY-ADVANCED-FINAL.md §八.
 */
const DEFAULT_FROZEN_K = 100
/**
 * Candidate window pulled from disk before the top-`frozenK` selection. It must
 * be LARGER than `frozenK`: the store returns newest-first, so if we only pulled
 * `frozenK` we'd pre-truncate by recency and a high-importance pin older than the
 * newest `frozenK` entries would never reach the importance sort — silently
 * evicted from the block despite being pinned (audit P2). Pulling a generous
 * window first, THEN sorting by (importance, recency), keeps pins in. With the
 * `budgetReviewer` byte cap bounding the store, this covers the whole store for
 * a normal member; a pin beyond the newest `frozenCandidateK` is still on disk
 * and recall-able, just not auto-frozen.
 */
const DEFAULT_FROZEN_CANDIDATE_K = 500

export class MemorySession {
  private readonly memory: MemoryHandle
  private readonly label: string | undefined
  private readonly frozenKinds: readonly MemoryKind[]
  private readonly volatileKinds: readonly MemoryKind[]
  private readonly volatileMaxChars: number | undefined
  private readonly frozenK: number
  private readonly frozenCandidateK: number
  private readonly frozenMaxChars: number | undefined
  private readonly tierConfig: TierConfig | undefined
  private readonly activeOnly: boolean
  private readonly showLinks: boolean
  private readonly showProcedures: boolean
  private readonly maxProcedures: number | undefined
  /** Frozen "now" for activeOnly — pinned per (re)build so the block stays stable
   *  between refreshes; re-sampled by {@link refresh} when auto-sampled. */
  private now: number | undefined
  /** Whether `now` was auto-sampled (vs caller-pinned) — re-sampled on refresh. */
  private readonly nowAutoSampled: boolean

  /** Memoized block — `null` until the first `ensureFrozenBlock()` resolves. */
  private frozen: string | null = null
  /** Memoized recent block, built alongside `frozen` (`''` when no volatile kinds). */
  private recent: string | null = null
  /** Guards against two concurrent first-tasks double-recalling. */
  private pending: Promise<string> | null = null

  constructor(opts: MemorySessionOptions) {
    this.memory = opts.memory
    this.label = opts.label
    this.volatileKinds = [...new Set(opts.volatileKinds ?? [])]
    const volatile = new Set(this.volatileKinds)
    // A kind lives in exactly ONE block: listing it as volatile moves it out of
    // the stable block (an emptied stable list still renders the empty shape).
    this.frozenKinds = (
      opts.frozenKinds && opts.frozenKinds.length > 0 ? opts.frozenKinds : DEFAULT_FROZEN_KINDS
    ).filter((k) => !volatile.has(k))
    this.volatileMaxChars = opts.volatileMaxChars
    this.frozenK = opts.frozenK ?? DEFAULT_FROZEN_K
    this.frozenCandidateK = Math.max(
      this.frozenK,
      opts.frozenCandidateK ?? DEFAULT_FROZEN_CANDIDATE_K,
    )
    this.frozenMaxChars = opts.frozenMaxChars
    this.tierConfig = opts.tierConfig
    this.activeOnly = opts.activeOnly ?? false
    this.showLinks = opts.showLinks ?? false
    this.showProcedures = opts.showProcedures ?? false
    this.maxProcedures = opts.maxProcedures
    // Pin `now` once: activeOnly needs a frozen number for the whole session, so
    // sample the clock at construction when one isn't supplied. Only sampled
    // when activeOnly is on (otherwise `now` never reaches the renderer).
    this.nowAutoSampled = opts.now === undefined
    this.now = opts.now ?? (this.activeOnly ? Date.now() : undefined)
  }

  /**
   * Drop the memoized block so the NEXT `ensureFrozenBlock()` re-recalls from
   * disk — surfacing memories written since the last build.
   *
   * The Hermes "one session = one stable prefix" default caches forever, which is
   * right for a bounded conversation (recent turns ride the in-context history,
   * the block is the long-term profile). But an ALWAYS-ON butler instance handles
   * many independent IM messages that each arrive as a fresh, history-less task —
   * so without a refresh the block stays frozen at its first-message contents and
   * the butler can't "remember" what it just captured. The resident butler opts
   * into per-task refresh; when `activeOnly` auto-sampled `now`, re-sample it so
   * the just-now view tracks wall-clock instead of process-start.
   */
  refresh(now?: number): void {
    this.frozen = null
    this.recent = null
    this.pending = null
    if (now !== undefined) this.now = now
    else if (this.activeOnly && this.nowAutoSampled) this.now = Date.now()
  }

  /**
   * Compute the frozen block (and the recent block, when `volatileKinds` is
   * set) once and cache it. Safe to call before every task — the recall
   * happens exactly once per session even under concurrent first-tasks (the
   * `pending` promise is shared).
   */
  async ensureFrozenBlock(): Promise<string> {
    if (this.frozen !== null) return this.frozen
    if (this.pending) return this.pending
    this.pending = (async () => {
      // Pull a GENEROUS candidate window per kind, then keep the top `frozenK`
      // by (importance, recency). `recall({k})` alone would recency-truncate
      // first and drop old pins before the importance sort ever sees them
      // (audit P2). `list` gives the raw newest-N without recall's text/since
      // filters — exactly the candidate set the block wants.
      const candidates: MemoryEntry[] = []
      for (const kind of this.frozenKinds) {
        candidates.push(...(await this.memory.list({ kind, limit: this.frozenCandidateK })))
      }
      const entries = candidates
        .sort(compareByImportanceThenRecency)
        .slice(0, this.frozenK)
      const renderOpts = {
        ...(this.label !== undefined ? { label: this.label } : {}),
        ...(this.frozenMaxChars !== undefined ? { maxChars: this.frozenMaxChars } : {}),
        // D/E/G opt-ins — each byte-identical to off when the data doesn't carry
        // the relevant meta, so threading them through is safe for plain stores.
        ...(this.activeOnly ? { activeOnly: true } : {}),
        ...(this.showLinks ? { showLinks: true } : {}),
        ...(this.showProcedures ? { showProcedures: true } : {}),
        ...(this.maxProcedures !== undefined ? { maxProcedures: this.maxProcedures } : {}),
        ...(this.now !== undefined ? { now: this.now } : {}),
        // Splitting per-turn kinds out means the block is re-read per refresh, not
        // frozen per session — say so. Off ⇒ the original preamble, byte-identical.
        ...(this.volatileKinds.length > 0 ? { refreshNote: true } : {}),
      }
      const block = this.tierConfig
        ? renderClusteredFrozenBlock(entries, { ...renderOpts, config: this.tierConfig })
        : renderFrozenBlock(entries, renderOpts)
      // Volatile kinds: newest-first by construction (recency ordering in the
      // renderer), same candidate window and same active-slice `now`.
      let recent = ''
      if (this.volatileKinds.length > 0) {
        const recentCandidates: MemoryEntry[] = []
        for (const kind of this.volatileKinds) {
          recentCandidates.push(...(await this.memory.list({ kind, limit: this.frozenCandidateK })))
        }
        recent = renderRecentMemoryBlock(recentCandidates, {
          ...(this.label !== undefined ? { label: this.label } : {}),
          ...(this.volatileMaxChars !== undefined ? { maxChars: this.volatileMaxChars } : {}),
          ...(this.activeOnly ? { activeOnly: true } : {}),
          ...(this.now !== undefined ? { now: this.now } : {}),
        })
      }
      this.recent = recent
      this.frozen = block
      this.pending = null
      return block
    })()
    return this.pending
  }

  /**
   * Synchronous read of the memoized block — `''` until `ensureFrozenBlock()`
   * has resolved at least once. The synchronous shape exists so the agent's
   * (synchronous) `buildRequest` can inject the block without re-recalling;
   * the agent calls `ensureFrozenBlock()` in its async task entry first.
   */
  frozenBlockSync(): string {
    return this.frozen ?? ''
  }

  /**
   * Synchronous read of the memoized RECENT block (opt-in `volatileKinds`) —
   * `''` before warm-up, when no volatile kinds are configured, or when those
   * kinds hold nothing. Built by the same `ensureFrozenBlock()` call and dropped
   * by the same {@link refresh}, so both blocks always reflect one read.
   */
  volatileBlockSync(): string {
    return this.recent ?? ''
  }

  /** Whether the block has been computed yet. */
  get isReady(): boolean {
    return this.frozen !== null
  }
}
