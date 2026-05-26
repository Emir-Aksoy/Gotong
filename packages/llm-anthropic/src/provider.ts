import Anthropic from '@anthropic-ai/sdk'
import type {
  LlmContentBlock,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
  LlmStreamChunk,
  LlmToolUseBlock,
  LlmUsage,
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

  /**
   * Phase 8 M2 — native streaming. Anthropic's SSE event vocabulary is:
   *
   *   message_start         — opens the message, carries initial usage
   *                           (input_tokens; output_tokens starts at 0)
   *   content_block_start   — opens a content block; type is either
   *                           'text' (will get text_delta events) or
   *                           'tool_use' (will get input_json_delta events
   *                           that accumulate to a JSON args string)
   *   content_block_delta   — delta into the open block:
   *                             { type: 'text_delta', text: '...' }
   *                           OR
   *                             { type: 'input_json_delta', partial_json: '...' }
   *   content_block_stop    — closes the current block. For tool_use we
   *                           parse the accumulated args JSON here and
   *                           emit our `tool_use` chunk.
   *   message_delta         — carries the final stop_reason + a partial
   *                           usage update (output_tokens fills in here)
   *   message_stop          — terminal event; we emit usage + end here.
   *
   * Translation contract (LlmStreamChunk):
   *   - text_delta → `{ type: 'text', text }` (empty strings filtered)
   *   - tool_use   → emitted exactly once per tool block on its
   *                  content_block_stop, with parsed input.
   *   - usage      → emitted once near the end. We coalesce
   *                  input_tokens (from message_start) + output_tokens
   *                  (from message_delta.usage) + cache_* if present.
   *   - end        → terminal; stopReason taken from message_delta.
   *
   * Errors:
   *   - SDK throws synchronously from `messages.create({stream:true})`
   *     (auth, rate-limit, transport) — propagate so LlmAgent's
   *     onAuthFailure path fires. We do NOT swallow into an 'error' chunk
   *     for these; that's the LlmStreamChunk contract.
   *   - Mid-stream malformed JSON in a tool_use input → emit an `error`
   *     chunk with code 'malformed_tool_args' and stop. Hard fail would
   *     lose the partial text the model already produced.
   */
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamChunk> {
    const body = this.buildBody(req)
    body.stream = true
    return this.streamImpl(body, signal)
  }

  private async *streamImpl(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncIterable<LlmStreamChunk> {
    // The SDK's stream() returns an async iterable of SSE events. We
    // type-check duck-style — the test fake mirrors the same shape.
    const sdkStream = await (
      this.client.messages.create as unknown as (
        b: Record<string, unknown>,
        opts?: { signal?: AbortSignal },
      ) => Promise<AsyncIterable<AnthropicStreamEvent>>
    )(body, signal ? { signal } : undefined)

    // Per-block scratch state. Anthropic SSE always opens exactly one
    // block at a time (we never see overlapping content_block_start
    // events), so a single slot is enough.
    let openBlock:
      | { kind: 'text' }
      | { kind: 'tool_use'; id: string; name: string; argsJson: string }
      | null = null

    let inputTokens = 0
    let cacheCreationTokens = 0
    let cacheReadTokens = 0
    let outputTokens = 0
    let stopReason: LlmStopReason = 'end_turn'

    for await (const ev of sdkStream) {
      switch (ev.type) {
        case 'message_start': {
          const u = ev.message?.usage
          if (u) {
            inputTokens = u.input_tokens ?? 0
            cacheCreationTokens = u.cache_creation_input_tokens ?? 0
            cacheReadTokens = u.cache_read_input_tokens ?? 0
            // output_tokens at message_start is typically 0 (will fill
            // in via message_delta); we still capture it defensively in
            // case Anthropic ever pre-fills it.
            outputTokens = u.output_tokens ?? 0
          }
          break
        }
        case 'content_block_start': {
          const b = ev.content_block
          if (b?.type === 'text') {
            openBlock = { kind: 'text' }
          } else if (b?.type === 'tool_use') {
            openBlock = {
              kind: 'tool_use',
              id: typeof b.id === 'string' ? b.id : '',
              name: typeof b.name === 'string' ? b.name : '',
              argsJson: '',
            }
          }
          break
        }
        case 'content_block_delta': {
          const d = ev.delta
          if (!d || !openBlock) break
          if (d.type === 'text_delta' && openBlock.kind === 'text') {
            const t = typeof d.text === 'string' ? d.text : ''
            if (t.length > 0) yield { type: 'text', text: t }
          } else if (
            d.type === 'input_json_delta' &&
            openBlock.kind === 'tool_use'
          ) {
            if (typeof d.partial_json === 'string') {
              openBlock.argsJson += d.partial_json
            }
          }
          break
        }
        case 'content_block_stop': {
          if (openBlock?.kind === 'tool_use') {
            // Parse the accumulated args JSON. The model emits a
            // well-formed JSON object; an empty string means {} (the
            // model called the tool with no args).
            let input: Record<string, unknown> = {}
            const raw = openBlock.argsJson.trim()
            if (raw.length > 0) {
              try {
                const parsed = JSON.parse(raw)
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  input = parsed as Record<string, unknown>
                }
              } catch {
                // The model produced invalid JSON for the tool args.
                // Surface as a soft-fail error chunk + stop the stream
                // — there's nothing useful we can do with broken args,
                // and continuing risks the agent calling the tool with
                // partial garbage.
                yield {
                  type: 'error',
                  code: 'malformed_tool_args',
                  message: `tool '${openBlock.name}' args JSON failed to parse: ${raw.slice(0, 200)}`,
                }
                return
              }
            }
            yield {
              type: 'tool_use',
              toolUse: {
                type: 'tool_use',
                id: openBlock.id,
                name: openBlock.name,
                input,
              },
            }
          }
          openBlock = null
          break
        }
        case 'message_delta': {
          if (ev.delta?.stop_reason !== undefined) {
            stopReason = mapStopReason(ev.delta.stop_reason)
          }
          // The output_tokens count arrives here (sometimes); the
          // SDK also folds the cumulative usage onto ev.usage.
          if (ev.usage?.output_tokens !== undefined) {
            outputTokens = ev.usage.output_tokens
          }
          break
        }
        case 'message_stop': {
          // Emit usage + end as the terminal pair.
          const usage: LlmUsage = {
            inputTokens,
            outputTokens,
          }
          if (cacheCreationTokens > 0) usage.cacheCreationTokens = cacheCreationTokens
          if (cacheReadTokens > 0) usage.cacheReadTokens = cacheReadTokens
          yield { type: 'usage', usage }
          yield { type: 'end', stopReason }
          return
        }
      }
    }
    // Defensive: if the SDK closes the iterator without an explicit
    // message_stop (would be an SDK bug), still emit a terminal `end`
    // so consumers' iterators don't dangle.
    yield {
      type: 'usage',
      usage: { inputTokens, outputTokens },
    }
    yield { type: 'end', stopReason }
  }

  /**
   * Phase 8 — request body assembly shared between `complete()` (non-stream)
   * and `stream()` (sets `stream:true`). Pulled out so the two paths can
   * never diverge on translation rules (tool snake_case, opus thinking-
   * model temperature drop, etc.).
   */
  private buildBody(req: LlmRequest): Record<string, unknown> {
    const model = req.model ?? this.defaultModel
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      messages: req.messages.map(translateMessage),
    }
    if (req.system !== undefined) body.system = req.system
    if (req.temperature !== undefined && !isThinkingModel(model)) {
      body.temperature = req.temperature
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => {
        const out: Record<string, unknown> = {
          name: t.name,
          input_schema: t.inputSchema,
        }
        if (t.description !== undefined) out.description = t.description
        return out
      })
    }
    return body
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // Note: Phase 8 — body assembly lives in `buildBody()` so the
    // streaming path (`stream()`) shares translation rules with this
    // legacy non-stream path. Don't inline anything here that doesn't
    // also belong in stream().
    const body = this.buildBody(req)

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
 * Phase 8 — structural shape of one Anthropic SSE event. The vendor SDK
 * exposes a discriminated union with much richer typing; we narrow to
 * just the fields the stream translator reads. Discriminator is `type`.
 */
interface AnthropicStreamEvent {
  type: string
  // message_start
  message?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  // content_block_start / content_block_stop
  content_block?: {
    type?: string
    id?: string
    name?: string
  }
  // content_block_delta / message_delta
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    stop_reason?: string | null
  }
  // message_delta — final usage update
  usage?: {
    output_tokens?: number
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
    case 'tool_use':
      return 'tool_use'
    default:
      return 'error'
  }
}
