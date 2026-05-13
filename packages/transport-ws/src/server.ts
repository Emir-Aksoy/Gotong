import type { Hub } from '@aipehub/core'
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from '@aipehub/protocol'
import { WebSocketServer } from 'ws'

import { Session, type SessionInfo } from './session.js'

export interface WebSocketTransportOptions {
  port?: number
  host?: string
  heartbeatIntervalMs?: number
  /** Return true to accept the apiKey. Async allowed. Default: no auth required. */
  authenticate?: (apiKey: string | undefined) => boolean | Promise<boolean>
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
