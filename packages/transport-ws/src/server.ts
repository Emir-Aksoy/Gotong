import type { Hub } from '@gotong/core'
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  type ServiceOwner,
  type ServiceType,
} from '@gotong/protocol'
import { WebSocketServer } from 'ws'

import { Session, type SessionInfo } from './session.js'

/**
 * Result of an `authenticate` hook.
 *
 * Three shapes, in order of richness:
 *
 *   - `boolean` — accept (true) or reject (false). All agents in the HELLO
 *     are accepted on `true`. This is the v0.1 shape; kept for back-compat.
 *
 *   - `{ ok: true, allowedAgents?: readonly string[] | '*' }` — accept the
 *     connection, optionally restricting which agent ids the client may
 *     declare. Use this to bind an API key to one or a few agent
 *     identities so a leaked key can't impersonate every agent in the
 *     deployment. Omit (or use `'*'`) to allow any id.
 *
 *   - `{ ok: false, reason?: string }` — reject. The optional reason is
 *     forwarded to the client as the REJECT message.
 */
export type AuthenticateResult =
  | boolean
  | { ok: true; allowedAgents?: readonly string[] | '*' }
  | { ok: false; reason?: string }

/**
 * Narrow contract the WebSocket transport needs to expose Hub Services to
 * remote agents (protocol v1.1 SERVICE_CALL). The host's `HubServices` is
 * the production implementation; tests pass a fake. transport-ws is kept
 * decoupled from `@gotong/host` and `@gotong/services-sdk` — the gateway
 * is the only seam.
 *
 * `attach` is called on first SERVICE_CALL for a given `(type, impl, owner)`;
 * subsequent calls reuse the cached handle. `detachFor` is called on
 * session close (and on per-agent leave for `kind:'agent'` owners).
 */
export interface ServiceCallGateway {
  attach(spec: {
    type: ServiceType
    impl: string
    owner: ServiceOwner
    /** Plugin-defined config blob — forwarded as `HELLO.services[i].config`. */
    config: unknown
  }): Promise<{ handle: unknown }>

  /**
   * Release any state filed against `owner`. Return type intentionally
   * `Promise<unknown>` (not `Promise<void>`) so production implementations
   * with richer return types (e.g. `HubServices.detachFor` returns
   * `DetachedHandle[]`) satisfy the interface structurally without an
   * adapter. The router awaits but discards the value.
   */
  detachFor(owner: ServiceOwner): Promise<unknown>
}

export interface WebSocketTransportOptions {
  port?: number
  host?: string
  heartbeatIntervalMs?: number
  /**
   * Optional services gateway (protocol v1.1). When provided, remote
   * sessions that declare `HELLO.services` may issue SERVICE_CALL frames
   * to drive Hub Services. When absent, any SERVICE_CALL is rejected as
   * `forbidden_service` — the v1.0 behaviour.
   *
   * Production code passes the host's `HubServices` (it satisfies this
   * interface via duck-typing on `attach` + `detachFor`). Tests pass a
   * narrow fake. See {@link ServiceCallGateway}.
   */
  services?: ServiceCallGateway
  /**
   * Authentication / authorization hook. Called once per HELLO with the
   * apiKey the client sent. Async allowed. Default: no auth required, all
   * agent ids allowed.
   *
   * Returning `true` (or `{ ok: true }` with no `allowedAgents`) is the
   * "open" mode. Returning `{ ok: true, allowedAgents: [...] }` enforces
   * per-key identity: any HELLO.agents.id not in the allow-list gets
   * rejected with `forbidden_agent`. See {@link AuthenticateResult}.
   */
  authenticate?: (
    apiKey: string | undefined,
  ) => AuthenticateResult | Promise<AuthenticateResult>
  /**
   * Agent admission policy (v1.1).
   *
   *   - `'open'` (default) — every successful HELLO becomes an active session
   *     immediately. This is the pre-v1.1 behaviour.
   *   - `'admin-approval'` — after authenticate succeeds, the connection is
   *     held in an awaiting-approval state and the HELLO is published as a
   *     pending application via `hub.requestAdmission(...)`. WELCOME is sent
   *     only after `hub.approveApplication(...)` is called; if it is
   *     rejected (or the client disconnects), no agent is registered and the
   *     socket is closed cleanly. Pair with `@gotong/web` admin UI to drive
   *     the approval decisions.
   */
  gating?: 'open' | 'admin-approval'
  /**
   * WS upgrade path (v3.4). When set, only HTTP upgrade requests whose
   * path matches are accepted; others get HTTP 404. Default `undefined`
   * meaning "accept any path" — kept for back-compat with examples and
   * SDKs that connect to `ws://host:port` (no path). Operators behind
   * a reverse proxy SHOULD set this to `/ws` so the proxy and the WS
   * server agree on a canonical mount point.
   */
  path?: string
  /**
   * Maximum size of a single WebSocket frame in bytes (v3.4). Frames
   * larger than this are rejected at the WS layer (close code 1009 —
   * message too big) **before** `decodeFrame()` parses any JSON, so a
   * 100 MB frame can't OOM the host before validation runs. Default
   * 262_144 (256 KiB) — large enough for typical TASK.payload structures
   * and HELLO with dozens of agents.
   *
   * Raise if your workflows legitimately exchange larger payloads (e.g.
   * artifact uploads inline). Lower for hardened public deployments
   * where every agent is expected to stay under 64 KiB.
   */
  maxPayload?: number
  /**
   * Maximum number of concurrent sessions (v3.4). When the cap is
   * reached, new connections are rejected during the HTTP upgrade with
   * status 503. Default 1024. Set to `0` or a negative value to disable.
   *
   * This is the only ceiling preventing a single peer from opening
   * sockets until file descriptors run out — pre-3.4 the only timeout
   * was the AWAIT_APPROVAL window, which doesn't apply to `gating:
   * 'open'` sessions.
   */
  maxConnections?: number
  /**
   * Origin allow-list for browser clients (v3.4). Two forms:
   *
   *   - `readonly string[]` — exact match against the `Origin` request
   *     header (e.g. `['https://hub.example.com']`).
   *   - `(origin: string | undefined) => boolean` — custom predicate.
   *
   * When set, upgrade requests whose Origin does not satisfy the
   * predicate are rejected with HTTP 403. Native clients (CLI / SDK)
   * typically do not send an Origin header; the predicate is called
   * with `undefined` for them, and the operator decides whether to
   * accept (`origin === undefined`) or reject those connections.
   *
   * Default `undefined` — no Origin check, identical to v3.3 behaviour.
   * Set this when exposing the WS port to browser-reachable origins to
   * defend against cross-site WebSocket hijacking (CSWSH).
   */
  allowedOrigins?: readonly string[] | ((origin: string | undefined) => boolean)
}

export interface WebSocketTransportHandle {
  readonly host: string
  readonly port: number
  readonly url: string
  /**
   * D1 — federation reuses the same ws.Server for inbound peer HELLO
   * via `acceptHubLinks({wss: handle.wss, ...})`. Exposed read-only so
   * the host's PeerRegistry can attach a 'connection'-listener sibling
   * to the agent-session handler without spinning up a second listener
   * on a different port.
   */
  readonly wss: WebSocketServer
  sessions(): SessionInfo[]
  close(): Promise<void>
}

/**
 * Start a WebSocket server that accepts remote agents speaking the Gotong
 * wire protocol (see docs/PROTOCOL.md). Each connecting client is wrapped
 * in a Session; each declared agent becomes a `RemoteAgentParticipant`
 * registered in the Hub's registry.
 *
 *   const wsHandle = await serveWebSocket(hub, { port: 4000 })
 *   // ... agents may now connect ...
 *   await wsHandle.close()
 */
/**
 * Default WS-upgrade hardening values (v3.4). Centralised so tests and
 * docs can refer to the same constants and so a future deployment-
 * profile env var (`GOTONG_WS_HARDENING_PROFILE=lan|public`) can flip
 * them without rewiring callsites.
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 262_144 // 256 KiB
export const DEFAULT_MAX_CONNECTIONS = 1024

/** Build the Origin predicate from the public `allowedOrigins` option. */
function buildOriginCheck(
  allowed: WebSocketTransportOptions['allowedOrigins'],
): (origin: string | undefined) => boolean {
  if (allowed === undefined) return () => true
  if (typeof allowed === 'function') return allowed
  const set = new Set(allowed)
  return (origin) => origin !== undefined && set.has(origin)
}

export function serveWebSocket(
  hub: Hub,
  opts: WebSocketTransportOptions = {},
): Promise<WebSocketTransportHandle> {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 4000
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const maxPayload = opts.maxPayload ?? DEFAULT_MAX_PAYLOAD_BYTES
  const maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS
  const checkOrigin = buildOriginCheck(opts.allowedOrigins)

  const sessions = new Set<Session>()

  return new Promise<WebSocketTransportHandle>((resolve, reject) => {
    // v3.4 hardening — see AUDIT-v3.3.md finding C1.
    //
    //   path           — when set, only this path accepts WS upgrades;
    //                    others get HTTP 404. Default `undefined`
    //                    preserves "any path" back-compat.
    //   maxPayload     — frames > 256 KiB are rejected with WS close
    //                    code 1009 BEFORE `JSON.parse` runs.
    //   verifyClient   — gates the HTTP upgrade on:
    //                      (1) Origin allow-list (defends CSWSH)
    //                      (2) connection-count cap (defends fd
    //                          exhaustion). Reached cap → HTTP 503.
    const wss = new WebSocketServer({
      host,
      port,
      ...(opts.path !== undefined ? { path: opts.path } : {}),
      maxPayload,
      verifyClient: (info, callback) => {
        if (!checkOrigin(info.origin)) {
          callback(false, 403, 'Forbidden origin')
          return
        }
        if (maxConnections > 0 && sessions.size >= maxConnections) {
          callback(false, 503, 'Server connection cap reached')
          return
        }
        callback(true)
      },
    })

    const onceError = (err: Error) => reject(err)
    wss.once('error', onceError)

    wss.once('listening', () => {
      wss.off('error', onceError)
      const addr = wss.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      const url = `ws://${host}:${actualPort}`
      console.log(`[gotong-ws] listening at ${url}`)

      wss.on('connection', (ws, req) => {
        const session = new Session(ws, hub, {
          remoteAddress: req.socket.remoteAddress,
          heartbeatIntervalMs,
          authenticate: opts.authenticate,
          gating: opts.gating ?? 'open',
          ...(opts.services ? { services: opts.services } : {}),
        })
        sessions.add(session)
        session.onClosed(() => sessions.delete(session))
      })

      wss.on('error', (err) => console.error('[gotong-ws] server error:', err))

      resolve({
        host,
        port: actualPort,
        url,
        wss,
        sessions: () => [...sessions].map((s) => s.info()),
        close: () =>
          new Promise<void>((res, rej) => {
            for (const s of sessions) s.close('server_shutdown')
            sessions.clear()
            wss.close((err) => (err ? rej(err) : res()))
          }),
      })
    })
  })
}
