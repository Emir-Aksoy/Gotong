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

import { randomUUID, timingSafeEqual } from 'node:crypto'

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
  // FED-M1: `peerToken` is OPTIONAL on the wire (kept optional so a
  // legacy peer that doesn't know about tokens can still connect AS LONG
  // AS the receiving side also has no peerToken configured). When the
  // receiver has a peerToken configured, an absent or mismatched
  // `peerToken` is a fatal handshake error.
  | {
      type: 'MESH_HELLO'
      peerId: ParticipantId
      protocolVersion: typeof MESH_PROTOCOL_VERSION
      peerToken?: string
    }
  | {
      type: 'MESH_HELLO_ACK'
      peerId: ParticipantId
      protocolVersion: typeof MESH_PROTOCOL_VERSION
      peerToken?: string
    }
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
  /**
   * FED-M1 — Pre-shared secret for mutual peer authentication. When
   * set, this side will:
   *   1. Present this exact value as `peerToken` in its HELLO /
   *      HELLO_ACK frame, AND
   *   2. Require the OTHER side to present the SAME value in its
   *      HELLO / HELLO_ACK; mismatched or missing → fatal handshake
   *      error, link closes.
   *
   * Typical deployment: one token per peer pair, configured the same
   * on both sides. Compared with `timingSafeEqual` to avoid leaking
   * token characters through response-time variation.
   *
   * When omitted, this side accepts ANY peerToken (or none) — keeps
   * pre-FED-M1 deployments and inproc-only test code working.
   *
   * Empty string is rejected at construction time to prevent a config
   * error from silently disabling auth.
   */
  peerToken?: string
  /**
   * Phase 6 #4 — per-peer token resolver. When set, takes precedence
   * over the shared `peerToken`: this side will call
   * `peerTokenResolver(claimedPeerId)` to look up the expected token
   * for the peer claiming that id in their HELLO. Returning `null`
   * means "unknown peer / disabled" — handshake rejects. Returning a
   * non-empty string is compared constant-time against the received
   * token.
   *
   * Typical wiring: the host's PeerRegistry passes a closure that
   * looks up the peer in the identity.peers table and reads the
   * vault entry's plaintext. This makes inbound auth symmetric with
   * outbound: each side stores the other's token in its own peers
   * table; a rotated token on one end is honored on the other end
   * without operator restart of the shared secret.
   *
   * Only meaningful on the IN side. OUT side: this option is
   * ignored. To rotate the token used by the OUT side, edit the
   * peers row via the admin API; PeerRegistry will pick it up at
   * the next reconciliation tick.
   */
  peerTokenResolver?: (claimedPeerId: ParticipantId) => string | null
  /** Per-dispatch timeout in ms. Default 30s. */
  dispatchTimeoutMs?: number
}

/**
 * FED-M1 — constant-time string compare for peerToken verification.
 * `timingSafeEqual` throws if buffer lengths differ, so we early-return
 * `false` in that case (a length mismatch is itself unguessable by an
 * attacker doing length-prefix-pinning, and is therefore safe to leak).
 * Returns `false` on any malformed input — callers want a boolean.
 */
function constantTimeStringEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  if (a.length === 0) return false
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

class WebSocketHubLinkImpl implements HubLink {
  readonly direction: HubLinkDirection
  private _peerId: ParticipantId
  private _status: HubLinkStatus = 'connecting'

  private readonly ws: WebSocket
  readonly selfId: ParticipantId
  private readonly expectedPeerId?: ParticipantId
  /** FED-M1 — shared secret for mutual peer auth. See option docs. */
  private readonly peerToken?: string
  /** Phase 6 #4 — per-peer token resolver. See option docs. */
  private readonly peerTokenResolver?: (
    claimedPeerId: ParticipantId,
  ) => string | null
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
    // FED-M1 — empty string is rejected at construction to catch the
    // common config typo where the env var was defined but empty
    // (silently disables auth otherwise).
    if (opts.peerToken !== undefined && opts.peerToken.length === 0) {
      throw new Error(
        'WebSocketHubLink: peerToken must be a non-empty string when provided; ' +
          'pass undefined to skip mutual auth explicitly',
      )
    }
    this.peerToken = opts.peerToken
    this.peerTokenResolver = opts.peerTokenResolver
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
      // FED-M1 — present our shared peer secret if configured. The
      // other side verifies via constantTimeStringEquals.
      ...(this.peerToken !== undefined ? { peerToken: this.peerToken } : {}),
    })
  }

  /**
   * Verify the `peerToken` from an incoming HELLO/HELLO_ACK frame.
   * Returns null on success, or an Error to attach to the
   * handshake-reject path.
   *
   * Resolution policy (highest priority first):
   *   1. Phase 6 #4 — `peerTokenResolver` set: look up the expected
   *      token by `claimedPeerId`. null → reject (unknown peer or
   *      disabled). non-empty string → constant-time compare. Mismatch
   *      → reject. The resolver path REQUIRES the peer to identify
   *      itself via `frame.peerId`; an absent claimedPeerId is rejected.
   *   2. FED-M1 — shared `peerToken` set: peer MUST present matching
   *      value. Missing or different → reject.
   *   3. Neither set → accept anything (legacy / inproc test path).
   *
   * Mixed deployments (one side configured, one side not) fail closed
   * on the configured side; the unconfigured side sees a silent close.
   */
  private verifyPeerToken(
    received: string | undefined,
    claimedPeerId: ParticipantId | undefined,
  ): { error: Error | null; tokenToReplyWith?: string } {
    if (this.peerTokenResolver) {
      if (!claimedPeerId || claimedPeerId.length === 0) {
        return {
          error: new Error('peer must present a peerId; per-peer auth requires it'),
        }
      }
      let expected: string | null
      try {
        expected = this.peerTokenResolver(claimedPeerId)
      } catch {
        // Resolver throw is a server-side bug. Fail closed and let the
        // operator see the upstream stack in their logs (we don't have
        // a logger here; the caller's onLink path will surface the close).
        return { error: new Error('peer token resolver threw; refusing connection') }
      }
      if (expected === null) {
        return {
          error: new Error(
            `unknown peer '${claimedPeerId}'; not in this host's peer registry`,
          ),
        }
      }
      if (expected.length === 0) {
        // Defensive: resolver returned '' instead of null. Treat as
        // misconfiguration, fail closed.
        return { error: new Error('peer token resolver returned empty string; refusing') }
      }
      if (received === undefined) {
        return { error: new Error('peer did not present a peerToken; mutual auth required') }
      }
      if (!constantTimeStringEquals(expected, received)) {
        return { error: new Error('peer presented an invalid peerToken; mutual auth failed') }
      }
      // Phase 6 #4: echo the per-peer token back in the reply so the
      // OUT side can verify it against its own local copy (mutual
      // auth). Both sides MUST have the same value stored — the IN
      // side derived it via resolver; the OUT side configured it via
      // its peers row.
      return { error: null, tokenToReplyWith: expected }
    }
    if (this.peerToken === undefined) {
      return { error: null }
    }
    if (received === undefined) {
      return { error: new Error('peer did not present a peerToken; mutual auth required') }
    }
    if (!constantTimeStringEquals(this.peerToken, received)) {
      // Never log the actual tokens — just the failure shape.
      return { error: new Error('peer presented an invalid peerToken; mutual auth failed') }
    }
    return { error: null, tokenToReplyWith: this.peerToken }
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
        // Audit #143 — once the handshake is open, a second HELLO is
        // either a buggy peer or an attempt by an attacker to mutate
        // `_peerId` (every HELLO path below overwrites it). Drop
        // silently; the legitimate handshake already resolved. We
        // also bail in 'closed' so a late-arriving stale frame on a
        // teardown ws doesn't trip side effects.
        if (this._status !== 'connecting') return
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
        // FED-M1 / Phase 6 #4 — verify the peer's token BEFORE
        // accepting the HELLO. We reject before sending HELLO_ACK so a
        // wrong-token peer never sees our selfId / our own token.
        // Per-peer mode (resolver set) uses frame.peerId to look up
        // the expected token; shared mode ignores claimedPeerId.
        // The verify result also tells us what value to echo back in
        // the ACK — under per-peer auth that's the per-pair secret
        // resolved for this peer; under shared mode it's just our
        // shared peerToken.
        let ackToken: string | undefined
        {
          const v = this.verifyPeerToken(frame.peerToken, frame.peerId)
          if (v.error) {
            this.rejectHandshake(v.error)
            this.transitionToClosed('peer_token_invalid')
            return
          }
          ackToken = v.tokenToReplyWith
        }
        this._peerId = frame.peerId
        this.sendFrame({
          type: 'MESH_HELLO_ACK',
          peerId: this.selfId,
          protocolVersion: MESH_PROTOCOL_VERSION,
          ...(ackToken !== undefined ? { peerToken: ackToken } : {}),
        })
        this._status = 'open'
        this.resolveHandshake()
        return

      case 'MESH_HELLO_ACK':
        if (this.direction !== 'out') return
        // Audit #143 — symmetric guard with HELLO: only honour an ACK
        // while we're still in the connecting state. A second ACK on an
        // open link would re-call resolveHandshake() (no-op, already
        // settled) but more importantly would rewrite `_peerId` to
        // whatever the attacker put in frame.peerId.
        if (this._status !== 'connecting') return
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
        // FED-M1 — verify the peer's token on the ACK. We've already
        // sent our own token in HELLO (which the peer accepted, else
        // they wouldn't be ACKing); now we close the mutual loop by
        // verifying their token before declaring the link open. The
        // OUT side typically has no resolver wired (that's an inbound
        // server concept); shared-token path handles ACK either way.
        {
          const v = this.verifyPeerToken(frame.peerToken, frame.peerId)
          if (v.error) {
            this.rejectHandshake(v.error)
            this.transitionToClosed('peer_token_invalid')
            return
          }
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
    const wasConnecting = this._status === 'connecting'
    this._status = 'closed'

    // FED-M1: if the close happens DURING handshake (e.g. the IN side
    // rejected our bad peerToken and closed the socket), reject the
    // handshake promise so callers see the close immediately instead of
    // having to wait for their timeout. The reason string surfaces the
    // shape of the close (peer_disconnected / ws_error / peer_token_*).
    if (wasConnecting) {
      this.rejectHandshake(new Error(`hub-link closed during handshake (${reason})`))
    }

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
  // FED-M1 — validate the option BEFORE opening the WebSocket so a
  // bad config (empty peerToken from an undefined env var) surfaces
  // as an immediate throw rather than racing with the connection
  // attempt and leaking a half-open ws.
  if (opts.peerToken !== undefined && opts.peerToken.length === 0) {
    throw new Error(
      'connectHubLink: peerToken must be a non-empty string when provided; ' +
        'pass undefined to skip mutual auth explicitly',
    )
  }
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
  /**
   * FED-M1 — shared peer auth secret. When set, every incoming
   * connection MUST present this same value in its HELLO frame, else
   * the handshake rejects and the socket closes silently. When omitted,
   * accepts unauthenticated peers (legacy behavior).
   *
   * Phase 6 #4: prefer `peerTokenResolver` for new deployments — it
   * scales to many peers without rotating one shared secret.
   * `peerToken` remains supported for environments without identity.
   */
  peerToken?: string
  /**
   * Phase 6 #4 — per-peer token resolver. Receives the claimed
   * `peerId` from the incoming HELLO and returns the expected token
   * for that peer (typically from `identity.peers` + vault), or
   * `null` to reject the connection as "unknown peer". Takes
   * precedence over `peerToken` when both are set.
   */
  peerTokenResolver?: (claimedPeerId: ParticipantId) => string | null
  /**
   * Phase 6 #12 — pre-handshake rate-limit hook. Called the instant
   * an upgrade lands, BEFORE constructing the HubLink. Receives the
   * source IP (or 'unknown' when the underlying socket has no
   * `remoteAddress`). Return `false` to drop the connection without
   * even allocating the handshake state machine — cheap defense
   * against brute-force token guessing or HELLO floods that would
   * otherwise pin event-loop ticks. Return `true` to let the
   * handshake proceed normally.
   *
   * Typical wiring: a per-IP RateLimiter in PeerRegistry that
   * tracks attempts and bills failures heavier than successes.
   */
  onConnectionAttempt?: (sourceIp: string) => boolean
  /**
   * Audit #142 — when true, prefer the first `X-Forwarded-For` entry
   * as the source IP for `onConnectionAttempt`. Default false: read
   * `req.socket.remoteAddress` directly.
   *
   * Set to true when this server sits behind a reverse proxy (Caddy,
   * nginx, ALB) that overwrites XFF with the actual client IP. Leaving
   * it false in a proxied deployment makes the rate-limiter bucket
   * every peer under the proxy's loopback IP — a single bad peer
   * starves all others, and the limiter is effectively useless.
   *
   * Leaving it ON when not behind a proxy lets a remote attacker spoof
   * the header to dodge limits. Match this to your network topology.
   */
  trustProxy?: boolean
}

/**
 * Audit #142 — derive the rate-limit IP from the upgrade request.
 * Mirrors the semantics of @aipehub/web's clientIp helper so a host
 * running both surfaces gets consistent bucketing per real client.
 */
function extractClientIp(
  req: { socket?: { remoteAddress?: string | null }; headers?: Record<string, string | string[] | undefined> } | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy && req?.headers) {
    const fwd = req.headers['x-forwarded-for']
    const raw = Array.isArray(fwd) ? fwd[0] : fwd
    if (typeof raw === 'string' && raw.length > 0) {
      const first = raw.split(',')[0]?.trim()
      if (first) return first
    }
  }
  return req?.socket?.remoteAddress || 'unknown'
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

  // Phase 6 #12 — `ws` library passes the IncomingMessage as the 2nd
  // arg of the 'connection' event. We pluck `socket.remoteAddress`
  // (cheap, no DNS) before constructing the link so the rate limiter
  // runs before any allocation.
  //
  // Audit #142 — `extractClientIp` honours `opts.trustProxy`. Without
  // it, hosts behind a reverse proxy bucket every peer under loopback.
  const trustProxy = opts.trustProxy === true
  const handler = (
    ws: WebSocket,
    req?: { socket?: { remoteAddress?: string | null }; headers?: Record<string, string | string[] | undefined> },
  ) => {
    if (opts.onConnectionAttempt) {
      const ip = extractClientIp(req, trustProxy)
      let allowed = true
      try {
        allowed = opts.onConnectionAttempt(ip) !== false
      } catch {
        allowed = false
      }
      if (!allowed) {
        try { ws.close() } catch { /* swallow */ }
        return
      }
    }
    const link = new WebSocketHubLinkImpl(ws, 'in', {
      selfId: opts.selfId,
      ...(opts.peerToken !== undefined ? { peerToken: opts.peerToken } : {}),
      ...(opts.peerTokenResolver
        ? { peerTokenResolver: opts.peerTokenResolver }
        : {}),
    })
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
