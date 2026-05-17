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
    const model = req.model ?? this.defaultModel
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    }
    if (req.system !== undefined) body.system = req.system
    // Opus 4.x ("thinking" models) reject `temperature` outright — the
    // API returns 400 even on values it would accept for other models.
    // Drop the param rather than forward and fail; callers that
    // really need a non-default temperature should pick a non-thinking
    // model. See README §"Claude Opus 4.7" for the full picture.
    if (req.temperature !== undefined && !isThinkingModel(model)) {
      body.temperature = req.temperature
    }

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
      const usage: LlmResponse['usage'] = {
        inputTokens: raw.usage.input_tokens,
        outputTokens: raw.usage.output_tokens,
      }
      // Prompt caching: only emit cache-token fields when non-zero
      // so accounting code doesn't have to special-case zero. Anthropic
      // reports `cache_creation_input_tokens` + `cache_read_input_tokens`
      // alongside `input_tokens`; the latter is *fresh* tokens only.
      if (raw.usage.cache_creation_input_tokens) {
        usage.cacheCreationTokens = raw.usage.cache_creation_input_tokens
      }
      if (raw.usage.cache_read_input_tokens) {
        usage.cacheReadTokens = raw.usage.cache_read_input_tokens
      }
      out.usage = usage
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
  usage?: {
    input_tokens: number
    output_tokens: number
    /** Tokens written to the prompt cache on this call. Premium-priced. */
    cache_creation_input_tokens?: number
    /** Tokens served from the prompt cache. Heavily discounted. */
    cache_read_input_tokens?: number
  }
}

/**
 * Models that reject `temperature` / `top_p` / `top_k` and demand
 * `temperature == 1`. Today: Opus 4.x. Future Anthropic "thinking"
 * models will follow the same pattern; we match by prefix so the next
 * Claude Opus drop works without a code change.
 */
function isThinkingModel(model: string): boolean {
  return model.startsWith('claude-opus-4')
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
