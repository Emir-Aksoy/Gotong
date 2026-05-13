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
  type DispatchStrategy,
  type ParticipantId,
  type Task,
  type TaskResult,
} from '@aipehub/core'

import { parsePredicate, type CompiledPredicate } from './predicate.js'
import { resolveRefs, type ResolutionContext } from './resolver.js'
import type { RunStore } from './run-store.js'
import {
  type Branch,
  type DispatchSpec,
  type ParallelStep,
  type RunState,
  type SimpleStep,
  type Step,
  type StepFailurePolicy,
  type StepRecord,
  type WorkflowDefinition,
} from './types.js'

/**
 * The minimal Hub surface the runner needs. Defined locally so the
 * `@aipehub/workflow` package doesn't import the full Hub class type
 * (and so tests can pass a stub).
 */
export interface HubLike {
  dispatch(opts: {
    from: ParticipantId
    strategy: DispatchStrategy
    payload: unknown
    title?: string
    weight?: number
    priority?: number
  }): Promise<TaskResult>
}

export interface WorkflowRunnerOptions {
  definition: WorkflowDefinition
  hub: HubLike
  /**
   * Persistence sink for `RunState` files. Pass `null` to disable
   * persistence (useful for in-memory tests).
   */
  runStore?: RunStore | null
  /** Generator for `runId`s. Tests may inject a deterministic one. */
  idGenerator?: () => string
  /** Clock injection for deterministic tests. */
  now?: () => number
}

/**
 * Compute the participant id for a runner from its workflow definition.
 * Exposed so callers can register it consistently and tests can assert.
 */
export function workflowParticipantId(workflowId: string): ParticipantId {
  return `workflow:${workflowId}`
}

export class WorkflowRunner extends AgentParticipant {
  readonly definition: WorkflowDefinition
  private readonly hub: HubLike
  private readonly runStore: RunStore | null
  private readonly idGen: () => string
  private readonly now: () => number
  /**
   * Pre-compiled `when` predicates per step id. Empty entries mean the
   * step has no `when`. Compiled once at construction so dispatch-time
   * is just a tree walk; bad predicates would have already been caught
   * by the schema validator at parseWorkflow time.
   */
  private readonly whenPredicates = new Map<string, CompiledPredicate>()

  constructor(opts: WorkflowRunnerOptions) {
    super({
      id: workflowParticipantId(opts.definition.id),
      capabilities: [opts.definition.trigger.capability],
    })
    this.definition = opts.definition
    this.hub = opts.hub
    this.runStore = opts.runStore ?? null
    this.idGen = opts.idGenerator ?? (() => randomUUID())
    this.now = opts.now ?? (() => Date.now())
    for (const step of opts.definition.steps) {
      if (step.when) {
        this.whenPredicates.set(step.id, parsePredicate(step.when))
      }
    }
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const runId = this.idGen()
    const state: RunState = {
      runId,
      workflowId: this.definition.id,
      triggeredByTaskId: task.id,
      triggerPayload: task.payload,
      steps: [],
      startedAt: this.now(),
      status: 'running',
    }
    await this.persist(state)

    const ctx: ResolutionContext = {
      triggerPayload: task.payload,
      stepOutputs: new Map<string, unknown>(),
    }
    const workflowFailureMode: 'halt' | 'continue' = this.definition.onFailure ?? 'halt'

    let lastStepOutput: unknown = undefined
    for (const step of this.definition.steps) {
      const record = await this.runStep(step, ctx, state)
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
          throw new Error(state.error)
        }
        // continue mode — record it, leave output undefined, move on
        ctx.stepOutputs.set(step.id, undefined)
      } else if (record.status === 'skipped') {
        ctx.stepOutputs.set(step.id, undefined)
      }
    }

    // Compute final output.
    let finalOutput: unknown
    if (this.definition.output !== undefined) {
      finalOutput = resolveRefs(this.definition.output, ctx)
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
    step: Step,
    ctx: ResolutionContext,
    _runState: RunState,
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
    const pred = this.whenPredicates.get(step.id)
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

    if ('parallel' in step && step.parallel === true) {
      return this.runParallelStep(step, ctx, record)
    }
    return this.runSimpleStep(step as SimpleStep, ctx, record)
  }

  private async runSimpleStep(
    step: SimpleStep,
    ctx: ResolutionContext,
    record: StepRecord,
  ): Promise<StepRecord> {
    const policy: StepFailurePolicy = step.onFailure ?? { action: 'halt' }
    const maxAttempts = policy.action === 'retry' ? policy.max + 1 : 1

    let lastError = 'unknown'
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      record.attempts = attempt
      const result = await this.dispatchOne(step.dispatch, ctx)
      record.subTaskIds.push(result.taskId)
      if (result.kind === 'ok') {
        record.status = 'done'
        record.output = result.output
        record.endedAt = this.now()
        return record
      }
      lastError = describeFailure(result)
    }

    // out of attempts
    record.endedAt = this.now()
    if (policy.action === 'continue') {
      record.status = 'skipped'
      record.error = lastError
      return record
    }
    record.status = 'failed'
    record.error = lastError
    return record
  }

  private async runParallelStep(
    step: ParallelStep,
    ctx: ResolutionContext,
    record: StepRecord,
  ): Promise<StepRecord> {
    const policy: StepFailurePolicy = step.onFailure ?? { action: 'halt' }
    record.attempts = 1

    const results = await Promise.all(
      step.branches.map((b) => this.runBranch(b, ctx)),
    )

    const branchOutputs: Record<string, unknown> = {}
    const failures: string[] = []
    for (let i = 0; i < step.branches.length; i++) {
      const branch = step.branches[i]!
      const r = results[i]!
      record.subTaskIds.push(r.taskId)
      if (r.kind === 'ok') {
        branchOutputs[branch.id] = r.output
      } else {
        branchOutputs[branch.id] = undefined
        failures.push(`branch '${branch.id}': ${describeFailure(r)}`)
      }
    }
    record.endedAt = this.now()
    record.output = branchOutputs

    if (failures.length === 0) {
      record.status = 'done'
      return record
    }

    // Retry policy at the parallel level retries the whole step. Keep it
    // simple in v0.1: a parallel `retry` means "re-run the whole fan-out".
    if (policy.action === 'retry') {
      let remaining = policy.max
      while (remaining > 0 && failures.length > 0) {
        remaining -= 1
        record.attempts += 1
        const retryResults = await Promise.all(
          step.branches.map((b) => this.runBranch(b, ctx)),
        )
        failures.length = 0
        for (let i = 0; i < step.branches.length; i++) {
          const branch = step.branches[i]!
          const r = retryResults[i]!
          record.subTaskIds.push(r.taskId)
          if (r.kind === 'ok') {
            branchOutputs[branch.id] = r.output
          } else {
            failures.push(`branch '${branch.id}': ${describeFailure(r)}`)
          }
        }
      }
      if (failures.length === 0) {
        record.status = 'done'
        return record
      }
    }

    if (policy.action === 'continue') {
      record.status = 'skipped'
      record.error = failures.join('; ')
      return record
    }
    record.status = 'failed'
    record.error = failures.join('; ')
    return record
  }

  private async runBranch(
    branch: Branch,
    ctx: ResolutionContext,
  ): Promise<TaskResult> {
    return this.dispatchOne(branch.dispatch, ctx)
  }

  private async dispatchOne(
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
    return this.hub.dispatch(opts)
  }

  // --- persistence wrapper --------------------------------------------------

  private async persist(state: RunState): Promise<void> {
    if (!this.runStore) return
    this.runStore.ensureDirs()
    await this.runStore.write(state)
  }
}

function describeFailure(r: TaskResult): string {
  if (r.kind === 'failed') return r.error
  if (r.kind === 'cancelled') return `cancelled: ${r.reason}`
  if (r.kind === 'no_participant') return `no participant: ${r.reason}`
  return 'unexpected ok in failure path'
}
