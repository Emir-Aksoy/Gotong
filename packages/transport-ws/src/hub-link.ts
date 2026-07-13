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
 * `@gotong/protocol` wire (HELLO/WELCOME/TASK/RESULT). The protocols
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
 *   MESH_PING      {ts}                         keepalive probe (REL-3)
 *   MESH_PONG      {ts}                         keepalive reply
 *   MESH_GOODBYE   {reason?}                    cooperative close
 */

import { randomUUID } from 'node:crypto'

import { WebSocket, type WebSocketServer } from 'ws'

import { isTrustTier } from '@gotong/core'
import type {
  FeedbackEntry,
  HubLink,
  HubLinkDirection,
  HubLinkStatus,
  Message,
  ParticipantId,
  Task,
  TaskResult,
  TrustTier,
} from '@gotong/core'

import type { PeerAuthEnvelope, PeerAuthScheme, PeerAuthVerdict } from './peer-auth.js'

export const MESH_PROTOCOL_VERSION = '1' as const

export type MeshFrame =
  // R1 — `auth` is an OPTIONAL credential envelope (`{scheme, credential}`,
  // see peer-auth.ts). Absent means this side presents no credential; the
  // receiver accepts that only if IT also has no auth scheme configured.
  // When the receiver has a scheme, an absent or mismatched envelope is a
  // fatal handshake error.
  // GT-M6 — `trustTier` is an OPTIONAL, purely ADVISORY self-declaration: the
  // sender discloses the graded-trust tier it believes the edge warrants. It is
  // NOT a credential and NOT verified — the receiver captures it only for the
  // owner's context (`link.peerDeclaredTrustTier`) and NEVER auto-applies it.
  // Trust stays anchored in structurally-unforgeable places (the bearer token
  // in `auth`, the owner-pinned key, the owner's own tier assignment); a wire
  // self-report of "I'm T3" can never make an edge T3 (声明 ≠ 信任). Being an
  // ignore-if-unknown optional field, it is backward/forward compatible, so the
  // exact-string MESH_PROTOCOL_VERSION stays '1' — which is itself proof the
  // field is not load-bearing: a v1 peer that ignores it must still interop.
  | {
      type: 'MESH_HELLO'
      peerId: ParticipantId
      protocolVersion: typeof MESH_PROTOCOL_VERSION
      auth?: PeerAuthEnvelope
      trustTier?: TrustTier
    }
  | {
      type: 'MESH_HELLO_ACK'
      peerId: ParticipantId
      protocolVersion: typeof MESH_PROTOCOL_VERSION
      auth?: PeerAuthEnvelope
      trustTier?: TrustTier
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
  /** #2-M3: fine-grained request/response RPC (cross-hub MCP proxy etc). */
  | { type: 'MESH_RPC_CALL'; rpcId: string; method: string; params: unknown }
  /** #2-M3: reply to a MESH_RPC_CALL — `ok` discriminates value vs error. */
  | {
      type: 'MESH_RPC_RESULT'
      rpcId: string
      ok: boolean
      value?: unknown
      error?: string
    }
  | { type: 'MESH_GOODBYE'; reason?: string }
  /**
   * REL-3 (audit debt #1) — symmetric keepalive. Either side may ping;
   * the other replies with a pong. Any inbound frame (not just pongs)
   * counts as proof of life, so a busy link never wastes a close on a
   * late pong. A half-open TCP connection that swallows frames stops
   * producing ANY inbound traffic and gets closed after
   * `maxMissedPings` silent intervals instead of lingering as a zombie.
   */
  | { type: 'MESH_PING'; ts: number }
  | { type: 'MESH_PONG'; ts: number }

const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000
const DEFAULT_PULL_TIMEOUT_MS = 30_000
const DEFAULT_RPC_TIMEOUT_MS = 30_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000
const DEFAULT_MAX_MISSED_PINGS = 2

interface PendingDispatch {
  resolve: (r: TaskResult) => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingPull {
  resolve: (entries: readonly FeedbackEntry[]) => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
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
   * R1 — peer authentication scheme. Owns BOTH what this side presents
   * in its HELLO/ACK and how it verifies the peer's. Build one with
   * `bearerAuth({ token })` (shared pre-shared secret, FED-M1) or
   * `bearerAuth({ resolver })` (per-peer lookup, Phase 6 #4); pass both
   * on the IN side and the resolver wins for verification.
   *
   * When omitted, this side presents no credential and accepts any peer
   * (or none) — inproc tests and trusted-LAN deployments. A configured
   * side fails closed against an unconfigured one.
   */
  auth?: PeerAuthScheme
  /** Per-dispatch timeout in ms. Default 30s. */
  dispatchTimeoutMs?: number
  /** #2-M3 — per-rpc timeout in ms. Default 30s. */
  rpcTimeoutMs?: number
  /**
   * REL-3 — keepalive ping interval in ms. Default 30s. Set to 0 to
   * disable keepalive entirely (inproc-style trust, or tests that
   * assert exact frame sequences).
   */
  keepaliveIntervalMs?: number
  /**
   * REL-3 — how many consecutive silent intervals (no inbound frame of
   * ANY type) before the link is declared dead and closed with reason
   * `keepalive_timeout`. Default 2 (≈60s of silence at the default
   * interval, mirroring session.ts's agent-session discipline).
   */
  maxMissedPings?: number
  /**
   * GT-M6 — OPTIONAL advisory graded-trust tier this side DECLARES in its
   * HELLO/ACK. It is a self-report the peer surfaces for the owner's context
   * and NEVER auto-applies (声明 ≠ 信任). Omitted → no declaration. This never
   * affects OUR side's gating; it is a courtesy disclosure for the peer.
   */
  declaredTrustTier?: TrustTier
}

class WebSocketHubLinkImpl implements HubLink {
  readonly direction: HubLinkDirection
  private _peerId: ParticipantId
  private _status: HubLinkStatus = 'connecting'

  private readonly ws: WebSocket
  readonly selfId: ParticipantId
  private readonly expectedPeerId?: ParticipantId
  /** R1 — peer auth scheme (presents + verifies). See option docs. */
  private readonly auth?: PeerAuthScheme
  /** GT-M6 — the advisory tier THIS side declares in HELLO/ACK (or undefined). */
  private readonly declaredTrustTier?: TrustTier
  /**
   * GT-M6 — the tier the PEER declared in its HELLO/ACK, captured for advisory
   * display only. `null` until a valid declaration arrives (unknown values are
   * ignored). NEVER consulted by auth / gating / routing — a self-report can
   * never grant trust (声明 ≠ 信任). The owner adjudicates; this is context.
   */
  private _peerDeclaredTrustTier: TrustTier | null = null
  private readonly dispatchTimeoutMs: number
  private readonly pullTimeoutMs: number = DEFAULT_PULL_TIMEOUT_MS

  private taskHandler?: (task: Task) => Promise<TaskResult>
  private pullHandler?: (forPeerId: ParticipantId) => Promise<readonly FeedbackEntry[]>
  private receiptHandler?: (params: {
    entryIds: readonly string[]
    kind: 'read' | 'rejected'
    reason?: string
  }) => void | Promise<void>
  private rpcHandler?: (call: { method: string; params: unknown }) => Promise<unknown>
  private readonly rpcTimeoutMs: number
  private readonly messageHandlers: Array<(m: Message) => void> = []
  private readonly closedHandlers: Array<() => void> = []
  private readonly pendingDispatches = new Map<string, PendingDispatch>()
  private readonly pendingPulls = new Map<string, PendingPull>()
  private readonly pendingRpcs = new Map<string, PendingRpc>()

  private readonly handshakePromise: Promise<void>
  private resolveHandshake!: () => void
  private rejectHandshake!: (err: Error) => void

  // REL-3 — keepalive state. `_lastSeenAt` is stamped on EVERY parsed
  // inbound frame; `missedPings` counts intervals with zero inbound
  // traffic and resets the same way.
  private readonly keepaliveIntervalMs: number
  private readonly maxMissedPings: number
  private _lastSeenAt?: number
  private missedPings = 0
  private keepaliveTimer?: ReturnType<typeof setInterval>

  constructor(
    ws: WebSocket,
    direction: HubLinkDirection,
    opts: WebSocketHubLinkOptions,
  ) {
    this.ws = ws
    this.direction = direction
    this.selfId = opts.selfId
    this.expectedPeerId = opts.expectedPeerId
    // R1 — the auth scheme self-validates at construction (e.g.
    // `bearerAuth` rejects an empty token), so the link just stores it.
    this.auth = opts.auth
    // GT-M6 — advisory tier this side declares; never gates anything locally.
    this.declaredTrustTier = opts.declaredTrustTier
    this.dispatchTimeoutMs = opts.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    this.keepaliveIntervalMs = opts.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS
    this.maxMissedPings = opts.maxMissedPings ?? DEFAULT_MAX_MISSED_PINGS
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

  /** REL-3 — epoch-ms of the most recent inbound frame from the peer. */
  get lastSeenAt(): number | undefined {
    return this._lastSeenAt
  }

  /**
   * GT-M6 — the graded-trust tier the peer DECLARED in its handshake, or `null`
   * if it declared none (or an unrecognised value). ADVISORY ONLY: nothing in
   * this link consults it; it is surfaced so a host/owner can see "the peer
   * claims T3" as context. The effective trust of an edge is the owner's own
   * `trust_tier` assignment, never this self-report (声明 ≠ 信任).
   */
  get peerDeclaredTrustTier(): TrustTier | null {
    return this._peerDeclaredTrustTier
  }

  /** @internal — used by `connectHubLink` / `acceptHubLinks`. */
  waitForHandshake(): Promise<void> {
    return this.handshakePromise
  }

  private sendHello(): void {
    // R1 — present our credential envelope if a scheme is configured.
    const env = this.auth?.present()
    this.sendFrame({
      type: 'MESH_HELLO',
      peerId: this.selfId,
      protocolVersion: MESH_PROTOCOL_VERSION,
      ...(env ? { auth: env } : {}),
      // GT-M6 — advisory tier declaration (omitted when unset). Never load-bearing.
      ...(this.declaredTrustTier ? { trustTier: this.declaredTrustTier } : {}),
    })
  }

  /**
   * R1 — verify the auth envelope from an incoming HELLO/HELLO_ACK.
   * Stays the single verification choke point: delegates to the
   * configured `PeerAuthScheme` (which dispatches by scheme kind), or
   * accepts unconditionally when no scheme is set (inproc / trusted-LAN).
   *
   * Mixed deployments (one side configured, one not) fail closed on the
   * configured side; the unconfigured side sees a silent close.
   */
  private verifyPeerAuth(
    received: PeerAuthEnvelope | undefined,
    claimedPeerId: ParticipantId | undefined,
  ): PeerAuthVerdict {
    if (!this.auth) return { error: null }
    return this.auth.verifyInbound(received, claimedPeerId)
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

    // REL-3 — any well-formed inbound frame proves the peer (and the
    // path to it) is alive. Stamping here rather than only on PONG
    // means a chatty link never pays keepalive overhead beyond the
    // outbound pings themselves.
    this._lastSeenAt = Date.now()
    this.missedPings = 0

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
        let ackAuth: PeerAuthEnvelope | undefined
        {
          const v = this.verifyPeerAuth(frame.auth, frame.peerId)
          if (v.error) {
            this.rejectHandshake(v.error)
            this.transitionToClosed('peer_token_invalid')
            return
          }
          ackAuth = v.replyWith
        }
        // GT-M6 — capture the peer's advisory tier declaration ONLY after auth
        // passed (a rejected handshake never records it), and ONLY if it's a
        // valid tier (unknown → ignored, stays null). This is advisory context,
        // never a gate: we've already verified the token above; the declaration
        // adds nothing to that verdict.
        this._peerDeclaredTrustTier = isTrustTier(frame.trustTier) ? frame.trustTier : null
        this._peerId = frame.peerId
        this.sendFrame({
          type: 'MESH_HELLO_ACK',
          peerId: this.selfId,
          protocolVersion: MESH_PROTOCOL_VERSION,
          ...(ackAuth ? { auth: ackAuth } : {}),
          // GT-M6 — echo our own advisory declaration on the ACK (symmetric).
          ...(this.declaredTrustTier ? { trustTier: this.declaredTrustTier } : {}),
        })
        this._status = 'open'
        this.startKeepalive()
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
          const v = this.verifyPeerAuth(frame.auth, frame.peerId)
          if (v.error) {
            this.rejectHandshake(v.error)
            this.transitionToClosed('peer_token_invalid')
            return
          }
        }
        // GT-M6 — capture the peer's advisory tier declaration from the ACK,
        // same discipline as the HELLO path: after auth, valid-only, never a gate.
        this._peerDeclaredTrustTier = isTrustTier(frame.trustTier) ? frame.trustTier : null
        this._peerId = frame.peerId
        this._status = 'open'
        this.startKeepalive()
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

      case 'MESH_RPC_CALL': {
        const handler = this.rpcHandler
        if (!handler) {
          this.sendFrame({
            type: 'MESH_RPC_RESULT',
            rpcId: frame.rpcId,
            ok: false,
            error: 'peer has no rpc handler',
          })
          return
        }
        Promise.resolve(handler({ method: frame.method, params: frame.params }))
          .then((value) =>
            this.sendFrame({ type: 'MESH_RPC_RESULT', rpcId: frame.rpcId, ok: true, value }),
          )
          .catch((err) =>
            this.sendFrame({
              type: 'MESH_RPC_RESULT',
              rpcId: frame.rpcId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          )
        return
      }

      case 'MESH_RPC_RESULT': {
        const pending = this.pendingRpcs.get(frame.rpcId)
        if (!pending) return // unknown / already-timed-out
        clearTimeout(pending.timer)
        this.pendingRpcs.delete(frame.rpcId)
        if (frame.ok) pending.resolve(frame.value)
        else pending.reject(new Error(frame.error || 'remote rpc failed'))
        return
      }

      case 'MESH_PING':
        // Reply only on an open link — a ping during handshake is a
        // protocol violation we ignore (the liveness stamp above
        // already happened, which is harmless).
        if (this._status === 'open') {
          this.sendFrame({ type: 'MESH_PONG', ts: frame.ts })
        }
        return

      case 'MESH_PONG':
        // Nothing to do — the liveness stamp above is the whole point.
        return

      case 'MESH_GOODBYE':
        this.transitionToClosed('peer_goodbye')
        return
    }
  }

  /**
   * REL-3 — start the symmetric keepalive loop. Called exactly once,
   * when the handshake transitions the link to 'open' (both the HELLO
   * and HELLO_ACK branches). Each tick: if the peer produced no inbound
   * frame for `maxMissedPings` consecutive intervals, the link is a
   * half-open zombie — close it so PeerRegistry's redial loop can see
   * the failure and reconnect. Otherwise bill one missed interval and
   * ping; any inbound frame resets the count.
   *
   * `.unref()` keeps the timer from pinning the event loop — a process
   * with nothing left but keepalive timers should be allowed to exit.
   */
  private startKeepalive(): void {
    if (this.keepaliveIntervalMs <= 0 || this.keepaliveTimer) return
    this.keepaliveTimer = setInterval(() => {
      if (this._status !== 'open') return
      if (this.missedPings >= this.maxMissedPings) {
        this.transitionToClosed('keepalive_timeout')
        // A half-open zombie won't complete a graceful close handshake
        // — terminate() drops the socket immediately so the fd and the
        // ws 'close' bookkeeping don't linger until the OS notices.
        try {
          this.ws.terminate()
        } catch {
          /* swallow */
        }
        return
      }
      this.missedPings += 1
      this.sendFrame({ type: 'MESH_PING', ts: Date.now() })
    }, this.keepaliveIntervalMs)
    this.keepaliveTimer.unref?.()
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

  async rpc(method: string, params: unknown): Promise<unknown> {
    if (this._status !== 'open') {
      throw new Error(`link_${this._status}`)
    }
    const rpcId = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(rpcId)
        reject(new Error(`rpc_timeout (${this.rpcTimeoutMs}ms)`))
      }, this.rpcTimeoutMs)
      this.pendingRpcs.set(rpcId, { resolve, reject, timer })
      this.sendFrame({ type: 'MESH_RPC_CALL', rpcId, method, params })
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

    // REL-3 — stop the keepalive loop; a closed link must never ping.
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = undefined
    }

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

    // Reject pending rpcs — unlike pull, rpc has a hard error contract so
    // callers (e.g. RemoteMcpToolset) see the close instead of hanging.
    for (const [, pending] of this.pendingRpcs) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`link_closed (${reason})`))
    }
    this.pendingRpcs.clear()

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
    event: 'rpc',
    handler: (call: { method: string; params: unknown }) => Promise<unknown>,
  ): void
  on(
    event: 'task' | 'message' | 'closed' | 'pull' | 'receipt' | 'rpc',
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
      case 'rpc':
        if (this.rpcHandler) {
          throw new Error(
            `HubLink: 'rpc' handler already registered (only one allowed per link)`,
          )
        }
        this.rpcHandler = handler as (call: {
          method: string
          params: unknown
        }) => Promise<unknown>
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
  // R1 — the auth scheme self-validates when constructed (e.g.
  // `bearerAuth` throws on an empty token), so there's nothing to
  // pre-validate here before opening the socket.
  const ws = new WebSocket(opts.url)
  const link = new WebSocketHubLinkImpl(ws, 'out', opts)
  const timeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      link.waitForHandshake(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`hub-link handshake timeout (${timeoutMs}ms)`)),
          timeoutMs,
        )
      }),
    ])
  } catch (err) {
    // The handshake timed out (or rejected). Tear the socket down before
    // propagating — otherwise it leaks. Two leaks, actually: (1) PeerRegistry
    // .dialOne retries on a backoff timer, so each redial would strand one
    // socket; (2) a still-CONNECTING socket that completes AFTER the timeout
    // would `sendHello()` and could finish a handshake on a link nobody holds
    // — a live orphan exchanging frames with no owner and no teardown path.
    // close() transitions the link closed and closes the ws (idempotent, and a
    // no-op goodbye on a non-OPEN socket).
    await link.close().catch(() => {})
    throw err
  } finally {
    // On success the timeout is still armed; clear it so it can't fire later
    // (rejecting an already-settled race) or keep the event loop alive.
    if (timer !== undefined) clearTimeout(timer)
  }
  return link
}

/**
 * D1 fix — the per-connection mesh handler that `acceptHubLinks` builds.
 * Exported so the host's shared-port demux
 * (`serveWebSocket(...).routeMeshTo`) can accept exactly this shape and
 * hand a socket it has already identified as a federation peer straight
 * to the mesh handshake. `req` carries only what the rate limiter needs
 * (source IP); it's optional so unit tests can invoke without an upgrade
 * request.
 */
export type MeshConnection = (
  ws: WebSocket,
  req?: {
    socket?: { remoteAddress?: string | null }
    headers?: Record<string, string | string[] | undefined>
  },
) => void

export interface AcceptHubLinksOptions {
  /**
   * A live `ws.WebSocketServer` whose `connection` events should be
   * wrapped as HubLinks. Provide EITHER `server` OR `register`. When
   * both are set, `register` wins and `server` is ignored.
   */
  server?: WebSocketServer
  /**
   * D1 fix — alternative to `server` for the shared-port topology.
   * Instead of attaching our own 'connection' listener to a server that
   * ALSO hosts agent sessions — where the two blind listeners race and
   * the agent `Session`'s `terminate()` on a MESH_HELLO first frame
   * kills the peer handshake before its ACK can flush — hand our
   * per-connection handler to a demultiplexer that has already peeked
   * the first frame and decided this socket is a mesh peer. Returns a
   * disposer that unregisters the handler. Wired in the host as
   * `serveWebSocket(...).routeMeshTo`.
   */
  register?: (handler: MeshConnection) => () => void
  selfId: ParticipantId
  /** Called once per peer that completes the handshake successfully. */
  onLink: (link: HubLink) => void
  /**
   * GT-M6 — our own OPTIONAL, purely ADVISORY tier self-declaration to echo
   * back on every inbound link's HELLO_ACK. Symmetric with
   * `ConnectHubLinkOptions.declaredTrustTier` (the OUT side sends it on HELLO).
   * It is context for the peer's owner, NEVER a credential and NEVER a gate —
   * the receiver captures it into `link.peerDeclaredTrustTier` but never
   * auto-applies it. Omit to send no declaration (byte-identical to today).
   */
  declaredTrustTier?: TrustTier
  handshakeTimeoutMs?: number
  /**
   * R1 — peer authentication scheme applied to every inbound link.
   * Build with `bearerAuth({ token })` for a shared pre-shared secret,
   * `bearerAuth({ resolver })` for per-peer lookup (typically from
   * `identity.peers` + vault), or both (resolver wins for verification).
   * Omit to accept unauthenticated peers. The same scheme object is
   * shared across all inbound connections (schemes are stateless).
   */
  auth?: PeerAuthScheme
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
  /** REL-3 — keepalive ping interval for accepted links. Default 30s; 0 disables. */
  keepaliveIntervalMs?: number
  /** REL-3 — consecutive silent intervals before `keepalive_timeout`. Default 2. */
  maxMissedPings?: number
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
 * Mirrors the semantics of @gotong/web's clientIp helper so a host
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
      ...(opts.auth ? { auth: opts.auth } : {}),
      ...(opts.declaredTrustTier ? { declaredTrustTier: opts.declaredTrustTier } : {}),
      ...(opts.keepaliveIntervalMs !== undefined
        ? { keepaliveIntervalMs: opts.keepaliveIntervalMs }
        : {}),
      ...(opts.maxMissedPings !== undefined
        ? { maxMissedPings: opts.maxMissedPings }
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

  if (opts.register) {
    // D1 fix — shared-port host: register with serveWebSocket's
    // first-frame demux instead of racing a sibling 'connection'
    // listener on the same server (which the agent Session would kill).
    return opts.register(handler)
  }
  const server = opts.server
  if (!server) {
    throw new Error('acceptHubLinks: either `server` or `register` must be provided')
  }
  server.on('connection', handler)
  return () => {
    server.off('connection', handler)
  }
}
