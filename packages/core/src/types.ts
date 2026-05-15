/**
 * Core wire types. Everything else in AipeHub speaks these.
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

export interface Task {
  id: TaskId
  from: ParticipantId
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
  createdAt: number
}

export type TaskResult =
  | { kind: 'ok'; taskId: TaskId; by: ParticipantId; output: unknown; ts: number }
  | { kind: 'failed'; taskId: TaskId; by: ParticipantId; error: string; ts: number }
  | { kind: 'cancelled'; taskId: TaskId; reason: string; ts: number }
  | { kind: 'no_participant'; taskId: TaskId; reason: string; ts: number }

// --- Participant -----------------------------------------------------------

export interface Participant {
  readonly id: ParticipantId
  readonly kind: ParticipantKind
  readonly capabilities: readonly string[]

  onMessage?(msg: Message): void | Promise<void>
  onTask?(task: Task): Promise<TaskResult>
  onTaskCancelled?(taskId: TaskId, reason: string): void | Promise<void>
  onShutdown?(): void | Promise<void>
}

// --- Admission gating (v1.1) -----------------------------------------------

/**
 * Coarse-grained mirror of `@aipehub/protocol`'s `ServiceUseDecl`. Carried
 * inside `PendingApplication` so admins can see what services a remote
 * agent is requesting **before** they approve the application.
 *
 * Defined here (not imported from `@aipehub/protocol`) because `core` does
 * not depend on `protocol` — keeping the dependency arrow one-directional
 * (`protocol → core` for `ParticipantId`, not the reverse). Equivalent
 * shape verified by the transport-ws → core adapter at the HELLO seam.
 *
 * Owner.id `'self'` is the agent shorthand; `'*'` is a wildcard. The
 * admin UI is free to render either verbatim.
 */
export interface ApplicationServiceDecl {
  type: string
  impl: string
  owner: { kind: string; id: string }
  /** Optional config blob; admins may inspect it but the field is opaque. */
  config?: unknown
}

/**
 * One client's bid to join the hub. A WebSocket HELLO becomes a
 * PendingApplication when the transport is configured with
 * `gating: 'admin-approval'`. Admin tools resolve it via
 * `hub.approveApplication(id)` / `hub.rejectApplication(id, reason)`.
 *
 * A single application can carry multiple agents (HELLO.agents is a list);
 * admin decisions are all-or-nothing on the application as a unit.
 *
 * `services` (v1.1) lists the Hub Services this application wants to call
 * over WebSocket. Empty / omitted means the client either won't use
 * services at all or is a v1.0 client predating the feature. Admins
 * SHOULD inspect this list before approving — it's an explicit ACL.
 */
export interface PendingApplication {
  id: string
  agents: ReadonlyArray<{ id: ParticipantId; capabilities: readonly string[] }>
  meta?: Readonly<Record<string, unknown>>
  pendingSince: number
  services?: readonly ApplicationServiceDecl[]
}

export type AdmissionDecision =
  | { approved: true; by?: ParticipantId }
  | { approved: false; by?: ParticipantId; reason: string }

// --- Evaluation (v1.1) -----------------------------------------------------

/**
 * A reviewer's verdict on a completed task. Append-only — once written,
 * lives in the transcript forever. `rating` is optional. Since v2.1 the
 * contribution system treats `rating` as a 0–5 score with one decimal of
 * precision; the Hub clamps and rounds incoming values in `evaluate(...)`
 * so the persisted entry is well-formed. Earlier integer-only ratings
 * (1–5 stars) still round-trip unchanged. `comment` is free text.
 *
 * Multiple evaluations against the same task are allowed and all live in
 * the transcript; the **latest rated one wins** for purposes of the
 * derived `TaskView.effectiveRating` / `.contribution` and the leaderboard.
 */
export interface Evaluation {
  taskId: TaskId
  by: ParticipantId
  rating?: number
  comment?: string
}

// --- Contribution / leaderboard (v2.1) ------------------------------------

/**
 * Per-participant aggregate of "how much they got done" within a time
 * window. Derived purely from the transcript by `Hub.leaderboard(...)`;
 * no extra state is stored.
 *
 * Counted: tasks with `status === 'done'` whose `completedAt` falls in
 * the window AND that have at least one rated evaluation. Unrated and
 * failed/cancelled tasks are ignored for `totalContribution`; unrated
 * ones still bump `unratedTaskCount` on the parent `Leaderboard` so the
 * UI can surface "you owe N reviews".
 *
 * `byCapability` slices the contribution by the capability(ies) that
 * routed each task — handy for spotting "alice is great at review but
 * not at draft". `explicit` dispatches contribute under no capability.
 */
export interface ContributionRow {
  participantId: ParticipantId
  taskCount: number
  /** Sum of weights of all rated, completed tasks credited to this id. */
  totalWeight: number
  /** Sum of (weight × rating) across all rated, completed tasks. */
  totalContribution: number
  /** Mean rating across `taskCount` rated tasks; 0 when taskCount===0. */
  averageRating: number
  /** Most recent `completedAt` we've credited (ms). */
  lastActivityTs: number
  byCapability: Record<string, { count: number; contribution: number }>
}

/**
 * Time-bounded view of {@link ContributionRow}[], sorted by
 * `totalContribution` descending. Returned by `Hub.leaderboard({ from, to })`
 * and surfaced verbatim at `/api/leaderboard` (admins **and** workers see
 * it — visibility is the point: "all contributions are seen by all").
 */
export interface Leaderboard {
  /** Window start, inclusive (ms since epoch). */
  from: number
  /** Window end, exclusive (ms since epoch). */
  to: number
  rows: ContributionRow[]
  /** Completed tasks in the window whose latest evaluation has no rating. */
  unratedTaskCount: number
  /** Total completed tasks counted in the window (rated + unrated). */
  totalTaskCount: number
}

// --- Transcript ------------------------------------------------------------

export type TranscriptEntry =
  | { seq: number; ts: number; kind: 'message'; data: Message }
  | { seq: number; ts: number; kind: 'task'; data: Task }
  | { seq: number; ts: number; kind: 'task_result'; data: TaskResult }
  | {
      seq: number
      ts: number
      kind: 'participant_joined'
      data: { id: ParticipantId; participantKind: ParticipantKind; capabilities: readonly string[] }
    }
  | { seq: number; ts: number; kind: 'participant_left'; data: { id: ParticipantId } }
  | {
      seq: number
      ts: number
      kind: 'agent_pending'
      data: PendingApplication
    }
  | {
      seq: number
      ts: number
      kind: 'agent_approved'
      data: { applicationId: string; agentIds: readonly ParticipantId[]; by?: ParticipantId }
    }
  | {
      seq: number
      ts: number
      kind: 'agent_rejected'
      data: { applicationId: string; agentIds: readonly ParticipantId[]; by?: ParticipantId; reason: string }
    }
  | { seq: number; ts: number; kind: 'evaluation'; data: Evaluation }
  /**
   * Hub Services soft-delete notification (v2.2). Plugins publish
   * this through `HubSurfaceForPlugins.publishEvent` after `softDelete`
   * resolves; the admin SSE stream relays it so the UI can show a
   * "moved to trash; auto-deletes in 30 days" toast in real time. The
   * `data.ref` is the same TrashRef the plugin returned to the caller;
   * `data.type` + `data.impl` repeat the plugin identity at the top
   * level so SSE consumers can filter without parsing TrashRef.
   */
  | {
      seq: number
      ts: number
      kind: 'service_trashed'
      data: {
        type: string
        impl: string
        ownerKind: string
        ownerId: string
        ref: {
          id: string
          deletedAt: number
          expiresAt: number
          reason?: string
        }
      }
    }
  /**
   * Hub Services lifecycle sweep notification (v2.2). Emitted when the
   * background sweeper hard-deletes an expired trash entry. UI consumers
   * use this to refresh the trash list / show "auto-purged after 30 days".
   */
  | {
      seq: number
      ts: number
      kind: 'service_purged'
      data: {
        type: string
        impl: string
        trashId: string
      }
    }
  /**
   * SERVICE_CALL audit event (v1.1 services-over-ws). Appended by the
   * transport-ws session AFTER each SERVICE_CALL is resolved (either
   * `ok:true` or any error code). The admin UI surfaces these as a
   * timeline so operators can see which agent touched which service +
   * any forbidden / failed calls.
   *
   * `args` is intentionally NOT persisted — they're free-form,
   * potentially large (e.g. SQL blobs), and may contain user data the
   * admin shouldn't see. Only the method + service identity + outcome.
   *
   * `from` is the calling agent's id (mirrors `SERVICE_CALL.from`).
   * `outcome` is `'ok'` when the call succeeded; otherwise the
   * `ServiceErrorCode` from SERVICE_RESULT.error.code.
   */
  | {
      seq: number
      ts: number
      kind: 'service_call'
      data: {
        from: ParticipantId
        type: string
        impl: string
        ownerKind: string
        ownerId: string
        method: string
        outcome: 'ok' | string
        durationMs: number
      }
    }

// --- Event stream (for observers / web UI) ---------------------------------

export type HubEvent = TranscriptEntry
