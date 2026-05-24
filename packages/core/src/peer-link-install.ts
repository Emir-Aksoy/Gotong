/**
 * installPeerLink — wire a HubLink to a local Hub.
 *
 * Composing M1 (HubAsParticipant), M2/M3 (HubLink), and M4 (RemoteHub
 * ViaLink): this helper does the two pieces of glue needed to make a
 * link into a fully working mesh edge:
 *
 *   1. **Outbound** — register a `RemoteHubViaLink` wrapper into the
 *      local `Hub`, so the local hub's capability dispatch can reach
 *      the peer.
 *
 *   2. **Inbound** — register `'task'` and `'message'` handlers on the
 *      link, so tasks / messages the PEER sends here get re-dispatched
 *      / re-published into the LOCAL hub.
 *
 * Symmetry: call `installPeerLink` on BOTH sides of a link (each with
 * its own local hub). Either hub can then dispatch a capability-matched
 * task and have it routed to the other, transparently.
 */

import type { Hub } from './hub.js'
import type { HubLink } from './hub-link.js'
import { RemoteHubViaLink } from './participants/remote-hub.js'
import type { ParticipantId, Task, TaskId, TaskResult } from './types.js'

export interface InstallPeerLinkOptions {
  /** Local hub that will host the wrapper + receive inbound dispatches. */
  hub: Hub
  /** Handshaken HubLink to the peer hub. */
  link: HubLink
  /**
   * Capabilities the peer claims to offer. Local capability dispatch
   * sees the wrapper as covering these. Defaults to `[]`.
   */
  remoteCapabilities?: readonly string[]
  /**
   * Override the local participant id used for the wrapper. Defaults to
   * `link.peerId`. Useful when the same peer is connected via multiple
   * links and a unique local id is needed per link.
   */
  localWrapperId?: ParticipantId
  /**
   * Channel names the wrapper subscribes to on the LOCAL hub. Any local
   * `hub.publish` on these channels will fan out to the wrapper, which
   * forwards them over the link to the peer. Defaults to `[]` — no
   * channels are mirrored, so the peer never sees local messages
   * unless explicitly forwarded by other means.
   *
   * Common patterns:
   *  - omit / `[]`              — tasks only, no message bridge
   *  - `['announcements']`      — selective mirror of one channel
   *  - `hub.bus.listChannels()` — full mirror (heavy; rarely wanted)
   */
  mirrorChannels?: readonly string[]
  /**
   * After `pullNow` pulls new inbound entries, automatically send a
   * 'read' receipt for them so the peer's outbound advances to
   * `status='read'`. Default `true`. Set to `false` if the local UI
   * controls the "mark as read" moment (e.g. user must click a button).
   */
  autoMarkRead?: boolean
}

export interface InstalledPeerLink {
  /** The wrapper registered in the local hub. */
  remotePeer: RemoteHubViaLink
  /**
   * Manually trigger a feedback pull from the peer. The same pull is
   * fired automatically once during install (fire-and-forget) so
   * `pullNow()` is for re-syncing after long disconnects.
   *
   * Pulled entries land in `hub.inboundFeedback`. Returns the count
   * of NEW entries received this call (ignoring re-deliveries — same
   * entry id is upserted, not duplicated).
   */
  pullNow: () => Promise<number>
  /**
   * Mark inbound entries as 'read' on this side AND push a 'read'
   * receipt to the peer. The peer's outbound ledger will advance to
   * `status='read'` for these ids. (Idempotent — peer ignores
   * duplicates.)
   */
  markRead: (entryIds: readonly string[]) => Promise<void>
  /**
   * Reject inbound entries (Q4). Locally marks them rejected and
   * pushes a 'rejected' receipt to the peer. The peer's reputation
   * for us will roll back the contribution of these entries.
   */
  rejectFeedback: (entryIds: readonly string[], reason?: string) => Promise<void>
  /**
   * Tear down: unregister the wrapper from the local hub and close the
   * link. Inbound handlers are not explicitly detached (HubLink does
   * not expose `off`), but the closed status makes them no-ops.
   */
  uninstall: () => Promise<void>
}

export function installPeerLink(opts: InstallPeerLinkOptions): InstalledPeerLink {
  const wrapperId = opts.localWrapperId ?? opts.link.peerId

  // ─── Inbound: peer's dispatch reaches us, we re-dispatch into local hub ──
  opts.link.on('task', async (task: Task): Promise<TaskResult> => {
    const result = await opts.hub.dispatch({
      from: task.from,
      strategy: task.strategy,
      payload: task.payload,
      title: task.title,
      deadlineMs: task.deadlineMs,
      priority: task.priority,
      weight: task.weight,
      countContribution: task.countContribution,
    })
    // The local hub generated a fresh internal task.id; relabel back to
    // the peer's task.id so their pending-dispatch table can match.
    return relabelTaskId(result, task.id)
  })

  opts.link.on('message', (msg) => {
    opts.hub.publish({
      from: msg.from,
      channel: msg.channel,
      body: msg.body,
    })
  })

  // ─── Outbound: register wrapper into local hub so dispatch can reach peer ──
  const remotePeer = new RemoteHubViaLink({
    id: wrapperId,
    link: opts.link,
    capabilities: opts.remoteCapabilities,
  })
  opts.hub.register(remotePeer)

  // Optionally subscribe the wrapper to local channels so local
  // publishes get mirrored over the link.
  for (const ch of opts.mirrorChannels ?? []) {
    opts.hub.subscribe(wrapperId, ch)
  }

  // ─── Pull-on-attach (M6): respond to peer pulls + initiate one ourselves ──
  //
  // Peer asks us "give me your outbound entries that target hub `forPeerId`"
  // (where `forPeerId` is the peer's selfId from THEIR perspective, which
  // we receive as the argument). We return the pending ones and atomically
  // mark them delivered.
  opts.link.on('pull', async (forPeerId) => {
    const entries = opts.hub.feedback.query({
      toHub: forPeerId,
      status: 'pending',
    })
    const now = Date.now()
    for (const e of entries) {
      opts.hub.feedback.markDelivered(e.id, now)
    }
    return entries
  })

  // ─── Receipt (M7): peer tells us how it processed entries we sent it ──
  opts.link.on('receipt', ({ entryIds, kind, reason }) => {
    for (const id of entryIds) {
      if (kind === 'read') {
        opts.hub.feedback.markRead(id)
      } else if (kind === 'rejected') {
        opts.hub.feedback.markRejected(id, reason)
      }
    }
  })

  // pullNow: ask the peer for whatever they have about us, append to
  // our inbound ledger (idempotent — same entry id is upserted).
  const autoMarkRead = opts.autoMarkRead !== false // default true
  const pullNow = async (): Promise<number> => {
    let entries: readonly import('./feedback/types.js').FeedbackEntry[] = []
    try {
      entries = await opts.link.pullFeedbackFor()
    } catch {
      return 0
    }
    let newCount = 0
    const fresh: string[] = []
    for (const e of entries) {
      if (opts.hub.inboundFeedback.get(e.id)) continue // already have it
      // Append with the PEER's id/createdAt to preserve the original.
      // The ledger's appendEntry accepts id/now overrides.
      const { id, createdAt, deliveredAt, readAt, rejectedAt, rejectionReason, ...draft } = e
      opts.hub.inboundFeedback.appendEntry(draft, { id, now: createdAt })
      // Replay status from the original entry — we keep these markers
      // so the recipient can see "the evaluator already saw I delivered".
      if (deliveredAt !== undefined) opts.hub.inboundFeedback.markDelivered(id, deliveredAt)
      if (readAt !== undefined) opts.hub.inboundFeedback.markRead(id, readAt)
      if (rejectedAt !== undefined)
        opts.hub.inboundFeedback.markRejected(id, rejectionReason, rejectedAt)
      newCount++
      fresh.push(id)
    }
    if (autoMarkRead && fresh.length > 0) {
      // Auto-confirm fresh entries as 'read' to the peer (M7).
      // Fire-and-forget; receipts are best-effort.
      void opts.link
        .pushReadReceipt({ entryIds: fresh, kind: 'read' })
        .catch(() => {
          /* swallow */
        })
      const now = Date.now()
      for (const id of fresh) opts.hub.inboundFeedback.markRead(id, now)
    }
    return newCount
  }

  // Fire the first pull asynchronously — install() returns synchronously
  // and the caller can `await pullNow()` later if they want to know the count.
  void pullNow().catch(() => {
    /* initial pull failure is non-fatal; caller can retry via pullNow */
  })

  const markRead = async (entryIds: readonly string[]): Promise<void> => {
    if (entryIds.length === 0) return
    const now = Date.now()
    for (const id of entryIds) opts.hub.inboundFeedback.markRead(id, now)
    await opts.link
      .pushReadReceipt({ entryIds, kind: 'read' })
      .catch(() => {
        /* receipts best-effort */
      })
  }

  const rejectFeedback = async (
    entryIds: readonly string[],
    reason?: string,
  ): Promise<void> => {
    if (entryIds.length === 0) return
    const now = Date.now()
    for (const id of entryIds) opts.hub.inboundFeedback.markRejected(id, reason, now)
    await opts.link
      .pushReadReceipt({ entryIds, kind: 'rejected', reason })
      .catch(() => {
        /* swallow */
      })
  }

  return {
    remotePeer,
    pullNow,
    markRead,
    rejectFeedback,
    uninstall: async () => {
      opts.hub.unregister(wrapperId)
      await opts.link.close()
    },
  }
}

function relabelTaskId(r: TaskResult, taskId: TaskId): TaskResult {
  switch (r.kind) {
    case 'ok':
      return { ...r, taskId }
    case 'failed':
      return { ...r, taskId }
    case 'cancelled':
      return { ...r, taskId }
    case 'no_participant':
      return { ...r, taskId }
  }
}
