import {
  AgentParticipant,
  type AgentOptions,
  type Task,
} from '@aipehub/core'
import { EMPTY_SERVICE_CTX, type ServiceCtx } from '@aipehub/services-sdk'
import type {
  LlmAgentToolset,
  LlmContentBlock,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmToolDefinition,
  LlmToolResultBlock,
  LlmToolUseBlock,
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
   * `handleTask` invocation. Each round = one provider.complete() that
   * returned `tool_use`. After this many rounds the agent aborts the
   * task with an error rather than risk an infinite loop (e.g. a
   * model that calls the same broken tool forever). Default: 8.
   *
   * Increase for legitimately deep workflows (multi-file refactors,
   * iterative debugging). Decrease for tight per-task budgets.
   */
  maxToolRounds?: number
  /**
   * B2.2 — invoked once per `provider.complete(req)` (so EVERY round
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
   * EVERY provider.complete, including each round of the tool-use
   * loop. Throwing aborts the task with the thrown error — the host
   * picks that up as the normal failure path.
   */
  protected readonly preCallHook?: (task: Task) => void | Promise<void>

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
  }

  /**
   * Default payload → request translation. Subclasses override for custom
   * prompt construction (e.g. injecting tool descriptions, retrieved context).
   */
  protected buildRequest(task: Task): LlmRequest {
    const payload = task.payload as LlmTaskPayload | undefined

    let userContent: string
    let perTaskSystem: string | undefined
    let perTaskMaxTokens: number | undefined
    let perTaskTemperature: number | undefined
    let perTaskModel: string | undefined
    let history: { role: 'user' | 'assistant'; content: string }[] | undefined

    if (typeof payload === 'string') {
      userContent = payload
    } else if (payload && typeof payload === 'object') {
      if (typeof payload.prompt === 'string') {
        userContent = payload.prompt
      } else if (typeof payload.topic === 'string') {
        userContent = `Please write about: ${payload.topic}`
      } else {
        // Unrecognized shape — stringify it so the model still sees something.
        userContent = JSON.stringify(payload)
      }
      perTaskSystem = payload.system
      perTaskMaxTokens = payload.maxTokens
      perTaskTemperature = payload.temperature
      perTaskModel = payload.model
      history = payload.history
    } else {
      userContent = task.title ?? ''
    }

    const messages: LlmRequest['messages'] = []
    if (history) messages.push(...history)
    messages.push({ role: 'user', content: userContent })

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
    if (!this.toolset) {
      // No toolset attached — same code path as v0.2.
      const req = this.buildRequest(task)
      if (this.preCallHook) await this.preCallHook(task)
      const res = await this.provider.complete(req)
      return this.parseResponse(res, task, 0)
    }
    return this.handleTaskWithTools(task)
  }

  /**
   * Run the multi-turn tool-use loop. Stops on the first non-`tool_use`
   * stop reason or after `maxToolRounds` rounds, whichever comes first.
   *
   * Loop body per round:
   *   1. Call `provider.complete(req)`.
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
      const res = await this.provider.complete(req)
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
