/**
 * Provider-neutral types for LLM completion. Concrete provider packages
 * (e.g. @aipehub/llm-anthropic) translate these to/from their vendor SDK.
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
 * Discriminated union of content block types. New block kinds (image,
 * resource, ...) get added here as we support them.
 */
export type LlmContentBlock =
  | LlmTextBlock
  | LlmToolUseBlock
  | LlmToolResultBlock

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
 * Vendor adapter. One per provider package (anthropic / openai / mock / ...).
 *
 * `complete()` MUST throw on transport or auth errors so the LlmAgent can
 * map them into a failed TaskResult. A response with `stopReason: 'error'`
 * is for soft-fail cases where the provider returned a body but indicated
 * something went wrong mid-generation.
 */
export interface LlmProvider {
  /** Human-readable identifier — used in logs and the `raw` envelope. */
  readonly name: string
  complete(req: LlmRequest): Promise<LlmResponse>
}

/**
 * The tool runtime the agent calls into when an LLM picks a tool. MCP's
 * `McpToolset` already satisfies this shape (it has `listTools` and
 * `callTool` with matching signatures), so wiring an MCP toolset to an
 * `LlmAgent` is just `new LlmAgent({ ..., tools: toolset })`.
 *
 * Library users who want to expose non-MCP tools (a hand-rolled function
 * registry, an HTTP API wrapper, etc) can implement this interface
 * directly without depending on `@aipehub/mcp-client`.
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
