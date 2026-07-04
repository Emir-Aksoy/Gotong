import OpenAI from 'openai'
import type {
  LlmArtifactResolver,
  LlmAudioBlock,
  LlmContentBlock,
  LlmFileRefBlock,
  LlmImageBlock,
  LlmImageSource,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmStopReason,
  LlmStreamChunk,
  LlmUsage,
} from '@gotong/llm'
import {
  DEFAULT_MULTIMODAL_INLINE_BYTE_CAP,
  MultimodalInlineSizeError,
  MultimodalNotSupportedError,
  extractInlineBase64Size,
} from '@gotong/llm'

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
 * and (usually) {@link maxTokensField} to `'max_tokens'`. Gotong's
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
   * Phase 9 — resolver for `artifact_ref` sources on multimodal blocks.
   * See AnthropicProviderOptions.artifactResolver for full semantics
   * — the type is shared so host wiring is identical across providers.
   */
  artifactResolver?: LlmArtifactResolver
  /**
   * Phase 9 — cap on inline base64 payload size per block. Defaults to
   * `DEFAULT_MULTIMODAL_INLINE_BYTE_CAP` (1 MB). Host reads
   * `GOTONG_MULTIMODAL_MAX_INLINE_MB` and forwards here.
   */
  maxInlineBytes?: number
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
  private readonly artifactResolver?: LlmArtifactResolver
  private readonly maxInlineBytes: number

  constructor(opts: OpenAIProviderOptions = {}) {
    this.name = opts.name ?? 'openai'
    this.defaultModel = opts.defaultModel ?? 'gpt-4o-mini'
    this.maxTokensField = opts.maxTokensField ?? 'max_completion_tokens'
    this.artifactResolver = opts.artifactResolver
    this.maxInlineBytes = opts.maxInlineBytes ?? DEFAULT_MULTIMODAL_INLINE_BYTE_CAP
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

  /**
   * Phase 8 M3 — native streaming. OpenAI's streaming event shape
   * differs from Anthropic's:
   *
   *   - Each yielded chunk is itself a partial ChatCompletion. We read
   *     `choices[0].delta` for the in-progress content (text or tool_calls)
   *     and `choices[0].finish_reason` for the terminal signal.
   *   - Text arrives in `delta.content` as plain string fragments.
   *   - Tool calls arrive in `delta.tool_calls`, each entry indexed by a
   *     stable `index` integer. The first chunk for each index carries
   *     `id`, `type`, `function.name`; subsequent chunks accumulate
   *     `function.arguments` as a JSON-encoded string. We buffer per-index
   *     and emit one `tool_use` chunk per index when `finish_reason` arrives.
   *   - Usage is only sent when we set `stream_options.include_usage: true`,
   *     and only on the very last chunk (where `choices` is empty).
   *
   * Translation:
   *   - delta.content → `{ type: 'text', text }` (empty strings filtered)
   *   - finished tool_calls → `{ type: 'tool_use', toolUse: {...} }`
   *   - terminal usage chunk → `{ type: 'usage', usage }`
   *   - finish_reason → terminal `{ type: 'end', stopReason }`
   *   - Malformed JSON in tool arguments → `error` chunk + early return
   *     (matches Anthropic translator's choice).
   *
   * Retry: streaming does NOT retry on transient errors. Once the SDK
   * starts yielding bytes we can't safely replay; the safe approach is
   * to let LlmAgent surface the transient error as a failed TaskResult
   * and let the operator decide. Pre-stream errors (auth / 400 / 429 /
   * network failure on the initial create()) still throw synchronously
   * from .next(), which keeps LlmAgent's onAuthFailure path firing.
   * (`isTransientError` is still exported for callers writing their own
   * retry harness around the agent.)
   */
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamChunk> {
    // Phase 9 — outer wrapper stays sync (LlmAgent's sync-throw → onAuthFailure
    // contract). The inner generator awaits buildBody, which is now async
    // because multimodal resolution may fetch artifact bytes. Pre-stream
    // failures (auth, artifact-not-found, oversize) surface on the first
    // iterator advance.
    return this.streamImpl(req, signal)
  }

  private async *streamImpl(
    req: LlmRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LlmStreamChunk> {
    const body = await this.buildBody(req)
    body.stream = true
    // Ask the server to send a usage chunk at the end (gated on this
    // option being set — OpenAI doesn't include usage in stream mode by
    // default). DeepSeek / Qwen / Ollama all accept the same option.
    body.stream_options = { include_usage: true }
    const sdkStream = await (
      this.client.chat.completions.create as unknown as (
        b: Record<string, unknown>,
        opts?: { signal?: AbortSignal },
      ) => Promise<AsyncIterable<OpenAIStreamChunkLike>>
    )(body, signal ? { signal } : undefined)

    // Per-index tool_call scratch state. OpenAI uses the same `index`
    // throughout a tool call's lifetime; we accumulate name + arguments
    // until finish_reason fires, then emit the parsed tool_use chunk.
    const toolBuffers = new Map<
      number,
      { id: string; name: string; argsJson: string }
    >()
    let usage: LlmUsage | undefined
    let stopReason: LlmStopReason = 'end_turn'

    for await (const chunk of sdkStream) {
      // 1) Usage may arrive on its own terminal chunk (OpenAI's
      //    behavior with include_usage:true: a final chunk with
      //    empty choices) OR alongside finish_reason on the same
      //    chunk (DeepSeek / some Qwen configurations). Capture
      //    whenever present; the canonical emit ordering is
      //    enforced below at finish_reason.
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        }
      }
      const choice = chunk.choices?.[0]
      if (!choice) continue
      const delta = choice.delta

      // 2) Text fragments.
      if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
        yield { type: 'text', text: delta.content }
      }

      // 3) Tool-call fragments. Each tc has an `index`; we accumulate
      //    name + arguments under that index.
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0
          let buf = toolBuffers.get(idx)
          if (!buf) {
            buf = { id: '', name: '', argsJson: '' }
            toolBuffers.set(idx, buf)
          }
          if (typeof tc.id === 'string' && tc.id.length > 0) {
            buf.id = tc.id
          }
          const fn = tc.function
          if (fn) {
            if (typeof fn.name === 'string' && fn.name.length > 0) {
              buf.name = fn.name
            }
            if (typeof fn.arguments === 'string') {
              buf.argsJson += fn.arguments
            }
          }
        }
      }

      // 4) Terminal chunk for THIS choice — emit accumulated tool_uses,
      //    then KEEP DRAINING: with include_usage:true, OpenAI sends the
      //    usage on a trailing chunk with empty choices AFTER the
      //    finish_reason chunk. Returning here (the old behavior) meant
      //    genuine-OpenAI streams never reached that chunk, so every
      //    streamed call hit the Phase 17 ledger/budget with 0 tokens.
      //    (DeepSeek puts usage alongside finish_reason, which is why
      //    this never showed up on the default provider.) The usage +
      //    end pair is emitted after the loop.
      if (choice.finish_reason) {
        stopReason = mapStopReason(choice.finish_reason)
        // Sort by index so multi-tool fan-outs come out in deterministic
        // order matching OpenAI's wire ordering.
        const indices = [...toolBuffers.keys()].sort((a, b) => a - b)
        for (const idx of indices) {
          const buf = toolBuffers.get(idx)!
          let input: Record<string, unknown> = {}
          const raw = buf.argsJson.trim()
          if (raw.length > 0) {
            try {
              const parsed = JSON.parse(raw)
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                input = parsed as Record<string, unknown>
              }
            } catch {
              // Mirrors the legacy complete() behavior: surface the raw
              // string under `_raw` so the agent sees it instead of
              // silently crashing on JSON.parse, BUT also emit an
              // error chunk so consumers know this happened mid-stream.
              yield {
                type: 'error',
                code: 'malformed_tool_args',
                message: `tool '${buf.name}' args JSON failed to parse: ${raw.slice(0, 200)}`,
              }
              return
            }
          }
          yield {
            type: 'tool_use',
            toolUse: {
              type: 'tool_use',
              id: buf.id,
              name: buf.name,
              input,
            },
          }
        }
        // Consumed — a (buggy) repeated finish_reason must not re-emit.
        toolBuffers.clear()
      }
    }
    // Stream drained (or, defensively, ended without finish_reason) —
    // emit the terminal pair so consumers' iterators don't dangle.
    if (usage) yield { type: 'usage', usage }
    yield { type: 'end', stopReason }
  }

  /**
   * Body assembly. Translation rules (system hoist, maxTokens field name,
   * tool wire shape) live here so `stream()` stays a thin wrapper that
   * just sets `stream: true` + `stream_options`.
   *
   * Phase 9 — async because multimodal blocks may resolve artifact bytes.
   */
  private async buildBody(req: LlmRequest): Promise<Record<string, unknown>> {
    const model = req.model ?? this.defaultModel
    const ctx: TranslateCtx = {
      model,
      resolver: this.artifactResolver,
      maxInlineBytes: this.maxInlineBytes,
    }
    const messages: Array<Record<string, unknown>> = []
    if (req.system !== undefined) {
      messages.push({ role: 'system', content: req.system })
    }
    // Translate sequentially across messages to preserve order, but
    // each message internally fans out artifact reads in parallel.
    for (const m of req.messages) {
      const out = await translateMessage(m, ctx)
      messages.push(...out)
    }
    const body: Record<string, unknown> = {
      model,
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
    return body
  }

}

/**
 * Phase 9 — translation context. `model` is needed because audio support
 * is model-dependent (only gpt-4o-audio-* variants accept input_audio
 * blocks via chat.completions; sending one to plain gpt-4o yields a
 * confusing 400 from the API rather than a typed error from us).
 */
interface TranslateCtx {
  model: string
  resolver?: LlmArtifactResolver
  maxInlineBytes: number
}

/**
 * Translate one provider-neutral message into one *or more* OpenAI
 * messages. `tool_result` blocks fan out into their own `{role:'tool', ...}`
 * messages, which is why this returns an array rather than a single record.
 *
 * Phase 9: async because image / audio / file_ref blocks may resolve
 * artifact bytes.
 */
async function translateMessage(
  m: LlmMessage,
  ctx: TranslateCtx,
): Promise<Array<Record<string, unknown>>> {
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
      } else if (block.type === 'image' || block.type === 'audio' || block.type === 'file_ref') {
        // OpenAI assistant messages don't accept image / audio / file
        // content. If a caller round-trips a user's multimodal block into
        // the assistant history (or a future model returns one) we surface
        // it as a typed error instead of silently dropping the block.
        throw new MultimodalNotSupportedError(
          'openai',
          block.type,
          'OpenAI assistant messages accept only text + tool_calls; '
          + 'put multimodal content on user turns',
        )
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
  // User turn: multimodal blocks (image / audio / file_ref) + text go
  // into a single user message whose `content` is an array of typed
  // parts (OpenAI's vision/audio convention). tool_result blocks still
  // fan out as standalone tool-role messages.
  const userMessages: Array<Record<string, unknown>> = []
  // Resolve all multimodal blocks in this message in parallel — same
  // pattern as the Anthropic translator. We do a first pass to figure
  // out which blocks need async resolution, then assemble in input order.
  const partPromises: Array<Promise<Record<string, unknown> | null>> = []
  for (const block of m.content) {
    if (block.type === 'text') {
      partPromises.push(Promise.resolve({ type: 'text', text: block.text }))
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
      partPromises.push(Promise.resolve(null)) // tool_result doesn't contribute to user content
    } else if (block.type === 'image') {
      partPromises.push(translateImageBlock(block, ctx))
    } else if (block.type === 'audio') {
      partPromises.push(translateAudioBlock(block, ctx))
    } else if (block.type === 'file_ref') {
      partPromises.push(translateFileRefBlock(block, ctx))
    }
  }
  const resolved = await Promise.all(partPromises)
  const parts = resolved.filter((p): p is Record<string, unknown> => p !== null)
  if (parts.length === 1 && parts[0]!.type === 'text') {
    // Pure-text user message — keep the legacy string-content shape so
    // older OpenAI-compat backends (which sometimes refuse the array
    // form for plain text) keep working.
    userMessages.unshift({ role: 'user', content: parts[0]!.text })
  } else if (parts.length > 0) {
    userMessages.unshift({ role: 'user', content: parts })
  }
  if (userMessages.length === 0) {
    // Defensive: don't drop a message silently — emit an empty user turn.
    userMessages.push({ role: 'user', content: '' })
  }
  return userMessages
}

/**
 * Phase 9 — translate `LlmImageBlock` to OpenAI's `image_url` content
 * part:
 *
 *   { type: 'image_url', image_url: { url: 'data:<mime>;base64,<data>' } }
 *   { type: 'image_url', image_url: { url: 'https://...' } }
 *
 * OpenAI uses the same `image_url` field for both inline base64 and
 * remote URL — the value is just a string the model loader can fetch
 * (or a data URL it decodes locally). Doesn't matter to the wire shape
 * which one was supplied.
 */
async function translateImageBlock(
  block: LlmImageBlock,
  ctx: TranslateCtx,
): Promise<Record<string, unknown>> {
  return { type: 'image_url', image_url: { url: await resolveImageSourceToUrl(block.source, ctx) } }
}

/**
 * Phase 9 — translate `LlmAudioBlock` to OpenAI's `input_audio` content
 * part:
 *
 *   { type: 'input_audio', input_audio: { data: '<base64>', format: 'wav'|'mp3' } }
 *
 * Only `gpt-4o-audio-*` variants accept this via chat.completions;
 * other models hit a 400 from the server. We pre-check the model name
 * (contains 'audio') and throw a typed error otherwise so the failure
 * mode is debuggable.
 *
 * Format mapping: OpenAI currently accepts `wav` and `mp3`. Anything
 * else throws here.
 */
async function translateAudioBlock(
  block: LlmAudioBlock,
  ctx: TranslateCtx,
): Promise<Record<string, unknown>> {
  if (!modelSupportsAudio(ctx.model)) {
    throw new MultimodalNotSupportedError(
      'openai',
      'audio',
      `model '${ctx.model}' has no audio input API; use a gpt-4o-audio-* variant`,
    )
  }
  const format = inferAudioFormat(block.format, block.source)
  if (format !== 'wav' && format !== 'mp3') {
    throw new MultimodalNotSupportedError(
      'openai',
      'audio',
      `OpenAI accepts only wav / mp3 via input_audio (got '${format}')`,
    )
  }
  // OpenAI audio input is base64-only — no url variant for input_audio
  // — so we resolve every source kind down to raw bytes + b64-encode.
  const data = await resolveAudioSourceToBase64(block.source, ctx)
  return { type: 'input_audio', input_audio: { data, format } }
}

/**
 * Phase 9 — file_ref translation. Routes by mime:
 *
 *   image/*                    → image_url content part (base64 inline)
 *   audio/* + audio-capable model → input_audio content part
 *   text/* or application/json → text part (prepended utf-8 text)
 *   everything else            → MultimodalNotSupportedError
 */
async function translateFileRefBlock(
  block: LlmFileRefBlock,
  ctx: TranslateCtx,
): Promise<Record<string, unknown>> {
  if (!ctx.resolver) {
    throw new MultimodalNotSupportedError(
      'openai',
      'file_ref',
      'file_ref blocks need an artifactResolver in OpenAIProviderOptions',
    )
  }
  const { bytes, mime: resolvedMime } = await ctx.resolver(block.artifactId)
  const mime = (resolvedMime || block.mime || '').toLowerCase()
  if (bytes.byteLength > ctx.maxInlineBytes) {
    throw new MultimodalInlineSizeError('openai', bytes.byteLength, ctx.maxInlineBytes)
  }
  if (mime.startsWith('image/')) {
    const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`
    return { type: 'image_url', image_url: { url: dataUrl } }
  }
  if (mime.startsWith('audio/')) {
    if (!modelSupportsAudio(ctx.model)) {
      throw new MultimodalNotSupportedError(
        'openai',
        'file_ref',
        `audio artifact requires audio-capable model; '${ctx.model}' won't accept it`,
      )
    }
    const fmt = mime.split('/')[1] ?? 'wav'
    if (fmt !== 'wav' && fmt !== 'mp3') {
      throw new MultimodalNotSupportedError(
        'openai',
        'file_ref',
        `OpenAI accepts only wav / mp3 (got '${fmt}')`,
      )
    }
    return {
      type: 'input_audio',
      input_audio: { data: bytesToBase64(bytes), format: fmt },
    }
  }
  if (mime.startsWith('text/') || mime === 'application/json') {
    return { type: 'text', text: bytesToUtf8(bytes) }
  }
  throw new MultimodalNotSupportedError(
    'openai',
    'file_ref',
    `mime '${mime}' has no OpenAI representation (image/* / audio/* / text/* / application/json only)`,
  )
}

/**
 * Phase 9 — turn any `LlmImageSource` into the `url` string OpenAI
 * accepts on `image_url`. URL passes through verbatim; base64 becomes a
 * `data:` URL; artifact_ref goes through the resolver then becomes a
 * `data:` URL.
 */
async function resolveImageSourceToUrl(
  source: LlmImageSource,
  ctx: TranslateCtx,
): Promise<string> {
  if (source.kind === 'url') return source.url
  if (source.kind === 'base64') {
    const size = extractInlineBase64Size({ type: 'image', source })
    if (size > ctx.maxInlineBytes) {
      throw new MultimodalInlineSizeError('openai', size, ctx.maxInlineBytes)
    }
    const clean = source.data.replace(/\s+/g, '')
    return `data:${source.mime};base64,${clean}`
  }
  // artifact_ref
  if (!ctx.resolver) {
    throw new MultimodalNotSupportedError(
      'openai',
      'image',
      `artifact_ref source requires an artifactResolver in OpenAIProviderOptions; `
      + `pass one when constructing the provider (host wires it automatically) `
      + `or inline the image as { kind: 'base64', data, mime }`,
    )
  }
  const { bytes, mime } = await ctx.resolver(source.artifactId)
  if (bytes.byteLength > ctx.maxInlineBytes) {
    throw new MultimodalInlineSizeError('openai', bytes.byteLength, ctx.maxInlineBytes)
  }
  return `data:${mime || source.mime};base64,${bytesToBase64(bytes)}`
}

/**
 * Phase 9 — audio source needs raw base64 (no url variant on
 * input_audio). Same resolver dispatch as images.
 */
async function resolveAudioSourceToBase64(
  source: LlmImageSource,
  ctx: TranslateCtx,
): Promise<string> {
  if (source.kind === 'base64') {
    const size = extractInlineBase64Size({ type: 'audio', source })
    if (size > ctx.maxInlineBytes) {
      throw new MultimodalInlineSizeError('openai', size, ctx.maxInlineBytes)
    }
    return source.data.replace(/\s+/g, '')
  }
  if (source.kind === 'url') {
    throw new MultimodalNotSupportedError(
      'openai',
      'audio',
      'OpenAI input_audio requires inline base64; fetch the URL host-side and inline it',
    )
  }
  // artifact_ref
  if (!ctx.resolver) {
    throw new MultimodalNotSupportedError(
      'openai',
      'audio',
      'audio artifact_ref needs an artifactResolver in OpenAIProviderOptions',
    )
  }
  const { bytes } = await ctx.resolver(source.artifactId)
  if (bytes.byteLength > ctx.maxInlineBytes) {
    throw new MultimodalInlineSizeError('openai', bytes.byteLength, ctx.maxInlineBytes)
  }
  return bytesToBase64(bytes)
}

/**
 * Phase 9 — pick an OpenAI input_audio `format` value from either the
 * caller's hint or the source's mime. Returns the raw extension string
 * (no validation); caller verifies it's wav/mp3 before sending.
 */
function inferAudioFormat(hint: string | undefined, source: LlmImageSource): string {
  if (hint) return hint
  const mime = source.kind === 'url' ? '' : source.mime
  // mime form 'audio/wav' / 'audio/mpeg' / 'audio/mp3' / 'audio/webm' …
  const sub = (mime.split('/')[1] ?? '').toLowerCase()
  if (sub === 'mpeg') return 'mp3' // RFC 3003 — audio/mpeg is mp3
  if (sub === 'x-wav') return 'wav'
  return sub || 'wav' // last-resort default
}

/**
 * Phase 9 — model name → does it accept audio input via chat.completions?
 * Loose match on 'audio' substring covers gpt-4o-audio-preview, future
 * gpt-4o-audio-*, and any OpenAI-compat vendor that mirrors the naming.
 */
function modelSupportsAudio(model: string): boolean {
  return model.toLowerCase().includes('audio')
}

/**
 * Phase 9 — base64-encode Uint8Array. Node Buffer fast path; portable
 * fallback for non-node runtimes.
 */
function bytesToBase64(bytes: Uint8Array): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Buf: any = (globalThis as { Buffer?: typeof globalThis.Buffer }).Buffer
  if (Buf && typeof Buf.from === 'function') {
    return Buf.from(bytes).toString('base64')
  }
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return (globalThis as { btoa?: (s: string) => string }).btoa!(bin)
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

// --- transient-error detection -----------------------------------------

/**
 * Classify an SDK / fetch error as transient (worth retrying) vs permanent.
 *
 * Transient (retry):
 *   - `Premature close` — server closed connection mid-response. This is the
 *     specific failure we saw on DeepSeek and the original motivation for
 *     this helper.
 *   - `socket hang up`, `fetch failed`, `read ECONNRESET` — TCP / HTTP-client
 *     surface terms for "connection died mid-flight".
 *   - `socket aborted` / `request aborted` (undici socket / request abort
 *     distinct from a user-issued AbortController). Pre-3.4 the regex
 *     matched the bare word `aborted`, which silently doubled charges
 *     when a user-supplied AbortController triggered with a message like
 *     "aborted by user" (H5).
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
 *   - Any error whose `name === 'AbortError'` or `code === 'ABORT_ERR'` —
 *     a user-driven cancellation. The whole point of `AbortController`
 *     is "stop doing this"; retrying would both ignore intent AND
 *     double-charge the user (the failed request still consumes API
 *     credit for input tokens). See AUDIT-v3.3.md finding H5.
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
  // both ignore their intent AND double-bill the input tokens already
  // counted by the upstream provider (H5). We treat any abort-by-name
  // / abort-by-code as PERMANENT.
  if (e.name === 'AbortError' || e.cause?.name === 'AbortError') return false
  if (e.code === 'ABORT_ERR' || e.cause?.code === 'ABORT_ERR') return false
  const msg = typeof e.message === 'string' ? e.message : ''
  // H5 — the regex below intentionally does NOT match the bare word
  // `aborted`. A user `AbortController` whose abort reason is a string
  // like "aborted by user" would otherwise trip this branch (the
  // AbortError name check above doesn't always catch user-raised
  // throwables in higher-level wrappers — `AggregateError`, custom
  // `Error` subclasses, etc.). We only match the two undici-internal
  // phrases that signal "the TCP socket aborted underneath us", which
  // genuinely is a network-layer transient.
  if (
    /premature close|socket hang up|fetch failed|socket aborted|request aborted|read econnreset|etimedout/i.test(msg)
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

/**
 * Phase 8 — structural shape of one streamed OpenAI ChatCompletion chunk.
 * Each chunk is a delta over the in-progress response. Discriminator
 * is `choices[0].finish_reason` (null → in-progress, string → terminal
 * for THAT choice). The very last chunk in stream-mode has empty
 * `choices` and carries `usage` instead.
 */
interface OpenAIStreamChunkLike {
  choices?: ReadonlyArray<{
    delta?: {
      content?: string | null
      tool_calls?: ReadonlyArray<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
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
