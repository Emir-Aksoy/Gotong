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

import type { MemoryHandle, MemoryKind } from '@aipehub/services-sdk'

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
}

const DEFAULT_FROZEN_KINDS: readonly MemoryKind[] = ['semantic']
const DEFAULT_FROZEN_K = 100

export class MemorySession {
  private readonly memory: MemoryHandle
  private readonly label: string | undefined
  private readonly frozenKinds: readonly MemoryKind[]
  private readonly frozenK: number
  private readonly frozenMaxChars: number | undefined
  private readonly tierConfig: TierConfig | undefined

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
