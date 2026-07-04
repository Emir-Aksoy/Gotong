/**
 * personal-butler-maintenance.ts — BF-M8: run the butler's memory 蒸馏 + 6h upkeep
 * in the PRODUCTION host, per member, on a background sweep.
 *
 * # Why this exists
 *
 * The resident butler (BF-M4) captures every turn into `episodic` and — until
 * this module — leaned on `frozenMemoryKinds: ['semantic','episodic']` so those
 * raw captures showed up in the next session's frozen block. That was a
 * stopgap: the `semantic` curated profile stayed EMPTY because nothing ever ran
 * consolidation in production. The MR-series built the whole distillation engine
 * (`tieredReviewer`) and the 6h-maintenance idiom (`statusProjectingReviewer`),
 * but only the `examples/personal-butler` demo and the §九 承重门 ever fired
 * them. BF-M8 folds that maintenance into `gotong start`.
 *
 * # What one tick does, per member
 *
 * For every `<rootDir>/user/<userId>/` namespace on disk it fires ONE
 * maintenance reviewer:
 *
 *   statusProjectingReviewer({                      // ④写状态 → STATUS.md (/me sees it)
 *     statusFile,
 *     inner: tieredReviewer({ summarize, budgetBytes? }),  // 蒸馏 episodic→cluster→profile
 *   })
 *
 * Deliberately LEAN vs. the MR4 example composition: the butler's default memory
 * config omits `working` scratch and doesn't auto-author procedures yet, so
 * `cleanOutputsReviewer` / `skillFileReviewer` would be pure no-ops here —
 * every node in this pass must earn its place. Dreaming / umbrella authoring
 * stay DEFERRED (they need the query-diversity signal + a procedure drafter);
 * the headline BF-M8 asked for is 蒸馏, and that is `tieredReviewer`.
 *
 * The butler's memory is TIERED (`PersonalButlerAgent` defaults
 * `tierConfig: DEFAULT_TIERS`), so consolidation MUST be `tieredReviewer`, not
 * the flat `consolidate` — routing episodic into per-cluster digests and
 * promoting each cluster to a durable profile once it accretes enough.
 *
 * # The aux model = the butler's own model
 *
 * The distillation `summarize` call runs on a provider built from the SAME
 * managed `chat` row the butler talks through (`LocalAgentPool.buildButlerProvider`),
 * so the maintenance model can never disagree with the conversational one and
 * its usage bills to the same place. The sweep resolves the provider at each
 * tick (not at boot) so a key added after start is picked up; a null provider
 * (no key / no butler row) makes the whole tick a clean no-op.
 *
 * # No-leak + best-effort
 *
 * Each member's namespace is opened + maintained in isolation, so one member's
 * pass never touches another's bytes; a throw in one member's tick is logged and
 * the sweep moves on (one corrupt tree must never stall the interval).
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { Logger } from '@gotong/core'
import { drainStream, type LlmProvider } from '@gotong/llm'
import {
  tieredReviewer,
  type MemoryReviewer,
  type MemorySummarizer,
  type TierConfig,
} from '@gotong/personal-memory'
import type { MemoryHandle } from '@gotong/services-sdk'

import { openButlerMemory } from './personal-butler-memory.js'
import {
  openButlerStatusFile,
  statusProjectingReviewer,
  type ButlerStatusFile,
} from './personal-butler-status.js'

/** Default maintenance cadence — 6h (the MR4 §八 upkeep rhythm). */
export const BUTLER_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** How many recent episodic entries to hand the review context per tick. */
const DEFAULT_RECALL_K = 200

/**
 * Adapt an `LlmProvider` into the `MemorySummarizer` the distillation engine
 * wants — a `{system,user}` → text call. Keeps `@gotong/personal-memory` free
 * of any `@gotong/llm` import (the summarizer type is intentionally provider-
 * agnostic); this is the one host seam that binds the two.
 */
export function butlerSummarizer(
  provider: LlmProvider,
  opts: { model?: string; maxTokens?: number } = {},
): MemorySummarizer {
  return async ({ system, user }) => {
    const res = await drainStream(
      provider.stream({
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: opts.maxTokens ?? 512,
        ...(opts.model ? { model: opts.model } : {}),
      }),
    )
    return res.text
  }
}

export interface ButlerMaintenanceReviewerOptions {
  /** The distillation LLM call (built from the butler's provider). */
  summarize: MemorySummarizer
  /** The per-user status file this tick projects its summary into (STATUS.md). */
  statusFile: ButlerStatusFile
  /** Tier layout; defaults (inside `tieredReviewer`) to `DEFAULT_TIERS` — the same
   *  tiers the butler agent uses, so consolidation routes into the same clusters. */
  tierConfig?: TierConfig
  /** Optional whole-namespace byte ceiling (deterministic eviction backstop after
   *  consolidation reclaims what it can). Omit = no ceiling (per-layer caps only). */
  budgetBytes?: number
}

/**
 * Build the per-user maintenance reviewer: `tieredReviewer` (蒸馏) wrapped by
 * `statusProjectingReviewer` (④写状态). One tick consolidates episodic into the
 * curated profile and records what it did to STATUS.md, which `/me`'s "上次维护"
 * line surfaces. Lean by design — see the module header for why cleanOutputs /
 * skillFile / dreaming are intentionally absent.
 */
export function buildButlerMaintenanceReviewer(
  opts: ButlerMaintenanceReviewerOptions,
): MemoryReviewer {
  return statusProjectingReviewer({
    statusFile: opts.statusFile,
    inner: tieredReviewer({
      summarize: opts.summarize,
      ...(opts.tierConfig ? { config: opts.tierConfig } : {}),
      ...(opts.budgetBytes !== undefined ? { budgetBytes: opts.budgetBytes } : {}),
    }),
  })
}

export interface RunButlerMaintenanceOnceOptions {
  /** Butler memory root (`<space>/butler/memory`). */
  rootDir: string
  /** The member whose namespace to maintain. */
  userId: string
  /** The distillation LLM call (built from the butler's provider via {@link butlerSummarizer}). */
  summarize: MemorySummarizer
  logger: Logger
  /** Injectable clock (deterministic tests). Default `Date.now`. */
  now?: () => number
  tierConfig?: TierConfig
  budgetBytes?: number
  /** Recent episodic count handed to the review context. Default {@link DEFAULT_RECALL_K}. */
  recallK?: number
}

/**
 * Run ONE maintenance pass for ONE member: distil their captured episodic into the
 * curated per-cluster profile and record what it did to STATUS.md. The single
 * source of truth shared by the background {@link ButlerMaintenanceSweeper} (per
 * tick, per member) and the on-demand "整理记忆" butler tool (S2-M2), so the two
 * can never drift. Opens a fresh file-backed handle on the member's namespace —
 * the butler's own handle points at the SAME jsonl, so its next-turn `refresh()`
 * picks up whatever this pass consolidated. Returns the reviewer's summary (or '').
 */
export async function runButlerMaintenanceOnce(
  opts: RunButlerMaintenanceOnceOptions,
): Promise<string> {
  const now = opts.now ?? Date.now
  const memory: MemoryHandle = openButlerMemory({
    rootDir: opts.rootDir,
    userId: opts.userId,
    logger: opts.logger,
    ...(now !== Date.now ? { now } : {}),
  })
  const statusFile = openButlerStatusFile({
    rootDir: opts.rootDir,
    userId: opts.userId,
    logger: opts.logger,
  })
  const reviewer = buildButlerMaintenanceReviewer({
    summarize: opts.summarize,
    statusFile,
    ...(opts.tierConfig ? { tierConfig: opts.tierConfig } : {}),
    ...(opts.budgetBytes !== undefined ? { budgetBytes: opts.budgetBytes } : {}),
  })
  const episodic = await memory.recall({ kinds: ['episodic'], k: opts.recallK ?? DEFAULT_RECALL_K })
  const out = await reviewer({ memory, episodic, now: now() })
  return out.summary ?? ''
}

export interface ButlerMaintenanceSweeperOptions {
  /** Butler memory root (`<space>/butler/memory`) — the same one the factory + /me view use. */
  rootDir: string
  /**
   * Resolve the butler's provider (usually `() => pool.buildButlerProvider()`).
   * Called at each tick so a key added after boot is picked up; a null result
   * makes the whole tick a clean no-op (no key / no butler row).
   */
  buildProvider: () => Promise<LlmProvider | null>
  logger: Logger
  /** Cadence; defaults to {@link BUTLER_MAINTENANCE_INTERVAL_MS} (6h). */
  intervalMs?: number
  /** Injectable clock (deterministic tests). Default `Date.now`. */
  now?: () => number
  /** Per-request model / token overrides for the distillation call. */
  model?: string
  maxTokens?: number
  /** Forwarded to the maintenance reviewer. */
  tierConfig?: TierConfig
  budgetBytes?: number
  /** Recent episodic count handed to the review context. Default {@link DEFAULT_RECALL_K}. */
  recallK?: number
}

/**
 * A background sweep that fires {@link buildButlerMaintenanceReviewer} once per
 * member on a fixed cadence. Enumerates the on-disk per-user namespaces
 * (`<rootDir>/user/*`), so it maintains exactly the members who have a butler
 * memory — no registry, no roster to keep in sync.
 *
 * Deliberately does NOT run at boot: a 6h maintenance job firing on every
 * restart would burn tokens for no benefit. The first tick lands one interval
 * after {@link start}.
 */
export class ButlerMaintenanceSweeper {
  private readonly rootDir: string
  private readonly buildProvider: () => Promise<LlmProvider | null>
  private readonly log: Logger
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly model?: string
  private readonly maxTokens?: number
  private readonly tierConfig?: TierConfig
  private readonly budgetBytes?: number
  private readonly recallK: number

  private timer?: ReturnType<typeof setInterval>
  private running = false

  constructor(opts: ButlerMaintenanceSweeperOptions) {
    this.rootDir = opts.rootDir
    this.buildProvider = opts.buildProvider
    this.log = opts.logger
    this.intervalMs = opts.intervalMs ?? BUTLER_MAINTENANCE_INTERVAL_MS
    this.now = opts.now ?? Date.now
    this.model = opts.model
    this.maxTokens = opts.maxTokens
    this.tierConfig = opts.tierConfig
    this.budgetBytes = opts.budgetBytes
    this.recallK = opts.recallK ?? DEFAULT_RECALL_K
  }

  /** Start the interval. `.unref()` so a pending tick never keeps the process alive. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.intervalMs)
    this.timer.unref?.()
    this.log.info('butler maintenance sweep armed', {
      intervalMs: this.intervalMs,
      rootDir: this.rootDir,
    })
  }

  /** Stop the interval (host shutdown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Fire one maintenance pass across every member namespace. Re-entrant-guarded
   * so a slow tick (many members / a slow model) never overlaps the next. Best-
   * effort throughout: a provider fault or one member's throw is logged and the
   * sweep continues — the truth is the jsonl, and skipping a tick is safe.
   */
  async runOnce(): Promise<void> {
    if (this.running) {
      this.log.debug('butler maintenance: previous tick still running, skipping')
      return
    }
    this.running = true
    try {
      const userIds = await this.listUserIds()
      if (userIds.length === 0) return

      const provider = await this.buildProvider()
      if (!provider) {
        // No butler row / no resolvable key — nothing to distill with. Honest
        // no-op (a fresh hub with no key set yet lands here every tick).
        this.log.debug('butler maintenance: no provider, skipping tick', {
          members: userIds.length,
        })
        return
      }
      const summarize = butlerSummarizer(provider, {
        ...(this.model ? { model: this.model } : {}),
        ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      })

      let active = 0
      for (const userId of userIds) {
        try {
          const summary = await this.maintainOne(userId, summarize)
          if (summary) active++
        } catch (err) {
          this.log.warn('butler maintenance: member tick failed', {
            userId,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
      this.log.info('butler maintenance: sweep complete', {
        members: userIds.length,
        active,
      })
    } finally {
      this.running = false
    }
  }

  /** Run the maintenance reviewer once for one member; returns its summary (or ''). */
  private async maintainOne(userId: string, summarize: MemorySummarizer): Promise<string> {
    return runButlerMaintenanceOnce({
      rootDir: this.rootDir,
      userId,
      summarize,
      logger: this.log,
      ...(this.now !== Date.now ? { now: this.now } : {}),
      ...(this.tierConfig ? { tierConfig: this.tierConfig } : {}),
      ...(this.budgetBytes !== undefined ? { budgetBytes: this.budgetBytes } : {}),
      recallK: this.recallK,
    })
  }

  /**
   * List the member namespaces under `<rootDir>/user/`. The directory name IS
   * the verbatim userId (see `ownerDir`), and any dir that exists was written
   * through `assertSafeOwnerId`, so reading names back is safe by construction.
   * A missing `user/` dir (no butler members yet) yields an empty list.
   */
  private async listUserIds(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.rootDir, 'user'), { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return [] // user/ doesn't exist yet — no members, no work
    }
  }
}
