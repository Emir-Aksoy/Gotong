/**
 * Discord WebSocket Gateway connection — the most complex piece of M5.
 *
 * Why complex: Discord pushes events via a persistent WebSocket
 * (unlike Telegram long-poll, Matrix sync long-poll, Lark webhook).
 * The bridge has to:
 *
 *   - Send IDENTIFY after the HELLO frame (op 10).
 *   - Heartbeat at the server-supplied interval. If a heartbeat is
 *     never ACK'd, the connection is "zombied" — force-close and
 *     reconnect.
 *   - Track the last DISPATCH sequence number so RESUME (op 6) can
 *     pick up where we left off.
 *   - Honour RECONNECT (op 7) by closing + reconnecting.
 *   - Honour INVALID_SESSION (op 9) by IDENTIFY-ing fresh (or RESUME-ing
 *     when the payload `d: true` says session is recoverable).
 *   - Distinguish fatal close codes (4004 auth failed, 4014 disallowed
 *     intents) from transient ones; never reconnect on fatal.
 *
 * The `WebSocketImpl` injection lets tests run without a real network.
 * It also accommodates Node 20 (where `globalThis.WebSocket` doesn't
 * exist) — operators can pass `import { WebSocket } from 'ws'` or
 * `import { WebSocket } from 'undici'`. Node 22+ has it built in.
 *
 * What's NOT here (deliberate for M5):
 *
 *   - Sharding. Single-shard supports up to 2500 guilds; AipeHub-side
 *     deployments are usually 1 hub <-> 1-few guilds, so the simplest
 *     wins.
 *   - Compression / zlib. The official client uses zstd; bridge takes
 *     plain JSON. Saves ~50% bandwidth in exchange for code we don't
 *     want to ship.
 *   - Voice gateway.
 *   - Identify rate-limit window tracking. We rely on `session_start_limit`
 *     headers + the 5s identify backoff; a single bot is well within
 *     the 1000/day budget.
 */

import { createDiscordClient, type DiscordClient } from './client.js'
import {
  DEFAULT_DISCORD_INTENTS,
  DiscordOp,
  type DiscordGatewayBotResponse,
  type DiscordGatewayFrame,
  type DiscordHelloData,
  type DiscordInvalidSessionData,
  type DiscordReadyData,
} from './types.js'

// ---------------------------------------------------------------------------
// WebSocket abstraction — `globalThis.WebSocket` (Node 22+) or `ws` / `undici`
// ---------------------------------------------------------------------------

/**
 * Minimal WebSocket-shaped interface the gateway needs. The
 * `ws` npm package's `WebSocket`, `undici.WebSocket`, and Node 22+
 * `globalThis.WebSocket` all conform.
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

// readyState constants — the WebSocket spec defines these as class
// statics on the constructor (CONNECTING=0, OPEN=1, CLOSING=2,
// CLOSED=3). We inline them so we don't depend on a specific impl.
const WS_OPEN = 1

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface DiscordGatewayOptions {
  /** Bot token. */
  token: string
  /**
   * Intent bitfield. Default: GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES
   * | MESSAGE_CONTENT. MESSAGE_CONTENT is privileged — must be enabled
   * in the bot's application portal first.
   */
  intents?: number
  /**
   * REST client used to fetch the gateway URL. If omitted, the gateway
   * spins up its own `createDiscordClient`. Tests inject one with a
   * mock fetch.
   */
  client?: DiscordClient
  /**
   * WebSocket constructor. Defaults to `globalThis.WebSocket` if
   * available. Node 20 doesn't have it built in — pass `WebSocket` from
   * `ws` or `undici` to make the bridge work there.
   */
  webSocketImpl?: WebSocketCtor
  /**
   * Initial reconnect backoff in ms. Grows exponentially up to
   * `reconnectMaxBackoffMs`. Default 1000.
   */
  reconnectBackoffMs?: number
  /** Cap on reconnect backoff. Default 30000. */
  reconnectMaxBackoffMs?: number
  /**
   * Override the gateway URL — skips the `GET /gateway/bot` fetch.
   * Mostly for tests; production wants the dynamic URL.
   */
  gatewayUrl?: string

  /** Called once per DISPATCH event (op 0). `eventName` is the `t` field. */
  onEvent: (eventName: string, data: unknown) => void | Promise<void>
  /** Called once when the gateway transitions to OPEN + IDENTIFY succeeds (READY). */
  onReady?: (ready: DiscordReadyData) => void
  /** Diagnostic surface for transient errors. Defaults to no-op. */
  onError?: (err: unknown) => void
  /**
   * Called when the gateway closes — either by `stop()` (user-initiated,
   * `intentional: true`), or by a fatal server-side close
   * (`fatal: true`). Bridge stops trying to reconnect in either case.
   */
  onClose?: (info: { code: number; reason: string; intentional: boolean; fatal: boolean }) => void
}

export interface DiscordGateway {
  /** Open the connection. Resolves once we've sent IDENTIFY (NOT once READY arrives — fire-and-forget). */
  start(): Promise<void>
  /** Close + cleanup. Idempotent. */
  stop(): Promise<void>
  /** Current state, mostly for tests / observability. */
  readonly state: 'idle' | 'connecting' | 'open' | 'closing' | 'closed'
  /** Last DISPATCH sequence number we observed; null before any DISPATCH. */
  readonly lastSeq: number | null
  /** Session id from the latest READY frame; null before connect or after a non-resumable close. */
  readonly sessionId: string | null
}

// ---------------------------------------------------------------------------
// Fatal close codes — gateway stops reconnecting on these
// ---------------------------------------------------------------------------

/**
 * Per https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-close-event-codes
 * these codes are *not* recoverable by reconnecting:
 *
 *   - 4004 Authentication failed (bad token)
 *   - 4010 Invalid shard
 *   - 4011 Sharding required
 *   - 4012 Invalid API version
 *   - 4013 Invalid intent(s)
 *   - 4014 Disallowed intent(s) — most common: MESSAGE_CONTENT not enabled
 *
 * Everything else (1000, 1001, 1006, 4000–4003, 4005–4009, …) is
 * treated as transient; bridge reconnects (and may RESUME).
 */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014])

/**
 * Close codes that invalidate the session — bridge must IDENTIFY
 * fresh (not RESUME). 4007 invalid seq, 4009 session timeout, plus
 * the "force re-identify" 4003 not authenticated.
 */
const NON_RESUMABLE_CLOSE_CODES = new Set([4003, 4007, 4009])

// ---------------------------------------------------------------------------
// createDiscordGateway
// ---------------------------------------------------------------------------

export function createDiscordGateway(opts: DiscordGatewayOptions): DiscordGateway {
  if (typeof opts?.token !== 'string' || opts.token.length === 0) {
    throw new TypeError('createDiscordGateway: token is required')
  }
  const resolvedWs =
    opts.webSocketImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
  if (!resolvedWs) {
    throw new TypeError(
      'createDiscordGateway: no WebSocket implementation. ' +
        'Pass `webSocketImpl` (e.g. `import { WebSocket } from "ws"`) or upgrade to Node 22+ which has globalThis.WebSocket built in.',
    )
  }
  // Bind to a non-null local so TypeScript narrowing survives the
  // closures below (control-flow narrowing doesn't always reach into
  // async callbacks).
  const WebSocketImpl: WebSocketCtor = resolvedWs
  const intents = opts.intents ?? DEFAULT_DISCORD_INTENTS
  const client = opts.client ?? createDiscordClient({ token: opts.token })
  const reconnectInitialMs = opts.reconnectBackoffMs ?? 1000
  const reconnectMaxMs = opts.reconnectMaxBackoffMs ?? 30_000
  const onError = opts.onError ?? (() => {})

  // --- mutable state ---
  let state: DiscordGateway['state'] = 'idle'
  let ws: WebSocketLike | null = null
  let lastSeq: number | null = null
  let sessionId: string | null = null
  let resumeGatewayUrl: string | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let heartbeatAckPending = false
  let intentionalStop = false
  /**
   * Backoff for the next reconnect attempt. Resets to `reconnectInitialMs`
   * on every successful READY.
   */
  let reconnectBackoff = reconnectInitialMs
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function clearHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    heartbeatAckPending = false
  }

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function sendFrame(frame: DiscordGatewayFrame): void {
    if (!ws || ws.readyState !== WS_OPEN) return
    try {
      ws.send(JSON.stringify(frame))
    } catch (err) {
      onError(err)
    }
  }

  function sendHeartbeat(): void {
    if (heartbeatAckPending) {
      // Last heartbeat went unacknowledged — connection is zombie.
      // Force close with non-1000 so the reconnect path doesn't
      // mistakenly treat this as a clean shutdown.
      onError(new Error('discord-gateway: heartbeat ACK timeout, reconnecting'))
      try {
        ws?.close(4000, 'heartbeat ack timeout')
      } catch (err) {
        onError(err)
      }
      return
    }
    heartbeatAckPending = true
    sendFrame({ op: DiscordOp.HEARTBEAT, d: lastSeq })
  }

  function startHeartbeat(intervalMs: number): void {
    clearHeartbeat()
    // Discord spec asks for an initial jitter to spread bot heartbeats
    // across the cluster. Math.random() * interval is what the docs
    // recommend.
    const jitter = Math.random() * intervalMs
    setTimeout(() => {
      if (!ws || ws.readyState !== WS_OPEN) return
      sendHeartbeat()
      heartbeatTimer = setInterval(sendHeartbeat, intervalMs)
    }, jitter)
  }

  function sendIdentify(): void {
    sendFrame({
      op: DiscordOp.IDENTIFY,
      d: {
        token: opts.token,
        intents,
        properties: {
          os: 'linux',
          browser: 'aipehub',
          device: 'aipehub',
        },
      },
    })
  }

  function sendResume(): void {
    if (sessionId === null || lastSeq === null) {
      // Defensive: shouldn't be called without these, but if it is,
      // identify fresh instead of sending a malformed RESUME.
      sendIdentify()
      return
    }
    sendFrame({
      op: DiscordOp.RESUME,
      d: { token: opts.token, session_id: sessionId, seq: lastSeq },
    })
  }

  async function handleFrame(frame: DiscordGatewayFrame): Promise<void> {
    // Track sequence on every DISPATCH (op 0) — RESUME needs it.
    if (frame.op === DiscordOp.DISPATCH && typeof frame.s === 'number') {
      lastSeq = frame.s
    }
    switch (frame.op) {
      case DiscordOp.HELLO: {
        const hello = frame.d as DiscordHelloData
        startHeartbeat(hello.heartbeat_interval)
        // If we have an active session, try RESUME; otherwise IDENTIFY.
        if (sessionId !== null && lastSeq !== null) {
          sendResume()
        } else {
          sendIdentify()
        }
        return
      }
      case DiscordOp.HEARTBEAT_ACK: {
        heartbeatAckPending = false
        return
      }
      case DiscordOp.HEARTBEAT: {
        // Discord occasionally asks the client to heartbeat immediately
        // (network issues, server load). Respond right away.
        sendFrame({ op: DiscordOp.HEARTBEAT, d: lastSeq })
        return
      }
      case DiscordOp.RECONNECT: {
        // Server politely asks us to reconnect; close with non-1000
        // so the reconnect handler doesn't treat it as intentional.
        try {
          ws?.close(4000, 'server requested reconnect')
        } catch (err) {
          onError(err)
        }
        return
      }
      case DiscordOp.INVALID_SESSION: {
        // `d: true` → session is resumable, retry RESUME after backoff.
        // `d: false` → session is dead, IDENTIFY fresh.
        const resumable = frame.d as DiscordInvalidSessionData
        if (!resumable) {
          sessionId = null
          lastSeq = null
        }
        // Discord docs say to wait 1–5s before re-identifying.
        // Use a small randomised delay.
        const wait = 1000 + Math.random() * 4000
        setTimeout(() => {
          if (!ws || ws.readyState !== WS_OPEN) return
          if (resumable && sessionId !== null && lastSeq !== null) {
            sendResume()
          } else {
            sendIdentify()
          }
        }, wait)
        return
      }
      case DiscordOp.DISPATCH: {
        const eventName = frame.t ?? ''
        // READY is a special bootstrap event — capture session id +
        // resume URL, then surface to user. RESUMED is the success
        // signal for RESUME — no payload action besides resetting backoff.
        if (eventName === 'READY') {
          const data = frame.d as DiscordReadyData
          sessionId = data.session_id
          resumeGatewayUrl = data.resume_gateway_url
          reconnectBackoff = reconnectInitialMs
          state = 'open'
          opts.onReady?.(data)
        } else if (eventName === 'RESUMED') {
          // Session continued cleanly. Backoff reset.
          reconnectBackoff = reconnectInitialMs
          state = 'open'
        }
        try {
          await opts.onEvent(eventName, frame.d)
        } catch (err) {
          onError(err)
        }
        return
      }
      default:
        // Other ops: PRESENCE_UPDATE / VOICE_STATE_UPDATE / etc. Ignore.
        return
    }
  }

  async function pickGatewayUrl(): Promise<string> {
    if (opts.gatewayUrl) return opts.gatewayUrl
    if (resumeGatewayUrl) return resumeGatewayUrl
    const resp = await client.call<DiscordGatewayBotResponse>('GET', '/gateway/bot')
    return resp.url
  }

  async function connectOnce(): Promise<void> {
    state = 'connecting'
    const base = await pickGatewayUrl()
    // Append the version + encoding query params; the URL Discord
    // returns is bare.
    const sep = base.includes('?') ? '&' : '?'
    const url = `${base}${sep}v=10&encoding=json`
    const socket = new WebSocketImpl(url)
    ws = socket

    socket.onopen = (): void => {
      // No-op; HELLO arrives next and drives the rest of the dance.
    }
    socket.onmessage = (ev): void => {
      let frame: DiscordGatewayFrame
      try {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
        frame = JSON.parse(raw) as DiscordGatewayFrame
      } catch (err) {
        onError(err)
        return
      }
      // Fire-and-forget the handler. We can't `await` here because the
      // WebSocket impl doesn't return a promise from onmessage; we
      // catch in handleFrame.
      void handleFrame(frame).catch(onError)
    }
    socket.onerror = (ev): void => {
      onError(ev instanceof Error ? ev : new Error('discord-gateway: socket error'))
    }
    socket.onclose = (ev): void => {
      const code = ev?.code ?? 1006
      const reason = ev?.reason ?? ''
      clearHeartbeat()
      ws = null
      if (intentionalStop) {
        state = 'closed'
        opts.onClose?.({ code, reason, intentional: true, fatal: false })
        return
      }
      const fatal = FATAL_CLOSE_CODES.has(code)
      if (NON_RESUMABLE_CLOSE_CODES.has(code)) {
        // Session not recoverable — clear before next attempt.
        sessionId = null
        lastSeq = null
        resumeGatewayUrl = null
      }
      if (fatal) {
        state = 'closed'
        opts.onClose?.({ code, reason, intentional: false, fatal: true })
        return
      }
      // Schedule a reconnect.
      const wait = reconnectBackoff
      reconnectBackoff = Math.min(reconnectBackoff * 2, reconnectMaxMs)
      state = 'closed'
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        if (intentionalStop) return
        void connectOnce().catch((err) => {
          onError(err)
          // Schedule another attempt — the close handler didn't fire
          // because connectOnce threw before the socket ever opened
          // (e.g. fetch for gateway URL failed).
          reconnectTimer = setTimeout(() => {
            if (!intentionalStop) void connectOnce().catch(onError)
          }, reconnectBackoff)
        })
      }, wait)
    }
  }

  return {
    get state(): DiscordGateway['state'] {
      return state
    },
    get lastSeq(): number | null {
      return lastSeq
    },
    get sessionId(): string | null {
      return sessionId
    },
    async start(): Promise<void> {
      if (state !== 'idle' && state !== 'closed') return
      intentionalStop = false
      await connectOnce()
    },
    async stop(): Promise<void> {
      intentionalStop = true
      clearReconnect()
      clearHeartbeat()
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
