import type {
  AgentParticipant,
  ChannelId,
  Message,
  ParticipantId,
  Task,
  TaskResult,
} from '@aipehub/core'
import {
  decodeFrame,
  encodeFrame,
  PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame,
} from '@aipehub/protocol'
import WebSocket from 'ws'

export type SessionState =
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'closing'
  | 'closed'

export interface ConnectOptions {
  url: string
  agents: AgentParticipant[]
  apiKey?: string
  clientName?: string
  clientVersion?: string
  /** Default true. Set false to fail the session on first disconnect. */
  autoReconnect?: boolean
  reconnectInitialBackoffMs?: number
  reconnectMaxBackoffMs?: number
  /** Notified on every state transition. */
  onStateChange?: (state: SessionState, info?: { reason?: string }) => void
}

export interface Session {
  readonly state: SessionState
  readonly sessionId: string | undefined
  publish(from: ParticipantId, channel: ChannelId, body: unknown): void
  subscribe(participantId: ParticipantId, channel: ChannelId): void
  unsubscribe(participantId: ParticipantId, channel: ChannelId): void
  close(reason?: string): Promise<void>
}

interface ResolvedOptions extends ConnectOptions {
  autoReconnect: boolean
  reconnectInitialBackoffMs: number
  reconnectMaxBackoffMs: number
  clientName: string
  clientVersion: string
}

/**
 * Connect to a remote Hub. Resolves once HELLO is acknowledged with WELCOME
 * (or rejects if REJECT/disconnect happens during the initial handshake).
 *
 * The returned Session keeps the connection alive in the background,
 * auto-reconnecting with exponential backoff if the link drops (unless
 * `autoReconnect: false`).
 */
export async function connect(opts: ConnectOptions): Promise<Session> {
  const resolved: ResolvedOptions = {
    autoReconnect: opts.autoReconnect ?? true,
    reconnectInitialBackoffMs: opts.reconnectInitialBackoffMs ?? 1_000,
    reconnectMaxBackoffMs: opts.reconnectMaxBackoffMs ?? 30_000,
    clientName: opts.clientName ?? '@aipehub/sdk-node',
    clientVersion: opts.clientVersion ?? '0.0.0',
    ...opts,
  }
  if (resolved.agents.length === 0) {
    throw new Error('connect: at least one agent required')
  }
  const seen = new Set<string>()
  for (const a of resolved.agents) {
    if (seen.has(a.id)) throw new Error(`duplicate agent id '${a.id}'`)
    seen.add(a.id)
  }
  const s = new SessionImpl(resolved)
  await s.openInitial()
  return s
}

class SessionImpl implements Session {
  state: SessionState = 'connecting'
  sessionId: string | undefined
  private ws: WebSocket | undefined
  private readonly agents: Map<ParticipantId, AgentParticipant>
  private closeRequested = false
  private backoff: number
  private welcomeWaiter?: {
    resolve: () => void
    reject: (e: Error) => void
  }

  constructor(private readonly opts: ResolvedOptions) {
    this.agents = new Map(opts.agents.map((a) => [a.id, a]))
    this.backoff = opts.reconnectInitialBackoffMs
  }

  async openInitial(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.welcomeWaiter = { resolve, reject }
      this.openSocket()
    })
  }

  private openSocket(): void {
    const ws = new WebSocket(this.opts.url)
    this.ws = ws

    ws.on('open', () => {
      this.send({
        type: 'HELLO',
        protocolVersion: PROTOCOL_VERSION,
        client: { name: this.opts.clientName, version: this.opts.clientVersion },
        agents: this.opts.agents.map((a) => ({
          id: a.id,
          capabilities: [...a.capabilities],
        })),
        ...(this.opts.apiKey !== undefined ? { apiKey: this.opts.apiKey } : {}),
      })
    })

    ws.on('message', (data) => {
      this.handleFrame(data.toString()).catch((err) =>
        console.error('[sdk-node] frame handler threw:', err),
      )
    })

    ws.on('error', (err) => {
      // 'close' will follow; reconnection logic lives there
      if (this.state === 'connecting' && this.welcomeWaiter) {
        const w = this.welcomeWaiter
        this.welcomeWaiter = undefined
        w.reject(err instanceof Error ? err : new Error(String(err)))
      }
    })

    ws.on('close', () => {
      this.handleDisconnect()
    })
  }

  private async handleFrame(text: string): Promise<void> {
    const r = decodeFrame(text)
    if (!r.ok) return
    const frame = r.frame as ServerFrame

    switch (frame.type) {
      case 'WELCOME': {
        this.sessionId = frame.sessionId
        this.setState('ready')
        this.backoff = this.opts.reconnectInitialBackoffMs
        if (this.welcomeWaiter) {
          this.welcomeWaiter.resolve()
          this.welcomeWaiter = undefined
        }
        break
      }
      case 'REJECT': {
        const err = new Error(`hub rejected: ${frame.code}: ${frame.message}`)
        if (this.welcomeWaiter) {
          this.welcomeWaiter.reject(err)
          this.welcomeWaiter = undefined
        }
        // do NOT auto-reconnect on REJECT — it's a permanent error class for v0.1
        this.closeRequested = true
        this.setState('closing', { reason: frame.code })
        try {
          this.ws?.close()
        } catch {
          /* ignore */
        }
        break
      }
      case 'TASK': {
        const agent = this.agents.get(frame.recipient)
        if (!agent) {
          this.send({
            type: 'RESULT',
            result: noParticipant(frame.task.id, `no agent '${frame.recipient}' in this client`),
          })
          break
        }
        // run handler, catch errors, send RESULT
        let result: TaskResult
        try {
          if (!agent.onTask) {
            result = noParticipant(frame.task.id, `agent '${agent.id}' has no onTask`)
          } else {
            result = await agent.onTask(frame.task)
          }
        } catch (err) {
          result = {
            kind: 'failed',
            taskId: frame.task.id,
            by: agent.id,
            error: err instanceof Error ? err.message : String(err),
            ts: Date.now(),
          }
        }
        this.send({ type: 'RESULT', result })
        break
      }
      case 'CANCEL': {
        const agent = this.agents.get(frame.recipient)
        if (agent && agent.onTaskCancelled) {
          try {
            await agent.onTaskCancelled(frame.taskId, frame.reason)
          } catch (err) {
            console.error(`[sdk-node] onTaskCancelled threw for ${agent.id}:`, err)
          }
        }
        break
      }
      case 'MESSAGE': {
        const agent = this.agents.get(frame.recipient)
        if (agent && agent.onMessage) {
          try {
            await agent.onMessage(frame.msg)
          } catch (err) {
            console.error(`[sdk-node] onMessage threw for ${agent.id}:`, err)
          }
        }
        break
      }
      case 'PING':
        this.send({ type: 'PONG', ts: frame.ts })
        break
      case 'PONG':
        // we don't currently emit PING from the client; ignore
        break
      case 'GOODBYE':
        // server closing gracefully — let 'close' handle reconnection
        break
      case 'ERROR':
        console.warn(`[sdk-node] server ERROR: ${frame.code} — ${frame.message}`)
        break
    }
  }

  private handleDisconnect(): void {
    this.ws = undefined
    if (this.state === 'closed') return
    if (this.closeRequested) {
      this.setState('closed')
      return
    }
    if (!this.opts.autoReconnect) {
      this.setState('closed', { reason: 'disconnected' })
      if (this.welcomeWaiter) {
        this.welcomeWaiter.reject(new Error('disconnected before WELCOME'))
        this.welcomeWaiter = undefined
      }
      return
    }
    this.setState('reconnecting')
    const wait = this.backoff
    this.backoff = Math.min(this.backoff * 2, this.opts.reconnectMaxBackoffMs)
    setTimeout(() => {
      if (this.state === 'closed' || this.closeRequested) return
      this.setState('connecting')
      this.openSocket()
    }, wait)
  }

  // --- public API --------------------------------------------------------

  publish(from: ParticipantId, channel: ChannelId, body: unknown): void {
    if (!this.agents.has(from)) {
      throw new Error(`publish: '${from}' is not one of this session's agents`)
    }
    this.send({ type: 'PUBLISH', from, channel, body })
  }

  subscribe(participantId: ParticipantId, channel: ChannelId): void {
    if (!this.agents.has(participantId)) {
      throw new Error(`subscribe: '${participantId}' is not one of this session's agents`)
    }
    this.send({ type: 'SUBSCRIBE', participantId, channel })
  }

  unsubscribe(participantId: ParticipantId, channel: ChannelId): void {
    if (!this.agents.has(participantId)) return
    this.send({ type: 'UNSUBSCRIBE', participantId, channel })
  }

  async close(reason?: string): Promise<void> {
    if (this.state === 'closed') return
    this.closeRequested = true
    this.setState('closing', reason !== undefined ? { reason } : undefined)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.send({ type: 'GOODBYE', ...(reason !== undefined ? { reason } : {}) })
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => {
      if (!this.ws) return resolve()
      const ws = this.ws
      const timer = setTimeout(() => {
        try {
          ws.terminate()
        } catch {
          /* ignore */
        }
        resolve()
      }, 500)
      ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    })
    this.setState('closed')
  }

  // --- internals ---------------------------------------------------------

  private setState(next: SessionState, info?: { reason?: string }): void {
    if (this.state === next) return
    this.state = next
    if (this.opts.onStateChange) {
      try {
        this.opts.onStateChange(next, info)
      } catch (err) {
        console.error('[sdk-node] onStateChange threw:', err)
      }
    }
  }

  private send(frame: ClientFrame): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(encodeFrame(frame))
    } catch (err) {
      console.error('[sdk-node] send failed:', err)
    }
  }
}

function noParticipant(taskId: string, reason: string): TaskResult {
  return { kind: 'no_participant', taskId, reason, ts: Date.now() }
}
