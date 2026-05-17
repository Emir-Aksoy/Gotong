/**
 * Provider-neutral types for LLM completion. Concrete provider packages
 * (e.g. @aipehub/llm-anthropic) translate these to/from their vendor SDK.
 *
 * Design goals:
 * - Smallest useful surface for v0.2 — non-streaming chat completion only.
 * - No tool-use, no images, no JSON mode hard-wired. Those are bigger
 *   features that deserve their own version bumps.
 * - Vendor-agnostic: nothing here references Claude / OpenAI specifics.
 */

/**
 * A turn in the conversation. We collapse "system" out of the role union
 * because it lives at the top level as a single string — this matches both
 * Anthropic's `system` field and is trivially mappable to OpenAI's
 * `{role:'system'}` first-message convention.
 */
export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LlmRequest {
  /** Top-level system prompt (Anthropic-style). Translators map to whatever the provider expects. */
  system?: string
  messages: LlmMessage[]
  /** Soft cap on output length. Provider may clamp to its own maximum. */
  maxTokens?: number
  /** 0..2 typically; passes through to provider untouched. */
  temperature?: number
  /** Per-request override of the provider's default model id. */
  model?: string
}

export type LlmStopReason = 'end_turn' | 'max_tokens' | 'error'

export interface LlmUsage {
  /**
   * Fresh (un-cached) input tokens. For providers without prompt
   * caching this is the full prompt size. For providers WITH prompt
   * caching (Anthropic, OpenAI 2024+), this is only the slice that
   * was neither written to cache nor read from cache.
   */
  inputTokens: number
  outputTokens: number
  /**
   * Tokens written to the prompt cache on this call (Anthropic
   * `cache_creation_input_tokens`). Billed at a premium (~1.25× input).
   * Omitted when zero or when the provider doesn't expose it.
   */
  cacheCreationTokens?: number
  /**
   * Tokens read from the prompt cache on this call (Anthropic
   * `cache_read_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens`).
   * Billed at a steep discount (~0.1× input). Omitted when zero or
   * when the provider doesn't expose it.
   */
  cacheReadTokens?: number
}

export interface LlmResponse {
  text: string
  stopReason: LlmStopReason
  usage?: LlmUsage
  /**
   * The raw provider response. Escape hatch for callers who need fields the
   * neutral interface doesn't expose. Do not rely on its shape across providers.
   */
  raw?: unknown
}

/**
 * Vendor adapter. One per provider package (anthropic / openai / mock / ...).
 *
 * `complete()` MUST throw on transport or auth errors so the LlmAgent can
 * map them into a failed TaskResult. A response with `stopReason: 'error'`
 * is for soft-fail cases where the provider returned a body but indicated
 * something went wrong mid-generation.
 */
export interface LlmProvider {
  /** Human-readable identifier — used in logs and the `raw` envelope. */
  readonly name: string
  complete(req: LlmRequest): Promise<LlmResponse>
}
