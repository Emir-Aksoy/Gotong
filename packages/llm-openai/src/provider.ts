import OpenAI from 'openai'
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
  /**
   * Number of **additional** attempts to make on transient transport-layer
   * errors (Premature close / socket hang up / ECONNRESET / 5xx / 429).
   * The first attempt is always made; this controls retries on top of it.
   * Total attempts = `maxRetries + 1`. Default `0` (no retries) so existing
   * callers see no behavior change. Suggested for OpenAI-compatible vendors
   * with flaky upstreams: `2` or `3`. Auth errors (401/403) and 4xx (other
   * than 429) never retry — they're not transient. Backoff is 500ms × 2ⁿ
   * with full jitter, capped at 5s per wait.
   */
  maxRetries?: number
  /**
   * Override the default backoff schedule. Useful in tests where you want
   * instant retries. Receives the 1-indexed attempt number (1 = before
   * first retry, 2 = before second, …) and returns ms to wait. Default
   * is `500 * 2^(n-1)` with up to 200ms jitter.
   */
  retryBackoffMs?: (attempt: number) => number
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
 *   Override via `maxTokensField` for vendors still on the legacy field.
 * - `finish_reason` of `'stop'` maps to `'end_turn'`, `'length'` to
 *   `'max_tokens'`, `'tool_calls'` to `'tool_use'` (v0.3+). Anything else
 *   (e.g. `content_filter`, `null`) maps to `'error'` so callers can surface it.
 * - Response text is `choices[0].message.content ?? ''`. Tool calls are
 *   extracted into `response.toolUses` (v0.3+).
 * - SDK exceptions (auth, rate-limit, transport) are not caught — they
 *   propagate so `LlmAgent` can map them to a failed `TaskResult`.
 *
 * Tool-use translation:
 * - Provider-neutral `LlmToolDefinition` → OpenAI's `{type:'function',function:{name,description,parameters}}`.
 * - Provider-neutral assistant `tool_use` blocks → `tool_calls` array on
 *   the assistant message; `LlmToolUseBlock.input` is JSON-stringified into
 *   `tool_calls[].function.arguments` (OpenAI's wire format).
 * - Provider-neutral `tool_result` blocks become standalone `{role:'tool',
 *   tool_call_id, content}` messages — OpenAI's chat format has no
 *   `tool_result` block type; instead, each tool result is its own message.
 */
export class OpenAIProvider implements LlmProvider {
  readonly name: string

  private readonly client: OpenAI
  private readonly defaultModel: string
  private readonly maxTokensField: 'max_completion_tokens' | 'max_tokens'
  private readonly maxRetries: number
  private readonly retryBackoffMs: (attempt: number) => number

  constructor(opts: OpenAIProviderOptions = {}) {
    this.name = opts.name ?? 'openai'
    this.defaultModel = opts.defaultModel ?? 'gpt-4o-mini'
    this.maxTokensField = opts.maxTokensField ?? 'max_completion_tokens'
    this.maxRetries = Math.max(0, opts.maxRetries ?? 0)
    this.retryBackoffMs = opts.retryBackoffMs ?? defaultBackoff
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
    const messages: Array<Record<string, unknown>> = []
    if (req.system !== undefined) {
      messages.push({ role: 'system', content: req.system })
    }
    for (const m of req.messages) {
      messages.push(...translateMessage(m))
    }

    const body: Record<string, unknown> = {
      model: req.model ?? this.defaultModel,
      messages,
    }
    if (req.maxTokens !== undefined) body[this.maxTokensField] = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          parameters: t.inputSchema,
        },
      }))
    }

    let lastErr: unknown
    const totalAttempts = this.maxRetries + 1
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
        // We use the SDK's loosely-typed call signature so the same code path
        // works whether `client` is the real SDK or a test fake.
        const raw = (await (
          this.client.chat.completions.create as unknown as (
            b: Record<string, unknown>,
          ) => Promise<OpenAIChatCompletionLike>
        )(body)) as OpenAIChatCompletionLike

        const firstChoice = raw.choices?.[0]
        const text = firstChoice?.message?.content ?? ''
        const toolUses = extractToolUses(firstChoice?.message?.tool_calls)
        const out: LlmResponse = {
          text,
          stopReason: mapStopReason(firstChoice?.finish_reason),
          raw,
        }
        if (toolUses.length > 0) out.toolUses = toolUses
        if (raw.usage) {
          out.usage = {
            inputTokens: raw.usage.prompt_tokens,
            outputTokens: raw.usage.completion_tokens,
          }
        }
        return out
      } catch (err) {
        lastErr = err
        // Don't retry on permanent errors (auth, model-not-found, etc.) or
        // when we've exhausted the budget. Any 4xx except 429 is permanent;
        // network-layer + 5xx + 429 are transient.
        if (attempt >= totalAttempts || !isTransientError(err)) {
          throw err
        }
        const waitMs = this.retryBackoffMs(attempt)
        await sleep(waitMs)
        // Loop and retry with the same body.
      }
    }
    // Defensive: the loop either returns or throws on every iteration; this
    // line keeps TypeScript happy if it can't prove the loop always exits.
    throw lastErr instanceof Error ? lastErr : new Error('OpenAIProvider: retry loop exited without result')
  }
}

/**
 * Translate one provider-neutral message into one *or more* OpenAI
 * messages. `tool_result` blocks fan out into their own `{role:'tool', ...}`
 * messages, which is why this returns an array rather than a single record.
 */
function translateMessage(m: LlmMessage): Array<Record<string, unknown>> {
  if (typeof m.content === 'string') {
    return [{ role: m.role, content: m.content }]
  }
  if (m.role === 'assistant') {
    // Assistant turns can mix text + tool_use. OpenAI requires `content`
    // to be either a string OR null when `tool_calls` is set. Collapse
    // text blocks; carry tool_use blocks across as `tool_calls`.
    const textParts: string[] = []
    const toolCalls: Array<Record<string, unknown>> = []
    for (const block of m.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            // OpenAI wants a JSON-encoded string here.
            arguments: JSON.stringify(block.input ?? {}),
          },
        })
      }
      // tool_result blocks should never appear on an assistant turn; ignore.
    }
    const out: Record<string, unknown> = {
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('') : null,
    }
    if (toolCalls.length > 0) out.tool_calls = toolCalls
    return [out]
  }
  // User turn: text passes through as content; tool_result blocks fan out
  // into their own `{role:'tool', ...}` messages. Plain text blocks (rare
  // on user turns in tool-use loops) are concatenated.
  const userMessages: Array<Record<string, unknown>> = []
  const textParts: string[] = []
  for (const block of m.content) {
    if (block.type === 'text') {
      textParts.push(block.text)
    } else if (block.type === 'tool_result') {
      const content =
        typeof block.content === 'string'
          ? block.content
          : block.content.map((tb) => tb.text).join('')
      userMessages.push({
        role: 'tool',
        tool_call_id: block.toolUseId,
        content,
      })
    }
  }
  if (textParts.length > 0) {
    userMessages.unshift({ role: 'user', content: textParts.join('') })
  }
  if (userMessages.length === 0) {
    // Defensive: don't drop a message silently — emit an empty user turn.
    userMessages.push({ role: 'user', content: '' })
  }
  return userMessages
}

/**
 * Pull `tool_use` blocks out of an OpenAI `tool_calls` array. Returns
 * `[]` when the field is absent — the caller branches on
 * `LlmResponse.toolUses` being present + non-empty.
 */
function extractToolUses(
  toolCalls:
    | ReadonlyArray<{
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    | undefined,
): LlmToolUseBlock[] {
  if (!toolCalls || toolCalls.length === 0) return []
  const out: LlmToolUseBlock[] = []
  for (const tc of toolCalls) {
    if (
      tc.type !== 'function' ||
      typeof tc.id !== 'string' ||
      !tc.function ||
      typeof tc.function.name !== 'string'
    ) {
      continue
    }
    let input: Record<string, unknown> = {}
    if (typeof tc.function.arguments === 'string' && tc.function.arguments.length > 0) {
      try {
        const parsed = JSON.parse(tc.function.arguments)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>
        }
      } catch {
        // OpenAI occasionally emits non-JSON in `arguments` when the
        // model errors mid-stream. Surface the raw string under a
        // conventional `_raw` key so the agent can see what happened
        // without crashing on JSON.parse.
        input = { _raw: tc.function.arguments }
      }
    }
    out.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input,
    })
  }
  return out
}

// --- transient-error detection -----------------------------------------

/**
 * Classify an SDK / fetch error as transient (worth retrying) vs permanent.
 *
 * Transient (retry):
 *   - `Premature close` — server closed connection mid-response. This is the
 *     specific failure we saw on DeepSeek and the original motivation for
 *     this helper.
 *   - `socket hang up`, `fetch failed`, `aborted`, `read ECONNRESET` — TCP
 *     /HTTP-client surface terms for "connection died mid-flight".
 *   - Node socket error codes: `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`,
 *     `EPIPE`, `EAI_AGAIN`, undici's `UND_ERR_SOCKET`. Looked up on both
 *     the error and `error.cause` (undici nests the underlying socket
 *     error there).
 *   - HTTP `429` (rate-limited) and any `5xx` (upstream is sick).
 *
 * Permanent (do not retry):
 *   - `401` / `403` — bad key.
 *   - `404` — wrong model id.
 *   - Other 4xx — bad request body.
 *
 * Exposed for tests; not part of the public API.
 */
export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as {
    name?: unknown
    message?: unknown
    code?: unknown
    status?: unknown
    cause?: { name?: unknown; code?: unknown; message?: unknown }
  }
  // AbortController.abort() throws a DOMException with name='AbortError'.
  // The caller deliberately cancelled the request — retrying would
  // both ignore their intent and defeat the cancellation semantics.
  // Distinguished from network-layer "aborted" disconnects (which
  // raise a regular Error and are matched by the regex below).
  if (e.name === 'AbortError' || e.cause?.name === 'AbortError') return false
  if (e.code === 'ABORT_ERR' || e.cause?.code === 'ABORT_ERR') return false
  const msg = typeof e.message === 'string' ? e.message : ''
  if (
    /premature close|socket hang up|fetch failed|aborted|read econnreset|etimedout/i.test(msg)
  ) {
    return true
  }
  const causeMsg = typeof e.cause?.message === 'string' ? e.cause.message : ''
  if (causeMsg && /premature close|socket hang up|fetch failed/i.test(causeMsg)) {
    return true
  }
  const code = (typeof e.code === 'string' ? e.code : '')
    || (typeof e.cause?.code === 'string' ? e.cause.code : '')
  const transientCodes = [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  ]
  if (transientCodes.includes(code)) return true
  const status = typeof e.status === 'number' ? e.status : 0
  if (status === 429 || (status >= 500 && status <= 599)) return true
  return false
}

function defaultBackoff(attempt: number): number {
  // 500ms × 2^(n-1) capped at 5s, plus up to 200ms jitter.
  const base = Math.min(500 * Math.pow(2, attempt - 1), 5000)
  return base + Math.floor(Math.random() * 200)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Minimal structural shape of an OpenAI `ChatCompletion` we touch. Declared
 * locally rather than imported from the SDK so v0.2 doesn't pin to a
 * particular minor version of the vendor types.
 */
interface OpenAIChatCompletionLike {
  choices?: ReadonlyArray<{
    message?: {
      content?: string | null
      tool_calls?: ReadonlyArray<{
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
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
    case 'tool_calls':
      return 'tool_use'
    default:
      return 'error'
  }
}
