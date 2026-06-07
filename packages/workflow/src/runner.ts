/**
 * `WorkflowRunner` — an `AgentParticipant` that runs one `WorkflowDefinition`.
 *
 * Register it on a Hub like any other agent:
 *
 *   const runner = new WorkflowRunner({ definition, hub, runStore })
 *   hub.register(runner)
 *
 * The runner's id is `workflow:<workflowId>` and its capability list is
 * `[definition.trigger.capability]`. When the Hub dispatches a task that
 * matches the trigger capability, `handleTask` walks the steps in order,
 * substituting `$ref`s, firing `hub.dispatch()` for each step, and writing
 * a `RunState` file after every step.
 *
 * The Hub itself stays untouched — the runner is "just an agent" that
 * happens to make N inner dispatches.
 */

import { randomUUID } from 'node:crypto'

import {
  AgentParticipant,
  SuspendTaskError,
  type AncestryNode,
  type DispatchStrategy,
  type ParticipantId,
  type Task,
  type TaskId,
  type TaskResult,
} from '@aipehub/core'

import { WorkflowRevisionError } from './lifecycle.js'
import { parsePredicate, type CompiledPredicate } from './predicate.js'
import { resolveRefs, type ResolutionContext } from './resolver.js'
import type { RunStore } from './run-store.js'
import {
  ParallelStepExecutor,
  SimpleStepExecutor,
  type StepExecContext,
  type StepExecutor,
} from './step-executors.js'
import {
  type DispatchSpec,
  type RunState,
  type Step,
  type StepRecord,
  type WorkflowDefinition,
} from './types.js'

/**
 * "Park forever" sentinel — the resume sweep never reaches it, so the run
 * stays suspended until an EXPLICIT event resumes it (an inbox resolve's
 * two-step recovery, or the boot-time `resumeRunningRuns` reconcile).
 * Mirrors `@aipehub/inbox`'s `NEVER_RESUME_AT`; duplicated as a local
 * constant rather than taking a cross-package dep (same as `@aipehub/cli-agent`).
 */
const NEVER_RESUME_AT = 9_999_999_999_000

/**
 * The minimal Hub surface the runner needs. Defined locally so the
 * `@aipehub/workflow` package doesn't import the full Hub class type
 * (and so tests can pass a stub).
 *
 * `origin` (B2.2.2) is the same shape as `core/types.ts` `TaskOrigin`
 * but typed structurally here to avoid pulling in the full Hub type;
 * the live `Hub.dispatch` accepts our shape because TS uses structural
 * compat on this field.
 */
export interface HubLike {
  dispatch(opts: {
    from: ParticipantId
    strategy: DispatchStrategy
    payload: unknown
    title?: string
    weight?: number
    priority?: number
    // v5 C-M2 — per-node I/O data classes; the live Hub.dispatch stamps them
    // onto Task.dataClasses, gating federated dispatch at the node level.
    dataClasses?: readonly string[]
    origin?: {
      orgId: string
      userId: string
      userRole?: string
      userEmail?: string
    }
    ancestry?: readonly AncestryNode[]
  }): Promise<TaskResult>
  taskResult?(taskId: TaskId): TaskResult | undefined
}

/**
 * Resolves the {@link WorkflowDefinition} a run should execute, by revision.
 * Phase 15: a run binds to the revision it started under, so re-publishing a
 * new revision never drifts an in-flight run onto new step logic.
 *
 * Synchronous on purpose — the runner stamps the revision into `RunState` and
 * exposes a `definition` getter without `await`. A host-backed resolver keeps
 * the needed revisions in memory (hydrated from the file stores, updated on
 * publish/rollback); the default single-revision resolver is trivial.
 */
export interface DefinitionResolver {
  /** The revision + definition a NEW run binds to (current published content). */
  current(): ResolvedDefinition
  /** The exact definition snapshot for a recorded run's revision. */
  byRevision(revision: number): WorkflowDefinition
}

export interface ResolvedDefinition {
  revision: number
  definition: WorkflowDefinition
}

export interface WorkflowRunnerOptions {
  definition: WorkflowDefinition
  hub: HubLike
  /**
   * Phase 15 — resolves the definition to execute by revision. When omitted,
   * the runner synthesizes a single-revision resolver from `definition` (rev 1),
   * which keeps every pre-Phase-15 call-site (`new WorkflowRunner({definition,
   * hub})`) working unchanged. The host injects a real, store-backed resolver
   * so new runs bind to the current published revision and resumes bind to the
   * revision they started under.
   */
  resolver?: DefinitionResolver
  /**
   * Persistence sink for `RunState` files. Pass `null` to disable
   * persistence (useful for in-memory tests).
   */
  runStore?: RunStore | null
  /** Generator for `runId`s. Tests may inject a deterministic one. */
  idGenerator?: () => string
  /** Clock injection for deterministic tests. */
  now?: () => number
  /**
   * R7 — extra step-execution strategies, keyed on `Step['kind']`. Registered
   * after the built-in `simple` / `parallel` executors (a custom executor may
   * override a built-in by reusing its kind). This is the seam for new control
   * flows (debate / swarm / supervisor): provide a `StepExecutor` here plus a
   * parser branch that emits its kind, and the runner core stays untouched.
   */
  stepExecutors?: StepExecutor[]
}

/**
 * Compute the participant id for a runner from its workflow definition.
 * Exposed so callers can register it consistently and tests can assert.
 */
export function workflowParticipantId(workflowId: string): ParticipantId {
  return `workflow:${workflowId}`
}

export class WorkflowRunner extends AgentParticipant {
  /** The workflow id — stable across revisions (identity + resume bind check). */
  readonly workflowId: string
  private readonly resolver: DefinitionResolver
  private readonly hub: HubLike
  private readonly runStore: RunStore | null
  /** R7 — protected so a runner subclass / custom executor can reuse them. */
  protected readonly idGen: () => string
  protected readonly now: () => number
  /** R7 — step-execution strategies, keyed on `Step['kind']`. */
  private readonly stepExecutors: Map<string, StepExecutor>
  /**
   * Per-revision compiled `when` predicates, built lazily on first use of a
   * revision and cached. Phase 15: a single runner can execute multiple
   * revisions over its lifetime (new runs on the current published revision,
   * resumes on whatever revision the run started under), so predicates can no
   * longer be compiled once at construction — they're keyed by revision here.
   * Bad predicates were already rejected at parseWorkflow time.
   */
  private readonly compiledCache = new Map<number, CompiledPredicates>()

  constructor(opts: WorkflowRunnerOptions) {
    super({
      id: workflowParticipantId(opts.definition.id),
      capabilities: [opts.definition.trigger.capability],
    })
    this.workflowId = opts.definition.id
    this.resolver = opts.resolver ?? singleRevisionResolver(opts.definition)
    this.hub = opts.hub
    this.runStore = opts.runStore ?? null
    this.idGen = opts.idGenerator ?? (() => randomUUID())
    this.now = opts.now ?? (() => Date.now())
    // Built-ins first; custom executors registered after may override a kind.
    this.stepExecutors = new Map()
    for (const ex of [
      new SimpleStepExecutor(),
      new ParallelStepExecutor(),
      ...(opts.stepExecutors ?? []),
    ]) {
      this.stepExecutors.set(ex.kind, ex)
    }
  }

  /**
   * Back-compat accessor: the current published definition. Resolves through
   * the (possibly host-backed) resolver, so it reflects the live revision.
   */
  get definition(): WorkflowDefinition {
    return this.resolver.current().definition
  }

  /** Build (or fetch from cache) the per-revision execution bundle. */
  private runDefnFor(revision: number, def: WorkflowDefinition): RunDefn {
    let compiled = this.compiledCache.get(revision)
    if (!compiled) {
      compiled = compilePredicates(def)
      this.compiledCache.set(revision, compiled)
    }
    return { revision, def, when: compiled.when, branchWhen: compiled.branchWhen }
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const runId = this.idGen()
    // Bind this run to the CURRENT published revision and stamp it into the
    // run state — resume later resolves the definition by this number, so a
    // subsequent publish can't drift this run onto new step logic.
    const { revision, definition } = this.resolver.current()
    const rd = this.runDefnFor(revision, definition)
    const state: RunState = {
      runId,
      workflowId: this.workflowId,
      definitionRevision: revision,
      triggeredByTaskId: task.id,
      // v2.5 — capture who fired the triggering task so HITL steps
      // can ask follow-up questions of that admin via `$trigger.from`.
      // Persisted into RunState so resume reconstructs the same value.
      triggeredByFrom: task.from,
      // B2.2.2 — capture origin so every inner dispatch re-stamps it.
      // The LlmAgent's preCallHook (org quota gate) reads
      // `task.origin.userId` to debit the right user.
      ...(task.origin ? { triggeredByOrigin: task.origin } : {}),
      ...(task.ancestry ? { triggeredByAncestry: [...task.ancestry] } : {}),
      triggerPayload: task.payload,
      steps: [],
      startedAt: this.now(),
      status: 'running',
    }
    await this.persist(state)

    const ctx: ResolutionContext = {
      triggerPayload: task.payload,
      triggerFrom: task.from,
      ...(task.origin ? { triggerOrigin: task.origin } : {}),
      triggerTaskId: task.id,
      ...(task.ancestry ? { triggerAncestry: task.ancestry } : {}),
      stepOutputs: new Map<string, unknown>(),
    }
    return this.executeStartingAt(rd, state, ctx, 0, undefined, { throwOnHaltFailure: true })
  }

  protected async handleResume(task: Task, state: unknown): Promise<unknown> {
    if (isWorkflowSuspendState(state)) {
      return this.resumeRun(state.runState, { throwOnHaltFailure: true })
    }
    return this.handleTask(task)
  }

  /**
   * Resume a previously-persisted run that was interrupted (typically by
   * a host restart). The state on disk must have `status === 'running'`;
   * any run that had already reached a terminal status is left alone.
   *
   * The resume model is "re-execute incomplete steps":
   *   - Steps recorded with `status: 'done'` keep their persisted output;
   *     we replay them into the resolution context but skip the dispatch.
   *   - Steps with `status: 'skipped'` keep their record as-is and feed
   *     `undefined` into the context (same as a fresh skipped step).
   *   - Steps with `status: 'failed'` AND workflow-level `onFailure:
   *     continue` are treated like skipped (their record is preserved).
   *   - Any other step record (`running`, or `failed` under halt) is
   *     dropped from `state.steps` and re-executed.
   *
   * Returns the final output (same as `handleTask`). By default a
   * halt-failure on resume just persists the new failure record; callers
   * that are running inside `AgentParticipant.onResume` can opt into
   * throwing so the Hub sees a failed resume result.
   */
  async resumeRun(
    initial: RunState,
    opts: { throwOnHaltFailure?: boolean } = {},
  ): Promise<unknown> {
    if (initial.status !== 'running') {
      throw new Error(
        `cannot resume run '${initial.runId}' — status is '${initial.status}', not 'running'`,
      )
    }
    if (initial.workflowId !== this.workflowId) {
      throw new Error(
        `cannot resume run '${initial.runId}' — its workflowId '${initial.workflowId}' does not match this runner ('${this.workflowId}')`,
      )
    }

    // Resolve the EXACT revision this run started under. A legacy run with no
    // stamped revision predates Phase 15 stamping, so it was executing the
    // ORIGINAL definition — pin it to revision 1 (boot-adoption makes every
    // pre-existing workflow rev 1). Falling back to `current()` would silently
    // drift such a run onto a newer published revision (rev 2+), the very thing
    // revision-stamping exists to prevent. If the pinned revision is gone, fail
    // loudly (caught below) rather than resume against a different definition.
    const revision = initial.definitionRevision ?? 1
    let rd: RunDefn
    try {
      rd = this.runDefnFor(revision, this.resolver.byRevision(revision))
    } catch (err) {
      if (err instanceof WorkflowRevisionError) throw err
      throw new WorkflowRevisionError(
        `cannot resume run '${initial.runId}' — revision ${revision} is unavailable: ${err instanceof Error ? err.message : String(err)}`,
        'revision_missing',
      )
    }

    // We operate on the caller's state object directly — the contract of
    // `resumeRun(state)` is "continue this run", so the caller expects
    // their object to reflect the final outcome once we resolve. Tests
    // and host code can read the updated state without an extra disk
    // round-trip.
    const state = initial
    const ctx: ResolutionContext = {
      triggerPayload: state.triggerPayload,
      // triggerFrom may be undefined on pre-v2.5 run files; that's OK
      // — resolver throws a helpful error if a workflow yaml uses
      // `$trigger.from` and the run state predates the field.
      triggerFrom: state.triggeredByFrom,
      // B2.2.2 — pre-v4-phase5 run files won't have triggeredByOrigin;
      // we simply pass undefined and the inner dispatches skip origin
      // (the org quota gate then treats them as unattributed → no
      // debit; the resumed run completes without quota enforcement).
      ...(state.triggeredByOrigin ? { triggerOrigin: state.triggeredByOrigin } : {}),
      triggerTaskId: state.triggeredByTaskId,
      ...(state.triggeredByAncestry ? { triggerAncestry: state.triggeredByAncestry } : {}),
      stepOutputs: new Map<string, unknown>(),
    }
    const workflowFailureMode: 'halt' | 'continue' = rd.def.onFailure ?? 'halt'

    // Index existing records by stepId. We keep the records that were in
    // a terminal-for-resume state; everything else gets dropped so the
    // step can run fresh.
    const keep: StepRecord[] = []
    const completedOutputs = new Map<string, unknown>()
    const replayLastOutput = { value: undefined as unknown }
    for (const sr of state.steps) {
      if (sr.status === 'done') {
        keep.push(sr)
        completedOutputs.set(sr.stepId, sr.output)
        replayLastOutput.value = sr.output
      } else if (sr.status === 'skipped') {
        keep.push(sr)
        completedOutputs.set(sr.stepId, undefined)
      } else if (sr.status === 'failed' && workflowFailureMode === 'continue') {
        keep.push(sr)
        completedOutputs.set(sr.stepId, undefined)
      } else if (sr.status === 'suspended') {
        const step = rd.def.steps.find((s) => s.id === sr.stepId)
        if (!step) {
          sr.status = 'failed'
          sr.error = `cannot resume suspended step '${sr.stepId}' — step no longer exists`
        } else {
          this.refreshSuspendedStepRecord(rd, ctx, sr, step)
        }
        const refreshedStatus = sr.status as StepRecord['status']
        if (refreshedStatus === 'suspended') {
          keep.push(sr)
          state.steps = keep
          await this.persist(state)
          // A genuine wake-time is always stamped when a step suspends
          // (`record.resumeAt = result.resumeAt`). Reaching the fallback means
          // it's unknown — a corrupt/legacy record or a vanished child result.
          // Re-parking a second out would busy-spin the sweep with no recovery
          // (nothing repopulates the missing wake-time on a timer); park
          // forever and let an explicit resume drive it instead.
          this.suspendWorkflow(state, sr.resumeAt ?? NEVER_RESUME_AT)
        }
        if (refreshedStatus === 'done') {
          keep.push(sr)
          completedOutputs.set(sr.stepId, sr.output)
          replayLastOutput.value = sr.output
        } else if (refreshedStatus === 'skipped') {
          keep.push(sr)
          completedOutputs.set(sr.stepId, undefined)
        } else if (refreshedStatus === 'failed' && workflowFailureMode === 'continue') {
          keep.push(sr)
          completedOutputs.set(sr.stepId, undefined)
        } else if (refreshedStatus === 'failed') {
          keep.push(sr)
          state.steps = keep
          state.status = 'failed'
          state.endedAt = this.now()
          state.error = `step '${sr.stepId}' failed: ${sr.error ?? 'unknown'}`
          await this.persist(state)
          if (opts.throwOnHaltFailure) throw new Error(state.error)
          return undefined
        }
      }
      // running / failed-under-halt → drop, will be re-run below
    }
    state.steps = keep
    await this.persist(state)

    // Find the first step in the definition that isn't already in
    // `completedOutputs`. That's where execution resumes from.
    let startIndex = 0
    for (let i = 0; i < rd.def.steps.length; i++) {
      const stepId = rd.def.steps[i]!.id
      if (completedOutputs.has(stepId)) {
        ctx.stepOutputs.set(stepId, completedOutputs.get(stepId))
        startIndex = i + 1
      } else {
        break
      }
    }

    return this.executeStartingAt(
      rd,
      state,
      ctx,
      startIndex,
      replayLastOutput.value,
      { throwOnHaltFailure: opts.throwOnHaltFailure ?? false },
    )
  }

  /**
   * Iterate `this.definition.steps` from `startIndex`, executing each
   * one in turn against `ctx`. Handles `done` / `failed` / `skipped`
   * branching the same way as the original `handleTask`. Returns the
   * final output once all steps have been processed.
   *
   * Shared between fresh `handleTask` runs (startIndex = 0) and
   * `resumeRun` (startIndex = first incomplete step). The
   * `throwOnHaltFailure` flag is the one behavioural difference: a
   * fresh task should reject so the Hub sees the failure; a resume run
   * has no caller and simply persists the failure state instead.
   */
  private async executeStartingAt(
    rd: RunDefn,
    state: RunState,
    ctx: ResolutionContext,
    startIndex: number,
    initialLastStepOutput: unknown,
    opts: { throwOnHaltFailure: boolean },
  ): Promise<unknown> {
    const workflowFailureMode: 'halt' | 'continue' = rd.def.onFailure ?? 'halt'
    let lastStepOutput = initialLastStepOutput

    for (let i = startIndex; i < rd.def.steps.length; i++) {
      const step = rd.def.steps[i]!
      const record = await this.runStep(rd, step, ctx)
      state.steps.push(record)
      await this.persist(state)

      if (record.status === 'done') {
        ctx.stepOutputs.set(step.id, record.output)
        lastStepOutput = record.output
      } else if (record.status === 'failed') {
        if (workflowFailureMode === 'halt') {
          state.status = 'failed'
          state.endedAt = this.now()
          state.error = `step '${step.id}' failed: ${record.error ?? 'unknown'}`
          await this.persist(state)
          if (opts.throwOnHaltFailure) throw new Error(state.error)
          return undefined
        }
        // continue mode — record it, leave output undefined, move on
        ctx.stepOutputs.set(step.id, undefined)
      } else if (record.status === 'skipped') {
        ctx.stepOutputs.set(step.id, undefined)
      } else if (record.status === 'suspended') {
        // See the resume-path note: unknown wake-time → park forever, not a
        // 1s busy-spin (the sweep would just re-enter with the same gap).
        this.suspendWorkflow(state, record.resumeAt ?? NEVER_RESUME_AT)
      }
    }

    // Compute final output.
    let finalOutput: unknown
    if (rd.def.output !== undefined) {
      finalOutput = resolveRefs(rd.def.output, ctx)
    } else {
      finalOutput = lastStepOutput
    }

    state.status = 'done'
    state.endedAt = this.now()
    state.finalOutput = finalOutput
    await this.persist(state)
    return finalOutput
  }

  // --- step execution -------------------------------------------------------

  private async runStep(
    rd: RunDefn,
    step: Step,
    ctx: ResolutionContext,
  ): Promise<StepRecord> {
    const record: StepRecord = {
      stepId: step.id,
      startedAt: this.now(),
      status: 'running',
      attempts: 0,
      subTaskIds: [],
    }

    // `when` gate — applies before any dispatch. A false predicate marks
    // the step as `skipped`, the runner doesn't call hub.dispatch, and
    // downstream refs to `$step.output` resolve to `undefined`.
    const pred = rd.when.get(step.id)
    if (pred) {
      let passed: boolean
      try {
        passed = pred.eval(ctx)
      } catch (err) {
        record.endedAt = this.now()
        record.status = 'failed'
        record.error = `when '${pred.source}' threw: ${err instanceof Error ? err.message : String(err)}`
        return record
      }
      if (!passed) {
        record.endedAt = this.now()
        record.status = 'skipped'
        return record
      }
    }

    // Absent `kind` ⇒ 'simple' (the pre-seam semantic: "no parallel marker ⇒
    // a plain dispatch step"). The parser always stamps it; hand-built defs may
    // not. Only an explicitly-set-but-unregistered kind fails closed.
    const kind = step.kind ?? 'simple'
    const executor = this.stepExecutors.get(kind)
    if (!executor) {
      record.status = 'failed'
      record.error = `no step executor registered for kind '${kind}'`
      record.endedAt = this.now()
      return record
    }
    return executor.run(step, record, this.execContextFor(rd, step, ctx))
  }

  /**
   * Build the narrow, run-scoped surface a {@link StepExecutor} uses — closing
   * over this run's resolution context and revision-bound branch predicates so
   * an executor never touches the runner, the `RunDefn`, or another step.
   */
  private execContextFor(rd: RunDefn, step: Step, ctx: ResolutionContext): StepExecContext {
    return {
      ctx,
      now: () => this.now(),
      dispatchOne: (spec) => this.dispatchOne(spec, ctx),
      taskResult: (taskId) => this.hub.taskResult?.(taskId),
      branchPredicate: (branchId) => rd.branchWhen.get(step.id)?.get(branchId),
    }
  }

  protected async dispatchOne(
    spec: DispatchSpec,
    ctx: ResolutionContext,
  ): Promise<TaskResult> {
    const resolvedPayload = resolveRefs(spec.payload, ctx)
    const opts: Parameters<HubLike['dispatch']>[0] = {
      from: this.id,
      strategy: spec.strategy,
      payload: resolvedPayload,
    }
    if (spec.title !== undefined) opts.title = spec.title
    if (spec.weight !== undefined) opts.weight = spec.weight
    if (spec.priority !== undefined) opts.priority = spec.priority
    // v5 C-M2 — node-level I/O authorization. Stamp the node's declared data
    // classes onto the task so the per-link outbound contract gates this
    // specific dispatch (a `pii` node refused on a `public`-only link while a
    // sibling `public` node on the same run crosses fine). No-op for local
    // dispatch — the gate lives on the federation wrapper, not the hub.
    if (spec.dataClasses !== undefined) opts.dataClasses = spec.dataClasses
    // B2.2.2 — re-stamp the original dispatcher's origin on every
    // inner dispatch. Without this the LlmAgent's preCallHook would
    // see `task.origin === undefined` (because the runner's id is
    // the only thing on `from`) and the quota gate would treat the
    // call as unattributed → no per-user debit.
    if (ctx.triggerOrigin) opts.origin = ctx.triggerOrigin
    if (ctx.triggerTaskId) {
      opts.ancestry = [
        ...(ctx.triggerAncestry ?? []),
        { taskId: ctx.triggerTaskId, by: this.id },
      ]
    }
    return this.hub.dispatch(opts)
  }

  /**
   * Re-evaluate a suspended step's child task(s) on resume, delegating the
   * kind-specific folding to the step's executor. Guards the `hub.taskResult`
   * pre-condition once here (kind-agnostic) so executors can assume it exists.
   */
  private refreshSuspendedStepRecord(
    rd: RunDefn,
    ctx: ResolutionContext,
    record: StepRecord,
    step: Step,
  ): void {
    if (!this.hub.taskResult) {
      record.status = 'failed'
      record.error =
        `cannot resume suspended step '${record.stepId}' — hub does not expose taskResult()`
      record.endedAt = this.now()
      return
    }
    const kind = step.kind ?? 'simple'
    const executor = this.stepExecutors.get(kind)
    if (!executor) {
      record.status = 'failed'
      record.error = `no step executor registered for kind '${kind}'`
      record.endedAt = this.now()
      return
    }
    executor.refreshSuspended(step, record, this.execContextFor(rd, step, ctx))
  }

  private suspendWorkflow(state: RunState, resumeAt: number): never {
    throw new SuspendTaskError({
      resumeAt,
      state: workflowSuspendState(state),
    })
  }

  // --- persistence wrapper --------------------------------------------------

  /** R7 — protected so a runner subclass can persist intermediate state. */
  protected async persist(state: RunState): Promise<void> {
    if (!this.runStore) return
    this.runStore.ensureDirs()
    await this.runStore.write(state)
  }
}

interface WorkflowSuspendState {
  kind: 'workflow_step_suspended'
  runState: RunState
}

function workflowSuspendState(runState: RunState): WorkflowSuspendState {
  return { kind: 'workflow_step_suspended', runState }
}

function isWorkflowSuspendState(value: unknown): value is WorkflowSuspendState {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'workflow_step_suspended' &&
    typeof (value as { runState?: unknown }).runState === 'object' &&
    (value as { runState?: unknown }).runState !== null
  )
}

/**
 * The per-run execution bundle: the bound revision, its definition, and the
 * `when` predicates compiled for THAT revision. Threaded through the execute
 * path so a run always reads the steps/predicates of its own revision, not the
 * runner's current one — this is what prevents an in-flight run from drifting
 * onto a newly-published revision.
 */
interface RunDefn {
  revision: number
  def: WorkflowDefinition
  when: Map<string, CompiledPredicate>
  // Nested stepId → branchId → predicate. Two-level keying is injective by
  // construction, so branch predicates can't collide even when ids contain
  // ':' (the schema's ID_RE permits it) — unlike a flat string-concat key.
  branchWhen: Map<string, Map<string, CompiledPredicate>>
}

interface CompiledPredicates {
  when: Map<string, CompiledPredicate>
  // Nested stepId → branchId → predicate. Two-level keying is injective by
  // construction, so branch predicates can't collide even when ids contain
  // ':' (the schema's ID_RE permits it) — unlike a flat string-concat key.
  branchWhen: Map<string, Map<string, CompiledPredicate>>
}

/** Compile every `when` / branch-`when` predicate in a definition. */
function compilePredicates(def: WorkflowDefinition): CompiledPredicates {
  const when = new Map<string, CompiledPredicate>()
  const branchWhen = new Map<string, Map<string, CompiledPredicate>>()
  for (const step of def.steps) {
    if (step.when) when.set(step.id, parsePredicate(step.when))
    if (step.kind === 'parallel') {
      for (const branch of step.branches) {
        if (branch.when) {
          let perStep = branchWhen.get(step.id)
          if (!perStep) {
            perStep = new Map<string, CompiledPredicate>()
            branchWhen.set(step.id, perStep)
          }
          perStep.set(branch.id, parsePredicate(branch.when))
        }
      }
    }
  }
  return { when, branchWhen }
}

/**
 * Default resolver for a runner with no host-backed revision store: the given
 * definition is the one and only revision (1). `byRevision` throws for any
 * other number — in a single-revision world a run can't have been stamped with
 * a revision that doesn't exist.
 */
function singleRevisionResolver(definition: WorkflowDefinition): DefinitionResolver {
  return {
    current: () => ({ revision: 1, definition }),
    byRevision: (revision) => {
      if (revision !== 1) {
        throw new WorkflowRevisionError(
          `revision ${revision} not available (single-revision runner)`,
          'revision_missing',
        )
      }
      return definition
    },
  }
}
