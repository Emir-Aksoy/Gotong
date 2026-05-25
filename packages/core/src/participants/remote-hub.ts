/**
 * RemoteHubViaLink — wrap a `HubLink` as a `Participant`.
 *
 * This is the M4 building block: once a `HubLink` is established
 * (inproc or ws), wrapping it in `RemoteHubViaLink` lets the local
 * `Hub` see the remote peer as a regular `Participant`. The local
 * `Hub.dispatch` then routes capability-matched tasks to the wrapper,
 * which forwards them over the link.
 *
 * Difference from M1's `HubAsParticipant`:
 *
 *   - `HubAsParticipant.inner: Hub`          — direct in-memory reference
 *   - `RemoteHubViaLink.link:   HubLink`     — abstract transport (inproc / ws)
 *
 * Capabilities are declared at construction (or via `setCapabilities`).
 * MVP does not auto-negotiate them through the wire — see
 * `docs/zh/HUB-MESH.md` §2.3 (a future iteration can carry capabilities
 * inside the mesh HELLO frame).
 */

import type { HubLink } from '../hub-link.js'
import type {
  Message,
  Participant,
  ParticipantId,
  Task,
  TaskId,
  TaskOrigin,
  TaskResult,
} from '../types.js'

/**
 * FED-M2 — pluggable resolver that turns the local `task.from` into the
 * user-level fields of `TaskOrigin` (everything except `orgId`, which
 * `RemoteHubViaLink` knows itself from its `selfHubId` option).
 *
 * The host wires this from its identity store:
 *
 *   const resolveOrigin: OriginResolver = (from) => {
 *     const u = identity.getUserById(from)
 *     if (!u) return null
 *     const m = identity.getMembership(from)
 *     return { userId: u.id, userRole: m?.role, userEmail: u.email }
 *   }
 *
 * Returning `null` means "the local actor isn't a v4 user (e.g. v3
 * admin, system-internal)" — the wrapper will not stamp `origin` and
 * the receiver sees an unauthenticated forwarded task. Receiver-side
 * ACLs (FED-M3) can refuse no-origin federated tasks.
 *
 * Sync or async — both supported so a resolver that hits an SQL store
 * (which is sync in better-sqlite3) and one that calls out to an
 * external IdP (async) both fit.
 */
export type OriginResolver = (
  from: ParticipantId,
) =>
  | Omit<TaskOrigin, 'orgId'>
  | null
  | Promise<Omit<TaskOrigin, 'orgId'> | null>

export interface RemoteHubViaLinkOptions {
  /**
   * The id by which the LOCAL hub addresses this remote peer. Conventionally
   * equals `link.peerId`, but can be any stable string (the wire layer
   * uses `link.peerId` for handshaking; this id is what the local
   * `Hub.dispatch` will see as `result.by` on success).
   */
  id: ParticipantId
  /** Established (handshaken) HubLink to the remote peer. */
  link: HubLink
  /**
   * Capabilities the remote peer claims to offer. Local capability
   * dispatch will include this wrapper whenever the required set is a
   * subset of these. Defaults to `[]` (no capabilities — wrapper only
   * reachable via explicit dispatch).
   */
  capabilities?: readonly string[]
  /**
   * FED-M2 — the LOCAL hub's id, stamped as `origin.orgId` on
   * forwarded tasks. Required only if `originResolver` is set; the
   * field has no meaning without a way to fill in the rest of origin.
   *
   * Conventionally equals `link.selfId` (the way the peer addresses
   * us), but passed separately so callers can choose a different
   * organisation-public name if needed.
   */
  selfHubId?: ParticipantId
  /**
   * FED-M2 — resolve user-level origin fields from `task.from`. When
   * omitted, forwarded tasks do not carry an `origin` claim and the
   * receiving hub treats them as legacy / unauthenticated. When set
   * AND it returns a non-null result, the wrapper stamps `origin` on
   * the task before forwarding.
   *
   * Returning null is a legitimate "I cannot identify this actor"
   * answer — common for v3-admin dispatches or system-internal flows.
   * The receiver's ACL decides whether to accept such tasks.
   */
  originResolver?: OriginResolver
}

export class RemoteHubViaLink implements Participant {
  readonly kind = 'agent' as const
  readonly id: ParticipantId
  private readonly link: HubLink
  private _capabilities: readonly string[]
  /** FED-M2 — see `RemoteHubViaLinkOptions.selfHubId`. */
  private readonly selfHubId?: ParticipantId
  /** FED-M2 — see `RemoteHubViaLinkOptions.originResolver`. */
  private readonly originResolver?: OriginResolver

  constructor(opts: RemoteHubViaLinkOptions) {
    this.id = opts.id
    this.link = opts.link
    this._capabilities = opts.capabilities ?? []
    if (opts.selfHubId !== undefined) this.selfHubId = opts.selfHubId
    if (opts.originResolver !== undefined) this.originResolver = opts.originResolver
  }

  get capabilities(): readonly string[] {
    return this._capabilities
  }

  /**
   * Replace the wrapper's declared capabilities. Called by capability-
   * negotiation glue if/when the peer's manifest changes.
   */
  setCapabilities(caps: readonly string[]): void {
    this._capabilities = caps
  }

  async onTask(task: Task): Promise<TaskResult> {
    // FED-M2 — stamp `origin` before forwarding so the receiver knows
    // the actor's org + user. Three cases:
    //   1. Task already has `origin` (multi-hop forward) → pass through
    //      unchanged. We do NOT overwrite; the original sender is the
    //      authoritative source of the claim.
    //   2. We have a resolver AND it returns non-null → build
    //      `{ orgId: selfHubId, ...resolved }` and attach.
    //   3. Resolver returns null OR no resolver configured → forward
    //      as-is. Receiver's ACL decides whether unidentified
    //      federated tasks are acceptable.
    let forwardTask = task
    if (task.origin === undefined && this.originResolver && this.selfHubId) {
      try {
        const partial = await this.originResolver(task.from)
        if (partial !== null) {
          forwardTask = {
            ...task,
            origin: {
              orgId: this.selfHubId,
              ...partial,
            },
          }
        }
      } catch {
        // Resolver fault must not block the task; forward without origin.
        // Receiver-side ACL handles the unidentified case.
      }
    }
    const result = await this.link.dispatch(forwardTask)
    return relabel(result, task.id, this.id)
  }

  async onMessage(msg: Message): Promise<void> {
    this.link.publish(msg)
  }
}

/**
 * Outer-facing TaskResult shape: `taskId` matches the LOCAL hub's view
 * (defensive — the wire layer SHOULD have already preserved it but we
 * don't trust the peer to be a well-behaved Hub) and `by` is the
 * wrapper id (the peer hub identity, not the inner worker).
 */
function relabel(
  r: TaskResult,
  taskId: TaskId,
  wrapperId: ParticipantId,
): TaskResult {
  switch (r.kind) {
    case 'ok':
      return { ...r, taskId, by: wrapperId }
    case 'failed':
      return {
        ...r,
        taskId,
        by: wrapperId,
        error: `[${wrapperId}] ${r.error}`,
      }
    case 'cancelled':
      return { ...r, taskId }
    case 'no_participant':
      return { ...r, taskId }
  }
}
