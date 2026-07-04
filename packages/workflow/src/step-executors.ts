/**
 * Step-execution strategies (R7 — the `StepExecutor` seam).
 *
 * `WorkflowRunner` keeps the kind-AGNOSTIC machinery — the `when` gate, record
 * bootstrap, per-revision binding, persistence, and the resume walk. Everything
 * kind-SPECIFIC (how a step turns into dispatch(es) and how child results fold
 * back into the record) lives behind the {@link StepExecutor} interface, keyed
 * on `Step['kind']`. The runner holds a `Map<kind, StepExecutor>` and delegates;
 * a new control-flow kind (debate / swarm / supervisor) is a new executor + a
 * parser branch that emits the new kind — `runStep` / `refreshSuspendedStepRecord`
 * / `compilePredicates` never grow another `if`.
 *
 * Executors are pure strategy objects: they receive every runtime primitive they
 * need via the per-call {@link StepExecContext} (clock, dispatch, child-result
 * lookup, compiled branch predicates), so they hold no reference to the runner
 * and the framework's zero-LLM nature is preserved — an executor only orchestrates
 * `hub.dispatch()` calls, it never decides anything itself.
 */

import { type TaskId, type TaskResult } from '@gotong/core'

import type { CompiledPredicate } from './predicate.js'
import type { ResolutionContext } from './resolver.js'
import type {
  Branch,
  DispatchSpec,
  ParallelStep,
  SimpleStep,
  Step,
  StepFailurePolicy,
  StepRecord,
} from './types.js'

/**
 * The narrow, run-scoped surface a {@link StepExecutor} may use. Built fresh by
 * the runner for each step, closing over that run's resolution context and
 * revision-bound predicates — so an executor never sees the runner itself, the
 * `RunDefn`, or any other step's state.
 */
export interface StepExecContext {
  /** Ref-resolution context for `$step.output` / `$trigger.payload` and `when`. */
  readonly ctx: ResolutionContext
  /** Injectable clock (deterministic in tests). */
  now(): number
  /** Fire one `hub.dispatch()` (refs resolved, origin/ancestry/data-classes stamped). */
  dispatchOne(spec: DispatchSpec): Promise<TaskResult>
  /** Read a child task's terminal/suspended result on resume (`hub.taskResult`). */
  taskResult(taskId: TaskId): TaskResult | undefined
  /** Compiled `when` predicate for a branch of THIS step (parallel-like kinds). */
  branchPredicate(branchId: string): CompiledPredicate | undefined
}

/**
 * Strategy for one step KIND. `run` executes a fresh step (the `when` gate has
 * already passed and `record` is bootstrapped to `running`); `refreshSuspended`
 * re-folds a suspended step's child task(s) on resume. Both mutate `record` in
 * place and (for `run`) return it.
 */
export interface StepExecutor {
  /** The `Step['kind']` this executor handles. */
  readonly kind: string
  run(step: Step, record: StepRecord, x: StepExecContext): Promise<StepRecord>
  refreshSuspended(step: Step, record: StepRecord, x: StepExecContext): void
}

// --- simple ---------------------------------------------------------------

/** A plain capability/explicit dispatch — one `hub.dispatch()`, with retry. */
export class SimpleStepExecutor implements StepExecutor {
  readonly kind = 'simple'

  async run(step: Step, record: StepRecord, x: StepExecContext): Promise<StepRecord> {
    const s = step as SimpleStep
    const policy: StepFailurePolicy = s.onFailure ?? { action: 'halt' }
    const maxAttempts = policy.action === 'retry' ? policy.max + 1 : 1

    let lastError = 'unknown'
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      record.attempts = attempt
      const result = await x.dispatchOne(s.dispatch)
      record.subTaskIds.push(result.taskId)
      if (result.kind === 'ok') {
        record.status = 'done'
        record.output = result.output
        // v5 G day-3 — stamp WHO executed this step (peer-agnostic id). The host
        // resolves whether it's a peer to render the post-launch cross-hub hop.
        record.executedBy = result.by
        // v5 G day-5 — and the cross-hub correlation handle (present only when
        // the result crossed a hub boundary), so the host can later fetch this
        // task's transcript from that peer. undefined for same-hub steps.
        if (result.peerTaskId !== undefined) record.peerTaskId = result.peerTaskId
        record.endedAt = x.now()
        return record
      }
      if (result.kind === 'suspended') {
        record.status = 'suspended'
        record.resumeAt = result.resumeAt
        record.error = describeFailure(result)
        record.suspendedTaskIds = [result.taskId]
        // Record the suspending participant too (e.g. a gated peer wrapper), so a
        // run parked at an outbound-approval gate already shows its destination.
        record.executedBy = result.by
        // v5 G day-5 — carry the cross-hub handle through a suspend too (e.g. the
        // peer's own agent parked); same correlation seam as the ok path.
        if (result.peerTaskId !== undefined) record.peerTaskId = result.peerTaskId
        return record
      }
      lastError = describeFailure(result)
    }

    // out of attempts
    record.endedAt = x.now()
    if (policy.action === 'continue') {
      record.status = 'skipped'
      record.error = lastError
      return record
    }
    record.status = 'failed'
    record.error = lastError
    return record
  }

  refreshSuspended(step: Step, record: StepRecord, x: StepExecContext): void {
    const s = step as SimpleStep
    const taskId = record.suspendedTaskIds?.[0] ?? record.subTaskIds.at(-1)
    if (!taskId) {
      record.status = 'failed'
      record.error = `cannot resume suspended step '${record.stepId}' — missing child task id`
      record.endedAt = x.now()
      return
    }
    const result = x.taskResult(taskId)
    if (!result || result.kind === 'suspended') {
      record.status = 'suspended'
      if (result?.kind === 'suspended') record.resumeAt = result.resumeAt
      record.suspendedTaskIds = [taskId]
      return
    }
    const policy: StepFailurePolicy = s.onFailure ?? { action: 'halt' }
    applyChildResultToRecord(record, result, policy, x.now())
  }
}

// --- parallel -------------------------------------------------------------

/** True parallel — all branches dispatched concurrently, all awaited. */
export class ParallelStepExecutor implements StepExecutor {
  readonly kind = 'parallel'

  async run(step: Step, record: StepRecord, x: StepExecContext): Promise<StepRecord> {
    const s = step as ParallelStep
    const policy: StepFailurePolicy = s.onFailure ?? { action: 'halt' }
    record.attempts = 1

    const branchOutputs: Record<string, unknown> = {}
    const suspended: SuspendedBranchTracker = { taskIds: {} }

    let failed = await this.runBranchesInto(s.branches, x, record, branchOutputs, suspended)
    if (Object.keys(suspended.taskIds).length > 0) {
      return this.markParallelSuspended(record, branchOutputs, suspended)
    }

    // A parallel `retry` re-runs ONLY the branches that failed last attempt —
    // never the whole fan-out. Re-dispatching a branch that already succeeded
    // would fire its side effects twice and could even demote a passed branch
    // to failed on a flaky second run. Skipped branches (`when:` false) were
    // never in `failed`, so they stay skipped for free.
    if (policy.action === 'retry') {
      let remaining = policy.max
      while (remaining > 0 && failed.length > 0) {
        remaining -= 1
        record.attempts += 1
        const retrySuspended: SuspendedBranchTracker = { taskIds: {} }
        failed = await this.runBranchesInto(
          failed.map((f) => f.branch),
          x,
          record,
          branchOutputs,
          retrySuspended,
        )
        if (Object.keys(retrySuspended.taskIds).length > 0) {
          return this.markParallelSuspended(record, branchOutputs, retrySuspended)
        }
      }
    }

    record.endedAt = x.now()
    record.output = branchOutputs
    if (failed.length === 0) {
      record.status = 'done'
      return record
    }
    const error = failed.map((f) => f.error).join('; ')
    if (policy.action === 'continue') {
      record.status = 'skipped'
      record.error = error
      return record
    }
    record.status = 'failed'
    record.error = error
    return record
  }

  /**
   * Run `branches` concurrently, fold each outcome into `record` / `branchOutputs`
   * / `suspended`, and return the branches that FAILED (with their error message)
   * so a `retry` pass can re-run exactly those — and only those. Shared by the
   * first attempt and every retry, which is why a retry never touches a branch
   * that already succeeded or was skipped.
   */
  private async runBranchesInto(
    branches: readonly Branch[],
    x: StepExecContext,
    record: StepRecord,
    branchOutputs: Record<string, unknown>,
    suspended: SuspendedBranchTracker,
  ): Promise<Array<{ branch: Branch; error: string }>> {
    const outcomes = await Promise.all(branches.map((b) => this.runBranch(b, x)))
    const failed: Array<{ branch: Branch; error: string }> = []
    for (let i = 0; i < branches.length; i++) {
      const branch = branches[i]!
      const error = this.applyBranchOutcome(branch, outcomes[i]!, record, branchOutputs, suspended)
      if (error !== undefined) failed.push({ branch, error })
    }
    return failed
  }

  refreshSuspended(step: Step, record: StepRecord, x: StepExecContext): void {
    const s = step as ParallelStep
    const branchTaskIds = record.suspendedBranchTaskIds ?? {}
    const branchOutputs = asRecord(record.output)
    const failures: string[] = []
    let nextResumeAt: number | undefined
    const stillSuspended: Record<string, string> = {}

    for (const branch of s.branches) {
      const taskId = branchTaskIds[branch.id]
      if (!taskId) continue
      const result = x.taskResult(taskId)
      if (!result || result.kind === 'suspended') {
        stillSuspended[branch.id] = taskId
        if (result?.kind === 'suspended') {
          nextResumeAt =
            nextResumeAt === undefined ? result.resumeAt : Math.min(nextResumeAt, result.resumeAt)
        }
        continue
      }
      if (result.kind === 'ok') {
        branchOutputs[branch.id] = result.output
        // A branch that suspended (e.g. at an outbound-approval gate) and has now
        // resolved: stamp who ultimately ran it + the cross-hub handle, same as
        // the first-attempt ok path. This is the parallel analog of the simple
        // step's resume fold carrying executedBy through.
        recordBranchExecutor(record, branch.id, result.by, result.peerTaskId)
      } else {
        branchOutputs[branch.id] = undefined
        failures.push(`branch '${branch.id}': ${describeFailure(result)}`)
      }
    }

    if (Object.keys(stillSuspended).length > 0) {
      record.status = 'suspended'
      record.output = branchOutputs
      record.suspendedBranchTaskIds = stillSuspended
      record.suspendedTaskIds = Object.values(stillSuspended)
      const resumeAt = nextResumeAt ?? record.resumeAt
      if (resumeAt !== undefined) record.resumeAt = resumeAt
      return
    }

    delete record.resumeAt
    delete record.suspendedTaskIds
    delete record.suspendedBranchTaskIds
    record.endedAt = x.now()
    record.output = branchOutputs
    if (failures.length === 0) {
      record.status = 'done'
      delete record.error
      return
    }
    const policy: StepFailurePolicy = s.onFailure ?? { action: 'halt' }
    if (policy.action === 'continue') {
      record.status = 'skipped'
      record.error = failures.join('; ')
      return
    }
    record.status = 'failed'
    record.error = failures.join('; ')
  }

  /**
   * Outcome of running one branch. Three shapes:
   *   - `ran`         — the branch dispatched and we got a TaskResult
   *   - `skipped`     — branch-level `when` was false → no dispatch
   *   - `when-error`  — `when` evaluation threw → treated as a failure
   */
  private async runBranch(branch: Branch, x: StepExecContext): Promise<BranchOutcome> {
    const pred = x.branchPredicate(branch.id)
    if (pred) {
      let passed: boolean
      try {
        passed = pred.eval(x.ctx)
      } catch (err) {
        return {
          kind: 'when-error',
          error: `when '${pred.source}' threw: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      if (!passed) {
        return { kind: 'skipped' }
      }
    }
    const result = await x.dispatchOne(branch.dispatch)
    return { kind: 'ran', result }
  }

  /**
   * Funnel ONE branch outcome into the running parallel-step record: write to
   * `branchOutputs`, possibly add a sub-task id, possibly record a suspension.
   * Returns the failure message when the branch failed (so the caller can both
   * surface it and decide whether to retry that branch), or `undefined` when it
   * succeeded, was skipped, or suspended. Shared by the first attempt and retry.
   */
  private applyBranchOutcome(
    branch: Branch,
    outcome: BranchOutcome,
    record: StepRecord,
    branchOutputs: Record<string, unknown>,
    suspended: SuspendedBranchTracker,
  ): string | undefined {
    if (outcome.kind === 'skipped') {
      branchOutputs[branch.id] = undefined
      return undefined
    }
    if (outcome.kind === 'when-error') {
      branchOutputs[branch.id] = undefined
      return `branch '${branch.id}': ${outcome.error}`
    }
    const r = outcome.result
    record.subTaskIds.push(r.taskId)
    if (r.kind === 'ok') {
      branchOutputs[branch.id] = r.output
      recordBranchExecutor(record, branch.id, r.by, r.peerTaskId)
      return undefined
    }
    if (r.kind === 'suspended') {
      branchOutputs[branch.id] = undefined
      suspended.taskIds[branch.id] = r.taskId
      suspended.resumeAt =
        suspended.resumeAt === undefined ? r.resumeAt : Math.min(suspended.resumeAt, r.resumeAt)
      // Stamp the suspending participant (e.g. a gated peer wrapper) so a branch
      // parked at an outbound-approval gate already shows its destination —
      // mirrors the simple step's suspend-path `executedBy` recording.
      recordBranchExecutor(record, branch.id, r.by, r.peerTaskId)
      return undefined
    }
    branchOutputs[branch.id] = undefined
    return `branch '${branch.id}': ${describeFailure(r)}`
  }

  private markParallelSuspended(
    record: StepRecord,
    branchOutputs: Record<string, unknown>,
    suspended: SuspendedBranchTracker,
  ): StepRecord {
    record.status = 'suspended'
    record.output = branchOutputs
    record.suspendedBranchTaskIds = suspended.taskIds
    record.suspendedTaskIds = Object.values(suspended.taskIds)
    if (suspended.resumeAt !== undefined) record.resumeAt = suspended.resumeAt
    record.error = `parallel step suspended waiting for child task(s): ${record.suspendedTaskIds.join(', ')}`
    return record
  }
}

// --- shared helpers -------------------------------------------------------

/** Fold a single child `TaskResult` into a step record (simple-step resume). */
function applyChildResultToRecord(
  record: StepRecord,
  result: TaskResult,
  policy: StepFailurePolicy,
  now: number,
): void {
  delete record.resumeAt
  delete record.suspendedTaskIds
  delete record.suspendedBranchTaskIds
  record.endedAt = now
  if (result.kind === 'ok') {
    record.status = 'done'
    record.output = result.output
    delete record.error
    return
  }
  const error = describeFailure(result)
  if (policy.action === 'continue') {
    record.status = 'skipped'
    record.error = error
    return
  }
  record.status = 'failed'
  record.error = error
}

/**
 * Record one parallel branch's executor attribution onto the step record (PB) —
 * the parallel analog of the simple step's `executedBy` / `peerTaskId` stamping.
 * Called for a branch's ok OR suspended outcome so a branch parked at an
 * outbound-approval gate already shows its destination. Lazily allocates the
 * per-branch maps (absent until a branch actually resolves a participant), and
 * the `peerTaskId` handle only when the branch crossed a hub boundary. Stays
 * peer-AGNOSTIC: just a participant id + opaque handle — the host decides which
 * ids are off-hub at read time, so the workflow package never learns federation.
 */
function recordBranchExecutor(
  record: StepRecord,
  branchId: string,
  by: string,
  peerTaskId: string | undefined,
): void {
  ;(record.branchExecutedBy ??= {})[branchId] = by
  if (peerTaskId !== undefined) (record.branchPeerTaskIds ??= {})[branchId] = peerTaskId
}

export function describeFailure(r: TaskResult): string {
  if (r.kind === 'failed') return r.error
  if (r.kind === 'cancelled') return `cancelled: ${r.reason}`
  if (r.kind === 'no_participant') return `no participant: ${r.reason}`
  if (r.kind === 'suspended') return `suspended until ${new Date(r.resumeAt).toISOString()} by ${r.by}`
  return 'unexpected ok in failure path'
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return { ...(value as Record<string, unknown>) }
}

/**
 * Discriminated outcome of `runBranch`. Kept module-private — the
 * parallel step caller funnels each shape into `applyBranchOutcome`.
 */
type BranchOutcome =
  | { kind: 'ran'; result: TaskResult }
  | { kind: 'skipped' }
  | { kind: 'when-error'; error: string }

interface SuspendedBranchTracker {
  taskIds: Record<string, string>
  resumeAt?: number
}
