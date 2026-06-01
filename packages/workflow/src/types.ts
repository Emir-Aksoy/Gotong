/**
 * Core types for `@aipehub/workflow`.
 *
 * A workflow is a YAML/JSON file that declares:
 *   - a `trigger` capability — admin dispatches to this cap to start the flow
 *   - a list of `steps` — each step either fires one `hub.dispatch()` or
 *     a fan-out of parallel branches
 *   - an `output` expression — what to return as the final TaskResult
 *
 * Values inside `payload` (and `output`) can reference earlier steps via
 *   $trigger.payload         → the inbound task's full payload
 *   $trigger.payload.foo     → a field on the inbound payload
 *   $stepId.output           → the entire output of an earlier step
 *   $stepId.output.bar       → a field on it
 *   $stepId.branchId.output  → the output of one branch inside a parallel step
 *
 * The resolver substitutes these at runtime; see `resolver.ts`.
 *
 * Schemas:
 *   schema: aipehub.workflow/v1
 *   workflow:
 *     id: string                        # required, unique within a space
 *     name?: string
 *     description?: string
 *     trigger:
 *       capability: string              # required — the entry capability
 *     steps: Step[]                     # required, non-empty
 *     output?: RefExpr | LiteralObject  # default: last step's output
 *     onFailure?: 'halt' | 'continue'   # default: 'halt'
 */

import type { AncestryNode, DispatchStrategy } from '@aipehub/core'

export const WORKFLOW_SCHEMA_V1 = 'aipehub.workflow/v1'

// --- Workflow definition ---------------------------------------------------

export interface WorkflowDefinition {
  schema: typeof WORKFLOW_SCHEMA_V1
  id: string
  name?: string
  description?: string
  trigger: TriggerSpec
  steps: Step[]
  /**
   * Final return value. May reference any earlier step output. If omitted,
   * defaults to the last step's `output` (or for a parallel step, an object
   * mapping each branch id to its output).
   */
  output?: unknown
  /**
   * What to do when any step fails. Default `'halt'` (return failure
   * immediately). `'continue'` records the failure but keeps going — useful
   * for best-effort cleanup flows.
   */
  onFailure?: 'halt' | 'continue'
  /**
   * Optional UX-surface declarations. The runner ignores this entirely —
   * it's consumed by the web layer to decide which workflows appear on the
   * member-facing `/me` workbench. See `WorkflowSurfaceSpec`.
   */
  surface?: WorkflowSurfaceSpec
  /**
   * Optional governance / risk metadata. The runner ignores this entirely —
   * it's consumed by the web layer to show a risk summary BEFORE an admin
   * imports or publishes the workflow ("what keys does it need, what data does
   * it touch, who has to sign off, what does it cost"). Declarative only; it
   * does not gate execution (the P2 RBAC + structure checks do that). See
   * `WorkflowGovernanceSpec`.
   */
  governance?: WorkflowGovernanceSpec
}

export interface TriggerSpec {
  /** The capability admins dispatch to in order to start this workflow. */
  capability: string
  /**
   * Optional ordered list of payload field descriptors. When present,
   * the admin UI renders a field-by-field form for this workflow
   * instead of asking the user to write JSON by hand.
   *
   * The workflow runner ignores this — it's purely a UI hint. Steps
   * reference fields via `$trigger.payload.<id>` exactly as they
   * always have; payloadSchema doesn't change validation semantics
   * (a step's resolver still treats every payload field as optional
   * and stringly-typed at the JSON level).
   *
   * Use cases this targets: long-form workflows where the payload is
   * "the human's self-description" (personal-growth-flow's 4 段
   * 自述), structured surveys, anything that would otherwise force
   * a non-technical user to learn the payload's JSON shape.
   */
  payloadSchema?: PayloadFieldSpec[]
}

/**
 * One field descriptor for the admin UI's workflow-specific dispatch
 * form. Mirrors HTML form controls 1:1 so the UI can render without
 * having to interpret types.
 */
export interface PayloadFieldSpec {
  /** Payload key — becomes `$trigger.payload.<id>` inside the workflow. */
  id: string
  /** Human-readable label, shown above the input. */
  label: string
  /**
   * Control kind:
   *   - 'text': single-line input
   *   - 'textarea': multi-line input (use `rows` to size)
   *   - 'number': numeric input (sent as number, not string)
   *   - 'select': dropdown; requires `options`
   *   - 'file': file upload (Phase 9 multimodal). The UI uploads the
   *     file to the host's `uploads` surface and substitutes a
   *     `LlmFileRefBlock`-shaped object into the payload at this id:
   *     `{ type: 'file_ref', artifactId: string, mime: string }`. The
   *     workflow then refs the file via `$trigger.payload.<id>` (the
   *     same `$ref` syntax — what changes is the value's shape, not
   *     how steps see it). Suitable for handing image / audio / pdf
   *     to an LlmAgent step downstream.
   */
  type: 'text' | 'textarea' | 'number' | 'select' | 'file'
  /** Tooltip / hint string displayed under the label. */
  hint?: string
  /** Placeholder text inside the empty input. */
  placeholder?: string
  /** Default value (string or number per type). */
  defaultValue?: string | number
  /** Submit-time required check (UI-side; runner doesn't enforce). */
  required?: boolean
  /** For type='textarea': number of visible rows (default 4). */
  rows?: number
  /** For type='select': option list. */
  options?: { value: string; label: string }[]
  /**
   * For type='file': accepted mime prefixes (e.g. `['image/']`,
   * `['image/png', 'image/jpeg']`, `['audio/']`). Pure UI hint — used
   * for the `<input accept="...">` attribute and pre-submit guard.
   * Upload endpoint enforces its own server-side allow-list (from
   * the artifact plugin's `allowedMimePrefixes`), so this is
   * advisory: a stricter accept here just narrows the picker.
   */
  accept?: string[]
  /**
   * For type='file': per-file size cap (MB) shown to the user and
   * checked pre-upload. The upload endpoint also enforces its own
   * cap via the artifact plugin's `maxBytesPerFile`. Default UI
   * limit (when omitted) is 10MB to mirror the plugin default.
   */
  maxSizeMb?: number
}

// --- Member-facing surface (Phase 14) --------------------------------------

/**
 * Role literal for `MeSurfaceSpec.allowedRoles`. Mirrors the identity role
 * set WITHOUT importing `@aipehub/identity` — the workflow package stays
 * free of any identity runtime dep (the same posture the web layer takes
 * with its own role mirror). Kept in sync by convention, not by type.
 */
export type WorkflowRole = 'owner' | 'admin' | 'member' | 'viewer'

/**
 * Optional UX-surface declarations on a workflow. Today only `me` (the
 * member-facing personal workbench at `/me`); kept as a nested object so a
 * future surface (e.g. a public intake form) slots in without reshaping the
 * workflow root.
 */
export interface WorkflowSurfaceSpec {
  me?: MeSurfaceSpec
}

/**
 * Declares that a workflow is runnable from the member-facing `/me`
 * workbench. WHY this lives in the workflow definition rather than a
 * hardcoded allowlist in the web layer: it moves the member-exposure
 * decision from a source edit to an import-time review of the YAML —
 * whoever can import a workflow (admin-gated) decides whether members may
 * run it.
 */
export interface MeSurfaceSpec {
  /** Master switch — a workflow only appears on `/me` when this is true. */
  enabled: boolean
  /** Member-facing label. Falls back to `workflow.name` then `id` in the UI. */
  label?: string
  /** Member-facing description. Falls back to `workflow.description`. */
  description?: string
  /**
   * Member-facing input fields — reuses `PayloadFieldSpec` (the exact shape
   * the admin dispatch form already renders). When omitted, the `/me` form
   * falls back to `trigger.payloadSchema`; when that's absent too, the form
   * has no fields.
   */
  inputSchema?: PayloadFieldSpec[]
  /**
   * Which roles may run this from `/me`. Omitted ⇒ `['owner','admin','member']`
   * (viewer excluded — viewers are read-only by convention; a workflow can
   * opt them in explicitly).
   */
  allowedRoles?: WorkflowRole[]
  /**
   * The single payload key the `/me` dispatch handler force-sets to the
   * caller's userId, so a member can't act for another user. Which key
   * depends on the workflow (personal-growth uses `case_id`; another might
   * use `owner_user_id`). Omitted ⇒ `'case_id'`. The handler drops any
   * caller-supplied value under this key, then sets it to the userId.
   */
  userScopeField?: string
}

// --- Governance / risk metadata (Phase 19 P5) ------------------------------

/**
 * Coarse data-sensitivity band a workflow handles, worst-case. Ordered
 * least→most sensitive. A local literal (no `@aipehub/identity` dep) like
 * `WorkflowRole` — the workflow package stays identity-free.
 */
export type DataSensitivity = 'public' | 'internal' | 'confidential' | 'pii'

/**
 * Optional governance / risk metadata on a workflow. Purely declarative — the
 * runner never reads it. The web layer renders it as a risk summary before an
 * admin imports or publishes, so "what will this thing touch, cost, and need a
 * human for" is visible at decision time instead of buried in the steps.
 *
 * It is NOT an enforcement boundary: P2's RBAC + structure checks gate what
 * actually runs. Think of this as the nutrition label, not the lock.
 */
export interface WorkflowGovernanceSpec {
  /** Worst-case data-sensitivity band a run touches. */
  dataSensitivity?: DataSensitivity
  /**
   * Credentials / API keys a run needs, by logical name (e.g. `anthropic`,
   * `windmill`, `crm-api`). Names, never secret values — this is a checklist
   * of "make sure these are in the vault", not the secrets themselves.
   */
  requiredCredentials?: string[]
  /** Rough expected LLM/API cost per run in USD (operator estimate). */
  expectedCostUsd?: number
  /**
   * Human roles that must act for a run to complete (HITL approvers), as
   * free-text job descriptions — e.g. `legal counsel`, `senior consultant`.
   * Free-text (not the RBAC role enum) because the meaningful unit here is the
   * real-world sign-off role, not the hub permission level.
   */
  requiredHumanRoles?: string[]
  /**
   * External systems a run reaches — MCP servers, peer hubs, automation
   * platforms, SaaS APIs (e.g. `chroma-mcp`, `peer:legal-org`, `windmill`).
   */
  externalSystems?: string[]
  /** Free-text note shown verbatim in the risk summary. */
  notes?: string
}

// --- Steps -----------------------------------------------------------------

export type Step = SimpleStep | ParallelStep

export interface SimpleStep {
  id: string
  /** Human-friendly hint. Optional. */
  description?: string
  /** Single `hub.dispatch()` call. */
  dispatch: DispatchSpec
  /** Per-step retry / continue policy. Defaults to the workflow-level one. */
  onFailure?: StepFailurePolicy
  /**
   * Optional predicate string. If present and evaluates to **false** at
   * the moment this step is about to run, the step is recorded as
   * `skipped` and `dispatch` is NOT called. Skipped steps have
   * `output: undefined`, which propagates through `$ref`s the same way
   * a `continue`-style failure does.
   *
   * Grammar (kept deliberately small — see `predicate.ts`):
   *
   *   when: $trigger.payload.priority == "high"
   *   when: $step1.output.ok == true && $trigger.payload.urgent != false
   *   when: !($step1.output.skip == true)
   *
   * Operands: `$ref` paths (resolved via the same resolver as `payload`)
   * OR literals (`"string"`, numbers, `true`, `false`, `null`). Operators:
   * `==`, `!=`, `&&`, `||`, `!`, and parens. No arithmetic, no functions.
   */
  when?: string
}

export interface ParallelStep {
  id: string
  description?: string
  /** True parallel — all branches dispatched concurrently, all awaited. */
  parallel: true
  branches: Branch[]
  onFailure?: StepFailurePolicy
  /** See `SimpleStep.when` — applies to the whole parallel fan-out. */
  when?: string
}

export interface Branch {
  id: string
  description?: string
  dispatch: DispatchSpec
  /**
   * Optional per-branch predicate. Evaluated **before** dispatch. A
   * `false` branch:
   *   - is NOT dispatched (no Hub task created),
   *   - contributes `undefined` to the parallel step's
   *     `{ branchId → output }` map,
   *   - does not appear in `subTaskIds`,
   *   - and is not counted as a failure.
   *
   * Same grammar as `Step.when` — strict typed `==`/`!=`, `&&`/`||`/`!`,
   * parens, `$trigger.payload.*` and `$stepId.output.*` refs. No
   * arithmetic / `<`/`>` / function calls.
   *
   * Stacks with the parent `ParallelStep.when`: if the whole step's
   * `when` is false, no branch's `when` is evaluated (the whole step
   * is skipped).
   */
  when?: string
}

/**
 * What to declare inside `dispatch:` for one step / branch.
 *
 * `strategy` is the same shape AipeHub uses everywhere — and is interpreted
 * directly (`{kind: 'capability', capabilities: [...]}` etc.).
 *
 * `payload` may contain `$ref` strings anywhere in its tree; they're resolved
 * just before the dispatch fires. Pass an object, a string, or a literal.
 *
 * `title` is propagated to `Task.title` for transcript readability.
 */
export interface DispatchSpec {
  strategy: DispatchStrategy
  payload: unknown
  title?: string
  weight?: number
  priority?: number
}

export type StepFailurePolicy =
  | { action: 'halt' }
  | { action: 'continue' }
  | { action: 'retry'; max: number }

// --- Runtime state (persisted to .aipehub/workflows/runs/<id>.json) --------

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface RunState {
  /** Unique id for this run instance. */
  runId: string
  /** The workflow definition id (what was triggered). */
  workflowId: string
  /**
   * Phase 15 — the immutable revision number this run is bound to (stamped at
   * run start from the workflow's current published revision). Resume resolves
   * the definition by THIS number, not the live/current one, so re-publishing
   * a new revision never drifts an in-flight run onto new step logic. Optional
   * for back-compat with pre-Phase-15 run files; the runner treats an absent
   * value as `currentRevision ?? 1` (which equals today's behavior, since
   * boot-adoption makes every existing workflow rev 1).
   */
  definitionRevision?: number
  /** The Hub task id that triggered this run (so admins can correlate). */
  triggeredByTaskId: string
  /**
   * The ParticipantId of whoever fired the triggering task — typically
   * an admin id. Optional for back-compat with pre-v2.5 run files; new
   * runs always set it so HITL steps inside the workflow can ask
   * follow-up questions of the originator via `$trigger.from` refs.
   */
  triggeredByFrom?: string
  /**
   * B2.2.2 — `task.origin` from the triggering dispatch, if any.
   * Persisted so resume reconstructs the same value, and so every
   * inner `hub.dispatch()` the runner fires can re-stamp the same
   * origin (lets the org quota gate inside `LlmAgent` debit the
   * actual user, not the runner's synthetic id).
   *
   * Untyped here (`Record<string, unknown>`) deliberately — pulling
   * `TaskOrigin` from `@aipehub/core` would invert the dependency
   * direction; the runner type-checks it structurally via the
   * `HubLike.dispatch` opts.
   */
  triggeredByOrigin?: { orgId: string; userId: string; userRole?: string; userEmail?: string }
  /**
   * Phase 10 interop — ancestry carried by the task that triggered this
   * workflow. Persisted so crash resume keeps the same dispatch-depth /
   * cycle boundary on later inner dispatches.
   */
  triggeredByAncestry?: AncestryNode[]
  /** Initial payload received from the triggering task. */
  triggerPayload: unknown
  /** Per-step records, in execution order. */
  steps: StepRecord[]
  /** When the run was created (ms since epoch). */
  startedAt: number
  /** When the run ended; absent while running. */
  endedAt?: number
  status: RunStatus
  /** Final output once status==='done'. */
  finalOutput?: unknown
  /** Final error reason once status==='failed'. */
  error?: string
}

export interface StepRecord {
  stepId: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'failed' | 'skipped' | 'suspended'
  /**
   * For a simple step: the resolved output.
   * For a parallel step: a `{ branchId → output }` map.
   */
  output?: unknown
  error?: string
  /** Earliest known wake time when a child dispatch returned `suspended`. */
  resumeAt?: number
  /** Child task ids currently parked by the Hub suspend/resume layer. */
  suspendedTaskIds?: string[]
  /** For parallel steps, maps branch id → suspended child task id. */
  suspendedBranchTaskIds?: Record<string, string>
  /** Attempts so far (1 on first try; >1 if retry policy fired). */
  attempts: number
  /** Sub-task ids dispatched for this step — links to the transcript. */
  subTaskIds: string[]
}

/**
 * Slimmed-down projection of `RunState` for listing many runs at once
 * (admin "run history" view). Skips the heavy `triggerPayload` /
 * `finalOutput` / per-step output blobs so a directory of 1k runs fits
 * comfortably in one HTTP response.
 */
export interface RunSummary {
  runId: string
  workflowId: string
  triggeredByTaskId: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  /** Number of step records present (≤ workflow.steps for in-progress runs). */
  stepCount: number
  /** Final-error reason if `status === 'failed'`. */
  error?: string
}

// --- Errors ----------------------------------------------------------------

export class WorkflowSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowSchemaError'
  }
}

export class WorkflowRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowRefError'
  }
}
