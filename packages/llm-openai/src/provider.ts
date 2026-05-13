import OpenAI from 'openai'
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
} from '@aipehub/llm'

/**
 * Construction options for {@link OpenAIProvider}.
 *
 * Either pass an explicit {@link client} (typical in tests), or let the
 * provider build one from {@link apiKey} (or `process.env.OPENAI_API_KEY`
 * if no key is supplied).
 */
export interface OpenAIProviderOptions {
  /** API key. Defaults to `process.env.OPENAI_API_KEY`. */
  apiKey?: string
  /** Model id used when an `LlmRequest` does not specify one. */
  defaultModel?: string
  /**
   * Dependency-injection escape hatch. When provided, the provider uses this
   * instance instead of constructing its own. Intended for tests; production
   * callers will normally pass `apiKey` and let the provider build the client.
   */
  client?: OpenAI
}

/**
 * OpenAI-backed {@link LlmProvider}. Translates the provider-neutral
 * `LlmRequest` shape into a `chat.completions.create` payload and folds the
 * response back into an `LlmResponse`.
 *
 * Behavior notes:
 * - The `system` field (if present) is hoisted to a leading
 *   `{role: 'system', content}` message so the wire shape matches OpenAI's
 *   chat-completions convention.
 * - We send `max_completion_tokens`, not the deprecated `max_tokens` — newer
 *   reasoning models require the new field and the old one is being removed.
 * - `finish_reason` of `'stop'` maps to `'end_turn'`, `'length'` to
 *   `'max_tokens'`. Anything else (e.g. `tool_calls`, `content_filter`,
 *   `null`) maps to `'error'` so callers can surface it.
 * - Response text is `choices[0].message.content ?? ''`.
 * - SDK exceptions (auth, rate-limit, transport) are not caught — they
 *   propagate so `LlmAgent` can map them to a failed `TaskResult`.
 */
export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai'

  private readonly client: OpenAI
  private readonly defaultModel: string

  constructor(opts: OpenAIProviderOptions = {}) {
    this.defaultModel = opts.defaultModel ?? 'gpt-4o-mini'
    if (opts.client) {
      this.client = opts.client
    } else {
      const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY
      this.client = new OpenAI(apiKey ? { apiKey } : {})
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
    if (req.system !== undefined) {
      messages.push({ role: 'system', content: req.system })
    }
    for (const m of req.messages) {
      messages.push({ role: m.role, content: m.content })
    }

    const body: Record<string, unknown> = {
      model: req.model ?? this.defaultModel,
      messages,
    }
    if (req.maxTokens !== undefined) body.max_completion_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature

    // We use the SDK's loosely-typed call signature so the same code path
    // works whether `client` is the real SDK or a test fake. SDK errors
    // (auth, rate-limit, transport) propagate to the caller untouched.
    const raw = (await (
      this.client.chat.completions.create as unknown as (
        b: Record<string, unknown>,
      ) => Promise<OpenAIChatCompletionLike>
    )(body)) as OpenAIChatCompletionLike

    const firstChoice = raw.choices?.[0]
    const text = firstChoice?.message?.content ?? ''

    const out: LlmResponse = {
      text,
      stopReason: mapStopReason(firstChoice?.finish_reason),
      raw,
    }
    if (raw.usage) {
      out.usage = {
        inputTokens: raw.usage.prompt_tokens,
        outputTokens: raw.usage.completion_tokens,
      }
    }
    return out
  }
}

/**
 * Minimal structural shape of an OpenAI `ChatCompletion` we touch. Declared
 * locally rather than imported from the SDK so v0.2 doesn't pin to a
 * particular minor version of the vendor types.
 */
interface OpenAIChatCompletionLike {
  choices?: ReadonlyArray<{
    message?: { content?: string | null }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number }
}

function mapStopReason(reason: string | null | undefined): LlmStopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    default:
      return 'error'
  }
}
