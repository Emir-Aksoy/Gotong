/**
 * `a2aSend` — POST a text message to an A2A agent's `message/send` endpoint
 * and return the agent's text reply.
 *
 * `fetchImpl` is injectable so tests (and the double-hub smoke) run without a
 * real network. The bearer token goes in `Authorization: Bearer <token>`;
 * `peerId` (AipeHub-to-AipeHub) adds the `X-Aipe-Peer-Id` header the receiving
 * hub uses to resolve the expected token + synthesize task origin. A generic
 * (non-AipeHub) A2A agent needs only the bearer.
 */

import { buildSendRequest, messageText, type A2AResponse } from './types.js'

/** Typed client failure so callers can branch on `.code` (a JSON-RPC / HTTP code). */
export class A2aClientError extends Error {
  readonly code: number | undefined
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'A2aClientError'
    this.code = code
  }
}

export interface A2aSendOptions {
  /** Inject for deterministic tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** A2A message id; defaults to a random uuid. */
  messageId?: string
  /** JSON-RPC request id; defaults to 1. */
  requestId?: string | number
  /**
   * AipeHub-to-AipeHub only: the CALLER's own peer id, sent as `X-Aipe-Peer-Id`
   * so the receiving hub resolves the expected bearer + stamps origin. Omit
   * for a generic (non-AipeHub) A2A agent.
   */
  peerId?: string
  /**
   * Message metadata forwarded on the request. An AipeHub server reads
   * `metadata.skill` to pick the dispatch capability; set `{ skill: '...' }`
   * to target a specific remote capability.
   */
  metadata?: Record<string, unknown>
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal
}

export async function a2aSend(
  url: string,
  token: string,
  text: string,
  opts: A2aSendOptions = {},
): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch
  const messageId = opts.messageId ?? crypto.randomUUID()
  const requestId = opts.requestId ?? 1
  const body = buildSendRequest(text, {
    messageId,
    requestId,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  })

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
    throw new A2aClientError(
      `a2aSend transport error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!res.ok) {
    throw new A2aClientError(`a2aSend HTTP ${res.status}`, res.status)
  }

  let parsed: A2AResponse
  try {
    parsed = (await res.json()) as A2AResponse
  } catch {
    throw new A2aClientError('a2aSend: response was not valid JSON')
  }

  if (parsed.error) {
    throw new A2aClientError(
      `a2aSend JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`,
      parsed.error.code,
    )
  }
  if (!parsed.result || !Array.isArray(parsed.result.parts)) {
    throw new A2aClientError('a2aSend: response had no message result')
  }
  return messageText(parsed.result)
}
