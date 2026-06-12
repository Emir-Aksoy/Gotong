/**
 * ACP (Agent Client Protocol) wire types — the subset AipeHub speaks.
 *
 * ACP is JSON-RPC 2.0, but unlike A2A it is BIDIRECTIONAL over one long-lived
 * stdio pipe: the client (hub) sends requests (`initialize` / `session/new` /
 * `session/prompt` / …) AND the agent sends back notifications (`session/update`)
 * and even reverse REQUESTS (`session/request_permission`). So we model generic
 * `JsonRpc*` envelopes once (the connection layer in `acp-connection.ts`
 * discriminates an incoming line by them) and layer the ACP method shapes on top.
 *
 * Scope (MVP): the blocking prompt loop + the permission reverse request. We do
 * NOT model streaming prompt variants, `fs/*` or `terminal/*` reverse requests
 * (the connection rejects unknown reverse methods), or session/load resume.
 */

export const JSONRPC_VERSION = '2.0'

// --- ACP method names ------------------------------------------------------
// client(hub) → agent
export const ACP_INITIALIZE = 'initialize'
export const ACP_AUTHENTICATE = 'authenticate'
export const ACP_SESSION_NEW = 'session/new'
export const ACP_SESSION_PROMPT = 'session/prompt'
/** `session/cancel` is a NOTIFICATION (no response) per ACP. */
export const ACP_SESSION_CANCEL = 'session/cancel'
// agent → client(hub)
/** `session/update` is an agent→client NOTIFICATION — the OBSERVE stream. */
export const ACP_SESSION_UPDATE = 'session/update'
/** `session/request_permission` is an agent→client REQUEST — the INTERCEPT seam. */
export const ACP_REQUEST_PERMISSION = 'session/request_permission'

// --- generic JSON-RPC 2.0 envelopes ----------------------------------------

export type JsonRpcId = string | number

export interface JsonRpcRequest<M extends string = string, P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION
  id: JsonRpcId
  method: M
  params?: P
}

export interface JsonRpcNotification<M extends string = string, P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION
  method: M
  params?: P
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcSuccessResponse<R = unknown> {
  jsonrpc: typeof JSONRPC_VERSION
  id: JsonRpcId | null
  result: R
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION
  id: JsonRpcId | null
  error: JsonRpcError
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccessResponse<R> | JsonRpcErrorResponse

/** Anything that can arrive on the wire — the parser discriminates by shape. */
export type AcpMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/** JSON-RPC reserved error codes we emit when answering a malformed reverse request. */
export const ACP_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const

// --- ACP content blocks ----------------------------------------------------

export interface AcpTextContentBlock {
  type: 'text'
  text: string
}

/** MVP emits only text blocks; an agent may send richer blocks we treat as opaque. */
export type AcpContentBlock = AcpTextContentBlock

export function textBlock(text: string): AcpTextContentBlock {
  return { type: 'text', text }
}

/** Concatenate the text of every text block (non-text blocks skipped). */
export function promptText(blocks: readonly AcpContentBlock[]): string {
  return blocks
    .filter((b): b is AcpTextContentBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

// --- initialize ------------------------------------------------------------

export interface AcpClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean }
  terminal?: boolean
}

export interface InitializeParams {
  protocolVersion: number
  clientCapabilities?: AcpClientCapabilities
}

export interface AcpAuthMethod {
  id: string
  name?: string
  description?: string
}

export interface AcpAgentCapabilities {
  loadSession?: boolean
  promptCapabilities?: Record<string, unknown>
}

export interface InitializeResult {
  protocolVersion: number
  agentCapabilities?: AcpAgentCapabilities
  authMethods?: AcpAuthMethod[]
}

export interface AuthenticateParams {
  methodId: string
}

// --- session new / load ----------------------------------------------------

export interface SessionNewParams {
  cwd?: string
  mcpServers?: unknown[]
}

export interface SessionNewResult {
  sessionId: string
}

// --- session prompt --------------------------------------------------------

/** ACP `StopReason` — the turn-end reason. Left open for forward-compat. */
export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | string

export interface SessionPromptParams {
  sessionId: string
  prompt: AcpContentBlock[]
}

export interface SessionPromptResult {
  stopReason: AcpStopReason
}

export interface SessionCancelParams {
  sessionId: string
}

// --- session/update (agent → client notification) --------------------------

export interface AcpAgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk'
  content: AcpContentBlock
}

export interface AcpToolCallUpdate {
  sessionUpdate: 'tool_call' | 'tool_call_update'
  toolCallId?: string
  title?: string
  status?: string
  [k: string]: unknown
}

export interface AcpPlanUpdate {
  sessionUpdate: 'plan'
  [k: string]: unknown
}

/** Open union — message/thought chunks carry text; tool_call/plan are opaque pass-through. */
export type AcpSessionUpdate =
  | AcpAgentMessageChunkUpdate
  | AcpToolCallUpdate
  | AcpPlanUpdate
  | { sessionUpdate: string; [k: string]: unknown }

export interface SessionUpdateParams {
  sessionId: string
  update: AcpSessionUpdate
}

/** Pull the text out of a message/thought chunk; undefined for tool_call/plan/etc. */
export function updateText(update: AcpSessionUpdate): string | undefined {
  if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
    const content = (update as AcpAgentMessageChunkUpdate).content
    if (content && content.type === 'text') return content.text
  }
  return undefined
}

// --- session/request_permission (agent → client reverse request) -----------

export type AcpPermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: AcpPermissionOptionKind
}

/** What the agent wants to do — shown to a human when the gate escalates. */
export interface AcpToolCall {
  toolCallId?: string
  title?: string
  /** e.g. 'edit' | 'execute' | 'read' | 'delete' | 'move' | 'fetch' (agent-defined). */
  kind?: string
  rawInput?: unknown
  [k: string]: unknown
}

export interface RequestPermissionParams {
  sessionId: string
  toolCall: AcpToolCall
  options: AcpPermissionOption[]
}

export type AcpPermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }

export interface RequestPermissionResult {
  outcome: AcpPermissionOutcome
}

export function selectedOutcome(optionId: string): RequestPermissionResult {
  return { outcome: { outcome: 'selected', optionId } }
}

export function cancelledOutcome(): RequestPermissionResult {
  return { outcome: { outcome: 'cancelled' } }
}

// --- builders --------------------------------------------------------------

export function buildRequest<P>(id: JsonRpcId, method: string, params?: P): JsonRpcRequest<string, P> {
  const req: JsonRpcRequest<string, P> = { jsonrpc: JSONRPC_VERSION, id, method }
  if (params !== undefined) req.params = params
  return req
}

export function buildNotification<P>(method: string, params?: P): JsonRpcNotification<string, P> {
  const n: JsonRpcNotification<string, P> = { jsonrpc: JSONRPC_VERSION, method }
  if (params !== undefined) n.params = params
  return n
}

export function buildResult<R>(id: JsonRpcId, result: R): JsonRpcSuccessResponse<R> {
  return { jsonrpc: JSONRPC_VERSION, id, result }
}

export function buildErrorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const err: JsonRpcError = { code, message }
  if (data !== undefined) err.data = data
  return { jsonrpc: JSONRPC_VERSION, id, error: err }
}

// --- type guards (used by the connection's line parser) --------------------

/** Validate a freshly-parsed line is a JSON-RPC 2.0 envelope; null otherwise. */
export function parseAcpMessage(raw: unknown): AcpMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  if ((raw as { jsonrpc?: unknown }).jsonrpc !== JSONRPC_VERSION) return null
  return raw as AcpMessage
}

/** A request: has both `method` and `id`. */
export function isRequest(m: AcpMessage): m is JsonRpcRequest {
  return 'method' in m && 'id' in m
}

/** A notification: has `method` but no `id`. */
export function isNotification(m: AcpMessage): m is JsonRpcNotification {
  return 'method' in m && !('id' in m)
}

/** A response: has `id` but no `method` (success carries `result`, failure `error`). */
export function isResponse(m: AcpMessage): m is JsonRpcResponse {
  return !('method' in m) && 'id' in m
}

export function isErrorResponse(r: JsonRpcResponse): r is JsonRpcErrorResponse {
  return 'error' in r
}
