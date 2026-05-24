/**
 * WebSocketHubLink — symmetric ws transport for hub-mesh (M3).
 *
 * Two `Hub` instances on different processes / machines establish a
 * peer relationship over WebSocket. Unlike the existing TeamBridgeAgent
 * (which is non-symmetric: upstream → bridge → local hub), either side
 * here can dispatch tasks to the other, either side can publish
 * messages, and either side can close.
 *
 * Wire is JSON-encoded frames, distinct from the existing
 * `@aipehub/protocol` wire (HELLO/WELCOME/TASK/RESULT). The protocols
 * are deliberately separate because:
 *
 *   - the existing protocol carries admission gating, agent registry,
 *     services-over-ws — none of which apply to a peer-hub link
 *   - the existing TASK frame assumes a "recipient" routed to one
 *     agent, whereas mesh tasks are addressed to "whoever the peer
 *     hub decides"
 *
 * Mesh frames (all JSON, all carry a `type` discriminator):
 *
 *   MESH_HELLO     {peerId, protocolVersion}   sent by OUT side first
 *   MESH_HELLO_ACK {peerId, protocolVersion}   sent by IN side in reply
 *   MESH_TASK      {task}                       either direction
 *   MESH_RESULT    {result}                     reply (matched by taskId)
 *   MESH_MESSAGE   {message}                    fire-and-forget
 *   MESH_GOODBYE   {reason?}                    cooperative close
 */

import { randomUUID } from 'node:crypto'

import { WebSocket, type WebSocketServer } from 'ws'

import type {
  FeedbackEntry,
  HubLink,
  HubLinkDirection,
  HubLinkStatus,
  Message,
  ParticipantId,
  Task,
  TaskResult,
} from '@aipehub/core'

export const MESH_PROTOCOL_VERSION = '1' as const

export type MeshFrame =
  | { type: 'MESH_HELLO'; peerId: ParticipantId; protocolVersion: typeof MESH_PROTOCOL_VERSION }
  | { type: 'MESH_HELLO_ACK'; peerId: ParticipantId; protocolVersion: typeof MESH_PROTOCOL_VERSION }
  | { type: 'MESH_TASK'; task: Task }
  | { type: 'MESH_RESULT'; result: TaskResult }
  | { type: 'MESH_MESSAGE'; message: Message }
  /** M6: ask peer "give me entries you've written about hub `forPeerId`". */
  | { type: 'MESH_PULL'; callId: string; forPeerId: ParticipantId }
  /** M6: reply to a MESH_PULL with the entries (peer already marked them delivered). */
  | { type: 'MESH_PULL_RESULT'; callId: string; entries: readonly FeedbackEntry[] }
  /**
   * M7: peer reports how it processed entries we sent it.
   * `kind: 'read'`     → peer accepted, mark our outbound as read.
   * `kind: 'rejected'` → peer refused; mark our outbound as rejected
   *                      and roll back the reputation contribution.
   */
  | {
      type: 'MESH_RECEIPT'
      entryIds: readonly string[]
      kind: 'read' | 'rejected'
      reason?: string
    }
  | { type: 'MESH_GOODBYE'; reason?: string }

const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000
const DEFAULT_PULL_TIMEOUT_MS = 30_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

interface PendingDispatch {
  resolve: (r: TaskResult) => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingPull {
  resolve: (entries: readonly FeedbackEntry[]) => void
  timer: ReturnType<typeof setTimeout>
}

export interface WebSocketHubLinkOptions {
  /** Self hub id — the value the peer will see as `link.peerId` on their side. */
  selfId: ParticipantId
  /**
   * Optional expected peer id. When set, any mismatch on the
   * HELLO/HELLO_ACK frame is a fatal handshake error and the link is
   * closed immediately. When omitted, whatever the peer reports is
   * accepted.
   */
  expectedPeerId?: ParticipantId
  /** Per-dispatch timeout in ms. Default 30s. */
  dispatchTimeoutMs?: number
}

class WebSocketHubLinkImpl implements HubLink {
  readonly direction: HubLinkDirection
  private _peerId: ParticipantId
  private _status: HubLinkStatus = 'connecting'

  private readonly ws: WebSocket
  readonly selfId: ParticipantId
  private readonly expectedPeerId?: ParticipantId
  private readonly dispatchTimeoutMs: number
  private readonly pullTimeoutMs: number = DEFAULT_PULL_TIMEOUT_MS

  private taskHandler?: (task: Task) => Promise<TaskResult>
  private pullHandler?: (forPeerId: ParticipantId) => Promise<readonly FeedbackEntry[]>
  private receiptHandler?: (params: {
    entryIds: readonly string[]
    kind: 'read' | 'rejected'
    reason?: string
  }) => void | Promise<void>
  private readonly messageHandlers: Array<(m: Message) => void> = []
  private readonly closedHandlers: Array<() => void> = []
  private readonly pendingDispatches = new Map<string, PendingDispatch>()
  private readonly pendingPulls = new Map<string, PendingPull>()

  private readonly handshakePromise: Promise<void>
  private resolveHandshake!: () => void
  private rejectHandshake!: (err: Error) => void

  constructor(
    ws: WebSocket,
    direction: HubLinkDirection,
    opts: WebSocketHubLinkOptions,
  ) {
    this.ws = ws
    this.direction = direction
    this.selfId = opts.selfId
    this.expectedPeerId = opts.expectedPeerId
    this.dispatchTimeoutMs = opts.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS
    this._peerId = opts.expectedPeerId ?? '<pending>'

    this.handshakePromise = new Promise<void>((resolve, reject) => {
      this.resolveHandshake = resolve
      this.rejectHandshake = reject
    })

    ws.on('message', (data) => this.handleFrame(data))
    ws.on('close', () => this.transitionToClosed('peer_disconnected'))
    ws.on('error', (err) => {
      this.rejectHandshake(err instanceof Error ? err : new Error(String(err)))
      this.transitionToClosed('ws_error')
    })

    // OUT side initiates handshake. IN side waits.
    if (direction === 'out') {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendHello()
      } else {
        ws.once('open', () => this.sendHello())
      }
    }
  }

  get peerId(): ParticipantId {
    return this._peerId
  }

  get status(): HubLinkStatus {
    return this._status
  }

  /** @internal — used by `connectHubLink` / `acceptHubLinks`. */
  waitForHandshake(): Promise<void> {
    return this.handshakePromise
  }

  private sendHello(): void {
    this.sendFrame({
      type: 'MESH_HELLO',
      peerId: this.selfId,
      protocolVersion: MESH_PROTOCOL_VERSION,
    })
  }

  private sendFrame(frame: MeshFrame): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame))
    }
  }

  private handleFrame(data: unknown): void {
    let frame: MeshFrame
    try {
      const text =
        typeof data === 'string'
          ? data
          : data instanceof Buffer
            ? data.toString('utf8')
            : String(data)
      frame = JSON.parse(text) as MeshFrame
    } catch {
      return // bad frame, ignore
    }

    switch (frame.type) {
      case 'MESH_HELLO':
        // Only the IN side legitimately receives HELLO.
        if (this.direction !== 'in') return
        if (frame.protocolVersion !== MESH_PROTOCOL_VERSION) {
          this.rejectHandshake(
            new Error(
              `mesh protocol version mismatch: got ${frame.protocolVersion}, expected ${MESH_PROTOCOL_VERSION}`,
            ),
          )
          this.transitionToClosed('protocol_version_mismatch')
          return
        }
        if (this.expectedPeerId && frame.peerId !== this.expectedPeerId) {
          this.rejectHandshake(
            new Error(
              `peer id mismatch: expected '${this.expectedPeerId}', got '${frame.peerId}'`,
            ),
          )
          this.transitionToClosed('peer_id_mismatch')
          return
        }
        this._peerId = frame.peerId
        this.sendFrame({
          type: 'MESH_HELLO_ACK',
          peerId: this.selfId,
          protocolVersion: MESH_PROTOCOL_VERSION,
        })
        this._status = 'open'
        this.resolveHandshake()
        return

      case 'MESH_HELLO_ACK':
        if (this.direction !== 'out') return
        if (frame.protocolVersion !== MESH_PROTOCOL_VERSION) {
          this.rejectHandshake(
            new Error(
              `mesh protocol version mismatch: got ${frame.protocolVersion}, expected ${MESH_PROTOCOL_VERSION}`,
            ),
          )
          this.transitionToClosed('protocol_version_mismatch')
          return
        }
        if (this.expectedPeerId && frame.peerId !== this.expectedPeerId) {
          this.rejectHandshake(
            new Error(
              `peer id mismatch: expected '${this.expectedPeerId}', got '${frame.peerId}'`,
            ),
          )
          this.transitionToClosed('peer_id_mismatch')
          return
        }
        this._peerId = frame.peerId
        this._status = 'open'
        this.resolveHandshake()
        return

      case 'MESH_TASK': {
        const task = frame.task
        const handler = this.taskHandler
        if (!handler) {
          this.sendFrame({
            type: 'MESH_RESULT',
            result: {
              kind: 'no_participant',
              taskId: task.id,
              reason: 'peer has no task handler',
              ts: Date.now(),
            },
          })
          return
        }
        Promise.resolve(handler(task))
          .then((result) => this.sendFrame({ type: 'MESH_RESULT', result }))
          .catch((err) => {
            this.sendFrame({
              type: 'MESH_RESULT',
              result: {
                kind: 'failed',
                taskId: task.id,
                by: this.selfId,
                error: err instanceof Error ? err.message : String(err),
                ts: Date.now(),
              },
            })
          })
        return
      }

      case 'MESH_RESULT': {
        const result = frame.result
        const pending = this.pendingDispatches.get(result.taskId)
        if (!pending) return // unknown / already-timed-out
        clearTimeout(pending.timer)
        this.pendingDispatches.delete(result.taskId)
        pending.resolve(result)
        return
      }

      case 'MESH_MESSAGE':
        for (const h of this.messageHandlers) {
          try {
            h(frame.message)
          } catch {
            /* fire-and-forget; swallow handler errors */
          }
        }
        return

      case 'MESH_PULL': {
        const handler = this.pullHandler
        if (!handler) {
          // No handler registered → respond with empty list so peer
          // doesn't hang waiting.
          this.sendFrame({
            type: 'MESH_PULL_RESULT',
            callId: frame.callId,
            entries: [],
          })
          return
        }
        Promise.resolve(handler(frame.forPeerId))
          .then((entries) =>
            this.sendFrame({
              type: 'MESH_PULL_RESULT',
              callId: frame.callId,
              entries,
            }),
          )
          .catch(() => {
            // On handler failure send empty list rather than failing the
            // call — feedback pull is best-effort.
            this.sendFrame({
              type: 'MESH_PULL_RESULT',
              callId: frame.callId,
              entries: [],
            })
          })
        return
      }

      case 'MESH_PULL_RESULT': {
        const pending = this.pendingPulls.get(frame.callId)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingPulls.delete(frame.callId)
        pending.resolve(frame.entries)
        return
      }

      case 'MESH_RECEIPT': {
        const handler = this.receiptHandler
        if (!handler) return // silently drop if no handler
        try {
          const r = handler({
            entryIds: frame.entryIds,
            kind: frame.kind,
            reason: frame.reason,
          })
          if (r && typeof (r as Promise<unknown>).catch === 'function') {
            ;(r as Promise<unknown>).catch(() => {
              /* receipts best-effort */
            })
          }
        } catch {
          /* swallow */
        }
        return
      }

      case 'MESH_GOODBYE':
        this.transitionToClosed('peer_goodbye')
        return
    }
  }

  async dispatch(task: Task): Promise<TaskResult> {
    if (this._status !== 'open') {
      return {
        kind: 'failed',
        taskId: task.id,
        by: this._peerId,
        error: `link_${this._status}`,
        ts: Date.now(),
      }
    }
    return new Promise<TaskResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingDispatches.delete(task.id)
        resolve({
          kind: 'failed',
          taskId: task.id,
          by: this._peerId,
          error: `dispatch_timeout (${this.dispatchTimeoutMs}ms)`,
          ts: Date.now(),
        })
      }, this.dispatchTimeoutMs)

      this.pendingDispatches.set(task.id, { resolve, timer })
      this.sendFrame({ type: 'MESH_TASK', task })
    })
  }

  publish(msg: Message): void {
    if (this._status !== 'open') return
    this.sendFrame({ type: 'MESH_MESSAGE', message: msg })
  }

  async pullFeedbackFor(): Promise<readonly FeedbackEntry[]> {
    if (this._status !== 'open') return []
    const callId = randomUUID()
    return new Promise<readonly FeedbackEntry[]>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPulls.delete(callId)
        resolve([]) // timeout → silent empty result; caller can retry
      }, this.pullTimeoutMs)
      this.pendingPulls.set(callId, { resolve, timer })
      this.sendFrame({
        type: 'MESH_PULL',
        callId,
        forPeerId: this.selfId,
      })
    })
  }

  async pushReadReceipt(opts: {
    entryIds: readonly string[]
    kind: 'read' | 'rejected'
    reason?: string
  }): Promise<void> {
    if (this._status !== 'open') return
    if (opts.entryIds.length === 0) return
    this.sendFrame({
      type: 'MESH_RECEIPT',
      entryIds: opts.entryIds,
      kind: opts.kind,
      reason: opts.reason,
    })
  }

  async close(): Promise<void> {
    if (this._status === 'closed') return
    if (this.ws.readyState === WebSocket.OPEN) {
      this.sendFrame({ type: 'MESH_GOODBYE' })
    }
    this.transitionToClosed('local_close')
    try {
      this.ws.close()
    } catch {
      /* swallow */
    }
  }

  private transitionToClosed(reason: string): void {
    if (this._status === 'closed') return
    this._status = 'closed'

    // Fail any pending dispatches so callers don't hang forever.
    for (const [taskId, pending] of this.pendingDispatches) {
      clearTimeout(pending.timer)
      pending.resolve({
        kind: 'failed',
        taskId,
        by: this._peerId,
        error: `link_closed (${reason})`,
        ts: Date.now(),
      })
    }
    this.pendingDispatches.clear()

    // Resolve pending pulls with empty list — pull is best-effort, no
    // hard error needed.
    for (const [, pending] of this.pendingPulls) {
      clearTimeout(pending.timer)
      pending.resolve([])
    }
    this.pendingPulls.clear()

    for (const h of this.closedHandlers) {
      try {
        h()
      } catch {
        /* swallow */
      }
    }
  }

  on(event: 'task', handler: (task: Task) => Promise<TaskResult>): void
  on(event: 'message', handler: (msg: Message) => void): void
  on(event: 'closed', handler: () => void): void
  on(
    event: 'pull',
    handler: (forPeerId: ParticipantId) => Promise<readonly FeedbackEntry[]>,
  ): void
  on(
    event: 'receipt',
    handler: (params: {
      entryIds: readonly string[]
      kind: 'read' | 'rejected'
      reason?: string
    }) => void | Promise<void>,
  ): void
  on(
    event: 'task' | 'message' | 'closed' | 'pull' | 'receipt',
    handler: unknown,
  ): void {
    switch (event) {
      case 'task':
        if (this.taskHandler) {
          throw new Error(
            `HubLink: 'task' handler already registered (only one allowed per link)`,
          )
        }
        this.taskHandler = handler as (t: Task) => Promise<TaskResult>
        return
      case 'message':
        this.messageHandlers.push(handler as (m: Message) => void)
        return
      case 'closed':
        this.closedHandlers.push(handler as () => void)
        return
      case 'pull':
        if (this.pullHandler) {
          throw new Error(
            `HubLink: 'pull' handler already registered (only one allowed per link)`,
          )
        }
        this.pullHandler = handler as (
          forPeerId: ParticipantId,
        ) => Promise<readonly FeedbackEntry[]>
        return
      case 'receipt':
        if (this.receiptHandler) {
          throw new Error(
            `HubLink: 'receipt' handler already registered (only one allowed per link)`,
          )
        }
        this.receiptHandler = handler as (params: {
          entryIds: readonly string[]
          kind: 'read' | 'rejected'
          reason?: string
        }) => void | Promise<void>
        return
    }
  }
}

// ─── factories ────────────────────────────────────────────────────────────

export interface ConnectHubLinkOptions extends WebSocketHubLinkOptions {
  url: string
  handshakeTimeoutMs?: number
}

/**
 * Open a new WebSocket connection to a peer hub and return a fully
 * handshaken HubLink. Throws if the handshake fails or times out.
 */
export async function connectHubLink(opts: ConnectHubLinkOptions): Promise<HubLink> {
  const ws = new WebSocket(opts.url)
  const link = new WebSocketHubLinkImpl(ws, 'out', opts)
  const timeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS

  await Promise.race([
    link.waitForHandshake(),
    new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error(`hub-link handshake timeout (${timeoutMs}ms)`)),
        timeoutMs,
      ),
    ),
  ])
  return link
}

export interface AcceptHubLinksOptions {
  /** A live `ws.WebSocketServer` whose `connection` events should be wrapped as HubLinks. */
  server: WebSocketServer
  selfId: ParticipantId
  /** Called once per peer that completes the handshake successfully. */
  onLink: (link: HubLink) => void
  handshakeTimeoutMs?: number
}

/**
 * Attach a `connection` handler to a WebSocketServer that wraps each
 * incoming connection as a HubLink. The callback is invoked only AFTER
 * the mesh handshake completes successfully; failed handshakes close
 * the underlying ws silently.
 *
 * Returns a disposer that detaches the handler (existing accepted
 * links are unaffected — they continue to live and must be closed
 * explicitly via `link.close()`).
 */
export function acceptHubLinks(opts: AcceptHubLinksOptions): () => void {
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS

  const handler = (ws: WebSocket) => {
    const link = new WebSocketHubLinkImpl(ws, 'in', { selfId: opts.selfId })
    Promise.race([
      link.waitForHandshake(),
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error(`mesh handshake timeout (${handshakeTimeoutMs}ms)`)),
          handshakeTimeoutMs,
        ),
      ),
    ])
      .then(() => opts.onLink(link))
      .catch(() => {
        try {
          ws.close()
        } catch {
          /* swallow */
        }
      })
  }

  opts.server.on('connection', handler)
  return () => {
    opts.server.off('connection', handler)
  }
}
