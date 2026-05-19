import Anthropic from '@anthropic-ai/sdk'
import type {
  LlmContentBlock,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
  LlmToolUseBlock,
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
 *   `max_tokens` → `'max_tokens'`. `tool_use` → `'tool_use'` (v0.3+).
 *   Everything else (e.g. `pause_turn`, future values) maps to `'error'`
 *   so callers can surface it.
 * - Response text is the concatenation of all `content[].text` for blocks
 *   whose `type === 'text'`. `tool_use` blocks are extracted into
 *   `response.toolUses` (v0.3+); they are NOT folded into `text`.
 * - SDK exceptions (auth, rate-limit, transport) are not caught — they
 *   propagate so `LlmAgent` can map them to a failed `TaskResult`.
 *
 * Tool-use translation:
 * - Provider-neutral `LlmToolDefinition.inputSchema` → Anthropic's
 *   `input_schema` (snake_case).
 * - Provider-neutral `LlmToolResultBlock.{toolUseId,isError}` →
 *   `tool_use_id` / `is_error`.
 * - `LlmMessage.content` accepts either a plain string (legacy) or an
 *   array of content blocks (needed for tool-use round-trips).
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
      messages: req.messages.map(translateMessage),
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
    if (req.tools && req.tools.length > 0) {
      // Anthropic expects `input_schema`; our neutral type uses
      // `inputSchema`. Re-key here so providers/tests don't have to
      // think about which casing they're holding.
      body.tools = req.tools.map((t) => {
        const out: Record<string, unknown> = {
          name: t.name,
          input_schema: t.inputSchema,
        }
        if (t.description !== undefined) out.description = t.description
        return out
      })
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
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')

    const toolUses: LlmToolUseBlock[] = []
    for (const b of raw.content ?? []) {
      if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        toolUses.push({
          type: 'tool_use',
          id: b.id,
          name: b.name,
          // Anthropic guarantees `input` is a JSON object even when the
          // model called the tool with no args (it'll be `{}`). Falling
          // back to `{}` defensively so a malformed response doesn't
          // produce a non-object input downstream.
          input:
            b.input && typeof b.input === 'object' && !Array.isArray(b.input)
              ? (b.input as Record<string, unknown>)
              : {},
        })
      }
    }

    const out: LlmResponse = {
      text,
      stopReason: mapStopReason(raw.stop_reason),
      raw,
    }
    if (toolUses.length > 0) out.toolUses = toolUses
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
 * Translate a provider-neutral message to the Anthropic on-wire shape.
 * String content passes through; block-array content needs each block
 * re-keyed (`toolUseId` → `tool_use_id`, `isError` → `is_error`).
 */
function translateMessage(m: LlmMessage): Record<string, unknown> {
  if (typeof m.content === 'string') {
    return { role: m.role, content: m.content }
  }
  return {
    role: m.role,
    content: m.content.map(translateBlock),
  }
}

function translateBlock(block: LlmContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      }
    case 'tool_result': {
      const out: Record<string, unknown> = {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
      }
      if (typeof block.content === 'string') {
        out.content = block.content
      } else {
        out.content = block.content.map((tb) => ({ type: 'text', text: tb.text }))
      }
      if (block.isError) out.is_error = true
      return out
    }
  }
}

/**
 * Minimal structural shape of an Anthropic `Message` we touch. Declared
 * locally rather than imported from the SDK so v0.2 doesn't pin to a
 * particular minor version of the vendor types.
 */
interface AnthropicMessageLike {
  content?: ReadonlyArray<AnthropicContentBlock>
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
 * Structural superset of every block shape Anthropic can emit; we
 * discriminate on `type` at the use site.
 */
interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
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
    case 'tool_use':
      return 'tool_use'
    default:
      return 'error'
  }
}
