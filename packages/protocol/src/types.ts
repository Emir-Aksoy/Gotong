/**
 * Wire-level types — the type contract `@aipehub/protocol` speaks. Lives
 * here (not in `@aipehub/core`) so a lightweight third-party SDK can speak
 * the protocol without pulling in core's runtime (Hub, Scheduler, Storage).
 *
 * `@aipehub/core` re-exports these so existing `from '@aipehub/core'`
 * imports keep working — the move is invisible to in-tree consumers.
 */

export type ParticipantId = string
export type ChannelId = string
export type TaskId = string
export type MessageId = string

export type ParticipantKind = 'agent' | 'human'

// --- Message ---------------------------------------------------------------

export interface Message {
  id: MessageId
  channel: ChannelId
  from: ParticipantId
  body: unknown
  ts: number
}

// --- Task & TaskResult -----------------------------------------------------

export type DispatchStrategy =
  | { kind: 'explicit'; to: ParticipantId }
  | { kind: 'capability'; capabilities: string[] }
  | { kind: 'broadcast'; capabilities?: string[] }

/**
 * FED-M2 — federated origin claim attached to tasks that crossed a
 * peer-hub boundary. Filled in by the sending hub (`RemoteHubViaLink`)
 * just before forwarding via `link.dispatch(task)`. The receiving hub
 * trusts the field because the link itself was mutually authenticated
 * at HELLO time (FED-M1) — i.e. "the peer wouldn't have made it past
 * the handshake if we didn't trust it to honestly self-identify the
 * actor on its side."
 *
 * Local-only tasks (originator is on the same hub as the dispatcher)
 * leave `origin` unset; surfaces that need to distinguish "local"
 * from "federated" use `origin === undefined` as the test.
 *
 * Receiver-side ACLs (FED-M3) match against fields of this object;
 * audit log writes (FED-M4) lift these fields into `metadata.origin`
 * for cross-hub traceability.
 */
export interface TaskOrigin {
  /** Sending hub id (== the peer's `selfId` from the local link's POV). */
  orgId: string
  /** The acting user id on the sending hub. */
  userId: string
  /** Optional v4 role of the acting user on the sending hub. */
  userRole?: string
  /**
   * Optional email of the acting user on the sending hub. Useful for
   * audit-log readability; the receiving hub MUST NOT use this as an
   * authoritative identifier (the sending hub's identity store may
   * mutate emails; orgId+userId is the stable key).
   */
  userEmail?: string
}

/**
 * Phase 10 M2 — one entry per ancestor in a dispatch chain.
 *
 * When an agent's tool-use loop calls `Hub.dispatch` (the Phase 10
 * `DispatchToolset` path), the new task carries an `ancestry` array
 * whose last element is the immediate parent task and whose first
 * element is the root dispatch. Tasks dispatched directly by a user /
 * admin / script (i.e. the root) leave `ancestry` unset (empty arrays
 * are normalised away to keep the transcript shape stable for legacy
 * single-dispatch runs).
 *
 * The hub uses the chain for two gates:
 *   1. **Depth** — `ancestry.length >= MAX_DISPATCH_DEPTH` → reject
 *      with `error: 'dispatch_depth_exceeded'` before the scheduler
 *      ever sees the task.
 *   2. **Cycle** — an `explicit` strategy whose target already appears
 *      as some ancestor's `by` field is rejected with
 *      `error: 'dispatch_cycle'`. Catches A → B → A patterns.
 *
 * `by` (not `from`) is what cycle detection compares because `by` is
 * the agent that actually *executed* that ancestor's work — that's
 * the loop participant. `from` is just the dispatcher (the one who
 * issued `hub.dispatch`), and a recursing agent calling itself via
 * tool-use is allowed (it'll terminate via the depth gate).
 *
 * Capability strategies are not pre-checked because the matcher
 * hasn't picked a participant yet; in practice a capability cycle
 * still terminates because each round eats one ancestry slot.
 */
export interface AncestryNode {
  /** The ancestor task's id. */
  taskId: TaskId
  /** The participant that **executed** the ancestor task (== that task's TaskResult.by). */
  by: ParticipantId
}

export interface Task {
  id: TaskId
  from: ParticipantId
  /**
   * FED-M2 — federated origin claim. Present when the task crossed a
   * peer-hub boundary; absent for local-only tasks. See `TaskOrigin`.
   */
  origin?: TaskOrigin
  /**
   * Phase 10 M2 — dispatch ancestry chain (root → immediate parent).
   * Present only for tasks dispatched by another agent's tool-use loop
   * (i.e. via `DispatchToolset` → `Hub.dispatch({ ..., ancestry: [...] })`).
   * Absent for root tasks dispatched directly by a user/admin/script.
   */
  ancestry?: readonly AncestryNode[]
  strategy: DispatchStrategy
  payload: unknown
  title?: string
  /**
   * Wall-clock deadline (ms since epoch). If set and `Date.now() > deadlineMs`
   * when the scheduler is about to dispatch (or dequeue) the task, the task
   * resolves with a `failed` TaskResult and `error: 'deadline_expired'`
   * without ever reaching a participant.
   */
  deadlineMs?: number
  /**
   * Relative ordering hint for priority-aware schedulers. Higher = more
   * urgent. Default is 0. Ignored by `DefaultScheduler`; honored by
   * `PriorityQueueScheduler` (v0.7).
   */
  priority?: number
  /**
   * Contribution-system **weight** for the task — "how much does getting
   * this done count for". A floating-point number in [0.1, 10.0] rounded
   * to one decimal place; defaults to 1.0 when omitted so legacy callers
   * keep behaving as if every task were unit-weight.
   *
   * Combined with a reviewer's `Evaluation.rating` (0–5) it yields the
   * task's **contribution score**: `contribution = weight × rating`. The
   * score surfaces on `TaskView` and aggregates inside `Hub.leaderboard()`.
   *
   * The Hub clamps and rounds the incoming value in `dispatch()` so the
   * persisted task is always well-formed; the field on `Task` is therefore
   * already-sanitised.
   */
  weight?: number
  /**
   * **Contribution opt-out for this specific task.** When `false`, the
   * leaderboard pretends the task doesn't exist — neither its rated
   * contribution nor its unrated-bookkeeping enters the totals. `true`
   * and `undefined` both mean "count it normally" so legacy and default
   * callers see the unchanged v2.1 behaviour.
   *
   * The rule baked into the system: the **publisher's** preference
   * (stored on `AdminRecord.contributionOptOut` / `WorkerRecord.
   * contributionOptOut`) controls **their own** dispatches. The Web
   * layer reads the logged-in publisher's preference and stamps this
   * field on outgoing tasks accordingly. The handler's preference is
   * *not* consulted — opting out of "I publish into the score" must not
   * be a way to also opt out of "I appear when I do work."
   */
  countContribution?: boolean
  /**
   * Phase 19 P4-M4 — data classification tags the task's payload carries
   * (e.g. 'pii', 'financial', 'public'). The outbound per-link data-class
   * allowlist refuses a task whose classes aren't all permitted by a peer's
   * trust contract, before it crosses the org boundary. Absent / empty = the
   * task declares no classes (unrestricted).
   */
  dataClasses?: readonly string[]
  createdAt: number
}

export type TaskResult =
  | { kind: 'ok'; taskId: TaskId; by: ParticipantId; output: unknown; ts: number }
  | { kind: 'failed'; taskId: TaskId; by: ParticipantId; error: string; ts: number }
  | { kind: 'cancelled'; taskId: TaskId; reason: string; ts: number }
  | { kind: 'no_participant'; taskId: TaskId; reason: string; ts: number }
  /**
   * Phase 11 M2 — participant threw `SuspendTaskError`. The scheduler
   * persisted (`resumeAt`, `state`) via its `notifySuspend` callback and
   * is parking the task; the resume sweep (M3) will re-dispatch the same
   * task to the same participant via `onResume(task, state)` after
   * `resumeAt`. Distinct from `failed` so callers/transcript can show a
   * waiting state and the task isn't counted as terminated.
   */
  | { kind: 'suspended'; taskId: TaskId; by: ParticipantId; resumeAt: number; ts: number }
