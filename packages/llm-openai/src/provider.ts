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
 *
 * The same provider class also backs **OpenAI-compatible** vendors —
 * DeepSeek, Qwen via DashScope, Zhipu (智谱), Moonshot (Kimi), local
 * Ollama / vLLM endpoints — by setting {@link baseURL}, {@link name},
 * and (usually) {@link maxTokensField} to `'max_tokens'`. AipeHub's
 * host wires this up automatically when `ManagedAgentSpec.provider`
 * is `'openai-compatible'`.
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
  /**
   * Override the API base URL. Use this for OpenAI-compatible vendors —
   * DeepSeek (`https://api.deepseek.com/v1`), Qwen via DashScope
   * (`https://dashscope.aliyuncs.com/compatible-mode/v1`), Zhipu
   * (`https://open.bigmodel.cn/api/paas/v4`), Moonshot
   * (`https://api.moonshot.cn/v1`), Ollama (`http://localhost:11434/v1`),
   * local vLLM, etc. Leave empty to hit api.openai.com.
   */
  baseURL?: string
  /**
   * Human-readable provider name used in {@link LlmProvider.name} (which
   * appears in logs and the `raw` envelope). Defaults to `'openai'`.
   * Set to something like `'deepseek'` or `'qwen'` when you point this
   * provider at an OpenAI-compatible endpoint so downstream logs read
   * truthfully.
   */
  name?: string
  /**
   * Which field name to use for the output-length cap on outgoing
   * requests. OpenAI's newer reasoning models require
   * `'max_completion_tokens'` (and reject the legacy `'max_tokens'`),
   * while almost every OpenAI-compatible vendor (DeepSeek, Qwen, Zhipu,
   * Moonshot, Ollama, vLLM, …) still only understands the legacy
   * `'max_tokens'`. Defaults to `'max_completion_tokens'` so OpenAI-native
   * users (the original behavior) keep working unchanged.
   */
  maxTokensField?: 'max_completion_tokens' | 'max_tokens'
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
  readonly name: string

  private readonly client: OpenAI
  private readonly defaultModel: string
  private readonly maxTokensField: 'max_completion_tokens' | 'max_tokens'

  constructor(opts: OpenAIProviderOptions = {}) {
    this.name = opts.name ?? 'openai'
    this.defaultModel = opts.defaultModel ?? 'gpt-4o-mini'
    this.maxTokensField = opts.maxTokensField ?? 'max_completion_tokens'
    if (opts.client) {
      this.client = opts.client
    } else {
      // Build the SDK client. We only set fields the OpenAI SDK actually
      // accepts in its constructor (`apiKey`, `baseURL`); leaving them
      // undefined makes the SDK fall back to its own defaults
      // (api.openai.com + OPENAI_API_KEY env).
      const init: { apiKey?: string; baseURL?: string } = {}
      const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY
      if (apiKey) init.apiKey = apiKey
      if (opts.baseURL) init.baseURL = opts.baseURL
      this.client = new OpenAI(init)
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
    if (req.maxTokens !== undefined) body[this.maxTokensField] = req.maxTokens
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
