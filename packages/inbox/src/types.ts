/**
 * Core types for `@aipehub/inbox` — the member task inbox.
 *
 * A workflow (or any agent) dispatches a Task to the `aipehub.human/v1`
 * capability with a {@link HumanTaskPayload}. The `HumanInboxParticipant`
 * broker records an {@link InboxItem} and suspends the task. The assigned
 * member sees the item in their `/me` inbox, submits an {@link InboxDecision},
 * and the task resumes with that decision as its output.
 *
 * This module is pure data + the {@link InboxStore} contract — zero runtime
 * deps. `FileInboxStore` is the default backend; a SQLite one can slot in
 * behind the same interface later.
 */

/** What kind of decision the human is being asked to make. */
export type InboxKind = 'approval' | 'choice' | 'edit'

/** One pickable option for a `kind: 'choice'` item. */
export interface InboxChoiceOption {
  value: string
  label?: string
}

/** Field hints for a `kind: 'edit'` item (the member edits free text). */
export interface InboxEditField {
  label?: string
  placeholder?: string
  defaultValue?: string
  /** Render a multi-line textarea instead of a single-line input. */
  multiline?: boolean
}

/**
 * The payload a workflow / agent dispatches to `aipehub.human/v1`. The
 * `human:` step sugar (workflow schema) and a raw dispatch both produce this
 * shape; the broker validates it in `handleTask`.
 */
export interface HumanTaskPayload {
  /** The v4 user id who must act. */
  assignee: string
  kind: InboxKind
  /** The question / instruction shown to the member. */
  prompt: string
  /** Short display title; falls back to `prompt`. */
  title?: string
  /** Required for `kind: 'choice'`. */
  options?: InboxChoiceOption[]
  /** Optional hints for `kind: 'edit'`. */
  editField?: InboxEditField
}

/**
 * The decision a member submits. The whole object becomes the human step's
 * output, so downstream `$step.output.*` refs are ergonomic
 * (`$gate.output.approved == true`, `$pick.output.value`, …). Carries its own
 * `kind` discriminant so a resolve handler can check it matches the item.
 */
export type InboxDecision =
  | { kind: 'approval'; approved: boolean; comment?: string }
  | { kind: 'choice'; value: string }
  | { kind: 'edit'; value: string }

/**
 * The immediate parent that dispatched the human task — the last ancestry
 * node. `by` is the dispatcher's participant id; for a workflow human step
 * it's `workflow:<id>`, which is what `resolve` resumes after the child.
 */
export interface InboxParent {
  taskId: string
  by: string
}

/**
 * One inbox item — persisted as `<spaceRoot>/inbox/<itemId>.json`. `itemId`
 * IS the suspended human Task's id, so `resolve` can look up the parked
 * `suspended_tasks` row by it directly.
 */
export interface InboxItem {
  /** Stable id = the suspended human Task's id. */
  itemId: string
  /** The user who must act. */
  userId: string
  kind: InboxKind
  prompt: string
  title?: string
  options?: InboxChoiceOption[]
  editField?: InboxEditField
  /** The dispatching parent, if any (absent on a context-free direct dispatch). */
  parent?: InboxParent
  /**
   * Whether the parent is a workflow runner (resolve resumes it after the
   * child), a bare agent (resolve only resumes the child — the agent already
   * got its `suspended` result and decides what to do), or none.
   */
  parentKind: 'workflow' | 'agent' | 'none'
  status: 'pending' | 'resolved'
  /** Set once resolved — the decision the member submitted. */
  decision?: InboxDecision
  createdAt: number
  resolvedAt?: number
}

/**
 * Persistence contract for inbox items. `FileInboxStore` is the default;
 * keep this narrow so a SQLite implementation can drop in unchanged.
 */
export interface InboxStore {
  /** Create the on-disk tree if missing. Idempotent. */
  ensureDirs(): void
  /** Persist (create or overwrite) one item, atomically. */
  write(item: InboxItem): Promise<void>
  /** Read one item by id; `null` if absent. */
  get(itemId: string): Promise<InboxItem | null>
  /** All `pending` items for a user, newest first. */
  listPending(userId: string): Promise<InboxItem[]>
  /**
   * Transition an item `pending → resolved` carrying the decision. This is the
   * race guard: it throws `InboxError('already_resolved')` when the item is not
   * pending (so a second `resolve` is rejected BEFORE any `hub.resumeTask`
   * runs), and `InboxError('not_found')` when the item is missing. Returns the
   * updated item.
   */
  markResolved(itemId: string, decision: InboxDecision, now?: number): Promise<InboxItem>
}

// --- Errors ----------------------------------------------------------------

export type InboxErrorCode =
  | 'not_found'
  | 'already_resolved'
  | 'forbidden'
  | 'invalid_decision'
  | 'invalid_payload'

/** Typed error so callers map `.code` to an HTTP status instead of parsing strings. */
export class InboxError extends Error {
  readonly code: InboxErrorCode
  constructor(code: InboxErrorCode, message: string) {
    super(message)
    this.name = 'InboxError'
    this.code = code
  }
}
