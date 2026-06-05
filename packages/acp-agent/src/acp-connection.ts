/**
 * acp-connection.ts — the ONLY module that touches NDJSON framing + JSON-RPC
 * correlation. Swapping a bridge = changing this one file.
 *
 * ACP is bidirectional over a single long-lived pipe: we SEND requests /
 * notifications AND the agent sends back its own notifications + reverse
 * requests. Every inbound line is discriminated purely by shape
 * (`parseAcpMessage` + `isRequest` / `isNotification` / `isResponse`):
 *
 *   - response     → resolve / reject the pending outbound request by id
 *   - notification → `onNotify` (the OBSERVE stream: `session/update`)
 *   - request      → `onRequest` (a reverse request, e.g. `session/request_permission`).
 *                    The handler OWNS answering that id via `respond()` /
 *                    `respondError()`. DEFERRED BY DESIGN: the connection never
 *                    auto-answers, so a handler that parks (never responds) simply
 *                    writes no response line — exactly the "subprocess stays blocked
 *                    on an open permission request" semantics that M5 relies on.
 *
 * This layer knows nothing about sessions, prompts, permissions, or escalation.
 * It is a dumb bidirectional JSON-RPC pipe; all ACP meaning lives above it.
 */

import { StringDecoder } from 'node:string_decoder'

import {
  ACP_ERROR,
  buildRequest,
  buildNotification,
  buildResult,
  buildErrorResponse,
  parseAcpMessage,
  isRequest,
  isNotification,
  isResponse,
  isErrorResponse,
  type JsonRpcId,
} from './acp-protocol.js'

/**
 * The minimal duplex the connection drives. A child process's stdio
 * (`child.stdout` as `input`, `child.stdin` as `output`) satisfies it, and so
 * does a crosswise pair of `PassThrough` streams in tests — that injectability
 * (mirroring a2a's `fetchImpl`) is how the unit tests run with no real spawn.
 */
export interface AcpTransport {
  /** Lines IN (agent → hub). */
  input: NodeJS.ReadableStream
  /** Lines OUT (hub → agent). */
  output: NodeJS.WritableStream
}

/** Typed connection failure so callers can branch on `.code` (a JSON-RPC code when the agent erred). */
export class AcpConnectionError extends Error {
  readonly code: number | undefined
  /**
   * The JSON-RPC error `data` payload, when the agent supplied one. Real bridges
   * stash the human-readable reason here (e.g. claude-code-acp puts the failing
   * turn's result text in `data` behind a generic "Internal error" message), so
   * surfacing it is the difference between a debuggable and an opaque failure.
   */
  readonly data: unknown
  constructor(message: string, code?: number, data?: unknown) {
    super(message)
    this.name = 'AcpConnectionError'
    this.code = code
    this.data = data
  }
}

export interface AcpRequestOptions {
  /** Abort → reject this request and forget its id (a late response for it is then dropped). */
  signal?: AbortSignal
}

/**
 * Inbound reverse-request handler. It OWNS answering `id` via the connection's
 * `respond()` / `respondError()` — possibly never (= park, the subprocess stays
 * blocked). The connection does not auto-answer when a handler is registered.
 */
export type AcpRequestHandler = (method: string, params: unknown, id: JsonRpcId) => void
export type AcpNotifyHandler = (method: string, params: unknown) => void
export type AcpCloseHandler = (err?: Error) => void

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export class AcpConnection {
  private readonly output: NodeJS.WritableStream
  private readonly pending = new Map<number, Pending>()
  private readonly decoder = new StringDecoder('utf8')
  private nextId = 1
  private buffer = ''
  private closed = false
  private closeErr: Error | undefined
  private requestHandler: AcpRequestHandler | undefined
  private notifyHandler: AcpNotifyHandler | undefined
  private closeHandler: AcpCloseHandler | undefined

  constructor(transport: AcpTransport) {
    this.output = transport.output
    transport.input.on('data', (chunk: Buffer | string) => this.onData(chunk))
    transport.input.on('end', () => this.onClosed())
    transport.input.on('error', (err: Error) => this.onClosed(err))
  }

  /** Register the reverse-request handler (the INTERCEPT bridge). Last registration wins. */
  onRequest(handler: AcpRequestHandler): void {
    this.requestHandler = handler
  }

  /** Register the notification handler (the OBSERVE stream). */
  onNotify(handler: AcpNotifyHandler): void {
    this.notifyHandler = handler
  }

  /** Fires once when the input ends or errors (after pending requests are rejected). */
  onClose(handler: AcpCloseHandler): void {
    this.closeHandler = handler
  }

  /** Send a request and resolve with its `result` (or reject on error response / close / abort). */
  request<R = unknown>(method: string, params?: unknown, opts: AcpRequestOptions = {}): Promise<R> {
    if (this.closed) return Promise.reject(this.closeErr ?? new AcpConnectionError('acp connection closed'))
    if (opts.signal?.aborted) return Promise.reject(new AcpConnectionError('acp request aborted'))
    const id = this.nextId++
    return new Promise<R>((resolve, reject) => {
      const pending: Pending = { resolve: resolve as (r: unknown) => void, reject }
      if (opts.signal) {
        const onAbort = (): void => {
          if (this.pending.delete(id)) reject(new AcpConnectionError('acp request aborted'))
        }
        pending.signal = opts.signal
        pending.onAbort = onAbort
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pending.set(id, pending)
      this.writeLine(buildRequest(id, method, params))
    })
  }

  /** Fire-and-forget notification (no id, no response). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.writeLine(buildNotification(method, params))
  }

  /** Answer an inbound reverse request with a success result. */
  respond(id: JsonRpcId, result: unknown): void {
    if (this.closed) return
    this.writeLine(buildResult(id, result))
  }

  /** Answer an inbound reverse request with a JSON-RPC error (e.g. reject an unsupported `fs/*`). */
  respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    if (this.closed) return
    this.writeLine(buildErrorResponse(id, code, message, data))
  }

  /** Tear down: reject every in-flight request and fire `onClose`. Idempotent. */
  close(err?: Error): void {
    this.onClosed(err)
  }

  private writeLine(msg: unknown): void {
    this.output.write(JSON.stringify(msg) + '\n')
  }

  private onData(chunk: Buffer | string): void {
    // StringDecoder so a multi-byte UTF-8 char split across two chunks isn't corrupted.
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      this.dispatchLine(line)
    }
  }

  private dispatchLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return // tolerate blank lines / CRLF stragglers
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      // A non-JSON line is noise from the child (e.g. a stray log to stdout); skip it
      // rather than tearing the connection down over one bad line.
      return
    }
    const msg = parseAcpMessage(raw)
    if (!msg) return

    if (isResponse(msg)) {
      // We only ever send integer ids, so a response correlates by number. (Reverse
      // requests carry the agent's own ids — handled in the isRequest branch, never
      // looked up here.)
      if (typeof msg.id !== 'number') return
      const pending = this.pending.get(msg.id)
      if (!pending) return // unknown / already-aborted id
      this.pending.delete(msg.id)
      if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort)
      if (isErrorResponse(msg)) {
        pending.reject(
          new AcpConnectionError(`acp error ${msg.error.code}: ${msg.error.message}`, msg.error.code, msg.error.data),
        )
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (isRequest(msg)) {
      if (this.requestHandler) {
        // Deferred by design: the handler answers `msg.id` whenever it likes (or never).
        this.requestHandler(msg.method, msg.params, msg.id)
      } else {
        // No listener at all → fail fast rather than hang the agent on an open request.
        this.respondError(msg.id, ACP_ERROR.METHOD_NOT_FOUND, `no handler for ${msg.method}`)
      }
      return
    }

    if (isNotification(msg)) {
      this.notifyHandler?.(msg.method, msg.params)
    }
  }

  private onClosed(err?: Error): void {
    if (this.closed) return
    this.closed = true
    this.closeErr = err ?? new AcpConnectionError('acp connection closed')
    for (const pending of this.pending.values()) {
      if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort)
      pending.reject(this.closeErr)
    }
    this.pending.clear()
    this.closeHandler?.(err)
  }
}
