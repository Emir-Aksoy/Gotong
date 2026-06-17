/**
 * Slack Socket Mode connection — the OFFICIAL 免穿透 transport.
 *
 * Socket Mode is Slack's outbound WebSocket: the app dials OUT, so no
 * public webhook URL, no TLS, no reverse proxy, no HMAC signing secret
 * are needed. This matches every other "official + 免穿透" bridge here
 * (Telegram long-poll, Discord gateway, Lark long connection) and is
 * the path OpenClaw / Hermes use for Slack.
 *
 * Protocol (https://docs.slack.dev/apis/events-api/using-socket-mode/):
 *
 *   1. POST apps.connections.open with the app-level token
 *      (`xapp-…`, `connections:write` scope) → `{ ok: true, url:
 *      "wss://…" }`. That URL is SINGLE-USE and expires in ~30s if not
 *      connected — we fetch a fresh one on every (re)connect.
 *   2. Connect. The server sends a `hello` message.
 *   3. The server pushes envelopes `{ envelope_id, type, payload }`.
 *      We ACK each by sending `{ envelope_id }` straight back (Slack
 *      wants the ack within 3s, independent of processing), then route
 *      the payload by `type`. Only `events_api` payloads (the standard
 *      `event_callback` body) surface to the consumer; `slash_commands`
 *      / `interactive` get an ack-only — out of scope for this bridge.
 *   4. The server may send a `disconnect` (reason: refresh_requested /
 *      warning / too_many_connections) before recycling the socket. We
 *      tear down and reconnect with a fresh URL.
 *
 * Unlike Discord's gateway, Socket Mode needs NO app-level heartbeat:
 * Slack pings at the WebSocket protocol level and the `ws` library
 * auto-pongs. So this state machine is simpler than Discord's — there's
 * no heartbeat timer, no sequence tracking, no RESUME.
 *
 * The `webSocketImpl` injection lets hermetic tests drive the whole
 * dance with a fake socket — no real network. Pass `socketUrl` to skip
 * the `apps.connections.open` round trip entirely.
 */

import type { SlackConnectionsOpenResponse, SlackSocketEnvelope } from './types.js'

// ---------------------------------------------------------------------------
// WebSocket abstraction — `globalThis.WebSocket` (Node 22+) or `ws` / `undici`
// ---------------------------------------------------------------------------

/**
 * Minimal WebSocket-shaped interface the connection needs. The `ws` npm
 * package's `WebSocket`, `undici.WebSocket`, and Node 22+
 * `globalThis.WebSocket` all conform. Mirrors im-discord's `WebSocketLike`
 * — im-slack keeps its own copy rather than depend on im-discord.
 */
export interface WebSocketLike {
  readyState: number
  onopen: ((ev?: unknown) => void) | null
  onclose: ((ev: { code: number; reason: string; wasClean?: boolean }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type WebSocketCtor = new (url: string) => WebSocketLike

// readyState OPEN per the WebSocket spec (CONNECTING=0, OPEN=1,
// CLOSING=2, CLOSED=3). Inlined so we don't depend on a specific impl.
const WS_OPEN = 1

// ---------------------------------------------------------------------------
// apps.connections.open error classification
// ---------------------------------------------------------------------------

/**
 * `apps.connections.open` error codes that mean "stop, don't retry" —
 * the app token is bad or the app is disabled, so reconnecting can
 * never succeed. Everything else (rate limits, transient 5xx, network)
 * is retried with backoff.
 */
const FATAL_OPEN_ERRORS = new Set([
  'invalid_auth',
  'not_allowed_token_type',
  'account_inactive',
  'token_revoked',
  'token_expired',
])

/** Error thrown by `pickSocketUrl` — carries the fatal/transient verdict. */
interface ConnectionsOpenError extends Error {
  code?: string
  fatal?: boolean
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface SlackSocketModeOptions {
  /**
   * App-level token (`xapp-…`, `connections:write` scope). Used to call
   * `apps.connections.open`. NOT the bot token — the bot token
   * (`xoxb-…`) is only for the Web API send path.
   */
  appToken: string
  /**
   * WebSocket constructor. Defaults to `globalThis.WebSocket` (Node
   * 22+). Node 20 doesn't have it built in — pass `WebSocket` from `ws`
   * or `undici`.
   */
  webSocketImpl?: WebSocketCtor
  /** Inject a fetch impl for `apps.connections.open`. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** API base. Defaults to `https://slack.com/api`. */
  baseUrl?: string
  /**
   * Override the WSS URL — skips `apps.connections.open`. Mostly for
   * tests; production fetches a fresh single-use URL on each connect.
   */
  socketUrl?: string
  /** Initial reconnect backoff in ms. Grows exponentially. Default 1000. */
  reconnectBackoffMs?: number
  /** Cap on reconnect backoff. Default 30000. */
  reconnectMaxBackoffMs?: number

  /**
   * Called once per inbound `events_api` envelope with its `payload` —
   * the standard `event_callback` body. The ack is already sent by the
   * time this runs.
   */
  onEvent: (payload: unknown) => void | Promise<void>
  /** Called once when the `hello` message arrives (connection established). */
  onHello?: (envelope: SlackSocketEnvelope) => void
  /** Diagnostic surface for transient errors. Defaults to no-op. */
  onError?: (err: unknown) => void
  /**
   * Called when the connection closes for good — either by `stop()`
   * (`intentional: true`) or by a fatal `apps.connections.open` failure
   * (`fatal: true`). The connection stops trying to reconnect in either
   * case.
   */
  onClose?: (info: { intentional: boolean; fatal: boolean; reason: string }) => void
}

export interface SlackSocketMode {
  /** Open the connection (fetch URL + connect). Resolves once the socket is constructed. */
  start(): Promise<void>
  /** Close + cleanup. Idempotent. */
  stop(): Promise<void>
  /** Current state, mostly for tests / observability. */
  readonly state: 'idle' | 'connecting' | 'open' | 'closing' | 'closed'
}

// ---------------------------------------------------------------------------
// createSlackSocketMode
// ---------------------------------------------------------------------------

export function createSlackSocketMode(opts: SlackSocketModeOptions): SlackSocketMode {
  if (typeof opts?.appToken !== 'string' || opts.appToken.length === 0) {
    throw new TypeError('createSlackSocketMode: appToken is required')
  }
  const resolvedWs =
    opts.webSocketImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
  if (!resolvedWs) {
    throw new TypeError(
      'createSlackSocketMode: no WebSocket implementation. ' +
        'Pass `webSocketImpl` (e.g. `import { WebSocket } from "ws"`) or upgrade to Node 22+ which has globalThis.WebSocket built in.',
    )
  }
  // Bind to a non-null local so TypeScript narrowing survives the async
  // closures below.
  const WebSocketImpl: WebSocketCtor = resolvedWs
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const baseUrl = (opts.baseUrl ?? 'https://slack.com/api').replace(/\/+$/, '')
  const reconnectInitialMs = opts.reconnectBackoffMs ?? 1000
  const reconnectMaxMs = opts.reconnectMaxBackoffMs ?? 30_000
  const onError = opts.onError ?? (() => {})

  // --- mutable state ---
  let state: SlackSocketMode['state'] = 'idle'
  let ws: WebSocketLike | null = null
  let intentionalStop = false
  let reconnectBackoff = reconnectInitialMs
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function ackEnvelope(envelopeId: string): void {
    if (!ws || ws.readyState !== WS_OPEN) return
    try {
      // The ack is just the envelope_id echoed back. No response
      // payload — this bridge never sets accepts_response_payload.
      ws.send(JSON.stringify({ envelope_id: envelopeId }))
    } catch (err) {
      onError(err)
    }
  }

  async function handleEnvelope(env: SlackSocketEnvelope): Promise<void> {
    // ACK first, unconditionally — Slack expects it within 3s and
    // independent of whether processing succeeds. Only control frames
    // (hello / disconnect) lack an envelope_id.
    if (typeof env.envelope_id === 'string' && env.envelope_id.length > 0) {
      ackEnvelope(env.envelope_id)
    }
    switch (env.type) {
      case 'hello':
        // Connection is live. Reset backoff so the next transient drop
        // starts from the floor again.
        reconnectBackoff = reconnectInitialMs
        state = 'open'
        opts.onHello?.(env)
        return
      case 'disconnect':
        // Server is recycling the socket (refresh_requested / warning /
        // too_many_connections). Close + reconnect with a fresh URL.
        // Not fatal, not intentional — the onclose handler reconnects.
        try {
          ws?.close(1000, 'server requested disconnect')
        } catch (err) {
          onError(err)
        }
        return
      case 'events_api':
        try {
          await opts.onEvent(env.payload)
        } catch (err) {
          onError(err)
        }
        return
      default:
        // slash_commands / interactive / unknown — ack-only (done
        // above). Nothing to surface in this bridge.
        return
    }
  }

  async function pickSocketUrl(): Promise<string> {
    if (opts.socketUrl) return opts.socketUrl
    const res = await fetchImpl(`${baseUrl}/apps.connections.open`, {
      method: 'POST',
      headers: {
        // apps.connections.open takes no body; auth is the app-level
        // token in the header. Form content-type keeps Slack happy.
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Bearer ${opts.appToken}`,
      },
    })
    let json: SlackConnectionsOpenResponse | null = null
    try {
      json = (await res.json()) as SlackConnectionsOpenResponse
    } catch {
      // Body wasn't JSON — treated as a transient failure below.
    }
    if (!json || json.ok !== true || typeof json.url !== 'string') {
      const code = json?.error ?? `HTTP_${res.status}`
      const err: ConnectionsOpenError = new Error(
        `slack apps.connections.open failed: ${code}`,
      )
      err.code = code
      err.fatal = json?.error ? FATAL_OPEN_ERRORS.has(json.error) : false
      throw err
    }
    return json.url
  }

  async function connectOnce(): Promise<void> {
    state = 'connecting'
    const url = await pickSocketUrl()
    const socket = new WebSocketImpl(url)
    ws = socket

    socket.onopen = (): void => {
      // No-op; the `hello` envelope arrives next and confirms liveness.
    }
    socket.onmessage = (ev): void => {
      let env: SlackSocketEnvelope
      try {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
        env = JSON.parse(raw) as SlackSocketEnvelope
      } catch (err) {
        onError(err)
        return
      }
      // Fire-and-forget; handleEnvelope catches its own async errors.
      void handleEnvelope(env).catch(onError)
    }
    socket.onerror = (ev): void => {
      onError(ev instanceof Error ? ev : new Error('slack-socket-mode: socket error'))
    }
    socket.onclose = (ev): void => {
      const reason = ev?.reason ?? ''
      ws = null
      if (intentionalStop) {
        state = 'closed'
        opts.onClose?.({ intentional: true, fatal: false, reason })
        return
      }
      // Transient close → reconnect with backoff + a fresh URL.
      const wait = reconnectBackoff
      reconnectBackoff = Math.min(reconnectBackoff * 2, reconnectMaxMs)
      state = 'closed'
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        if (intentionalStop) return
        void connectOnce().catch((err) => {
          onError(err)
          if ((err as ConnectionsOpenError).fatal) {
            // Bad app token surfaced during reconnect — stop trying.
            opts.onClose?.({
              intentional: false,
              fatal: true,
              reason: String((err as ConnectionsOpenError).code ?? 'fatal'),
            })
            return
          }
          // Another transient failure (e.g. the URL fetch failed before
          // the socket ever opened, so onclose won't fire). Re-schedule.
          reconnectTimer = setTimeout(() => {
            if (!intentionalStop) void connectOnce().catch(onError)
          }, reconnectBackoff)
        })
      }, wait)
    }
  }

  return {
    get state(): SlackSocketMode['state'] {
      return state
    },
    async start(): Promise<void> {
      if (state !== 'idle' && state !== 'closed') return
      intentionalStop = false
      try {
        await connectOnce()
      } catch (err) {
        // The very first apps.connections.open / connect failed.
        if ((err as ConnectionsOpenError).fatal) {
          // Misconfigured app token — surface loudly so the operator
          // fixes it rather than silently retrying forever.
          state = 'closed'
          opts.onClose?.({
            intentional: false,
            fatal: true,
            reason: String((err as ConnectionsOpenError).code ?? 'fatal'),
          })
          throw err
        }
        // Transient at boot (flaky network) — schedule a retry instead
        // of crashing the host.
        onError(err)
        state = 'closed'
        reconnectTimer = setTimeout(() => {
          if (!intentionalStop) void connectOnce().catch(onError)
        }, reconnectBackoff)
      }
    },
    async stop(): Promise<void> {
      intentionalStop = true
      clearReconnect()
      state = 'closing'
      if (ws) {
        try {
          ws.close(1000, 'bridge stop')
        } catch (err) {
          onError(err)
        }
        ws = null
      }
      state = 'closed'
    },
  }
}
