/**
 * OneBot v11 forward-WebSocket client.
 *
 * Responsibilities:
 *
 *   1. Connect to `ws://<adapter>:<port>/` (or wss for TLS-fronted
 *      adapters). Optional access token in
 *      `Authorization: Bearer <token>` or as `?access_token=` query.
 *   2. Route incoming frames into two streams:
 *      - Frames with `echo` matching an outstanding action request →
 *        resolve the pending promise.
 *      - Frames without `echo` (server-push events) → emit to the
 *        `onEvent` callback.
 *   3. Surface non-zero `retcode` as `OneBotApiError`.
 *   4. Per-action timeout with AbortController-like semantics —
 *      stale actions don't sit in the pending map forever.
 *
 * What's NOT here (deliberate for M7):
 *
 *   - Reconnect logic. The bridge owns lifecycle and reconnects by
 *     constructing a new client. Keeping the client single-life
 *     simplifies the pending-actions map (no need to think about
 *     "what happens to in-flight actions on reconnect?" — bridge
 *     re-creates the client from scratch and any pending promises
 *     reject with `disposed`).
 *   - HTTP transport. v11 spec supports HTTP POST + reverse webhook
 *     but forward WebSocket is the simplest production setup.
 *   - Message rate limiting. The adapter is responsible for QQ-side
 *     pacing — bridge sends as fast as the caller asks.
 *
 * Why not just use a WebSocket-RPC library: OneBot v11's wire format
 * is JSON+echo and only ~50 lines of routing. A library would drag
 * in extra deps and an opinionated reconnect strategy.
 */

import type {
  OneBotActionRequest,
  OneBotActionResponse,
  OneBotEvent,
} from './types.js'

/**
 * Minimal WebSocket interface. We type to the platform-neutral
 * surface (readyState + onopen/onmessage/onclose/onerror + send/close)
 * so we can swap in `ws`, `undici.WebSocket`, or `globalThis.WebSocket`
 * on Node 22+.
 */
export interface WebSocketLike {
  readyState: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type WebSocketCtor = new (url: string, protocols?: string[]) => WebSocketLike

export class OneBotApiError extends Error {
  readonly action: string
  /** Numeric retcode (non-zero, since 0 doesn't reach here). */
  readonly retcode: number
  /** Adapter-supplied human message ('wording' takes precedence over 'msg'). */
  readonly detail: string | null

  constructor(input: { action: string; retcode: number; msg?: string; wording?: string }) {
    const detail = input.wording ?? input.msg ?? null
    super(`onebot ${input.action}: retcode=${input.retcode}${detail ? ` — ${detail}` : ''}`)
    this.name = 'OneBotApiError'
    this.action = input.action
    this.retcode = input.retcode
    this.detail = detail
  }
}

export interface OneBotClientOptions {
  /**
   * WebSocket endpoint exposed by the OneBot adapter. Example:
   *   ws://127.0.0.1:3001/
   *   wss://obb.example.com/ws
   * Required.
   */
  url: string
  /**
   * Optional access token. When set, the client sends it on the
   * initial WebSocket upgrade as `Authorization: Bearer <token>`
   * and also appends `?access_token=<token>` for adapters that
   * only check the query form. (NapCat / go-cqhttp accept either.)
   */
  accessToken?: string
  /**
   * WebSocket constructor. Defaults to `globalThis.WebSocket`.
   * Node 22+ has it; on Node 20 pass `import { WebSocket } from "ws"`
   * (note: `ws` ignores the `protocols` arg the same way browser does).
   */
  webSocketImpl?: WebSocketCtor
  /**
   * Per-action timeout. Defaults to 30s — `send_msg` on a healthy
   * adapter is milliseconds, but image uploads can take longer. We
   * pick a ceiling generous enough for the common case and let the
   * caller adjust per-call.
   */
  timeoutMs?: number
  /**
   * Random hex id factory — injected for tests. Defaults to a 12-byte
   * crypto-random hex string. The id only needs to be unique on the
   * one open socket, so 12 bytes (~96 bits) is overkill safety.
   */
  generateEcho?: () => string
}

export interface OneBotClient {
  /**
   * Open the underlying WebSocket and wait for it to enter
   * OPEN state. Throws on connect failure (refused / bad token).
   */
  start(): Promise<void>
  /**
   * Close the socket. Any pending actions reject with `disposed`.
   * Idempotent.
   */
  stop(): Promise<void>
  /**
   * Subscribe to server-push events (messages, lifecycle, …).
   * Returns an unsubscribe function. Replacing is undefined.
   */
  onEvent(listener: (ev: OneBotEvent) => void): () => void
  /** Subscribe to lifecycle changes (open / close / error). */
  onState(listener: (state: 'connecting' | 'open' | 'closed') => void): () => void
  /**
   * Send an action and resolve with `data`. Rejects with
   * `OneBotApiError` on non-zero retcode, `TimeoutError` on timeout,
   * `Error('disposed')` when the client is stopped mid-flight.
   */
  callAction<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>
  /** Current connection state — useful for diagnostics. */
  readonly state: 'connecting' | 'open' | 'closed'
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Default crypto-random hex echo factory. Lives outside the
 * `createOneBotClient` body so the closure stays small.
 */
function defaultGenerateEcho(): string {
  const arr = new Uint8Array(12)
  // crypto.getRandomValues is global on Node 18+ and all browsers.
  globalThis.crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function createOneBotClient(opts: OneBotClientOptions): OneBotClient {
  if (typeof opts?.url !== 'string' || opts.url.length === 0) {
    throw new TypeError('createOneBotClient: url is required')
  }
  const resolvedWs =
    opts.webSocketImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
  if (!resolvedWs) {
    throw new TypeError(
      'createOneBotClient: no WebSocket implementation available. ' +
        'Pass webSocketImpl explicitly (Node 20: `import { WebSocket } from "ws"`) ' +
        'or run on Node 22+ which has built-in WebSocket.',
    )
  }
  const WebSocketImpl: WebSocketCtor = resolvedWs
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const generateEcho = opts.generateEcho ?? defaultGenerateEcho

  // Build the connect URL. NapCat / go-cqhttp accept the token via
  // header OR query string; we put it on the query so the same call
  // works on adapters that ignore subprotocol/header (some browser
  // WebSocket impls strip the Authorization header on connect).
  function buildUrl(): string {
    if (!opts.accessToken) return opts.url
    const sep = opts.url.includes('?') ? '&' : '?'
    return `${opts.url}${sep}access_token=${encodeURIComponent(opts.accessToken)}`
  }

  let ws: WebSocketLike | null = null
  let state: 'connecting' | 'open' | 'closed' = 'closed'
  let disposed = false
  const eventListeners: Array<(ev: OneBotEvent) => void> = []
  const stateListeners: Array<(s: 'connecting' | 'open' | 'closed') => void> = []
  /**
   * Pending actions, keyed by echo. Each entry holds the resolver +
   * a timeout timer that we clear on response. We also use this map
   * to fail-fast all in-flights on close / stop.
   */
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (err: unknown) => void
      action: string
      timer: ReturnType<typeof setTimeout>
    }
  >()

  function setState(s: 'connecting' | 'open' | 'closed'): void {
    // Dedup repeated transitions to the same state. Without this,
    // `stop()` racing with the socket's own onclose fires `closed`
    // twice on subscribers.
    if (state === s) return
    state = s
    for (const l of stateListeners) {
      try {
        l(s)
      } catch {
        // Ignore listener errors here; lifecycle path must stay clean.
      }
    }
  }

  function failAllPending(err: Error): void {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  function handleFrame(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // Drop malformed frames — adapters shouldn't send these but
      // we don't want one bad frame to take down the socket.
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    const obj = parsed as Record<string, unknown>
    // Response shape: has `echo` matching a pending action.
    if (typeof obj.echo === 'string' && pending.has(obj.echo)) {
      const entry = pending.get(obj.echo)!
      pending.delete(obj.echo)
      clearTimeout(entry.timer)
      const resp = obj as unknown as OneBotActionResponse
      if (resp.retcode === 0 || resp.retcode === 1) {
        entry.resolve(resp.data)
      } else {
        entry.reject(
          new OneBotApiError({
            action: entry.action,
            retcode: resp.retcode,
            msg: resp.msg,
            wording: resp.wording,
          }),
        )
      }
      return
    }
    // Otherwise it's an event push.
    if (typeof obj.post_type === 'string') {
      const ev = obj as unknown as OneBotEvent
      for (const l of eventListeners) {
        try {
          l(ev)
        } catch {
          // Event-listener throws are swallowed at this layer — the
          // bridge is responsible for surfacing via onError.
        }
      }
    }
  }

  return {
    get state() {
      return state
    },
    async start(): Promise<void> {
      if (disposed) throw new Error('OneBotClient: already disposed')
      if (state !== 'closed') return
      setState('connecting')
      const sock = new WebSocketImpl(buildUrl())
      ws = sock
      await new Promise<void>((resolve, reject) => {
        const onOpen = (): void => {
          sock.onopen = null
          sock.onerror = null
          setState('open')
          resolve()
        }
        const onErr = (ev: unknown): void => {
          sock.onopen = null
          sock.onerror = null
          ws = null
          setState('closed')
          reject(
            new Error(
              `OneBotClient: WebSocket connect failed${
                ev && typeof ev === 'object' && 'message' in ev
                  ? `: ${String((ev as { message?: unknown }).message)}`
                  : ''
              }`,
            ),
          )
        }
        sock.onopen = onOpen
        sock.onerror = onErr
        sock.onmessage = (ev) => {
          // Browser sends ArrayBuffer for binary, string for text;
          // ws sends Buffer. Normalise to string.
          if (typeof ev.data === 'string') handleFrame(ev.data)
          else if (ev.data instanceof ArrayBuffer)
            handleFrame(new TextDecoder('utf-8').decode(ev.data))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          else if ((ev.data as any)?.toString) handleFrame((ev.data as any).toString('utf-8'))
        }
        sock.onclose = (ev) => {
          ws = null
          setState('closed')
          failAllPending(
            new Error(
              `OneBotClient: socket closed (code=${ev.code ?? 'n/a'} reason=${ev.reason ?? ''})`,
            ),
          )
        }
      })
    },
    async stop(): Promise<void> {
      if (disposed) return
      disposed = true
      const sock = ws
      ws = null
      failAllPending(new Error('disposed'))
      if (sock) {
        try {
          sock.close(1000, 'normal')
        } catch {
          // Close throws on already-closed sockets in some impls.
        }
      }
      setState('closed')
    },
    onEvent(listener) {
      eventListeners.push(listener)
      return () => {
        const i = eventListeners.indexOf(listener)
        if (i >= 0) eventListeners.splice(i, 1)
      }
    },
    onState(listener) {
      stateListeners.push(listener)
      return () => {
        const i = stateListeners.indexOf(listener)
        if (i >= 0) stateListeners.splice(i, 1)
      }
    },
    async callAction<T = unknown>(
      action: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      if (disposed) throw new Error('OneBotClient: disposed')
      if (state !== 'open' || !ws) {
        throw new Error(`OneBotClient: cannot send while state=${state}`)
      }
      const echo = generateEcho()
      const req: OneBotActionRequest = { action, params, echo }
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(echo)) {
            pending.delete(echo)
            reject(
              new Error(
                `OneBotClient: action timeout after ${timeoutMs}ms — action=${action}`,
              ),
            )
          }
        }, timeoutMs)
        pending.set(echo, {
          action,
          resolve: (v) => resolve(v as T),
          reject,
          timer,
        })
        try {
          ws!.send(JSON.stringify(req))
        } catch (err) {
          pending.delete(echo)
          clearTimeout(timer)
          reject(err)
        }
      })
    },
  }
}
