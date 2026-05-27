import {
  AgentParticipant,
  type AgentOptions,
  type Task,
} from '@aipehub/core'
import { EMPTY_SERVICE_CTX, type ServiceCtx } from '@aipehub/services-sdk'
import type {
  LlmAgentToolset,
  LlmContentBlock,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
  LlmStreamChunk,
  LlmToolDefinition,
  LlmToolResultBlock,
  LlmToolUseBlock,
  LlmUsage,
} from './types.js'

/**
 * Default shape of a task payload for an LLM agent. Either pass a string
 * (treated as the user message) or an object with explicit fields. Subclasses
 * are free to override `buildRequest` and accept anything they want.
 */
export type LlmTaskPayload =
  | string
  | {
      /** The user-facing prompt content. */
      prompt?: string
      /** Free-form topic; if `prompt` is absent, this is wrapped in a sentence. */
      topic?: string
      /** Optional per-task override of the agent-level system prompt. */
      system?: string
      /** Optional per-task override of model parameters. */
      maxTokens?: number
      temperature?: number
      model?: string
      /** If present, used as the prior conversation turns (e.g. multi-turn). */
      history?: { role: 'user' | 'assistant'; content: string }[]
      /**
       * Phase 9 — direct `LlmMessage` list, replacing the
       * `prompt` + `history` + auto-string-wrap path. Set this when
       * the payload carries multimodal blocks (image / audio /
       * file_ref) — the `prompt: string` path only handles text.
       *
       * Precedence: when present, `messages` wins; `prompt`, `topic`,
       * `history` are ignored. `system` / `maxTokens` / `temperature`
       * / `model` still apply.
       *
       * Use case: a workflow form with `type: 'file'` produces a
       * payload like `{ pic: { type: 'file_ref', ... } }` — the
       * workflow runner or a wrapper agent reshapes that into
       * `{ messages: [{ role:'user', content:[fileRef, textBlock] }] }`
       * before dispatching to the LlmAgent.
       */
      messages?: LlmMessage[]
    }

export interface LlmAgentOptions extends AgentOptions {
  /** The provider that backs this agent. The agent does NOT own its credentials. */
  provider: LlmProvider
  /** Agent-level system prompt. Per-task `system` in the payload overrides this. */
  system?: string
  /** Default per-request output cap. */
  maxTokens?: number
  /** Default sampling temperature. */
  temperature?: number
  /** Default model id passed through to the provider. */
  model?: string
  /**
   * Pre-attached Hub Services handles (memory / artifact / datastore).
   * Per RFC §7, the host's LocalAgentPool resolves the agent yaml's
   * `uses:` block at spawn time and injects the resulting handles
   * here. The agent itself doesn't drive lifecycle — it just reads.
   *
   * Subclasses access via the protected `services` field. The base
   * `buildRequest` does **not** auto-inject service descriptions into
   * the system prompt; that's a per-agent design decision (see PR-13
   * templates for examples that do).
   *
   * Omit (or pass `undefined`) for the common case of an agent with
   * no `uses:` block — the field is then `EMPTY_SERVICE_CTX`, a
   * frozen `{}` so identity comparisons stay cheap.
   */
  services?: ServiceCtx
  /**
   * Optional toolset (typically an `McpToolset`) the LLM may call
   * during `handleTask`. When set, the agent runs a tool-use loop:
   * if the LLM's response includes `tool_use` blocks, the agent
   * executes them via `tools.callTool(...)`, feeds the results back,
   * and re-invokes the provider until a non-`tool_use` stop reason.
   *
   * Leave unset for plain text-in/text-out agents — the loop is then
   * skipped and behavior matches v0.2 exactly.
   *
   * The agent does NOT own the toolset's lifecycle: connect / disconnect
   * is the caller's responsibility, so a single toolset can be shared
   * across many agents within the same host.
   */
  tools?: LlmAgentToolset
  /**
   * Safety cap on the number of tool-use rounds within a single
   * `handleTask` invocation. Each round = one provider.stream() call
   * that returned `tool_use`. After this many rounds the agent aborts
   * the task with an error rather than risk an infinite loop (e.g. a
   * model that calls the same broken tool forever). Default: 8.
   *
   * Increase for legitimately deep workflows (multi-file refactors,
   * iterative debugging). Decrease for tight per-task budgets.
   */
  maxToolRounds?: number
  /**
   * B2.2 — invoked once per `provider.stream(req)` (so EVERY round
   * of the tool-use loop too, not just the first). Receives the
   * current `Task` so the hook can read `task.origin?.userId` for
   * quota attribution. Synchronous or async; throwing aborts the
   * task with the thrown error.
   *
   * Typical wiring: host's `OrgApiPool.makeLlmQuotaGate({metric:
   * 'llm_requests', period: 'daily'})` returns a function fit for
   * this slot. Absent → no gating (the local-only / SDK / test
   * default).
   */
  preCallHook?: (task: Task) => void | Promise<void>
  /**
   * Phase 6 #2 — auth-failure hook. Invoked when `provider.stream`
   * throws an error whose shape suggests the credential is invalid
   * (currently: `.status === 401` or the SDK exception class name
   * matches `/AuthenticationError/`). Best-effort: errors thrown by
   * the hook itself are swallowed (logged via `console.error`) so the
   * original LLM error reaches the task result intact.
   *
   * Typical wiring: host's LocalAgentPool builds a closure that
   * revokes the vault entry the resolved key came from, writes an
   * audit row, and invalidates the OrgApiPool cache — turning the
   * 401 into a one-time event rather than a tight error loop on
   * every subsequent task.
   *
   * Absent → no auto-revoke (the local-only / SDK / test default;
   * the agent just re-throws the 401 like any other provider error).
   */
  onAuthFailure?: (err: unknown, task: Task) => void | Promise<void>
  /**
   * Phase 8 M5 — per-chunk hook fired once per `LlmStreamChunk` the
   * provider yields, BEFORE the chunk is folded into the accumulated
   * `LlmResponse`. Used by the workflow runner to write per-chunk
   * transcript events (Phase 8 M6) which the web layer then forwards
   * over SSE to the admin UI (Phase 8 M7).
   *
   * Best-effort: errors thrown by the hook are caught + logged but
   * do NOT abort the stream. Treating chunk emission as load-bearing
   * for task success would couple the LLM agent to the transcript
   * service in a way that breaks SDK-only / test usage; the agent
   * still returns a complete `LlmResponse` even if every hook call
   * fails.
   *
   * Fires for EVERY provider call within a task — both the first
   * round and each subsequent tool-use round. Hooks that want to
   * scope per-round work should track that themselves.
   *
   * Absent → no per-chunk emission. The agent still consumes the
   * stream and returns an aggregated `LlmResponse` exactly as before.
   */
  onStreamChunk?: (chunk: LlmStreamChunk, task: Task) => void | Promise<void>
}

/**
 * Output shape returned by the default `handleTask` implementation. Subclasses
 * that override `parseResponse` can return anything they want.
 */
export interface LlmTaskOutput {
  text: string
  stopReason: LlmResponse['stopReason']
  usage?: LlmResponse['usage']
  /** Convenience: provider name that produced this output. */
  by: string
  /**
   * Number of tool-use rounds executed during this task. 0 when no
   * toolset was attached, or when the LLM never asked for a tool.
   * Useful for cost / latency observability.
   */
  toolRounds?: number
}

/**
 * An AgentParticipant that delegates `handleTask` to an LlmProvider.
 *
 * Two extension points for subclasses:
 *   - `buildRequest(task)` — translate a Task into an LlmRequest (default
 *     handles `LlmTaskPayload`).
 *   - `parseResponse(response, task)` — translate an LlmResponse into the
 *     final output object (default returns `LlmTaskOutput`).
 *
 * Override `handleTask` directly for full control (e.g. multi-step reasoning,
 * retry policies, JSON parsing with re-prompt on failure).
 *
 * When constructed with `tools: McpToolset` (or any `LlmAgentToolset`),
 * the default `handleTask` runs a multi-round tool-use loop — see
 * {@link LlmAgentOptions.tools}.
 */
export class LlmAgent extends AgentParticipant {
  protected readonly provider: LlmProvider
  protected readonly defaults: {
    system?: string
    maxTokens?: number
    temperature?: number
    model?: string
  }
  /**
   * Hub Services handles attached to this agent for its whole life.
   * `EMPTY_SERVICE_CTX` (a frozen `{}`) when the spawner didn't supply
   * a ctx — common for SDK-connected agents and tests. Subclasses
   * read e.g. `this.services.memory?.recall(...)` without worrying
   * about an undefined ctx.
   */
  protected readonly services: ServiceCtx
  /**
   * Tool runtime attached at construction. Undefined when this agent
   * was constructed without `tools:`. Subclasses can override
   * `handleTask` to drive tools differently, but the default loop
   * works against any `LlmAgentToolset`.
   */
  protected readonly toolset: LlmAgentToolset | undefined
  protected readonly maxToolRounds: number
  /**
   * B2.2 — pre-call hook (typically a quota gate). Invoked before
   * EVERY provider.stream, including each round of the tool-use
   * loop. Throwing aborts the task with the thrown error — the host
   * picks that up as the normal failure path.
   */
  protected readonly preCallHook?: (task: Task) => void | Promise<void>
  /**
   * Phase 6 #2 — see LlmAgentOptions.onAuthFailure doc. Captured on
   * spawn; called best-effort from the centralized call wrapper
   * inside handleTask / handleTaskWithTools.
   */
  protected readonly onAuthFailure?: (
    err: unknown,
    task: Task,
  ) => void | Promise<void>
  /**
   * Phase 8 M5 — see LlmAgentOptions.onStreamChunk doc. Captured on
   * spawn; called best-effort from the stream-consumer inside the
   * call wrapper. Errors are caught and logged; the stream keeps
   * going.
   */
  protected readonly onStreamChunk?: (
    chunk: LlmStreamChunk,
    task: Task,
  ) => void | Promise<void>

  constructor(opts: LlmAgentOptions) {
    super({ id: opts.id, capabilities: opts.capabilities })
    this.provider = opts.provider
    this.defaults = {
      system: opts.system,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      model: opts.model,
    }
    this.services = opts.services ?? EMPTY_SERVICE_CTX
    this.toolset = opts.tools
    this.maxToolRounds = opts.maxToolRounds ?? 8
    this.preCallHook = opts.preCallHook
    this.onAuthFailure = opts.onAuthFailure
    this.onStreamChunk = opts.onStreamChunk
  }

  /**
   * Phase 6 #2 — detect "the provider rejected our credential" from a
   * thrown error. Heuristic by design: SDKs differ in how they expose
   * this, but `.status === 401` is universal for HTTP-based providers
   * (OpenAI/Anthropic/Mistral SDKs all attach it), and an error class
   * named `AuthenticationError` is the de-facto convention. The
   * narrowness is intentional — we'd rather miss a credential failure
   * (next call also fails → operator sees 2x logs) than nuke a key
   * because of a transient 503 the provider sent with a misleading
   * error message.
   */
  protected isAuthFailure(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false
    const e = err as { status?: unknown; name?: unknown; constructor?: { name?: unknown } }
    if (typeof e.status === 'number' && e.status === 401) return true
    if (typeof e.name === 'string' && /AuthenticationError/i.test(e.name)) return true
    const cn = e.constructor?.name
    if (typeof cn === 'string' && /AuthenticationError/i.test(cn)) return true
    return false
  }

  /**
   * Phase 8 M5 — wrap `provider.stream` so all call sites (the
   * single-shot path and the multi-round tool-use loop) get auth
   * detection + per-chunk emission identically.
   *
   * Auth detection: a synchronous throw from `provider.stream(req)`
   * (or from the first `.next()` of the iterator) typically means
   * auth / transport failure. The onAuthFailure hook is best-effort:
   * a throwing hook is logged but does NOT mask the original provider
   * error — operators need the 401 surfaced clearly to debug.
   *
   * Per-chunk emission: every chunk yielded by the stream fires
   * `onStreamChunk(chunk, task)` BEFORE being folded into the
   * accumulated response. Hook errors are caught + logged, never
   * abort the stream. See `onStreamChunk` doc for rationale.
   *
   * The aggregated `LlmResponse` returned is the result of folding the
   * stream via the same rules as the standalone `drainStream` helper:
   * concatenated text, collected tool_uses, first usage observed,
   * terminal stopReason.
   */
  protected async streamWithAuthHook(
    req: LlmRequest,
    task: Task,
  ): Promise<LlmResponse> {
    let stream: AsyncIterable<LlmStreamChunk>
    try {
      stream = this.provider.stream(req)
    } catch (err) {
      await this.runAuthFailureHook(err, task)
      throw err
    }

    const textParts: string[] = []
    const toolUses: LlmToolUseBlock[] = []
    let usage: LlmUsage | undefined
    let stopReason: LlmStopReason = 'end_turn'
    let errorAppend: string | undefined

    try {
      for await (const chunk of stream) {
        // Per-chunk hook fires BEFORE accumulation so transcript
        // events arrive in true wire order. Best-effort.
        if (this.onStreamChunk) {
          try {
            await this.onStreamChunk(chunk, task)
          } catch (hookErr) {
            // eslint-disable-next-line no-console
            console.error('[llm-agent] onStreamChunk hook threw', hookErr)
          }
        }
        switch (chunk.type) {
          case 'text':
            if (chunk.text.length > 0) textParts.push(chunk.text)
            break
          case 'tool_use':
            toolUses.push(chunk.toolUse)
            break
          case 'usage':
            if (!usage) usage = chunk.usage
            break
          case 'end':
            stopReason = chunk.stopReason
            break
          case 'error':
            stopReason = 'error'
            errorAppend = `[${chunk.code}] ${chunk.message}`
            break
        }
      }
    } catch (err) {
      // Auth / transport errors that surface on iteration (e.g.
      // SDK threw between create() and first chunk) get the same
      // hook treatment as sync throws above.
      await this.runAuthFailureHook(err, task)
      throw err
    }

    let text = textParts.join('')
    if (errorAppend) text = text ? `${text}\n\n${errorAppend}` : errorAppend
    const out: LlmResponse = { text, stopReason }
    if (toolUses.length > 0) out.toolUses = toolUses
    if (usage) out.usage = usage
    return out
  }

  /**
   * Internal — invoke onAuthFailure best-effort when an error looks
   * like a credential rejection. Extracted so the sync-throw path and
   * the mid-iteration throw path share the same logic.
   */
  private async runAuthFailureHook(err: unknown, task: Task): Promise<void> {
    if (!this.onAuthFailure || !this.isAuthFailure(err)) return
    try {
      await this.onAuthFailure(err, task)
    } catch (hookErr) {
      // Best-effort: never let the auth-revoke hook mask the
      // original error. Operators need the 401 in the task result
      // to debug; hook failure goes to stderr where the host log
      // pipeline (pino) picks it up.
      // eslint-disable-next-line no-console
      console.error('[llm-agent] onAuthFailure hook threw', hookErr)
    }
  }

  /**
   * Default payload → request translation. Subclasses override for custom
   * prompt construction (e.g. injecting tool descriptions, retrieved context).
   */
  protected buildRequest(task: Task): LlmRequest {
    const payload = task.payload as LlmTaskPayload | undefined

    let messages: LlmRequest['messages']
    let perTaskSystem: string | undefined
    let perTaskMaxTokens: number | undefined
    let perTaskTemperature: number | undefined
    let perTaskModel: string | undefined

    if (typeof payload === 'string') {
      messages = [{ role: 'user', content: payload }]
    } else if (payload && typeof payload === 'object') {
      // Phase 9 — `messages` takes precedence. This is the multimodal
      // entry point: any payload carrying image / audio / file_ref
      // blocks rides here as an explicit `LlmMessage[]`. We trust the
      // caller's shape — providers (M2/M3) own the per-block
      // validation + translation.
      if (Array.isArray(payload.messages) && payload.messages.length > 0) {
        messages = payload.messages
      } else {
        let userContent: string
        if (typeof payload.prompt === 'string') {
          userContent = payload.prompt
        } else if (typeof payload.topic === 'string') {
          userContent = `Please write about: ${payload.topic}`
        } else {
          // Unrecognized shape — stringify so the model still sees something.
          userContent = JSON.stringify(payload)
        }
        messages = []
        if (payload.history) messages.push(...payload.history)
        messages.push({ role: 'user', content: userContent })
      }
      perTaskSystem = payload.system
      perTaskMaxTokens = payload.maxTokens
      perTaskTemperature = payload.temperature
      perTaskModel = payload.model
    } else {
      messages = [{ role: 'user', content: task.title ?? '' }]
    }

    const system = perTaskSystem ?? this.defaults.system
    const maxTokens = perTaskMaxTokens ?? this.defaults.maxTokens
    const temperature = perTaskTemperature ?? this.defaults.temperature
    const model = perTaskModel ?? this.defaults.model

    const req: LlmRequest = { messages }
    if (system !== undefined) req.system = system
    if (maxTokens !== undefined) req.maxTokens = maxTokens
    if (temperature !== undefined) req.temperature = temperature
    if (model !== undefined) req.model = model
    return req
  }

  /**
   * Default response → output translation. Override to e.g. parse JSON,
   * extract code blocks, or re-prompt on validation failure.
   *
   * `toolRounds` reflects how many tool-use turns ran before this final
   * response — subclasses that override should preserve / surface it for
   * cost observability.
   */
  protected parseResponse(
    response: LlmResponse,
    _task: Task,
    toolRounds = 0,
  ): LlmTaskOutput {
    const out: LlmTaskOutput = {
      text: response.text,
      stopReason: response.stopReason,
      by: this.provider.name,
    }
    if (response.usage) out.usage = response.usage
    if (toolRounds > 0) out.toolRounds = toolRounds
    return out
  }

  /**
   * Default tool-result flattener. The MCP `CallToolResult` `content`
   * array can contain text / image / resource blocks; only text is
   * something a current-gen LLM can consume directly. Concatenate all
   * text blocks; if none exist, fall back to a JSON dump so the model
   * at least sees that the call succeeded.
   *
   * Subclasses can override for richer flattening (e.g. summarize a
   * resource handle into a URL the next turn can fetch).
   */
  protected flattenToolResult(content: ReadonlyArray<unknown>): string {
    const parts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: unknown; text?: unknown }
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text)
        }
      }
    }
    if (parts.length > 0) return parts.join('')
    // No text blocks. Surface the shape so the LLM can at least see
    // that the call returned something. Truncate so a giant image
    // payload doesn't blow up the next turn's input.
    try {
      const dump = JSON.stringify(content)
      return dump.length > 2_000 ? dump.slice(0, 2_000) + '…(truncated)' : dump
    } catch {
      return '<unrenderable tool output>'
    }
  }

  protected async handleTask(task: Task): Promise<unknown> {
    // Phase 10 M2 — wrap the task body in the toolset's per-task
    // scope so DispatchToolset (and other ancestry/state-aware
    // toolsets) can inject AsyncLocalStorage context for the
    // duration of this task only. Legacy toolsets without
    // `runForTask` get the unwrapped path.
    const work = async (): Promise<unknown> => {
      if (!this.toolset) {
        // No toolset attached — same code path as v0.2.
        const req = this.buildRequest(task)
        if (this.preCallHook) await this.preCallHook(task)
        const res = await this.streamWithAuthHook(req, task)
        return this.parseResponse(res, task, 0)
      }
      return this.handleTaskWithTools(task)
    }
    if (this.toolset?.runForTask) {
      return this.toolset.runForTask(
        { id: task.id, from: task.from, ancestry: task.ancestry },
        work,
      )
    }
    return work()
  }

  /**
   * Run the multi-turn tool-use loop. Stops on the first non-`tool_use`
   * stop reason or after `maxToolRounds` rounds, whichever comes first.
   *
   * Loop body per round:
   *   1. Call `streamWithAuthHook(req, task)` which drives `provider.stream`.
   *   2. If stopReason !== 'tool_use' (or no tool_use blocks present),
   *      we're done — flatten via `parseResponse`.
   *   3. Otherwise, execute each tool_use via `toolset.callTool`.
   *      Errors (transport, unknown_tool, tool_call_failed) are caught
   *      and surfaced to the model as `isError: true` tool_result blocks
   *      — this lets the model recover by re-trying or picking a
   *      different tool, instead of bringing the whole task down.
   *   4. Append the assistant's `tool_use` blocks + the user's
   *      `tool_result` blocks to messages, and loop.
   */
  protected async handleTaskWithTools(task: Task): Promise<unknown> {
    const baseReq = this.buildRequest(task)
    // Snapshot the tool list once per task. Re-listing every round
    // would be wasteful — MCP tool schemas don't change mid-session
    // in practice, and the SDK doesn't push a tools-changed event we
    // can subscribe to.
    const tools = await this.listToolsForLlm()

    let req: LlmRequest =
      tools.length > 0 ? { ...baseReq, tools } : { ...baseReq }
    let rounds = 0

    while (true) {
      if (this.preCallHook) await this.preCallHook(task)
      const res = await this.streamWithAuthHook(req, task)
      const wantsTool =
        res.stopReason === 'tool_use' &&
        res.toolUses !== undefined &&
        res.toolUses.length > 0

      if (!wantsTool) {
        return this.parseResponse(res, task, rounds)
      }

      rounds++
      if (rounds > this.maxToolRounds) {
        // Surface as a soft-fail response so the caller still gets
        // partial text + usage rather than an unbounded throw.
        return this.parseResponse(
          {
            ...res,
            stopReason: 'error',
            text:
              (res.text ? res.text + '\n\n' : '') +
              `[llm-agent: aborted after ${this.maxToolRounds} tool-use rounds]`,
          },
          task,
          rounds,
        )
      }

      // toolUses is guaranteed defined by `wantsTool` above.
      const toolUses = res.toolUses as LlmToolUseBlock[]
      const assistantBlocks: LlmContentBlock[] = []
      if (res.text) assistantBlocks.push({ type: 'text', text: res.text })
      assistantBlocks.push(...toolUses)

      const toolResultBlocks: LlmToolResultBlock[] = []
      for (const tu of toolUses) {
        try {
          const out = await this.toolset!.callTool(tu.name, tu.input)
          const text = this.flattenToolResult(out.content)
          const block: LlmToolResultBlock = {
            type: 'tool_result',
            toolUseId: tu.id,
            content: text,
          }
          if (out.isError) block.isError = true
          toolResultBlocks.push(block)
        } catch (err) {
          // Errors from the toolset (unknown tool, dead server,
          // transport failure, tool_call_failed) are converted to
          // `isError: true` results. The model sees the failure and
          // can recover; the agent doesn't crash on a flaky tool.
          toolResultBlocks.push({
            type: 'tool_result',
            toolUseId: tu.id,
            content:
              err instanceof Error
                ? err.message
                : `tool '${tu.name}' threw: ${String(err)}`,
            isError: true,
          })
        }
      }

      req = {
        ...req,
        messages: [
          ...req.messages,
          { role: 'assistant', content: assistantBlocks },
          { role: 'user', content: toolResultBlocks },
        ],
      }
    }
  }

  /**
   * Snapshot the toolset's tools, normalizing the names to satisfy
   * the LLM tool-name regex `^[a-zA-Z0-9_-]+$`. MCP names that pass
   * through `McpToolset` (`<server>__<tool>`) already satisfy it;
   * hand-rolled toolsets must do the same.
   */
  protected async listToolsForLlm(): Promise<LlmToolDefinition[]> {
    if (!this.toolset) return []
    const raw = await this.toolset.listTools()
    // Strip down to the neutral shape so providers don't see extra
    // fields they don't understand.
    return raw.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.inputSchema,
    }))
  }
}

