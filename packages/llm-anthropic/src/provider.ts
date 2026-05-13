import Anthropic from '@anthropic-ai/sdk'
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
} from '@aipehub/llm'

/**
 * Construction options for {@link AnthropicProvider}.
 *
 * Either pass an explicit {@link client} (typical in tests), or let the
 * provider build one from {@link apiKey} (or `process.env.ANTHROPIC_API_KEY`
 * if no key is supplied).
 */
export interface AnthropicProviderOptions {
  /** API key. Defaults to `process.env.ANTHROPIC_API_KEY`. */
  apiKey?: string
  /** Model id used when an `LlmRequest` does not specify one. */
  defaultModel?: string
  /**
   * Cap on output tokens used when an `LlmRequest` does not specify one.
   * Anthropic's API REQUIRES `max_tokens` on every call — we always send
   * something. Default: 1024.
   */
  defaultMaxTokens?: number
  /**
   * Dependency-injection escape hatch. When provided, the provider uses this
   * instance instead of constructing its own. Intended for tests; production
   * callers will normally pass `apiKey` and let the provider build the client.
   */
  client?: Anthropic
}

/**
 * Anthropic-backed {@link LlmProvider}. Translates the provider-neutral
 * `LlmRequest` shape into Anthropic's `messages.create` payload and folds the
 * response back into an `LlmResponse`.
 *
 * Behavior notes:
 * - `stop_reason` of `end_turn` / `stop_sequence` collapses to `'end_turn'`.
 *   `max_tokens` maps to `'max_tokens'`. Everything else (e.g. `tool_use`,
 *   `pause_turn`, future values) maps to `'error'` so callers can surface it.
 * - Response text is the concatenation of all `content[].text` for blocks
 *   whose `type === 'text'`. Tool-use blocks are ignored in v0.2.
 * - SDK exceptions (auth, rate-limit, transport) are not caught — they
 *   propagate so `LlmAgent` can map them to a failed `TaskResult`.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic'

  private readonly client: Anthropic
  private readonly defaultModel: string
  private readonly defaultMaxTokens: number

  constructor(opts: AnthropicProviderOptions = {}) {
    // Default to Claude's most capable model. Override via `defaultModel` for
    // a cheaper/faster pick (e.g. `claude-sonnet-4-6`, `claude-haiku-4-5`).
    this.defaultModel = opts.defaultModel ?? 'claude-opus-4-7'
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 1024
    if (opts.client) {
      this.client = opts.client
    } else {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY
      this.client = new Anthropic(apiKey ? { apiKey } : {})
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: req.model ?? this.defaultModel,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    }
    if (req.system !== undefined) body.system = req.system
    if (req.temperature !== undefined) body.temperature = req.temperature

    // We use the SDK's loosely-typed call signature so the same code path
    // works whether `client` is the real SDK or a test fake. SDK errors
    // (auth, rate-limit, transport) propagate to the caller untouched.
    const raw = (await (
      this.client.messages.create as unknown as (
        b: Record<string, unknown>,
      ) => Promise<AnthropicMessageLike>
    )(body)) as AnthropicMessageLike

    const text = (raw.content ?? [])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')

    const out: LlmResponse = {
      text,
      stopReason: mapStopReason(raw.stop_reason),
      raw,
    }
    if (raw.usage) {
      out.usage = {
        inputTokens: raw.usage.input_tokens,
        outputTokens: raw.usage.output_tokens,
      }
    }
    return out
  }
}

/**
 * Minimal structural shape of an Anthropic `Message` we touch. Declared
 * locally rather than imported from the SDK so v0.2 doesn't pin to a
 * particular minor version of the vendor types.
 */
interface AnthropicMessageLike {
  content?: ReadonlyArray<{ type: string; text?: string }>
  stop_reason?: string | null
  usage?: { input_tokens: number; output_tokens: number }
}

function mapStopReason(reason: string | null | undefined): LlmStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn'
    case 'max_tokens':
      return 'max_tokens'
    default:
      return 'error'
  }
}
