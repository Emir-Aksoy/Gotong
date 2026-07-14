/**
 * `MemoryAugmentedAgent` — an `LlmAgent` that carries persistent memory.
 *
 * Two hooks onto the base agent, nothing else:
 *
 *   1. **Frozen-block injection.** `buildRequest` prepends a byte-stable
 *      memory block to the system prompt. The block is computed once per
 *      session (see {@link MemorySession}) so the system-prompt prefix stays
 *      identical across every turn — preserving prompt caching. It goes at
 *      the FRONT so the stable bytes form the cache prefix; the agent's own
 *      (also stable) system prompt follows.
 *
 *   2. **Memory tools.** A {@link MemoryToolset} (`remember` / `recall` /
 *      `forget`) is composed into the agent's `tools` slot alongside whatever
 *      toolset the caller passed (dispatch / MCP / …). The model writes
 *      durable facts with `remember` (they surface in the NEXT session's
 *      frozen block) and digs up older history with `recall`.
 *
 * Everything else — the tool-use loop, suspend/resume working memory, usage
 * sink, auth hook — is inherited from `LlmAgent` unchanged.
 *
 * Memory handle resolution: explicit `memory` option wins; otherwise the
 * agent reads `services.memory` (the per-owner handle the host injects from
 * the agent yaml's `uses:` block). A memory-augmented agent with neither is a
 * misconfiguration and throws at construction.
 */

import type { Task } from '@gotong/core'
import {
  ComposedToolset,
  LlmAgent,
  type LlmAgentOptions,
  type LlmAgentToolset,
  type LlmRequest,
} from '@gotong/llm'
import type { MemoryHandle, MemoryKind } from '@gotong/services-sdk'

import {
  buildTurnCapture,
  extractReplyText,
  extractUserText,
  isHeartbeatPayload,
} from './capture.js'
import { PersonalMemoryError } from './errors.js'
import type { MemoryRetriever } from './retriever.js'
import { MemorySession } from './session.js'
import type { TierConfig } from './tiers.js'
import { MemoryToolset, type MemoryLinkLookup } from './toolset.js'

export interface MemoryAugmentedAgentOptions extends LlmAgentOptions {
  /**
   * Memory handle. Falls back to `services.memory` when omitted. A
   * memory-augmented agent with neither is a misconfiguration (throws).
   */
  memory?: MemoryHandle
  /** Kinds the `remember` tool may write. Default `['episodic', 'semantic']`. */
  writableMemoryKinds?: readonly MemoryKind[]
  /**
   * Swappable backend for the `recall` tool (vector / hybrid / chroma-mcp).
   * Default = the handle's own `recall`. Only the on-demand `recall` path is
   * pluggable; the frozen block stays the byte-stable curated profile.
   */
  memoryRetriever?: MemoryRetriever
  /**
   * Opt-in (E-M3, wired by M-GRAPH): after a `recall`, expand ONE hop along the
   * matched entries' `meta.links` and append the linked entries — this lookup
   * resolves those link-target ids to entries. Omit → no expansion (default,
   * byte-identical). Expansion rides the on-demand `recall` path ONLY; the
   * byte-stable frozen block is untouched.
   */
  memoryLinkLookup?: MemoryLinkLookup
  /** Max one-hop neighbors appended per recall when {@link memoryLinkLookup} is set. */
  memoryExpandK?: number
  /** Kinds that seed the frozen block. Default `['semantic']`. */
  frozenMemoryKinds?: readonly MemoryKind[]
  /** Max entries pulled for the frozen block. Default 100. */
  frozenMemoryK?: number
  /** Soft char cap for the frozen block body. Default 4000. */
  frozenMemoryMaxChars?: number
  /**
   * Cluster catalog (decision ③). When set, the frozen block is rendered
   * GROUPED BY CLUSTER (画像 / 项目 / 人物 / 承诺 / 其它). Omit for the flat
   * block — the default, so existing memory-augmented agents are unchanged.
   * The butler opts in with `DEFAULT_TIERS`.
   */
  tierConfig?: TierConfig
  /**
   * Opt-in (decision D): the frozen block shows only facts in effect now —
   * closed time-edges and not-yet-valid facts are dropped. A `now` is pinned at
   * construction so the block stays byte-stable. Default off (byte-identical to
   * off for plain stores with no bitemporal meta).
   */
  frozenActiveOnly?: boolean
  /** Opt-in (decision E): the frozen block appends intra-block link tails. Default off. */
  frozenShowLinks?: boolean
  /** Opt-in (decision G): the frozen block lifts procedures into a how-to section. Default off. */
  frozenShowProcedures?: boolean
  /** Max procedures listed when {@link frozenShowProcedures} is on. */
  frozenMaxProcedures?: number
  /** Pinned frozen "now" (ms) for {@link frozenActiveOnly}; sampled at construction if omitted. */
  frozenNow?: number
  /**
   * Re-recall the frozen block on EVERY task (vs the Hermes default of once per
   * session). Default `false` — a bounded conversation rides recent turns on its
   * in-context history and the block stays a stable prefix. An ALWAYS-ON butler
   * (one memoized instance serving many independent, history-less IM messages)
   * sets this `true` so each message sees memories captured since the last one —
   * the difference between "remembers across sessions" and not. Trades prefix-cache
   * stability for freshness; for stateless per-message dispatch there's little
   * cross-message prefix to cache anyway.
   */
  frozenRefreshPerTask?: boolean
  /**
   * M2 — automatically record each completed turn into `episodic` memory
   * (decision D5: turn-end is one of the two honest capture points). Default
   * `true`. Set `false` to opt out (e.g. an agent that captures by some other
   * means, or a read-only assistant). Heartbeat ticks are never captured.
   */
  captureTurns?: boolean
  /** Soft char cap on a single capture entry's text. */
  captureMaxChars?: number
  /**
   * Static meta merged into every capture entry — e.g. a per-user namespace
   * key so a multi-user butler's episodic log stays separable (M6). The
   * frozen block / capture are otherwise per-agent.
   */
  captureMeta?: Record<string, unknown>
}

export class MemoryAugmentedAgent extends LlmAgent {
  private readonly session: MemorySession
  protected readonly memoryToolset: MemoryToolset
  /** The resolved memory handle — also the capture target (M2). */
  private readonly memory: MemoryHandle
  private readonly captureTurns: boolean
  private readonly captureMaxChars: number | undefined
  private readonly captureMeta: Record<string, unknown> | undefined
  /** Re-recall the frozen block per task (always-on butler) vs once per session. */
  private readonly frozenRefreshPerTask: boolean

  constructor(opts: MemoryAugmentedAgentOptions) {
    const memory = opts.memory ?? opts.services?.memory
    if (!memory) {
      throw new PersonalMemoryError(
        'memory_handle_required',
        `MemoryAugmentedAgent '${opts.id}' requires a memory handle — pass ` +
          '`memory` or construct it with a `services.memory` from a `uses: [{ type: \'memory\' }]` block.',
      )
    }

    const memoryToolset = new MemoryToolset({
      memory,
      ...(opts.writableMemoryKinds !== undefined
        ? { writableKinds: opts.writableMemoryKinds }
        : {}),
      ...(opts.memoryRetriever !== undefined ? { retriever: opts.memoryRetriever } : {}),
      ...(opts.memoryLinkLookup !== undefined ? { linkLookup: opts.memoryLinkLookup } : {}),
      ...(opts.memoryExpandK !== undefined ? { expandK: opts.memoryExpandK } : {}),
    })

    // Compose memory tools with any caller toolset. Memory tools FIRST so
    // their bare names (remember/recall/forget) are checked ahead of MCP
    // `<server>__<tool>` / `dispatch_task` — those never collide, so this
    // is just a deterministic ordering, not a precedence hack.
    const tools: LlmAgentToolset = opts.tools
      ? ComposedToolset.of(memoryToolset, opts.tools)
      : memoryToolset

    super({ ...opts, tools })

    this.memory = memory
    this.memoryToolset = memoryToolset
    this.captureTurns = opts.captureTurns ?? true
    this.captureMaxChars = opts.captureMaxChars
    this.captureMeta = opts.captureMeta
    this.frozenRefreshPerTask = opts.frozenRefreshPerTask ?? false
    this.session = new MemorySession({
      memory,
      label: opts.id,
      ...(opts.frozenMemoryKinds !== undefined ? { frozenKinds: opts.frozenMemoryKinds } : {}),
      ...(opts.frozenMemoryK !== undefined ? { frozenK: opts.frozenMemoryK } : {}),
      ...(opts.frozenMemoryMaxChars !== undefined
        ? { frozenMaxChars: opts.frozenMemoryMaxChars }
        : {}),
      ...(opts.tierConfig !== undefined ? { tierConfig: opts.tierConfig } : {}),
      // D/E/G frozen-block opt-ins — threaded through so a butler can surface
      // only-in-effect facts, link tails, and a how-to section in its always-on
      // block. Each is byte-identical to off for stores without that meta.
      ...(opts.frozenActiveOnly !== undefined ? { activeOnly: opts.frozenActiveOnly } : {}),
      ...(opts.frozenShowLinks !== undefined ? { showLinks: opts.frozenShowLinks } : {}),
      ...(opts.frozenShowProcedures !== undefined
        ? { showProcedures: opts.frozenShowProcedures }
        : {}),
      ...(opts.frozenMaxProcedures !== undefined
        ? { maxProcedures: opts.frozenMaxProcedures }
        : {}),
      ...(opts.frozenNow !== undefined ? { now: opts.frozenNow } : {}),
    })
  }

  /**
   * Compute the frozen block once before the first request goes out, then
   * run the normal `LlmAgent` task path (which calls our `buildRequest`).
   * Memoized inside the session — cheap on every subsequent task.
   */
  protected override async handleTask(task: Task): Promise<unknown> {
    // An always-on butler re-recalls per task so it sees what it just captured;
    // the default keeps the once-per-session cache (a stable prompt prefix).
    if (this.frozenRefreshPerTask) this.session.refresh()
    await this.session.ensureFrozenBlock()
    const out = await super.handleTask(task)
    await this.captureTurn(task, out)
    return out
  }

  /** Same pre-warm on resume so a parked-then-woken task still injects memory. */
  protected override async handleResume(task: Task, state: unknown): Promise<unknown> {
    if (this.frozenRefreshPerTask) this.session.refresh()
    await this.session.ensureFrozenBlock()
    const out = await this.resumeBody(task, state)
    await this.captureTurn(task, out)
    return out
  }

  /**
   * Resume body seam. The default delegates to `LlmAgent.handleResume`
   * (restore `__llmMessages` working memory and continue the tool loop, or
   * fall back to a fresh run). A subclass that owns a bespoke suspend/resume
   * state — e.g. `PersonalButlerAgent`'s approval-gated governed actions —
   * overrides this to inject its decision, while frozen-block warm-up and
   * turn capture stay in one place (`handleResume` above) for every subclass.
   */
  protected resumeBody(task: Task, state: unknown): Promise<unknown> {
    return super.handleResume(task, state)
  }

  /**
   * M2 — record a completed turn into episodic memory. Best-effort: a capture
   * failure must never fail the turn the user already got an answer for, so we
   * swallow + log. Only runs after the turn *completed* — if the tool loop
   * parked (threw `SuspendTaskError`), `super.handleTask` rethrew above and we
   * never reach here; the eventual resume captures instead. Heartbeat ticks
   * are skipped (episodic is the conversation log, not a maintenance record).
   */
  private async captureTurn(task: Task, output: unknown): Promise<void> {
    if (!this.captureTurns) return
    if (isHeartbeatPayload(task)) return
    try {
      const entry = buildTurnCapture({
        userText: extractUserText(task),
        replyText: extractReplyText(output),
        taskId: task.id,
        from: task.from,
        ...(this.captureMeta !== undefined ? { meta: this.captureMeta } : {}),
        ...(this.captureMaxChars !== undefined ? { maxChars: this.captureMaxChars } : {}),
      })
      if (entry) await this.memory.remember(entry)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[personal-memory] turn capture failed for '${this.id}'`, err)
    }
  }

  /**
   * Prepend the frozen memory block to the system prompt. Front position =
   * the stable bytes lead the prefix; the agent's own system prompt follows.
   * Reads the memoized block synchronously (already warmed by `handleTask`);
   * `''` before warm-up means "no injection" — a safe degradation.
   */
  protected override buildRequest(task: Task): LlmRequest {
    const req = super.buildRequest(task)
    const block = this.session.frozenBlockSync()
    if (block) {
      req.system = req.system ? `${block}\n\n${req.system}` : block
    }
    return req
  }

  /** The session backing this agent. Exposed for the host (later milestones
   *  bind one session per (user, butler); M1 = one per agent instance). */
  get memorySession(): MemorySession {
    return this.session
  }
}
