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
 * One client's bid to join the hub. A WebSocket HELLO becomes a
 * PendingApplication when the transport is configured with
 * `gating: 'admin-approval'`. Admin tools resolve it via
 * `hub.approveApplication(id)` / `hub.rejectApplication(id, reason)`.
 *
 * A single application can carry multiple agents (HELLO.agents is a list);
 * admin decisions are all-or-nothing on the application as a unit.
 */
export interface PendingApplication {
  id: string
  agents: ReadonlyArray<{ id: ParticipantId; capabilities: readonly string[] }>
  meta?: Readonly<Record<string, unknown>>
  pendingSince: number
}

export type AdmissionDecision =
  | { approved: true; by?: ParticipantId }
  | { approved: false; by?: ParticipantId; reason: string }

// --- Evaluation (v1.1) -----------------------------------------------------

/**
 * A reviewer's verdict on a completed task. Append-only — once written,
 * lives in the transcript forever. `rating` is optional (any agreed scale,
 * e.g. 1–5 stars); `comment` is free text.
 */
export interface Evaluation {
  taskId: TaskId
  by: ParticipantId
  rating?: number
  comment?: string
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

// --- Event stream (for observers / web UI) ---------------------------------

export type HubEvent = TranscriptEntry
