/**
 * `MemorySession` — the once-per-session frozen-block memoizer.
 *
 * Pairs with {@link renderFrozenBlock} (the byte-stable renderer) to deliver
 * Hermes-style prefix-cache preservation:
 *
 *   - The frozen block is computed ON THE FIRST task of a session (a single
 *     `recall` of the curated `semantic` memory) and CACHED.
 *   - Every subsequent task in the same session reuses the exact same bytes.
 *   - New memories the butler writes mid-session (via the `remember` tool)
 *     land on disk but DO NOT mutate this cached block — they surface in the
 *     NEXT session's block, when a fresh `MemorySession` re-recalls.
 *
 * That "stale on purpose" behaviour is the whole point: a system prompt whose
 * prefix shifts every turn defeats prompt caching. One session == one stable
 * prefix.
 *
 * The frozen block draws from `semantic` memory only (the curated profile /
 * MEMORY.md analog). Raw `episodic` history is recalled on demand via the
 * `recall` tool, not poured into every prompt.
 */

import type { MemoryHandle, MemoryKind } from '@gotong/services-sdk'

import { renderClusteredFrozenBlock, renderFrozenBlock } from './frozen-block.js'
import type { TierConfig } from './tiers.js'

export interface MemorySessionOptions {
  /** The (already per-owner-scoped) memory handle this session reads. */
  memory: MemoryHandle
  /** Heading label for the rendered block (typically the agent id). */
  label?: string
  /** Kinds that seed the frozen block. Default `['semantic']`. */
  frozenKinds?: readonly MemoryKind[]
  /** Max entries pulled for the block. Default 100. */
  frozenK?: number
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
 * Max entries pulled into the always-on block. This is a DELIBERATE CEILING, not
 * a growth bound: `semantic` memory can hold more than this, and when it does the
 * renderer keeps the top `frozenK` by (importance, recency) and notes the rest as
 * "(N lower-priority … omitted)". The omitted tail is NOT lost — it stays on disk
 * and the model reaches it on demand via the `recall` tool. Two other mechanisms
 * do the actual scaling: the `budgetReviewer` (decision F/D eviction) bounds how
 * much accrues on disk in the first place, and the pluggable embedding retriever
 * (decision C-M3) scales `recall` past the default O(n) lexical scan. So the
 * frozen block stays a small, byte-stable prompt prefix no matter how large the
 * store grows. See docs/zh/ledger/MEMORY-ADVANCED-FINAL.md §八.
 */
const DEFAULT_FROZEN_K = 100

export class MemorySession {
  private readonly memory: MemoryHandle
  private readonly label: string | undefined
  private readonly frozenKinds: readonly MemoryKind[]
  private readonly frozenK: number
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
  /** Guards against two concurrent first-tasks double-recalling. */
  private pending: Promise<string> | null = null

  constructor(opts: MemorySessionOptions) {
    this.memory = opts.memory
    this.label = opts.label
    this.frozenKinds =
      opts.frozenKinds && opts.frozenKinds.length > 0 ? opts.frozenKinds : DEFAULT_FROZEN_KINDS
    this.frozenK = opts.frozenK ?? DEFAULT_FROZEN_K
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
    this.pending = null
    if (now !== undefined) this.now = now
    else if (this.activeOnly && this.nowAutoSampled) this.now = Date.now()
  }

  /**
   * Compute the frozen block once and cache it. Safe to call before every
   * task — the recall happens exactly once per session even under
   * concurrent first-tasks (the `pending` promise is shared).
   */
  async ensureFrozenBlock(): Promise<string> {
    if (this.frozen !== null) return this.frozen
    if (this.pending) return this.pending
    this.pending = (async () => {
      const entries = await this.memory.recall({
        kinds: [...this.frozenKinds],
        k: this.frozenK,
      })
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
      }
      const block = this.tierConfig
        ? renderClusteredFrozenBlock(entries, { ...renderOpts, config: this.tierConfig })
        : renderFrozenBlock(entries, renderOpts)
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

  /** Whether the block has been computed yet. */
  get isReady(): boolean {
    return this.frozen !== null
  }
}
