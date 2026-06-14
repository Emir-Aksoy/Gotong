/**
 * `HubStewardAgent` — natural-language → `StewardProposal`.
 *
 * The "管家". A member describes what they want done to their own hub resources
 * (agents / workflows) in plain language; this agent emits a structured proposal
 * (a reply + zero or more `StewardAction`s). It does NOT execute writes and does
 * NOT run a tool loop — mirroring `WorkflowAssistantAgent` (emit structured
 * output), not `DispatchToolset` (drive tools). The host's `HostStewardService`
 * (SW-M3/M4) re-classifies + executes each action behind the existing member
 * services + a Phase 16 approval inbox.
 *
 * Why a thin classifier and not an autonomous agent: the North Star says the
 * framework runs no autonomous decisions — the steward DRAFTS, a human reviews +
 * executes. Keeping it single-shot + structured also makes it deterministically
 * testable with a mock provider (no real LLM in CI) and keeps the failure modes
 * of self-correcting loops (cost / latency / convergence) out of scope.
 */

import {
  LlmAgent,
  type LlmAgentOptions,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmTaskOutput,
} from '@aipehub/llm'
import type { Task } from '@aipehub/core'

import type { HubStewardPayload, StewardAction, StewardParseStatus } from './types.js'
import { buildStewardSystemPrompt, parseStewardProposal, renderStewardUserMessage } from './prompt.js'

const DEFAULT_ID = 'hub-steward'
const DEFAULT_CAPABILITIES = ['hub:steward']

/** Convenience ids so hosts / tests reference them in one place. */
export const HUB_STEWARD_CAPABILITY = 'hub:steward'
export const HUB_STEWARD_DEFAULT_ID = DEFAULT_ID

/**
 * What `HubStewardAgent` returns. Extends `LlmTaskOutput` so it's a well-behaved
 * `LlmAgent` subclass (`text` = the reply a transcript reader sees; `stopReason`
 * / `usage` / `by` from the base contract). The steward-specific fields
 * (`reply`, `actions`, `raw`, `parseStatus`) are additive.
 *
 * Note `actions` are UNTIERED `StewardAction`s — the agent extracts + validates
 * shape only. The host's `plan()` classifies each into a `ClassifiedAction`
 * (it needs hub context — the member's cross-hub workflow ids — to tier them).
 */
export interface HubStewardOutput extends LlmTaskOutput {
  /** The steward's conversational reply (always present). */
  reply: string
  /** The well-formed actions extracted from the LLM JSON (malformed ones dropped). */
  actions: StewardAction[]
  /** Full LLM response before extraction — useful for debugging parse failures. */
  raw: string
  /** Verdict on extracting the proposal — see {@link StewardParseStatus}. */
  parseStatus: StewardParseStatus
}

/**
 * Constructor options. Accepts everything `LlmAgent` accepts EXCEPT `system`
 * (the steward owns its prompt) — pass `systemOverride` only if you really mean
 * to replace the contract. `id` / `capabilities` default but can be overridden.
 */
export interface HubStewardOptions extends Omit<LlmAgentOptions, 'system' | 'id'> {
  id?: string
  /**
   * Replace the built-in system prompt. **Only if you know what you're doing** —
   * the default prompt encodes the action vocabulary + the two hard rules
   * (dangerous / cross-hub are propose-only; credentials / peers / security are
   * out of scope). A custom prompt that drops them produces unsafe proposals.
   */
  systemOverride?: string
}

export class HubStewardAgent extends LlmAgent {
  private readonly stewardSystem: string

  constructor(opts: HubStewardOptions) {
    const { systemOverride, id, capabilities, ...rest } = opts
    super({
      ...rest,
      id: id ?? DEFAULT_ID,
      capabilities: capabilities ?? DEFAULT_CAPABILITIES,
      system: buildStewardSystemPrompt(systemOverride),
    })
    this.stewardSystem = this.defaults.system ?? ''
  }

  /** Build the LLM request: the steward system prompt + instruction + snapshot. */
  protected override buildRequest(task: Task): LlmRequest {
    const payload = task.payload as HubStewardPayload | undefined
    if (!payload || typeof payload !== 'object' || typeof payload.instruction !== 'string') {
      throw new Error('hub:steward payload must be { instruction: string, snapshot?: {...} }')
    }
    if (payload.instruction.trim().length === 0) {
      throw new Error('hub:steward payload.instruction must be non-empty')
    }

    const messages: LlmMessage[] = []
    // Prior conversational turns (multi-step edits like "再礼貌一点") ride first,
    // so the model can resolve back-references against what it already proposed.
    if (Array.isArray(payload.history)) {
      for (const turn of payload.history) {
        if (turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string') {
          messages.push({ role: turn.role, content: turn.content })
        }
      }
    }
    messages.push({ role: 'user', content: renderStewardUserMessage(payload) })

    const req: LlmRequest = { messages, system: this.stewardSystem }
    if (this.defaults.maxTokens !== undefined) req.maxTokens = this.defaults.maxTokens
    if (this.defaults.temperature !== undefined) req.temperature = this.defaults.temperature
    if (this.defaults.model !== undefined) req.model = this.defaults.model
    return req
  }

  /** Extract the `StewardProposal` from the LLM reply. */
  protected override parseResponse(
    response: LlmResponse,
    _task: Task,
    _toolRounds = 0,
  ): HubStewardOutput {
    const raw = response.text
    const { proposal, status } = parseStewardProposal(raw)
    const out: HubStewardOutput = {
      // LlmTaskOutput contract: `text` is what transcript / SDK consumers see —
      // the human-readable reply, not the raw JSON.
      text: proposal.reply,
      stopReason: response.stopReason,
      by: this.provider.name,
      reply: proposal.reply,
      actions: proposal.actions,
      raw,
      parseStatus: status,
    }
    if (response.usage) out.usage = response.usage
    return out
  }
}
