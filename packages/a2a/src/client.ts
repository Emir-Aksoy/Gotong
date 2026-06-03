/**
 * A2A client — POST to an A2A agent's JSON-RPC endpoint.
 *
 *   - `a2aSend(url, token, text)` — blocking `message/send`, returns the agent's
 *     text reply. If the remote SUSPENDED (returned a Task instead of a
 *     Message) it throws `A2aClientError` carrying `.taskId` so the caller can
 *     poll. (Backward-compatible blocking helper; used by the C-M4 participant.)
 *   - `a2aSendRaw(...)` — same POST but returns the raw `Message | Task` result
 *     so a caller that understands task lifecycle (Route B P1-M8) can branch.
 *   - `a2aGetTask(url, token, taskId)` — one `tasks/get`, returns the `Task`.
 *
 * `fetchImpl` is injectable so tests (and the double-hub smoke) run without a
 * real network. The bearer goes in `Authorization: Bearer <token>`; `peerId`
 * (AipeHub-to-AipeHub) adds the `X-Aipe-Peer-Id` header the receiving hub uses
 * to resolve the expected token + synthesize task origin / scope task ownership.
 * A generic (non-AipeHub) A2A agent needs only the bearer.
 */

import {
  buildSendRequest,
  buildTasksGetRequest,
  isA2ATask,
  messageText,
  type A2AMessage,
  type A2AResponse,
  type A2ATask,
} from './types.js'

/** Typed client failure so callers can branch on `.code` (a JSON-RPC / HTTP code). */
export class A2aClientError extends Error {
  readonly code: number | undefined
  /**
   * Set when a blocking `a2aSend` got a Task instead of a Message (the remote
   * suspended) — poll this id via `a2aGetTask` instead of treating it as failed.
   */
  readonly taskId: string | undefined
  constructor(message: string, code?: number, taskId?: string) {
    super(message)
    this.name = 'A2aClientError'
    this.code = code
    this.taskId = taskId
  }
}

interface PostOptions {
  /** Inject for deterministic tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /**
   * AipeHub-to-AipeHub only: the CALLER's own peer id, sent as `X-Aipe-Peer-Id`
   * so the receiving hub resolves the expected bearer + stamps origin. Omit
   * for a generic (non-AipeHub) A2A agent.
   */
  peerId?: string
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal
}

export interface A2aSendOptions extends PostOptions {
  /** A2A message id; defaults to a random uuid. */
  messageId?: string
  /** JSON-RPC request id; defaults to 1. */
  requestId?: string | number
  /**
   * Message metadata forwarded on the request. An AipeHub server reads
   * `metadata.skill` to pick the dispatch capability; set `{ skill: '...' }`
   * to target a specific remote capability.
   */
  metadata?: Record<string, unknown>
}

export interface A2aGetTaskOptions extends PostOptions {
  /** JSON-RPC request id; defaults to 1. */
  requestId?: string | number
}

/** Shared transport: POST a JSON-RPC body, map transport/HTTP/JSON-RPC errors, return the response. */
async function postA2a(url: string, token: string, body: unknown, opts: PostOptions): Promise<A2AResponse> {
  const doFetch = opts.fetchImpl ?? fetch
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (opts.peerId) headers['x-aipe-peer-id'] = opts.peerId

  let res: Response
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (err) {
    throw new A2aClientError(`a2a transport error: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) {
    throw new A2aClientError(`a2a HTTP ${res.status}`, res.status)
  }
  let parsed: A2AResponse
  try {
    parsed = (await res.json()) as A2AResponse
  } catch {
    throw new A2aClientError('a2a: response was not valid JSON')
  }
  if (parsed.error) {
    throw new A2aClientError(`a2a JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`, parsed.error.code)
  }
  return parsed
}

/**
 * Blocking `message/send` — return the raw result (Message ok, or Task when the
 * remote suspended). Throws only on transport / HTTP / JSON-RPC failure.
 */
export async function a2aSendRaw(
  url: string,
  token: string,
  text: string,
  opts: A2aSendOptions = {},
): Promise<A2AMessage | A2ATask> {
  const body = buildSendRequest(text, {
    messageId: opts.messageId ?? crypto.randomUUID(),
    requestId: opts.requestId ?? 1,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  })
  const parsed = await postA2a(url, token, body, opts)
  if (!parsed.result) {
    throw new A2aClientError('a2aSend: response had no result')
  }
  return parsed.result
}

/**
 * Blocking `message/send`, returning the reply TEXT. If the remote returns a
 * Task (it suspended), throws `A2aClientError` with `.taskId` set — the caller
 * should poll `a2aGetTask` rather than treat it as a hard failure.
 */
export async function a2aSend(
  url: string,
  token: string,
  text: string,
  opts: A2aSendOptions = {},
): Promise<string> {
  const result = await a2aSendRaw(url, token, text, opts)
  if (isA2ATask(result)) {
    throw new A2aClientError(
      `a2aSend: remote returned a Task (state ${result.status.state}); poll tasks/get`,
      undefined,
      result.id,
    )
  }
  if (!Array.isArray(result.parts)) {
    throw new A2aClientError('a2aSend: response had no message result')
  }
  return messageText(result)
}

/** Poll a parked task once via `tasks/get`; returns the current `Task`. */
export async function a2aGetTask(
  url: string,
  token: string,
  taskId: string,
  opts: A2aGetTaskOptions = {},
): Promise<A2ATask> {
  const body = buildTasksGetRequest(taskId, opts.requestId ?? 1)
  const parsed = await postA2a(url, token, body, opts)
  if (!parsed.result || !isA2ATask(parsed.result)) {
    throw new A2aClientError('a2aGetTask: response was not a Task')
  }
  return parsed.result
}
