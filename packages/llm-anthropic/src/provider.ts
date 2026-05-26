import Anthropic from '@anthropic-ai/sdk'
import type {
  LlmArtifactResolver,
  LlmContentBlock,
  LlmImageSource,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmStopReason,
  LlmStreamChunk,
  LlmUsage,
} from '@aipehub/llm'
import {
  DEFAULT_MULTIMODAL_INLINE_BYTE_CAP,
  MultimodalInlineSizeError,
  MultimodalNotSupportedError,
  extractInlineBase64Size,
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
  /**
   * Phase 9 — resolver for `artifact_ref` sources on multimodal blocks.
   * When set, the provider calls this to fetch raw bytes for any
   * `LlmImageBlock` / `LlmAudioBlock` with `source.kind === 'artifact_ref'`
   * and for any `LlmFileRefBlock` it sees. Without it, those blocks throw
   * `MultimodalNotSupportedError`. The host wires this to per-task
   * `ArtifactHandle.readBytes` so the provider stays decoupled from
   * services-sdk.
   */
  artifactResolver?: LlmArtifactResolver
  /**
   * Phase 9 — cap on inline base64 payload size accepted from a single
   * block. Default: `DEFAULT_MULTIMODAL_INLINE_BYTE_CAP` (1 MB). Override
   * via env `AIPE_MULTIMODAL_MAX_INLINE_MB` is parsed by the host and
   * forwarded here at construction time — provider doesn't read env so
   * tests stay deterministic. Throws `MultimodalInlineSizeError` when a
   * single block exceeds the cap.
   */
  maxInlineBytes?: number
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
  private readonly artifactResolver?: LlmArtifactResolver
  private readonly maxInlineBytes: number

  constructor(opts: AnthropicProviderOptions = {}) {
    // Default to Claude's most capable model. Override via `defaultModel` for
    // a cheaper/faster pick (e.g. `claude-sonnet-4-6`, `claude-haiku-4-5`).
    this.defaultModel = opts.defaultModel ?? 'claude-opus-4-7'
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 1024
    this.artifactResolver = opts.artifactResolver
    this.maxInlineBytes = opts.maxInlineBytes ?? DEFAULT_MULTIMODAL_INLINE_BYTE_CAP
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
    // The outer wrapper is sync so we keep the same shape contract LlmAgent
    // depends on (sync `provider.stream(req)` throw → onAuthFailure path).
    // The inner generator awaits `buildBody`, which is now async because
    // Phase 9 multimodal resolution can fetch artifact bytes. Anything that
    // throws inside buildBody surfaces on first iterator advance — same
    // path mid-stream failures take, so the LlmAgent loop handles it
    // uniformly.
    return this.streamImpl(req, signal)
  }

  private async *streamImpl(
    req: LlmRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LlmStreamChunk> {
    const body = await this.buildBody(req)
    body.stream = true
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
   * Request body assembly. Same translation rules (tool snake_case, opus
   * thinking-model temperature drop, etc.) regardless of stream mode —
   * `stream()` just appends `stream:true` to whatever this returns.
   */
  private async buildBody(req: LlmRequest): Promise<Record<string, unknown>> {
    const model = req.model ?? this.defaultModel
    // Phase 9: translateMessage is async (artifact resolution); fan out
    // in parallel so a long-tail readBytes doesn't serialise the whole
    // message list.
    const translatedMessages = await Promise.all(
      req.messages.map((m) => translateMessage(m, {
        resolver: this.artifactResolver,
        maxInlineBytes: this.maxInlineBytes,
      })),
    )
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      messages: translatedMessages,
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

}

/**
 * Phase 9 — context object threaded through translation so artifact
 * resolution + cap enforcement reach every block without each call site
 * re-wiring it.
 */
interface TranslateCtx {
  resolver?: LlmArtifactResolver
  maxInlineBytes: number
}

/**
 * Translate a provider-neutral message to the Anthropic on-wire shape.
 * String content passes through; block-array content needs each block
 * re-keyed (`toolUseId` → `tool_use_id`, `isError` → `is_error`).
 */
async function translateMessage(
  m: LlmMessage,
  ctx: TranslateCtx,
): Promise<Record<string, unknown>> {
  if (typeof m.content === 'string') {
    return { role: m.role, content: m.content }
  }
  // Each block resolves independently — fan out in parallel so artifact
  // reads happen concurrently. Order in the resulting array still matches
  // input order because Promise.all preserves index order.
  const blocks = await Promise.all(m.content.map((b) => translateBlock(b, ctx)))
  // file_ref + text/* mime resolution can produce a `null` (skip) when a
  // future variant doesn't have a useful Anthropic representation; today
  // every supported branch returns a value. Defensive filter doesn't hurt.
  return {
    role: m.role,
    content: blocks.filter((b): b is Record<string, unknown> => b !== null),
  }
}

async function translateBlock(
  block: LlmContentBlock,
  ctx: TranslateCtx,
): Promise<Record<string, unknown>> {
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
    case 'image':
      return translateImageSource(block.source, ctx)
    case 'audio':
      // Anthropic doesn't accept audio input as of Phase 9 — surface as
      // a typed error rather than silently dropping the block.
      throw new MultimodalNotSupportedError(
        'anthropic',
        'audio',
        'Anthropic vision API only accepts image input; use OpenAI gpt-4o for audio',
      )
    case 'file_ref':
      return translateFileRef(block.artifactId, block.mime, ctx)
  }
}

/**
 * Phase 9 — translate an `LlmImageSource` to Anthropic's image content
 * block shape. Anthropic vision accepts two source flavors:
 *
 *   { type: 'image', source: { type: 'base64', media_type, data } }
 *   { type: 'image', source: { type: 'url', url } }
 *
 * `artifact_ref` sources go through the resolver to fetch raw bytes,
 * then base64-encode in process — the API treats inline bytes
 * identically regardless of how the caller named them.
 */
async function translateImageSource(
  source: LlmImageSource,
  ctx: TranslateCtx,
): Promise<Record<string, unknown>> {
  if (source.kind === 'url') {
    return {
      type: 'image',
      source: { type: 'url', url: source.url },
    }
  }
  if (source.kind === 'base64') {
    // Enforce inline cap before we hand the body to the SDK — Anthropic
    // will reject oversize payloads anyway, but with a less-helpful
    // error and after burning bandwidth.
    const size = extractInlineBase64Size({ type: 'image', source })
    if (size > ctx.maxInlineBytes) {
      throw new MultimodalInlineSizeError('anthropic', size, ctx.maxInlineBytes)
    }
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: source.mime,
        // Strip whitespace defensively (RFC 2045 soft-wrap clients) so
        // the wire bytes match exactly what was uploaded.
        data: source.data.replace(/\s+/g, ''),
      },
    }
  }
  // artifact_ref: resolve, base64-encode, ship as inline.
  if (!ctx.resolver) {
    throw new MultimodalNotSupportedError(
      'anthropic',
      'image',
      `artifact_ref source requires an artifactResolver in AnthropicProviderOptions; `
      + `pass one when constructing the provider (host wires it automatically) `
      + `or inline the image as { kind: 'base64', data, mime }`,
    )
  }
  const { bytes, mime } = await ctx.resolver(source.artifactId)
  if (bytes.byteLength > ctx.maxInlineBytes) {
    throw new MultimodalInlineSizeError('anthropic', bytes.byteLength, ctx.maxInlineBytes)
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      // Trust the resolver's mime over the caller's declared mime —
      // the file backend's sniff from extension is usually more
      // accurate than what the human typed.
      media_type: mime || source.mime,
      data: bytesToBase64(bytes),
    },
  }
}

/**
 * Phase 9 — file_ref translation. Routes by mime:
 *
 *   image/*                    → translateImageSource (base64 inline)
 *   text/* or application/json → emit as a text block (prepended utf-8)
 *   everything else            → MultimodalNotSupportedError
 *
 * The "text bundle" path means a workflow can attach a doc / JSON
 * artifact and the model sees its content verbatim. Larger plain-text
 * uploads still hit the inline cap; that's fine — over a megabyte of
 * text belongs in a RAG flow, not the prompt.
 */
async function translateFileRef(
  artifactId: string,
  declaredMime: string,
  ctx: TranslateCtx,
): Promise<Record<string, unknown>> {
  if (!ctx.resolver) {
    throw new MultimodalNotSupportedError(
      'anthropic',
      'file_ref',
      'file_ref blocks need an artifactResolver in AnthropicProviderOptions',
    )
  }
  const { bytes, mime: resolvedMime } = await ctx.resolver(artifactId)
  const mime = (resolvedMime || declaredMime || '').toLowerCase()
  if (bytes.byteLength > ctx.maxInlineBytes) {
    throw new MultimodalInlineSizeError('anthropic', bytes.byteLength, ctx.maxInlineBytes)
  }
  if (mime.startsWith('image/')) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mime,
        data: bytesToBase64(bytes),
      },
    }
  }
  if (mime.startsWith('text/') || mime === 'application/json') {
    const text = bytesToUtf8(bytes)
    return { type: 'text', text }
  }
  throw new MultimodalNotSupportedError(
    'anthropic',
    'file_ref',
    `mime '${mime}' has no Anthropic representation (image/* or text/* / application/json only)`,
  )
}

/**
 * Phase 9 — node Buffer is the fast path for base64 (Buffer extends
 * Uint8Array). When Uint8Array is something else (some bundled
 * runtimes, the test stub), we fall back to a hand-roll via String
 * concat — slower but correct.
 */
function bytesToBase64(bytes: Uint8Array): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Buf: any = (globalThis as { Buffer?: typeof globalThis.Buffer }).Buffer
  if (Buf && typeof Buf.from === 'function') {
    return Buf.from(bytes).toString('base64')
  }
  // Browser / non-node fallback. We won't normally reach this branch
  // because the provider runs on the host process, but it keeps the
  // function portable.
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  // btoa exists in modern node and all browsers.
  return (globalThis as { btoa?: (s: string) => string }).btoa!(bin)
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
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
