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

import type { Task } from '@aipehub/core'
import {
  ComposedToolset,
  LlmAgent,
  type LlmAgentOptions,
  type LlmAgentToolset,
  type LlmRequest,
} from '@aipehub/llm'
import type { MemoryHandle, MemoryKind } from '@aipehub/services-sdk'

import {
  buildTurnCapture,
  extractReplyText,
  extractUserText,
  isHeartbeatPayload,
} from './capture.js'
import { PersonalMemoryError } from './errors.js'
import type { MemoryRetriever } from './retriever.js'
import { MemorySession } from './session.js'
import { MemoryToolset } from './toolset.js'

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
  /** Kinds that seed the frozen block. Default `['semantic']`. */
  frozenMemoryKinds?: readonly MemoryKind[]
  /** Max entries pulled for the frozen block. Default 100. */
  frozenMemoryK?: number
  /** Soft char cap for the frozen block body. Default 4000. */
  frozenMemoryMaxChars?: number
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
    this.session = new MemorySession({
      memory,
      label: opts.id,
      ...(opts.frozenMemoryKinds !== undefined ? { frozenKinds: opts.frozenMemoryKinds } : {}),
      ...(opts.frozenMemoryK !== undefined ? { frozenK: opts.frozenMemoryK } : {}),
      ...(opts.frozenMemoryMaxChars !== undefined
        ? { frozenMaxChars: opts.frozenMemoryMaxChars }
        : {}),
    })
  }

  /**
   * Compute the frozen block once before the first request goes out, then
   * run the normal `LlmAgent` task path (which calls our `buildRequest`).
   * Memoized inside the session — cheap on every subsequent task.
   */
  protected override async handleTask(task: Task): Promise<unknown> {
    await this.session.ensureFrozenBlock()
    const out = await super.handleTask(task)
    await this.captureTurn(task, out)
    return out
  }

  /** Same pre-warm on resume so a parked-then-woken task still injects memory. */
  protected override async handleResume(task: Task, state: unknown): Promise<unknown> {
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
