import { randomUUID } from 'node:crypto'

import type { Hub, ParticipantId } from '@aipehub/core'
import {
  decodeFrame,
  encodeFrame,
  HELLO_TIMEOUT_MS,
  MAX_MISSED_PINGS,
  majorVersionOf,
  PROTOCOL_VERSION,
  type ClientFrame,
  type HelloFrame,
  type RejectCode,
  type ServerFrame,
} from '@aipehub/protocol'
import type { WebSocket } from 'ws'

import { RemoteAgentParticipant } from './remote-participant.js'

type SessionState = 'AWAIT_HELLO' | 'READY' | 'CLOSING' | 'DEAD'

import type { AuthenticateResult } from './server.js'

export interface SessionOptions {
  remoteAddress?: string
  heartbeatIntervalMs: number
  authenticate?: (
    apiKey: string | undefined,
  ) => AuthenticateResult | Promise<AuthenticateResult>
}

export interface SessionInfo {
  sessionId: string
  state: SessionState
  remoteAddress?: string
  agents: ParticipantId[]
  connectedAt: number
}

/**
 * Per-connection state machine. Owns one WebSocket, one or more
 * RemoteAgentParticipants, and the heartbeat. Lifecycle:
 *
 *   AWAIT_HELLO -> READY -> CLOSING -> DEAD
 *
 * Errors and timeouts collapse straight to DEAD via `terminate()`.
 */
export class Session {
  readonly sessionId = `s_${randomUUID().slice(0, 8)}`
  readonly connectedAt = Date.now()
  private state: SessionState = 'AWAIT_HELLO'
  private readonly participants = new Map<ParticipantId, RemoteAgentParticipant>()
  private heartbeatTimer?: NodeJS.Timeout
  private helloTimer?: NodeJS.Timeout
  private missedPings = 0
  private closedHandlers: Array<() => void> = []

  constructor(
    private readonly ws: WebSocket,
    private readonly hub: Hub,
    private readonly opts: SessionOptions,
  ) {
    ws.on('message', (data) => {
      this.onMessage(data.toString()).catch((err) =>
        console.error(`[ws][${this.sessionId}] handler threw:`, err),
      )
    })
    ws.on('close', () => this.cleanup())
    ws.on('error', (err) => {
      console.error(`[ws][${this.sessionId}] socket error:`, err)
      this.cleanup()
    })
    this.helloTimer = setTimeout(() => {
      if (this.state === 'AWAIT_HELLO') {
        this.sendReject('bad_hello', `HELLO not received within ${HELLO_TIMEOUT_MS}ms`)
        this.terminate()
      }
    }, HELLO_TIMEOUT_MS)
  }

  info(): SessionInfo {
    return {
      sessionId: this.sessionId,
      state: this.state,
      remoteAddress: this.opts.remoteAddress,
      agents: [...this.participants.keys()],
      connectedAt: this.connectedAt,
    }
  }

  onClosed(handler: () => void): void {
    this.closedHandlers.push(handler)
  }

  /** External graceful close (server shutdown). */
  close(reason = 'server_shutdown'): void {
    if (this.state === 'DEAD' || this.state === 'CLOSING') return
    this.state = 'CLOSING'
    this.send({ type: 'GOODBYE', reason })
    setTimeout(() => this.terminate(), 100)
  }

  // --- inbound -------------------------------------------------------------

  private async onMessage(text: string): Promise<void> {
    if (this.state === 'DEAD') return
    const r = decodeFrame(text)
    if (!r.ok) {
      this.sendError('bad_frame', r.reason)
      return
    }
    const frame = r.frame as ClientFrame

    if (this.state === 'AWAIT_HELLO') {
      if (frame.type !== 'HELLO') {
        this.sendReject('bad_hello', `expected HELLO, got ${frame.type}`)
        this.terminate()
        return
      }
      await this.handleHello(frame)
      return
    }
    if (this.state !== 'READY') return

    switch (frame.type) {
      case 'RESULT':
        this.handleResult(frame.result)
        break
      case 'PUBLISH':
        if (!this.participants.has(frame.from)) {
          this.sendError('forbidden_publish', `'${frame.from}' not owned by this connection`)
          break
        }
        this.hub.publish({ from: frame.from, channel: frame.channel, body: frame.body })
        break
      case 'SUBSCRIBE':
        if (!this.participants.has(frame.participantId)) {
          this.sendError('unknown_recipient', `'${frame.participantId}' not owned by this connection`)
          break
        }
        this.hub.subscribe(frame.participantId, frame.channel)
        break
      case 'UNSUBSCRIBE':
        if (!this.participants.has(frame.participantId)) break
        this.hub.unsubscribe(frame.participantId, frame.channel)
        break
      case 'PING':
        this.send({ type: 'PONG', ts: frame.ts })
        break
      case 'PONG':
        this.missedPings = 0
        break
      case 'GOODBYE':
        this.handleGoodbye()
        break
      case 'HELLO':
        this.sendError('unexpected_frame', 'HELLO already received')
        break
    }
  }

  private async handleHello(frame: HelloFrame): Promise<void> {
    if (this.helloTimer) {
      clearTimeout(this.helloTimer)
      this.helloTimer = undefined
    }

    if (majorVersionOf(frame.protocolVersion) !== majorVersionOf(PROTOCOL_VERSION)) {
      this.sendReject(
        'protocol_mismatch',
        `server speaks ${PROTOCOL_VERSION}, client speaks ${frame.protocolVersion}`,
      )
      this.terminate()
      return
    }

    // Default: open auth, every agent id allowed.
    let allowedAgents: readonly string[] | '*' = '*'

    if (this.opts.authenticate) {
      let raw: AuthenticateResult
      try {
        raw = await this.opts.authenticate(frame.apiKey)
      } catch (err) {
        this.sendReject(
          'internal_error',
          `authenticate threw: ${err instanceof Error ? err.message : String(err)}`,
        )
        this.terminate()
        return
      }
      // Normalize the three shapes.
      if (raw === false) {
        this.sendReject('auth_failed', 'apiKey verification failed')
        this.terminate()
        return
      }
      if (raw === true) {
        // accept, no per-agent restriction
      } else if (raw.ok === false) {
        this.sendReject('auth_failed', raw.reason ?? 'apiKey verification failed')
        this.terminate()
        return
      } else {
        // raw.ok === true
        if (raw.allowedAgents !== undefined && raw.allowedAgents !== '*') {
          allowedAgents = raw.allowedAgents
        }
      }
    }

    if (!Array.isArray(frame.agents) || frame.agents.length === 0) {
      this.sendReject('bad_hello', 'HELLO.agents must be a non-empty array')
      this.terminate()
      return
    }

    const created: RemoteAgentParticipant[] = []
    for (const decl of frame.agents) {
      if (!decl || typeof decl.id !== 'string') {
        for (const p of created) this.hub.unregister(p.id)
        this.sendReject('bad_hello', 'each agent must have a string id')
        this.terminate()
        return
      }
      if (allowedAgents !== '*' && !allowedAgents.includes(decl.id)) {
        for (const p of created) this.hub.unregister(p.id)
        this.sendReject(
          'forbidden_agent',
          `agent '${decl.id}' is not allowed for this API key`,
        )
        this.terminate()
        return
      }
      if (this.hub.registry.has(decl.id)) {
        for (const p of created) this.hub.unregister(p.id)
        this.sendReject('duplicate_id', `agent '${decl.id}' already registered`)
        this.terminate()
        return
      }
      const participant = new RemoteAgentParticipant({
        id: decl.id,
        capabilities: Array.isArray(decl.capabilities) ? decl.capabilities : [],
        send: (f) => this.send(f),
      })
      try {
        this.hub.register(participant)
      } catch (err) {
        for (const prev of created) this.hub.unregister(prev.id)
        this.sendReject(
          'internal_error',
          err instanceof Error ? err.message : String(err),
        )
        this.terminate()
        return
      }
      this.participants.set(decl.id, participant)
      created.push(participant)
    }

    this.send({
      type: 'WELCOME',
      sessionId: this.sessionId,
      protocolVersion: PROTOCOL_VERSION,
      serverTime: Date.now(),
      heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
    })
    this.state = 'READY'
    this.startHeartbeat()
  }

  private handleResult(result: import('@aipehub/core').TaskResult): void {
    for (const p of this.participants.values()) {
      if (p.tryResolveTask(result)) return
    }
    this.sendError('unknown_task', `no pending task ${result.taskId}`, { taskId: result.taskId })
  }

  private handleGoodbye(): void {
    if (this.state !== 'READY') return
    this.state = 'CLOSING'
    this.send({ type: 'GOODBYE' })
    setTimeout(() => this.terminate(), 100)
  }

  // --- heartbeat -----------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'READY') return
      if (this.missedPings >= MAX_MISSED_PINGS) {
        console.warn(`[ws][${this.sessionId}] closing — missed ${this.missedPings} PINGs`)
        this.terminate()
        return
      }
      this.missedPings += 1
      this.send({ type: 'PING', ts: Date.now() })
    }, this.opts.heartbeatIntervalMs)
  }

  // --- outbound ------------------------------------------------------------

  private send(frame: ServerFrame): void {
    if (this.ws.readyState !== this.ws.OPEN) return
    try {
      this.ws.send(encodeFrame(frame))
    } catch (err) {
      console.error(`[ws][${this.sessionId}] send failed:`, err)
    }
  }

  private sendReject(code: RejectCode, message: string): void {
    this.send({ type: 'REJECT', code, message })
  }

  private sendError(code: string, message: string, context?: unknown): void {
    this.send({ type: 'ERROR', code, message, context })
  }

  // --- teardown ------------------------------------------------------------

  private terminate(): void {
    if (this.state === 'DEAD') return
    try {
      this.ws.terminate()
    } catch {
      /* ignore */
    }
    this.cleanup()
  }

  private cleanup(): void {
    if (this.state === 'DEAD') return
    this.state = 'DEAD'
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    if (this.helloTimer) {
      clearTimeout(this.helloTimer)
      this.helloTimer = undefined
    }
    for (const p of this.participants.values()) {
      p.failAllPending('remote_disconnect')
      try {
        this.hub.unregister(p.id)
      } catch {
        /* ignore */
      }
    }
    this.participants.clear()
    for (const h of this.closedHandlers) {
      try {
        h()
      } catch {
        /* ignore */
      }
    }
    this.closedHandlers = []
  }
}
