import {
  AgentParticipant,
  type AgentOptions,
  type Task,
} from '@aipehub/core'
import { EMPTY_SERVICE_CTX, type ServiceCtx } from '@aipehub/services-sdk'
import type { LlmProvider, LlmRequest, LlmResponse } from './types.js'

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
   */
  protected parseResponse(response: LlmResponse, _task: Task): LlmTaskOutput {
    const out: LlmTaskOutput = {
      text: response.text,
      stopReason: response.stopReason,
      by: this.provider.name,
    }
    if (response.usage) out.usage = response.usage
    return out
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const req = this.buildRequest(task)
    const res = await this.provider.complete(req)
    return this.parseResponse(res, task)
  }
}
