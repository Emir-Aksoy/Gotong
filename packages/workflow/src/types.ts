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

import type { DispatchStrategy } from '@aipehub/core'

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
}

export interface TriggerSpec {
  /** The capability admins dispatch to in order to start this workflow. */
  capability: string
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
  /** The Hub task id that triggered this run (so admins can correlate). */
  triggeredByTaskId: string
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
  status: 'running' | 'done' | 'failed' | 'skipped'
  /**
   * For a simple step: the resolved output.
   * For a parallel step: a `{ branchId → output }` map.
   */
  output?: unknown
  error?: string
  /** Attempts so far (1 on first try; >1 if retry policy fired). */
  attempts: number
  /** Sub-task ids dispatched for this step — links to the transcript. */
  subTaskIds: string[]
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
