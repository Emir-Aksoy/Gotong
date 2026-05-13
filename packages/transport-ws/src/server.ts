import type { Hub } from '@aipehub/core'
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from '@aipehub/protocol'
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

export interface WebSocketTransportOptions {
  port?: number
  host?: string
  heartbeatIntervalMs?: number
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
}

export interface WebSocketTransportHandle {
  readonly host: string
  readonly port: number
  readonly url: string
  sessions(): SessionInfo[]
  close(): Promise<void>
}

/**
 * Start a WebSocket server that accepts remote agents speaking the AipeHub
 * wire protocol (see docs/PROTOCOL.md). Each connecting client is wrapped
 * in a Session; each declared agent becomes a `RemoteAgentParticipant`
 * registered in the Hub's registry.
 *
 *   const wsHandle = await serveWebSocket(hub, { port: 4000 })
 *   // ... agents may now connect ...
 *   await wsHandle.close()
 */
export function serveWebSocket(
  hub: Hub,
  opts: WebSocketTransportOptions = {},
): Promise<WebSocketTransportHandle> {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 4000
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS

  const sessions = new Set<Session>()

  return new Promise<WebSocketTransportHandle>((resolve, reject) => {
    const wss = new WebSocketServer({ host, port })

    const onceError = (err: Error) => reject(err)
    wss.once('error', onceError)

    wss.once('listening', () => {
      wss.off('error', onceError)
      const addr = wss.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      const url = `ws://${host}:${actualPort}`
      console.log(`[aipehub-ws] listening at ${url}`)

      wss.on('connection', (ws, req) => {
        const session = new Session(ws, hub, {
          remoteAddress: req.socket.remoteAddress,
          heartbeatIntervalMs,
          authenticate: opts.authenticate,
        })
        sessions.add(session)
        session.onClosed(() => sessions.delete(session))
      })

      wss.on('error', (err) => console.error('[aipehub-ws] server error:', err))

      resolve({
        host,
        port: actualPort,
        url,
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
