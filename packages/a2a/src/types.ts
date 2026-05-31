/**
 * A2A (Agent2Agent) wire types — the subset AipeHub speaks.
 *
 * Scope is deliberately the blocking `message/send` JSON-RPC method of A2A
 * 0.2.5, plus the AgentSkill subset the agent card advertises. Streaming
 * (`message/stream`), task lifecycle (`tasks/get`), and push notifications are
 * out of scope — the host serves only blocking `message/send` (see the agent
 * card capability flags, all false).
 *
 * Shared by BOTH directions so the inbound server (host, C-M3) and the
 * outbound `A2aRemoteParticipant` (C-M4) agree on one vocabulary:
 *   - inbound:  host parses an A2ARequest → dispatches → returns an A2AMessage
 *   - outbound: the participant builds an A2ARequest → reads back the A2AMessage
 */

export const A2A_METHOD_MESSAGE_SEND = 'message/send'
export const JSONRPC_VERSION = '2.0'

/** A2A `AgentSkill` (0.2.5) subset — mirrors the host agent card's skill shape. */
export interface A2ASkill {
  id: string
  name: string
  description?: string
  tags?: string[]
}

/** A text part — the only `Part` kind AipeHub emits / reads. */
export interface A2ATextPart {
  kind: 'text'
  text: string
}

export type A2APart = A2ATextPart

/** An A2A `Message` (0.2.5). `role` is `user` inbound, `agent` on the reply. */
export interface A2AMessage {
  role: 'user' | 'agent'
  parts: A2APart[]
  messageId: string
  kind: 'message'
  /** Set when the message is associated with a task (we don't create tasks). */
  taskId?: string
  contextId?: string
  /**
   * Free-form metadata. The host A2A server reads `metadata.skill` (a string)
   * to pick the dispatch capability when present, else falls back to the
   * server's configured default capability.
   */
  metadata?: Record<string, unknown>
}

/** `params` of a `message/send` call. */
export interface A2ASendParams {
  message: A2AMessage
  // `configuration` (blocking flag, accepted output modes, …) omitted — we
  // serve only the blocking default.
}

/** JSON-RPC 2.0 request for `message/send`. */
export interface A2ARequest {
  jsonrpc: typeof JSONRPC_VERSION
  id: string | number
  method: typeof A2A_METHOD_MESSAGE_SEND
  params: A2ASendParams
}

/** JSON-RPC 2.0 error object. */
export interface A2AErrorObject {
  code: number
  message: string
  data?: unknown
}

/**
 * JSON-RPC 2.0 response. For blocking `message/send` the `result` is an
 * `A2AMessage` — our server always replies with a Message, never a Task.
 */
export interface A2AResponse {
  jsonrpc: typeof JSONRPC_VERSION
  id: string | number | null
  result?: A2AMessage
  error?: A2AErrorObject
}

/**
 * JSON-RPC error codes we use. -32xxx are the JSON-RPC reserved range; -32001
 * is our "the dispatch suspended" signal (this version has no task lifecycle
 * to poll, so a parked cross-org call surfaces as an error rather than a Task).
 */
export const A2A_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** Dispatch returned `suspended` — not resumable over this minimal surface. */
  SUSPENDED: -32001,
  /** No participant satisfied the requested capability. */
  NO_PARTICIPANT: -32002,
} as const

// --- helpers ---------------------------------------------------------------

export function textPart(text: string): A2ATextPart {
  return { kind: 'text', text }
}

/** Concatenate every text part of a message (non-text parts are skipped). */
export function messageText(message: A2AMessage): string {
  return message.parts
    .filter((p): p is A2ATextPart => p.kind === 'text')
    .map((p) => p.text)
    .join('')
}

/** Build a `user`-role message carrying a single text part. */
export function userMessage(
  text: string,
  messageId: string,
  metadata?: Record<string, unknown>,
): A2AMessage {
  const m: A2AMessage = { role: 'user', parts: [textPart(text)], messageId, kind: 'message' }
  if (metadata) m.metadata = metadata
  return m
}

/** Build an `agent`-role reply carrying a single text part. */
export function agentMessage(text: string, messageId: string): A2AMessage {
  return { role: 'agent', parts: [textPart(text)], messageId, kind: 'message' }
}

/** Build a full JSON-RPC `message/send` request from text. */
export function buildSendRequest(
  text: string,
  opts: { messageId: string; requestId: string | number; metadata?: Record<string, unknown> },
): A2ARequest {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: opts.requestId,
    method: A2A_METHOD_MESSAGE_SEND,
    params: { message: userMessage(text, opts.messageId, opts.metadata) },
  }
}
