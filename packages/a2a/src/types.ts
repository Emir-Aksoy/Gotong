/**
 * A2A (Agent2Agent) wire types — the subset AipeHub speaks.
 *
 * Scope is the blocking `message/send` JSON-RPC method of A2A 0.2.5, the
 * AgentSkill subset the agent card advertises, AND the task lifecycle pair
 * `message/send`(→Task) + `tasks/get` (Route B P1-M8). When a cross-org
 * dispatch SUSPENDS (long-running compute / HITL approval) the host can no
 * longer answer in one blocking round-trip, so it returns a `Task` with state
 * `working`; the caller polls `tasks/get` until the task reaches a terminal
 * state. Streaming (`message/stream`) + push notifications stay out of scope
 * (the agent card's streaming/push capability flags remain false — honest).
 *
 * Shared by BOTH directions so the inbound server (host) and the outbound
 * client agree on one vocabulary:
 *   - inbound:  host parses an A2ARequest → dispatches → returns a Message (ok)
 *               or a Task (suspended); `tasks/get` polls the parked task.
 *   - outbound: the client builds an A2ARequest → reads back a Message or Task;
 *               `a2aGetTask` polls a returned Task to a terminal state.
 */

export const A2A_METHOD_MESSAGE_SEND = 'message/send'
/** Route B P1-M8 — poll a parked task's status/result. */
export const A2A_METHOD_TASKS_GET = 'tasks/get'
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

// --- task lifecycle (Route B P1-M8) ----------------------------------------

/**
 * A2A `TaskState` (0.2.5) — the subset AipeHub emits / recognizes. The host
 * EMITS only `working` (parked: long compute or HITL approval), `completed`
 * (the parked task resumed → ok) and `failed` (resumed → failed / cancelled /
 * no_participant). `submitted` / `input-required` / `canceled` are recognized
 * for forward-compat with richer peers but the host doesn't produce them yet.
 */
export const A2A_TASK_STATES = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
] as const
export type A2ATaskState = (typeof A2A_TASK_STATES)[number]

/** Terminal states — a poller can stop once a task reaches one of these. */
export const A2A_TERMINAL_TASK_STATES: readonly A2ATaskState[] = ['completed', 'failed', 'canceled']

export function isTerminalTaskState(state: A2ATaskState): boolean {
  return A2A_TERMINAL_TASK_STATES.includes(state)
}

/**
 * A2A `TaskStatus` (0.2.5). `message` carries the agent's reply (when
 * `completed`) or the error text (when `failed`).
 */
export interface A2ATaskStatus {
  state: A2ATaskState
  message?: A2AMessage
  /** ISO-8601 timestamp; optional (injected for deterministic tests, else omitted). */
  timestamp?: string
}

/**
 * An A2A `Task` (0.2.5 subset). `id` is an OPAQUE, server-minted handle —
 * NEVER the internal hub task id (that would leak naming and let a peer poll
 * another org's task). `tasks/get` resolves it back, scoped to the
 * authenticated peer that created it.
 */
export interface A2ATask {
  id: string
  kind: 'task'
  status: A2ATaskStatus
  contextId?: string
}

/** `params` of a `tasks/get` call. */
export interface A2ATasksGetParams {
  id: string
}

/** JSON-RPC 2.0 request for `tasks/get`. */
export interface A2ATasksGetRequest {
  jsonrpc: typeof JSONRPC_VERSION
  id: string | number
  method: typeof A2A_METHOD_TASKS_GET
  params: A2ATasksGetParams
}

/** JSON-RPC 2.0 error object. */
export interface A2AErrorObject {
  code: number
  message: string
  data?: unknown
}

/**
 * JSON-RPC 2.0 response. `result` is a Message (blocking `message/send` that
 * completed) OR a Task (`message/send` that suspended, and every `tasks/get`).
 * Discriminate by `result.kind` ('message' | 'task').
 */
export interface A2AResponse {
  jsonrpc: typeof JSONRPC_VERSION
  id: string | number | null
  result?: A2AMessage | A2ATask
  error?: A2AErrorObject
}

/**
 * JSON-RPC error codes we use. -326xx are the JSON-RPC reserved range; -32001
 * is A2A 0.2.5's `TaskNotFoundError` (a `tasks/get` for an unknown task id, or
 * one not owned by the authenticated peer — fail-closed, anti-enumeration).
 */
export const A2A_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** `tasks/get` for an unknown / not-owned task id (A2A `TaskNotFoundError`). */
  TASK_NOT_FOUND: -32001,
  /**
   * @deprecated Route B P1-M8 — `message/send` now returns a `Task` (state
   * `working`) instead of this error when a dispatch suspends. Same numeric
   * value as TASK_NOT_FOUND (A2A's -32001); removed once the host stops
   * emitting it (M8b).
   */
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

// --- task lifecycle builders (Route B P1-M8) -------------------------------

interface TaskBuildOpts {
  contextId?: string
  /** ISO-8601 timestamp; omitted when absent (kept off the wire for tests). */
  timestamp?: string
}

function makeTask(id: string, status: A2ATaskStatus, opts: TaskBuildOpts): A2ATask {
  const task: A2ATask = { id, kind: 'task', status }
  if (opts.contextId) task.contextId = opts.contextId
  return task
}

/** A `Task` in the `working` state — the dispatch suspended (long compute / HITL). */
export function workingTask(id: string, opts: TaskBuildOpts = {}): A2ATask {
  const status: A2ATaskStatus = { state: 'working' }
  if (opts.timestamp) status.timestamp = opts.timestamp
  return makeTask(id, status, opts)
}

/** A `completed` Task — the parked task resumed → ok; reply text is the status message. */
export function completedTask(
  id: string,
  text: string,
  messageId: string,
  opts: TaskBuildOpts = {},
): A2ATask {
  const status: A2ATaskStatus = { state: 'completed', message: agentMessage(text, messageId) }
  if (opts.timestamp) status.timestamp = opts.timestamp
  return makeTask(id, status, opts)
}

/** A `failed` Task — the parked task resumed → failed; error text is the status message. */
export function failedTask(
  id: string,
  errorText: string,
  messageId: string,
  opts: TaskBuildOpts = {},
): A2ATask {
  const status: A2ATaskStatus = { state: 'failed', message: agentMessage(errorText, messageId) }
  if (opts.timestamp) status.timestamp = opts.timestamp
  return makeTask(id, status, opts)
}

/** Build a full JSON-RPC `tasks/get` request. */
export function buildTasksGetRequest(taskId: string, requestId: string | number): A2ATasksGetRequest {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: requestId,
    method: A2A_METHOD_TASKS_GET,
    params: { id: taskId },
  }
}

/** Type guard — discriminate a response `result` between a Message and a Task. */
export function isA2ATask(result: A2AMessage | A2ATask): result is A2ATask {
  return result.kind === 'task'
}
