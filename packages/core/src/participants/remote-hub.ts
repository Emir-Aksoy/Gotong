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
  TaskResult,
} from '../types.js'

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
}

export class RemoteHubViaLink implements Participant {
  readonly kind = 'agent' as const
  readonly id: ParticipantId
  private readonly link: HubLink
  private _capabilities: readonly string[]

  constructor(opts: RemoteHubViaLinkOptions) {
    this.id = opts.id
    this.link = opts.link
    this._capabilities = opts.capabilities ?? []
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
    const result = await this.link.dispatch(task)
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
