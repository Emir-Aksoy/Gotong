/**
 * HubAsParticipant — wrap a `Hub` so it can be `register()`-ed into another
 * `Hub` as a normal `Participant`.
 *
 * This is the type-system entry point for the hub-mesh architecture
 * (see `docs/zh/HUB-MESH.md` §2.1). Once a hub can act as a participant,
 * hubs can compose into arbitrary peer-to-peer topologies — no parent /
 * child, no root, just edges.
 *
 * Design notes:
 *
 * - `kind` is `'agent'` for wire compatibility. `ParticipantKind`
 *   intentionally stays `'agent' | 'human'`; downstream code can detect
 *   "this agent is really a hub" out of band (e.g. an `isHubAdapter`
 *   marker carried by the caller) without breaking the protocol.
 *
 * - `capabilities` is a live getter: the union of all currently-registered
 *   participants' capabilities in the inner hub. Recomputed on each read
 *   so dynamic registration is reflected immediately. Callers that cache
 *   the value should re-read.
 *
 * - `onTask` calls `inner.dispatch(...)` and relabels the result's
 *   `taskId` back to the OUTER task id so the outer hub can correlate.
 *   The inner hub generates its own task id internally; that id lives in
 *   the inner transcript only and never leaks out.
 *
 * - `onMessage` calls `inner.publish(...)` with the original `from`.
 *   There is no automatic identity translation in M1 — the original
 *   `from` may not exist in the inner hub, and that is fine for
 *   message-bus semantics (publish is fire-and-forget). Callers that
 *   need namespacing should wrap this adapter and translate.
 */

import type {
  Message,
  Participant,
  ParticipantId,
  Task,
  TaskId,
  TaskResult,
} from '../types.js'
import type { Hub } from '../hub.js'

export interface HubAsParticipantOptions {
  /**
   * The id by which the OUTER hub addresses this wrapper. It does NOT
   * have to match any internal identifier of the inner hub; it is the
   * "peer name" as seen from the outer hub.
   */
  id: ParticipantId
  /**
   * The inner hub being wrapped. Tasks and messages routed to this
   * adapter are re-dispatched / re-published into this hub.
   */
  inner: Hub
}

export class HubAsParticipant implements Participant {
  readonly kind = 'agent' as const
  readonly id: ParticipantId
  private readonly inner: Hub

  constructor(opts: HubAsParticipantOptions) {
    this.id = opts.id
    this.inner = opts.inner
  }

  /**
   * Union of capabilities of all participants currently registered in the
   * inner hub. Computed on each read.
   */
  get capabilities(): readonly string[] {
    const seen = new Set<string>()
    for (const p of this.inner.participants()) {
      for (const cap of p.capabilities) seen.add(cap)
    }
    return [...seen]
  }

  async onTask(task: Task): Promise<TaskResult> {
    const innerResult = await this.inner.dispatch({
      from: task.from,
      strategy: task.strategy,
      payload: task.payload,
      title: task.title,
      deadlineMs: task.deadlineMs,
      priority: task.priority,
      weight: task.weight,
      countContribution: task.countContribution,
    })
    return relabel(innerResult, task.id, this.id)
  }

  async onMessage(msg: Message): Promise<void> {
    this.inner.publish({
      from: msg.from,
      channel: msg.channel,
      body: msg.body,
    })
  }
}

/**
 * Rewrite outer-visible fields of a TaskResult so the outer hub sees the
 * wrapper as the responding peer:
 *
 *  - `taskId` → outer task id (the inner hub's internal id is discarded)
 *  - `by`     → wrapper id (only on `ok` / `failed` kinds; the other two
 *                kinds do not carry `by`). The inner participant's true
 *                id is preserved indirectly: outer transcript records
 *                the wrapper as responder; inner transcript records the
 *                real worker. Cross-correlation is `outer.taskId` ↔
 *                wrapper id ↔ inner transcript.
 *  - `failed.error` → prefixed with `[wrapper/inner-by]` so debuggers can
 *                still trace which inner participant blew up without
 *                having to open the inner transcript first.
 */
function relabel(r: TaskResult, taskId: TaskId, wrapperId: ParticipantId): TaskResult {
  switch (r.kind) {
    case 'ok':
      return { ...r, taskId, by: wrapperId }
    case 'failed':
      return {
        ...r,
        taskId,
        by: wrapperId,
        error: `[${wrapperId}/${r.by}] ${r.error}`,
      }
    case 'cancelled':
      return { ...r, taskId }
    case 'no_participant':
      return { ...r, taskId }
  }
}
