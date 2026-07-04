/**
 * Provider-neutral types for LLM completion. Concrete provider packages
 * (e.g. @gotong/llm-anthropic) translate these to/from their vendor SDK.
 *
 * Design goals:
 * - Smallest useful surface for v0.2 — non-streaming chat completion only.
 * - v0.3 adds tool-use (PR #38) — `LlmRequest.tools` lets the agent declare
 *   what the LLM may call; `LlmResponse.toolUses` surfaces the LLM's
 *   chosen tool calls back. Tool-use is opt-in: legacy callers that pass
 *   `string` content still work unchanged.
 * - No streaming, no images, no JSON mode hard-wired. Those are bigger
 *   features that deserve their own version bumps.
 * - Vendor-agnostic: nothing here references Claude / OpenAI specifics.
 */

/**
 * A turn in the conversation. We collapse "system" out of the role union
 * because it lives at the top level as a single string — this matches both
 * Anthropic's `system` field and is trivially mappable to OpenAI's
 * `{role:'system'}` first-message convention.
 *
 * `content` accepts either a plain string (the legacy v0.2 shape — still
 * the right thing for single-turn chat) or an array of typed blocks
 * (needed for tool-use round-trips). Provider translators MUST handle both.
 */
export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string | LlmContentBlock[]
}

/**
 * Plain-text content. The only block type valid in both `user` and
 * `assistant` turns regardless of tool-use status.
 */
export interface LlmTextBlock {
  type: 'text'
  text: string
}

/**
 * The LLM's request to call a tool. Emitted by the provider when the
 * response's `stopReason === 'tool_use'`. The agent runtime is expected
 * to execute the tool and feed the result back as an `LlmToolResultBlock`
 * in the next request's messages array.
 *
 * `id` is the provider-assigned correlation id — it MUST be echoed back
 * verbatim on the matching `tool_result`, or the LLM will reject the next
 * turn. Treat it as opaque.
 */
export interface LlmToolUseBlock {
  type: 'tool_use'
  /** Provider-assigned correlation id. Echo verbatim on tool_result. */
  id: string
  /** The tool name the LLM picked. Matches one of `LlmRequest.tools[].name`. */
  name: string
  /** The arguments the LLM chose. Validated against the tool's `inputSchema`
   *  by the provider; arrives here as a parsed object. */
  input: Record<string, unknown>
}

/**
 * The agent's tool-execution result, sent back to the LLM as part of the
 * next `user` turn. The provider translator wraps this into whatever the
 * vendor expects (Anthropic: a `tool_result` block in user content;
 * OpenAI: a `tool` role message).
 *
 * `content` accepts either a string (the typical case — your tool produced
 * text) or a small text-block array for multipart outputs. Image blobs,
 * resource handles, and other MCP content types must be flattened into
 * text by the caller; the LLM has no other way to consume them yet.
 */
export interface LlmToolResultBlock {
  type: 'tool_result'
  /** The `id` from the matching `tool_use` block. */
  toolUseId: string
  content: string | LlmTextBlock[]
  /** Set when the tool errored — lets the LLM see the failure and retry. */
  isError?: boolean
}

/**
 * Source for binary content (image / audio) referenced from an
 * `LlmMessage`. Three first-class shapes (RFC §1):
 *
 * - `base64` — inline bytes. Capped at 1 MB by default (env
 *   `GOTONG_MULTIMODAL_MAX_INLINE_MB`); larger uploads SHOULD land
 *   in an artifact and be referenced via `artifact_ref` instead.
 *   `mime` is required so providers know which API endpoint to pick
 *   without sniffing.
 * - `url` — public URL the vendor SDK will fetch on its end. No bytes
 *   cross the hub. Provider translators don't validate the URL.
 * - `artifact_ref` — points at an `ArtifactHandle.read*()` ref in the
 *   per-owner artifact store. Provider translators read the artifact
 *   at request time, so a single artifact can be referenced by N
 *   messages without N copies in the transcript. `mime` is required
 *   here too because the artifact metadata may be lossy (file backend
 *   guesses from extension; `image/png` vs `application/octet-stream`
 *   matters to the LLM).
 */
export type LlmImageSource =
  | { kind: 'base64'; data: string; mime: string }
  | { kind: 'url'; url: string }
  | { kind: 'artifact_ref'; artifactId: string; mime: string }

/**
 * Image input block. Sent to the LLM as part of a user turn (most
 * commonly) or as part of a tool result. The provider translator
 * resolves the source (decodes base64 / dereferences artifact / passes
 * URL through) and shapes it into the vendor's vision API format.
 *
 * Phase 9 scope: input only. The LLM doesn't currently stream images
 * back as part of its response — output remains text + tool_use.
 */
export interface LlmImageBlock {
  type: 'image'
  source: LlmImageSource
}

/**
 * Audio input block. Same source shape as `LlmImageBlock` but routed
 * through audio-capable APIs (Whisper / GPT-4o audio for OpenAI;
 * Anthropic doesn't support audio input as of Phase 9 and will throw
 * `MultimodalNotSupportedError`).
 *
 * `format` is an optional vendor hint — when omitted, the provider
 * sniffs from `mime`. Some vendors require an explicit format param
 * (Whisper API needs it for non-mp3 inputs).
 */
export interface LlmAudioBlock {
  type: 'audio'
  source: LlmImageSource
  format?: 'wav' | 'mp3' | 'webm' | 'ogg' | 'm4a'
}

/**
 * Generic file reference — the artifact's MIME determines how the
 * provider translates it: `image/*` → vision API, `audio/*` → audio
 * API, `text/*` and `application/json` → prepended as text. Anything
 * else throws `MultimodalNotSupportedError`.
 *
 * Use this when the upload UX doesn't know up-front whether the file
 * is image / audio / text (e.g. a generic "attach file" button). When
 * the caller knows the type, prefer `LlmImageBlock` / `LlmAudioBlock`
 * — they let provider translators skip the mime routing step.
 *
 * Per RFC §3, artifacts live in a per-owner namespace; the agent's
 * `ServiceCtx.artifact` handle MUST own the referenced `artifactId`,
 * or provider translation throws.
 */
export interface LlmFileRefBlock {
  type: 'file_ref'
  artifactId: string
  /** MIME of the artifact. Required — provider routes on this. */
  mime: string
}

/**
 * Discriminated union of content block types. Phase 9 adds image /
 * audio / file_ref; older callers using `text` / `tool_use` /
 * `tool_result` keep working unchanged.
 */
export type LlmContentBlock =
  | LlmTextBlock
  | LlmToolUseBlock
  | LlmToolResultBlock
  | LlmImageBlock
  | LlmAudioBlock
  | LlmFileRefBlock

/**
 * Default cap on inline base64 payload size. Anything larger SHOULD
 * be uploaded as an artifact and referenced via
 * `{ kind: 'artifact_ref', artifactId, mime }` instead. The default
 * is conservative on purpose — large inline base64 bloats the
 * transcript jsonl and slows down replay / grep. Override at runtime
 * with env `GOTONG_MULTIMODAL_MAX_INLINE_MB`.
 */
export const DEFAULT_MULTIMODAL_INLINE_BYTE_CAP = 1024 * 1024 // 1 MB

/**
 * Callback a provider invokes when it encounters an `artifact_ref`
 * source on an `LlmImageBlock` / `LlmAudioBlock`, or any
 * `LlmFileRefBlock`. The host wires this to a per-task / per-owner
 * `ArtifactHandle.readBytes` so the provider can stay decoupled from
 * `@gotong/services-sdk`.
 *
 * Returning `bytes` + `mime`:
 * - `bytes` is what the provider will base64-encode into the vendor
 *   API call (Anthropic vision base64 source, OpenAI image_url
 *   data URL, Whisper multipart, ...).
 * - `mime` overrides the block's declared mime — file backends'
 *   guessed mime tends to be more accurate than what the caller
 *   typed by hand. Providers that strictly need the caller-declared
 *   mime should preserve theirs at the call site.
 *
 * Errors thrown by the resolver propagate out of the provider's
 * `stream()` iterator (mid-iteration, not synchronously) — the
 * LlmAgent loop maps them to a failed TaskResult the same way it
 * handles other mid-stream throws.
 */
export type LlmArtifactResolver = (
  artifactId: string,
) => Promise<{ bytes: Uint8Array; mime: string }>

/**
 * Parse the env override for the inline base64 cap. Returns the cap
 * in bytes — either `floor(parseFloat(env) * 1024 * 1024)` when the
 * env var is set to a positive finite number, or the default
 * `DEFAULT_MULTIMODAL_INLINE_BYTE_CAP` otherwise.
 *
 * Lives here (not in the provider packages) so all providers parse
 * the same env name consistently. Callers usually pass the result
 * into provider options at construction time so tests can override
 * deterministically without touching `process.env`.
 */
export function readMultimodalInlineCapFromEnv(
  env: Record<string, string | undefined> = (typeof process !== 'undefined'
    ? process.env
    : {}) as Record<string, string | undefined>,
): number {
  const raw = env.GOTONG_MULTIMODAL_MAX_INLINE_MB
  if (!raw) return DEFAULT_MULTIMODAL_INLINE_BYTE_CAP
  const mb = Number.parseFloat(raw)
  if (!Number.isFinite(mb) || mb <= 0) return DEFAULT_MULTIMODAL_INLINE_BYTE_CAP
  return Math.floor(mb * 1024 * 1024)
}

/**
 * Error thrown by a provider when a content block can't be sent to the
 * underlying LLM — either the vendor doesn't support that modality
 * (e.g. Anthropic + audio) or the request shape would exceed limits
 * (`MultimodalInlineSizeError` extends this).
 *
 * Callers should catch this in the LlmAgent loop and either downgrade
 * (omit the block, ask the model to re-prompt) or surface it as a
 * failed task. Never silently drop — RFC §6 explicitly forbids
 * "treat as text" fallback so debugging is reliable.
 */
export class MultimodalNotSupportedError extends Error {
  readonly code = 'MULTIMODAL_NOT_SUPPORTED'
  constructor(
    readonly providerName: string,
    readonly blockType: LlmContentBlock['type'],
    readonly detail?: string,
  ) {
    super(
      `${providerName} doesn't support content block '${blockType}'`
      + (detail ? `: ${detail}` : ''),
    )
    this.name = 'MultimodalNotSupportedError'
  }
}

/**
 * Specialisation of `MultimodalNotSupportedError` for the "request too
 * large" case. Kept as a subclass (not a sibling) so callers that catch
 * the parent automatically handle both.
 */
export class MultimodalInlineSizeError extends MultimodalNotSupportedError {
  readonly inlineByteSize: number
  readonly capBytes: number
  constructor(providerName: string, inlineByteSize: number, capBytes: number) {
    super(
      providerName,
      'image',
      `inline base64 payload ${inlineByteSize} bytes exceeds cap ${capBytes} bytes`
      + ` — upload as an artifact and reference via artifact_ref`,
    )
    this.name = 'MultimodalInlineSizeError'
    this.inlineByteSize = inlineByteSize
    this.capBytes = capBytes
  }
}

/**
 * Compute the byte size of an inline base64 payload on the block, if
 * any. Returns 0 for non-multimodal blocks, `url` / `artifact_ref`
 * sources, and missing/malformed base64. Provider translators use
 * this to enforce the inline cap (RFC §4) before the request goes
 * out to the vendor.
 *
 * Base64 → byte size is the standard formula:
 *   bytes = floor(b64Len * 3 / 4) - (1 if 1 padding `=` else 0) - (2 if 2)
 * We strip whitespace defensively because some clients ship soft-
 * wrapped base64 (RFC 2045 76-col convention).
 */
export function extractInlineBase64Size(block: LlmContentBlock): number {
  if (block.type !== 'image' && block.type !== 'audio') return 0
  const src = block.source
  if (src.kind !== 'base64') return 0
  const cleaned = src.data.replace(/\s+/g, '')
  if (!cleaned) return 0
  // Validate base64 charset; bail on anything that isn't valid b64 so
  // we don't return a misleading size for caller-corrupted data. The
  // provider will reject the body anyway, but a 0 here avoids a false
  // cap-exceeded error along the way.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return 0
  const padding = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0
  return Math.floor(cleaned.length * 3 / 4) - padding
}

/**
 * A tool the LLM may invoke. Field names mirror MCP SDK's `Tool` so
 * `McpToolset.listTools()` output drops in directly. Provider translators
 * re-map `inputSchema` → `input_schema` for vendors that want snake_case
 * (Anthropic does).
 */
export interface LlmToolDefinition {
  /** Must match the LLM tool-name regex `^[a-zA-Z0-9_-]+$`. */
  name: string
  /** Optional human-readable description; many LLMs use this to pick a tool. */
  description?: string
  /** JSON Schema describing the tool's input. Keep it tight — every extra
   *  property is more output tokens of "looking at the schema". */
  inputSchema: Record<string, unknown>
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
  /**
   * Tools the LLM may invoke. When non-empty, the provider attaches them
   * to the request and may return `stopReason: 'tool_use'` with one or
   * more `toolUses` blocks. When empty / omitted, the provider behaves
   * exactly like v0.2 (plain text in, plain text out).
   */
  tools?: LlmToolDefinition[]
}

/**
 * - `end_turn` — the LLM finished its response cleanly.
 * - `max_tokens` — the LLM hit the output cap; consider re-prompting.
 * - `tool_use` — the LLM wants to call one or more tools. The agent must
 *   execute them and submit the results in the next turn. See
 *   `LlmResponse.toolUses`.
 * - `error` — soft fail; the provider returned a body but something
 *   else went sideways mid-generation. `text` may be partial.
 */
export type LlmStopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'error'

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
  /** Concatenated text from every `text` block in the response. May be
   *  empty if the LLM responded only with `tool_use` blocks. */
  text: string
  stopReason: LlmStopReason
  /**
   * Tool calls the LLM wants the agent runtime to execute. Present iff
   * `stopReason === 'tool_use'`. May contain more than one entry when
   * the LLM chose to fan out (e.g. read two files in parallel).
   */
  toolUses?: LlmToolUseBlock[]
  usage?: LlmUsage
  /**
   * The raw provider response. Escape hatch for callers who need fields the
   * neutral interface doesn't expose. Do not rely on its shape across providers.
   */
  raw?: unknown
}

/**
 * Provider-neutral streaming chunk. Discriminated on `type`.
 *
 * Design goals (Phase 8):
 * - First-class streaming. The default path through `LlmProvider` is
 *   `stream()`; `complete()` is convenience sugar that drains a stream
 *   and returns the final `LlmResponse`.
 * - Per-chunk semantics small enough that the SSE bridge to the admin UI
 *   can forward verbatim without server-side state.
 * - Tool-use is delivered as one fully-formed block per chunk (the provider
 *   buffers the JSON args internally and emits the parsed input). Partial
 *   tool-args streaming is intentionally NOT modeled in v0.4 — the LlmAgent
 *   loop can't execute a tool until the args are complete anyway, so per-
 *   chunk partials would only buy us "model is typing the JSON" animation
 *   in the UI, which isn't worth the extra state machine.
 * - `end` always arrives exactly once and is always the LAST chunk for a
 *   successful stream. `error` short-circuits and is the last chunk for
 *   a soft-fail stream. Hard-fail (auth, transport) throws synchronously
 *   from the provider so LlmAgent's existing error path still fires.
 * - `usage` is optional and typically arrives once near the end. Providers
 *   that emit incremental usage updates MUST coalesce server-side and emit
 *   at most one `usage` chunk per stream (we don't sum multiple).
 */
export type LlmStreamChunk =
  | LlmStreamTextChunk
  | LlmStreamToolUseChunk
  | LlmStreamUsageChunk
  | LlmStreamEndChunk
  | LlmStreamErrorChunk

/**
 * Incremental text. Concatenating every `text` chunk in arrival order
 * reproduces the final response text byte-for-byte. Provider translators
 * MUST NOT emit empty `text: ''` chunks — they confuse SSE consumers and
 * the typewriter render.
 */
export interface LlmStreamTextChunk {
  type: 'text'
  text: string
}

/**
 * A fully-formed tool-use block the LLM wants the agent to execute. The
 * provider has already parsed the model's args JSON; the agent runtime
 * can `toolset.callTool(toolUse.name, toolUse.input)` immediately.
 *
 * Multiple `tool_use` chunks may arrive within one stream when the LLM
 * fans out (e.g. read two files in parallel). They are emitted in the
 * same order the model produced them.
 */
export interface LlmStreamToolUseChunk {
  type: 'tool_use'
  toolUse: LlmToolUseBlock
}

/**
 * Token-usage report for the stream. Optional. Providers should emit this
 * once near the end (typically just before `end`) so accounting code has
 * a stable hook. Coalesce server-side if the vendor SDK reports usage
 * incrementally — multiple `usage` chunks in one stream is undefined behavior.
 */
export interface LlmStreamUsageChunk {
  type: 'usage'
  usage: LlmUsage
}

/**
 * Terminal chunk for a normal stream. ALWAYS the last chunk emitted by a
 * successful stream. Consumers can use the iterator's natural completion
 * OR this chunk to know the stream is done — the convention exists so
 * SSE bridges can forward "stream ended" as an explicit event for clients
 * that don't have native iterator semantics.
 */
export interface LlmStreamEndChunk {
  type: 'end'
  stopReason: LlmStopReason
}

/**
 * Soft-fail terminal chunk. The provider returned a body but signalled
 * something went sideways mid-generation (e.g. partial tool-use block
 * the model didn't finish, vendor-specific "filtered" stop). After
 * `error`, the iterator completes — no further chunks.
 *
 * Hard fails (auth, transport, vendor 5xx) are thrown synchronously by
 * `stream()` BEFORE the iterator yields anything. That keeps the
 * existing LlmAgent `onAuthFailure` / failed-TaskResult path working
 * unchanged.
 */
export interface LlmStreamErrorChunk {
  type: 'error'
  /** Provider-mapped code (e.g. 'malformed_tool_args', 'content_filter'). */
  code: string
  message: string
}

/**
 * Vendor adapter. One per provider package (anthropic / openai / mock / ...).
 *
 * Phase 8 M8 — stream-only. `stream()` is the single LLM call surface;
 * the legacy `complete()` was removed once the LlmAgent loop, all
 * providers, and the test suite were migrated to consume streams
 * directly. Callers who want a one-shot final-response shape should
 * pipe through {@link drainStream} (exported below) — it folds any
 * `LlmStreamChunk` iterable into an `LlmResponse` with the same
 * semantics complete() had, minus the provider-specific `raw` escape
 * hatch (which can't survive the stream contract).
 *
 * `stream()` MUST throw synchronously on transport or auth errors so the
 * LlmAgent can map them into a failed TaskResult (and trigger the
 * `onAuthFailure` hook). Errors that surface mid-generation belong in an
 * `'error'` chunk, NOT a thrown exception.
 */
export interface LlmProvider {
  /** Human-readable identifier — used in logs and the `raw` envelope. */
  readonly name: string
  /**
   * Streaming chat completion. Yields chunks in arrival order, terminating
   * with exactly one `'end'` or `'error'` chunk. Consumers should aggregate
   * `text` chunks for the final transcript and accumulate `tool_use` chunks
   * for the tool-use loop.
   *
   * Implementations SHOULD honor `signal` to abort the upstream HTTP call
   * (Anthropic/OpenAI SDKs both accept AbortSignal). When omitted, the
   * stream runs to natural completion.
   */
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamChunk>
}

/**
 * Drain an async-iterable stream of chunks into a single `LlmResponse`.
 * Useful for provider `complete()` implementations during the Phase 8
 * transition AND for callers (tests, simple SDK users) that don't need
 * incremental output.
 *
 * Semantics:
 * - Concatenates every `text` chunk in arrival order.
 * - Collects every `tool_use` chunk into `response.toolUses`.
 * - Captures the first `usage` chunk (subsequent ones are ignored — see
 *   {@link LlmStreamUsageChunk}).
 * - Maps the terminal chunk:
 *     `'end'`   → `stopReason` from the chunk
 *     `'error'` → `stopReason: 'error'`, appends error message to `text`
 * - If the iterator ends without an explicit terminal chunk (provider
 *   bug), returns `stopReason: 'end_turn'` on a best-effort basis.
 */
export async function drainStream(
  stream: AsyncIterable<LlmStreamChunk>,
): Promise<LlmResponse> {
  const textParts: string[] = []
  const toolUses: LlmToolUseBlock[] = []
  let usage: LlmUsage | undefined
  let stopReason: LlmStopReason = 'end_turn'
  let errorAppend: string | undefined

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text':
        if (chunk.text.length > 0) textParts.push(chunk.text)
        break
      case 'tool_use':
        toolUses.push(chunk.toolUse)
        break
      case 'usage':
        // First usage chunk wins. Per LlmStreamUsageChunk contract a
        // well-behaved provider only emits one; defending against the
        // misbehaving case so accounting code isn't double-counted.
        if (!usage) usage = chunk.usage
        break
      case 'end':
        stopReason = chunk.stopReason
        break
      case 'error':
        stopReason = 'error'
        errorAppend = `[${chunk.code}] ${chunk.message}`
        break
    }
  }

  let text = textParts.join('')
  if (errorAppend) text = text ? `${text}\n\n${errorAppend}` : errorAppend

  const out: LlmResponse = { text, stopReason }
  if (toolUses.length > 0) out.toolUses = toolUses
  if (usage) out.usage = usage
  return out
}

/**
 * The tool runtime the agent calls into when an LLM picks a tool. MCP's
 * `McpToolset` already satisfies this shape (it has `listTools` and
 * `callTool` with matching signatures), so wiring an MCP toolset to an
 * `LlmAgent` is just `new LlmAgent({ ..., tools: toolset })`.
 *
 * Library users who want to expose non-MCP tools (a hand-rolled function
 * registry, an HTTP API wrapper, etc) can implement this interface
 * directly without depending on `@gotong/mcp-client`.
 *
 * `callTool` returns a shape that matches MCP's `CallToolResult` so the
 * adapter is zero-cost — that means a `content` array of `{type,text,...}`
 * blocks, with an optional `isError` flag for tool-level failures.
 */
export interface LlmAgentToolset {
  listTools(): Promise<LlmToolDefinition[]> | LlmToolDefinition[]
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<LlmToolCallResult>
  /**
   * Phase 10 M2 — optional per-task scope. `LlmAgent.handleTask` calls
   * this with a `fn` callback that does the actual LLM work. Toolsets
   * that need per-task state (`DispatchToolset` uses it to track
   * dispatch ancestry; `McpToolset` and most others ignore it)
   * implement this; the toolset wraps `fn` in its own scope
   * (typically `AsyncLocalStorage.run`) so concurrent tasks stay
   * isolated.
   *
   * Why `run(fn)` rather than `onTaskStart()`: `AsyncLocalStorage.
   * enterWith` is not safe under concurrent sibling chains — it
   * mutates the ALS frame in the calling sync stack and bleeds into
   * peers. `run(store, fn)` push/pops a scoped frame and is the only
   * race-free option for "set context for this task only".
   *
   * The task shape is kept permissive to avoid pulling
   * `@gotong/core` into this contract; concrete consumers cast /
   * pick fields they need.
   */
  runForTask?<T>(
    task: {
      readonly id: string
      readonly from: string
      readonly ancestry?: ReadonlyArray<{ taskId: string; by: string }>
    },
    fn: () => Promise<T>,
  ): Promise<T>
}

/**
 * Provider-neutral shape of a tool-call return value. Matches the MCP
 * `CallToolResult` field-for-field so the MCP toolset drops in with no
 * adapter. Hand-rolled toolsets should follow the same shape.
 */
export interface LlmToolCallResult {
  content: ReadonlyArray<unknown>
  isError?: boolean
}
