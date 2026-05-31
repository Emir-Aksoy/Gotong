/**
 * Workflow lifecycle + revision model (Phase 15).
 *
 * Two orthogonal concerns live here:
 *
 *   1. A **lifecycle state machine** — a workflow moves through
 *      draft → review → published → deprecated → archived. Only the pure
 *      `transition()` function and its legality table live in this module;
 *      persistence is the host service's job (see `@aipehub/host`
 *      workflow-versioning).
 *
 *   2. **Immutable revisions** — every time a workflow's content is locked
 *      (on import, publish-of-an-edit, or rollback) a new numbered revision
 *      is appended. A run binds to the revision number it started under
 *      (`RunState.definitionRevision`), so re-publishing never drifts an
 *      in-flight run onto new step logic. The revision *snapshots* are
 *      stored by `RevisionStore` (M2); this module only declares their shape.
 *
 * WHY the split: `transition()` is a pure function over `record.state` so it
 * unit-tests with hand-built records and no I/O. Revision-number bookkeeping
 * (allocating the next number, hashing content, writing the snapshot) needs
 * the store and is done one layer up — it sets `currentRevision` /
 * `headRevision` / `revisions[]` *after* this function flips the state.
 *
 * This module has zero dependencies on the Hub or any store — only on the
 * definition type. Keep it that way.
 */

import type { WorkflowDefinition } from './types.js'

// --- Lifecycle states + actions --------------------------------------------

/**
 * The lifecycle state of a workflow.
 *
 *   - `draft`      — author's editable working copy. NOT registered on the
 *                    Hub (un-runnable). The head revision is the draft content.
 *   - `review`     — frozen candidate awaiting approval. Still not live.
 *   - `published`  — live: the trigger capability is registered and routes to
 *                    `currentRevision`. Exactly one revision is "current".
 *   - `deprecated` — soft sunset: still live (in-flight work + admin re-runs
 *                    keep working) but hidden from the member `/me` surface
 *                    and badged in admin. Re-publishing un-deprecates it.
 *   - `archived`   — tombstoned: unregistered from the Hub, terminal. Revision
 *                    history is retained so any historical run can still
 *                    resolve the revision it ran under.
 */
export type LifecycleState =
  | 'draft'
  | 'review'
  | 'published'
  | 'deprecated'
  | 'archived'

/**
 * An action that drives a {@link LifecycleState} transition. See
 * {@link transition} for the legality table.
 */
export type LifecycleAction =
  | 'submitReview'
  | 'publish'
  | 'backToDraft'
  | 'deprecate'
  | 'rollback'
  | 'archive'

/** How a revision came to exist — recorded on the revision metadata. */
export type RevisionOrigin = 'import' | 'saveDraft' | 'publish' | 'rollback'

// --- Revision shapes -------------------------------------------------------

/**
 * Lightweight metadata for one revision. Carried inline on the
 * {@link LifecycleRecord} so the admin UI can list revisions without reading
 * every snapshot file. The full definition lives in {@link WorkflowRevision}.
 */
export interface RevisionMeta {
  /** Monotonic, 1-based, user-facing revision number. */
  revision: number
  /** sha256 of the canonical-JSON of the definition — integrity + dedupe. */
  contentHash: string
  /** When this revision was locked (ms since epoch). */
  createdAt: number
  /** Who locked it (a user/participant id), if known. */
  createdBy?: string
  /** Why it was locked. */
  origin: RevisionOrigin
  /** For `origin: 'rollback'` — the earlier revision whose content this clones. */
  rolledBackFrom?: number
}

/**
 * An immutable revision snapshot: the {@link RevisionMeta} plus the frozen
 * {@link WorkflowDefinition} as it was at that revision. This is what
 * `RevisionStore` (M2) persists, write-once, at
 * `workflows/revisions/<id>/<rev>.json`.
 */
export interface WorkflowRevision extends RevisionMeta {
  definition: WorkflowDefinition
}

// --- The per-workflow lifecycle record -------------------------------------

/** One audit entry appended to {@link LifecycleRecord.history} per transition. */
export interface TransitionLog {
  at: number
  action: LifecycleAction
  from: LifecycleState
  to: LifecycleState
  by?: string
  /** For `action: 'rollback'` — the revision the caller asked to roll back to. */
  targetRevision?: number
}

/**
 * The mutable, per-workflow lifecycle record. One per workflow id, persisted
 * by `LifecycleStore` (M2) at `workflows/lifecycle/<id>.json` and rewritten
 * atomically on every transition.
 */
export interface LifecycleRecord {
  workflowId: string
  state: LifecycleState
  /**
   * The revision a NEW run binds to (i.e. the live, published content).
   * Absent only for a workflow that has never been published (a pure draft).
   */
  currentRevision?: number
  /** The highest revision number allocated so far. Always ≥ 1 once any exists. */
  headRevision: number
  /**
   * The trigger capability — FROZEN across revisions. Changing it means a
   * different workflow (import a new id instead); the host enforces this so a
   * single runner stays registered on a stable capability across publishes.
   */
  triggerCapability: string
  /** Metadata for every revision ever allocated, ascending by `revision`. */
  revisions: RevisionMeta[]
  /** Append-only transition audit log. */
  history: TransitionLog[]
  updatedAt: number
}

// --- Errors ----------------------------------------------------------------

/**
 * Thrown when a lifecycle transition is illegal or malformed. `code` is a
 * stable machine-readable string the HTTP layer maps to a status (e.g.
 * `illegal_transition` → 409).
 */
export class WorkflowLifecycleError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'WorkflowLifecycleError'
    this.code = code
  }
}

/**
 * Thrown when a revision can't be read/resolved or a write-once invariant is
 * violated (e.g. a run references a revision that's gone, or a store tries to
 * overwrite an existing `<rev>.json`).
 */
export class WorkflowRevisionError extends Error {
  readonly code: string
  constructor(message: string, code = 'revision_error') {
    super(message)
    this.name = 'WorkflowRevisionError'
    this.code = code
  }
}

// --- The state machine -----------------------------------------------------

/**
 * Legal transitions, as `state → action → nextState`. An action absent from a
 * state's entry is illegal from that state. See {@link LifecycleState} docs
 * for what each state means operationally.
 *
 *   draft      --submitReview--> review
 *   draft      --publish-------> published     (direct publish; import uses this)
 *   review     --publish-------> published
 *   review     --backToDraft---> draft
 *   published  --publish-------> published      (publish a new edited revision)
 *   published  --deprecate-----> deprecated
 *   published  --rollback------> published      (re-point current to an older rev)
 *   deprecated --publish-------> published      (re-publishing un-deprecates)
 *   deprecated --archive-------> archived
 *   archived   --(terminal)
 */
const LEGAL: Record<
  LifecycleState,
  Partial<Record<LifecycleAction, LifecycleState>>
> = {
  draft: { submitReview: 'review', publish: 'published' },
  review: { publish: 'published', backToDraft: 'draft' },
  published: { publish: 'published', deprecate: 'deprecated', rollback: 'published' },
  deprecated: { publish: 'published', archive: 'archived' },
  archived: {},
}

/** Per-transition inputs the pure function can't invent (time, actor, target). */
export interface TransitionInput {
  /** Timestamp for the audit log + `updatedAt` (caller passes `Date.now()`). */
  at: number
  /** Acting user/participant id, recorded in the audit log. */
  by?: string
  /** Required for `action: 'rollback'` — which revision to roll back to. */
  targetRevision?: number
}

/**
 * Apply a lifecycle `action` to `record`, returning a NEW record with the
 * flipped `state`, a fresh `updatedAt`, and an appended audit entry. Pure: it
 * does NOT touch `currentRevision` / `headRevision` / `revisions` — revision
 * bookkeeping is the caller's job (it needs the store to allocate/hash/write).
 *
 * Throws {@link WorkflowLifecycleError}:
 *   - `illegal_transition` if `action` isn't legal from `record.state`
 *   - `rollback_target_required` if a rollback omits `input.targetRevision`
 */
export function transition(
  record: LifecycleRecord,
  action: LifecycleAction,
  input: TransitionInput,
): LifecycleRecord {
  const next = LEGAL[record.state][action]
  if (next === undefined) {
    throw new WorkflowLifecycleError(
      `illegal transition: cannot '${action}' from state '${record.state}'`,
      'illegal_transition',
    )
  }
  if (action === 'rollback' && input.targetRevision === undefined) {
    throw new WorkflowLifecycleError(
      `rollback requires a targetRevision`,
      'rollback_target_required',
    )
  }

  const log: TransitionLog = { at: input.at, action, from: record.state, to: next }
  if (input.by !== undefined) log.by = input.by
  if (action === 'rollback') log.targetRevision = input.targetRevision

  return {
    ...record,
    state: next,
    updatedAt: input.at,
    history: [...record.history, log],
  }
}

/**
 * Whether a workflow in this state is registered live on the Hub (its trigger
 * capability is active). `published` and `deprecated` are live; `draft`,
 * `review`, and `archived` are not. The host uses this to decide whether to
 * register/unregister the runner as the state crosses the boundary.
 */
export function isLiveState(state: LifecycleState): boolean {
  return state === 'published' || state === 'deprecated'
}

/**
 * The actions legal from `state`, in declaration order. Handy for the admin UI
 * to gate which transition buttons to render, and for `getState` responses.
 */
export function legalActions(state: LifecycleState): LifecycleAction[] {
  return Object.keys(LEGAL[state]) as LifecycleAction[]
}
