/**
 * HubLink — a SYMMETRIC bidirectional channel between two hubs.
 *
 * This is M2 of the hub-mesh implementation (see `docs/zh/HUB-MESH.md`
 * §2.2). It replaces the non-symmetric `TeamBridgeAgent` (sdk-node)
 * with a peer-to-peer abstraction: either side can dispatch tasks to
 * the other, either side can publish messages to the other, and either
 * side can close the link.
 *
 * Three intended implementations share this interface:
 *
 *   - `InprocHubLink`        — same process, direct in-memory wiring
 *                              (M2, this file)
 *   - `WebSocketHubLink`     — cross-process / cross-machine over wss
 *                              (M3)
 *   - test mocks             — anything implementing the interface
 *
 * The interface intentionally does NOT mention feedback ledger
 * methods (`pullFeedbackFor`, `pushReadReceipt`). Those are added as
 * extensions in M5–M7 so M2 stays minimal and the WebSocket version
 * can be built without the ledger being on the critical path.
 */

import type { FeedbackEntry } from './feedback/types.js'
import type { Message, ParticipantId, Task, TaskResult } from './types.js'

export type HubLinkDirection = 'in' | 'out' | 'inproc'
export type HubLinkStatus = 'connecting' | 'open' | 'closed'

export interface HubLink {
  /** Stable identifier of the peer hub as seen from THIS side. */
  readonly peerId: ParticipantId

  /**
   * The id by which the PEER addresses us. Symmetric counterpart to
   * `peerId`. Used by the feedback pull protocol (M6): when we call
   * `pullFeedbackFor()`, we tell the peer "give me everything where
   * `toHub === selfId`".
   */
  readonly selfId: ParticipantId

  /**
   * Who initiated this link, from this side's point of view.
   *
   *   - `'out'`     — this side opened the connection (ws client)
   *   - `'in'`      — this side accepted the connection (ws server upgrade)
   *   - `'inproc'`  — same process, no actual transport
   */
  readonly direction: HubLinkDirection

  readonly status: HubLinkStatus

  /**
   * Forward a task to the peer hub for it to dispatch internally.
   * Returns the peer's TaskResult. Caller is responsible for handing
   * the resulting taskId / by back to the originating Hub.
   *
   * If the link is not `open`, resolves immediately with a `failed`
   * result and `error: 'link_<status>'`.
   *
   * If the peer never registered a task handler (`on('task', ...)`),
   * resolves with `no_participant`.
   */
  dispatch(task: Task): Promise<TaskResult>

  /**
   * Forward a published message to the peer hub. Fire-and-forget; if
   * the link is not `open` or the peer has no message handlers
   * registered, the call silently no-ops (matches the message-bus
   * semantics in `Hub.publish`).
   */
  publish(msg: Message): void

  /**
   * Close the link from this side. Implementations close the
   * underlying transport (if any) and trigger `'closed'` handlers on
   * BOTH sides — this is symmetric: peer's `status` flips to
   * `'closed'` as soon as it observes the close.
   *
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  close(): Promise<void>

  /**
   * Ask the peer for any feedback entries it has written ABOUT us
   * (`toHub === selfId`) that have not yet been delivered to us.
   * The peer is expected to mark those entries as delivered atomically
   * before returning, so subsequent pulls don't re-deliver.
   *
   * Returns an empty array if the peer has nothing pending or has
   * registered no `'pull'` handler.
   */
  pullFeedbackFor(): Promise<readonly FeedbackEntry[]>

  /**
   * Tell the peer how we processed entries they sent us:
   *
   *   - `kind: 'read'`     — we accepted and processed them
   *   - `kind: 'rejected'` — we refused (Q4); peer should NOT count
   *                          these toward our reputation. Optional
   *                          `reason` is human-readable.
   *
   * Fire-and-forget: returns once the frame is sent (resolves
   * immediately on inproc; ws may queue if link is back-pressured but
   * does not await delivery confirmation).
   */
  pushReadReceipt(opts: {
    entryIds: readonly string[]
    kind: 'read' | 'rejected'
    reason?: string
  }): Promise<void>

  /**
   * #2-M3 — fine-grained request/response RPC to the peer hub. Unlike
   * `dispatch` (Task semantics, broad), this is a narrow call: the peer's
   * registered `'rpc'` handler runs and its return value comes back as the
   * resolved value. `method` namespaces the call (e.g. `'mcp.listTools'`);
   * `params` and the return value must be JSON-serializable.
   *
   * REJECTS (not a soft failure result) when the link is not open, the
   * call times out, the peer registered no `'rpc'` handler, or the
   * handler threw. The generic seam underpins the cross-hub MCP proxy but
   * carries no MCP semantics itself — those live in the responder.
   */
  rpc(method: string, params: unknown): Promise<unknown>

  on(event: 'task', handler: (task: Task) => Promise<TaskResult>): void
  on(event: 'message', handler: (msg: Message) => void): void
  on(event: 'closed', handler: () => void): void
  /**
   * Handler invoked when the PEER calls its `pullFeedbackFor()` over
   * this link. Argument is the peer's `selfId` (== our `peerId`); the
   * handler returns entries this side has written about that peer and
   * is responsible for marking them delivered.
   */
  on(
    event: 'pull',
    handler: (forPeerId: ParticipantId) => Promise<readonly FeedbackEntry[]>,
  ): void
  /**
   * Handler invoked when the PEER calls `pushReadReceipt()`. The
   * handler should apply the receipt to its outbound ledger:
   * `kind: 'read'` → `markRead`, `kind: 'rejected'` → `markRejected`.
   * Synchronous or async; errors are swallowed (receipt delivery is
   * best-effort).
   */
  on(
    event: 'receipt',
    handler: (params: {
      entryIds: readonly string[]
      kind: 'read' | 'rejected'
      reason?: string
    }) => void | Promise<void>,
  ): void
  /**
   * #2-M3 — handler invoked when the PEER calls `rpc(method, params)` over
   * this link. Returns the value to send back; throwing surfaces as a
   * rejection on the caller's side. Only one handler per link.
   */
  on(
    event: 'rpc',
    handler: (call: { method: string; params: unknown }) => Promise<unknown>,
  ): void
}

// ─── inproc implementation ────────────────────────────────────────────────

class InprocHubLinkImpl implements HubLink {
  readonly direction = 'inproc' as const
  readonly peerId: ParticipantId
  readonly selfId: ParticipantId
  private _status: HubLinkStatus = 'open'

  private peer?: InprocHubLinkImpl
  private taskHandler?: (task: Task) => Promise<TaskResult>
  private pullHandler?: (forPeerId: ParticipantId) => Promise<readonly FeedbackEntry[]>
  private receiptHandler?: (params: {
    entryIds: readonly string[]
    kind: 'read' | 'rejected'
    reason?: string
  }) => void | Promise<void>
  private rpcHandler?: (call: { method: string; params: unknown }) => Promise<unknown>
  private messageHandlers: Array<(msg: Message) => void> = []
  private closedHandlers: Array<() => void> = []

  constructor(peerId: ParticipantId, selfId: ParticipantId) {
    this.peerId = peerId
    this.selfId = selfId
  }

  get status(): HubLinkStatus {
    return this._status
  }

  /** @internal — only `createInprocHubLinkPair` should call this. */
  _attachPeer(other: InprocHubLinkImpl): void {
    this.peer = other
  }

  async dispatch(task: Task): Promise<TaskResult> {
    if (this._status !== 'open') {
      return {
        kind: 'failed',
        taskId: task.id,
        by: this.peerId,
        error: `link_${this._status}`,
        ts: Date.now(),
      }
    }
    const handler = this.peer?.taskHandler
    if (!handler) {
      return {
        kind: 'no_participant',
        taskId: task.id,
        reason: `peer '${this.peerId}' has no task handler`,
        ts: Date.now(),
      }
    }
    return handler(task)
  }

  publish(msg: Message): void {
    if (this._status !== 'open') return
    const handlers = this.peer?.messageHandlers ?? []
    for (const h of handlers) {
      try {
        h(msg)
      } catch {
        /* publish is fire-and-forget; swallow handler errors */
      }
    }
  }

  async close(): Promise<void> {
    if (this._status === 'closed') return
    this._status = 'closed'
    // Symmetric close: tell peer too (which will in turn no-op because
    // its status flips first).
    const peer = this.peer
    if (peer && peer._status !== 'closed') {
      await peer.close()
    }
    for (const h of this.closedHandlers) {
      try {
        h()
      } catch {
        /* swallow */
      }
    }
  }

  async pullFeedbackFor(): Promise<readonly FeedbackEntry[]> {
    if (this._status !== 'open') return []
    const handler = this.peer?.pullHandler
    if (!handler) return []
    // Peer's pull handler receives PEER's view of "who is asking",
    // which from the peer's perspective is this.selfId (== peer's peerId).
    return handler(this.selfId)
  }

  async pushReadReceipt(opts: {
    entryIds: readonly string[]
    kind: 'read' | 'rejected'
    reason?: string
  }): Promise<void> {
    if (this._status !== 'open') return
    const handler = this.peer?.receiptHandler
    if (!handler) return
    try {
      await handler(opts)
    } catch {
      /* receipts are best-effort */
    }
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    if (this._status !== 'open') {
      throw new Error(`link_${this._status}`)
    }
    const handler = this.peer?.rpcHandler
    if (!handler) {
      throw new Error(`peer '${this.peerId}' has no rpc handler`)
    }
    // Round-trip through JSON like the ws transport would, so inproc and
    // ws share identical "only serializable data crosses" semantics — a
    // handler that returns a class instance / function fails the same way
    // in tests as it would over the wire.
    return handler({ method, params: JSON.parse(JSON.stringify(params ?? null)) })
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
            `HubLink: 'task' handler already registered (only one allowed; replace by calling .on('task', ...) on a fresh link)`,
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

/**
 * Create a pair of symmetric in-process HubLinks. After this call,
 * `a.dispatch(task)` triggers any `'task'` handler registered on `b`
 * (and vice versa), and `a.publish(msg)` triggers all `'message'`
 * handlers on `b` (and vice versa).
 *
 * Typical wiring on each side:
 *
 *   const { a, b } = createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
 *
 *   // hubA side:
 *   a.on('task',    (task) => hubA.dispatch({ ...explode task... }).then(relabel))
 *   a.on('message', (msg)  => hubA.publish({ ...explode msg... }))
 *
 *   // hubB side:
 *   b.on('task',    (task) => hubB.dispatch({ ...explode task... }).then(relabel))
 *   b.on('message', (msg)  => hubB.publish({ ...explode msg... }))
 *
 * Then either side can `link.dispatch(task)` to reach the other.
 */
export function createInprocHubLinkPair(opts: {
  /**
   * id by which the `a` side identifies the peer (i.e. b's hub id from
   * a's point of view). Equivalently, `b`'s selfId.
   */
  aPeerId: ParticipantId
  /**
   * id by which the `b` side identifies the peer (i.e. a's hub id from
   * b's point of view). Equivalently, `a`'s selfId.
   */
  bPeerId: ParticipantId
}): { a: HubLink; b: HubLink } {
  // a's view: peer = aPeerId (B), self = bPeerId (A, as B addresses it)
  // b's view: peer = bPeerId (A), self = aPeerId (B, as A addresses it)
  const a = new InprocHubLinkImpl(opts.aPeerId, opts.bPeerId)
  const b = new InprocHubLinkImpl(opts.bPeerId, opts.aPeerId)
  a._attachPeer(b)
  b._attachPeer(a)
  return { a, b }
}
