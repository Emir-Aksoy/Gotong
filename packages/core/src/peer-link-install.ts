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
import { RemoteHubViaLink, type OriginResolver } from './participants/remote-hub.js'
import type {
  DispatchStrategy,
  ParticipantId,
  Task,
  TaskId,
  TaskResult,
} from './types.js'

/**
 * FED-M3 — receiver-side ACL for federated tasks.
 *
 * Three independent gates; all configured ones must pass:
 *
 *   1. `requireOrigin` — refuse tasks without a federated origin
 *      claim. Useful when the peer is expected to always stamp origin
 *      (i.e. it has an `originResolver`); a missing origin then
 *      signals a misconfigured or downgrade-attack peer.
 *
 *   2. `requireOriginRole` — restrict to specific roles on the
 *      sending hub (e.g. `['owner', 'admin']`). Requires `origin` to
 *      be present (so paired with `requireOrigin: true` in practice;
 *      a task with no origin has no role to check and is denied by
 *      this gate unless `requireOrigin` is false, in which case the
 *      gate is effectively skipped for unidentified tasks).
 *
 *   3. `capabilities` — capability allowlist. The task's strategy
 *      must declare capabilities (so `explicit` strategy is rejected;
 *      cross-org dispatch by explicit participant id is rarely sane
 *      anyway), AND every required capability must be in the list.
 *      `broadcast` with no capabilities filter is denied too (full-
 *      mesh broadcast across orgs is almost certainly a mistake).
 *
 * Absent fields mean "this gate skipped." A `PeerLinkAcl` with all
 * three undefined is equivalent to "no ACL configured" and accepts
 * everything (legacy behavior).
 */
export interface PeerLinkAcl {
  /** Capability allowlist; undefined = no check. Empty array = deny all. */
  capabilities?: readonly string[]
  /** Refuse tasks without an `origin` claim. Default false (accept). */
  requireOrigin?: boolean
  /** Restrict to these `origin.userRole` values. Empty/undefined = no check. */
  requireOriginRole?: readonly string[]
}

/** Internal — verdict on a single inbound task. */
function evaluateAcl(
  task: Task,
  acl: PeerLinkAcl,
): { ok: true } | { ok: false; reason: string } {
  if (acl.requireOrigin && !task.origin) {
    return { ok: false, reason: 'origin_required' }
  }
  if (acl.requireOriginRole && acl.requireOriginRole.length > 0) {
    const role = task.origin?.userRole
    if (!role || !acl.requireOriginRole.includes(role)) {
      return { ok: false, reason: 'origin_role_denied' }
    }
  }
  if (acl.capabilities !== undefined) {
    const required = extractRequiredCapabilities(task.strategy)
    if (required === null) {
      return { ok: false, reason: 'strategy_not_allowlisted' }
    }
    const allowed = new Set(acl.capabilities)
    for (const c of required) {
      if (!allowed.has(c)) {
        return { ok: false, reason: `capability_denied:${c}` }
      }
    }
  }
  return { ok: true }
}

function extractRequiredCapabilities(
  strategy: DispatchStrategy,
): readonly string[] | null {
  switch (strategy.kind) {
    case 'capability':
      return strategy.capabilities
    case 'broadcast':
      // A broadcast with no capability filter is "everyone you've got."
      // We treat that as un-allowlistable across orgs — peer must
      // narrow the broadcast to specific capabilities to pass ACL.
      return strategy.capabilities ?? null
    case 'explicit':
      // Cross-org dispatch to a specific local participant id requires
      // the sender to know our internal naming, which leaks structure.
      // Denied at the ACL level. (Callers wanting this can omit ACL.)
      return null
  }
}

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
  /**
   * FED-M2 — our hub id, stamped on outbound tasks as `origin.orgId`.
   * Required if `originResolver` is set; otherwise unused. Convention:
   * pass `link.selfId` (the id by which the peer addresses us).
   */
  selfHubId?: ParticipantId
  /**
   * FED-M2 — turn the LOCAL actor (`task.from`) into the user-level
   * fields of `TaskOrigin` when forwarding outbound tasks. See
   * `OriginResolver`. Without this, outbound tasks carry no `origin`
   * and the receiving hub treats them as unidentified.
   */
  originResolver?: OriginResolver
  /**
   * FED-M3 — receiver-side ACL for inbound tasks. When set, every
   * inbound task is checked against the policy BEFORE being dispatched
   * into the local hub; refusals return `failed` with an error string
   * `cross_org_acl_denied (<reason>)` and never reach a participant.
   * When unset, all inbound tasks pass through (legacy behavior).
   *
   * See `PeerLinkAcl` for the policy fields.
   */
  acl?: PeerLinkAcl
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
  // FED-M3 — receiver-side ACL gate. Checked BEFORE re-dispatch so a
  // denied task never reaches a participant, never writes a transcript
  // row in the local hub, and never spends scheduler time. `by` on the
  // refusal result is our `selfHubId` if provided (== our orgId from
  // the peer's POV) so the sender's logs identify the refuser cleanly;
  // falls back to the wrapper id otherwise.
  const aclRefusalBy: ParticipantId = opts.selfHubId ?? wrapperId
  opts.link.on('task', async (task: Task): Promise<TaskResult> => {
    if (opts.acl) {
      const verdict = evaluateAcl(task, opts.acl)
      if (!verdict.ok) {
        return {
          kind: 'failed',
          taskId: task.id,
          by: aclRefusalBy,
          error: `cross_org_acl_denied (${verdict.reason})`,
          ts: Date.now(),
        }
      }
    }
    const result = await opts.hub.dispatch({
      from: task.from,
      strategy: task.strategy,
      payload: task.payload,
      title: task.title,
      deadlineMs: task.deadlineMs,
      priority: task.priority,
      weight: task.weight,
      countContribution: task.countContribution,
      // FED-M2: preserve federated origin so receiver-side ACL +
      // audit log can see who-from-which-org originated this task.
      ...(task.origin ? { origin: task.origin } : {}),
      // Phase 10 M3: preserve dispatch ancestry across the hub
      // boundary so depth + cycle gates still bound the chain. A
      // task that's already 4 hops deep on the sender's side stays
      // 4 hops deep on ours — the receiver's MAX_DISPATCH_DEPTH gate
      // can then refuse a 5th hop locally instead of letting the
      // counter reset at each boundary.
      ...(task.ancestry && task.ancestry.length > 0
        ? { ancestry: task.ancestry }
        : {}),
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
    // FED-M2: pass through origin-stamping config so outbound tasks
    // carry the actor's org+user when leaving this hub.
    ...(opts.selfHubId !== undefined ? { selfHubId: opts.selfHubId } : {}),
    ...(opts.originResolver !== undefined ? { originResolver: opts.originResolver } : {}),
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
    // Phase 11 M2 — a peer-link inbound that came back suspended
    // is relayed with the same kind. The remote side persisted the
    // park in *its* identity store; this side just surfaces the
    // status to the caller. The eventual resume produces a fresh
    // task_result frame on the wire.
    case 'suspended':
      return { ...r, taskId }
  }
}
