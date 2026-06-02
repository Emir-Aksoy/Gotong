import { SuspendTaskError } from '../suspend.js'
import type {
  Message,
  Participant,
  ParticipantId,
  Task,
  TaskId,
  TaskResult,
} from '../types.js'

export interface AgentOptions {
  id: ParticipantId
  capabilities?: readonly string[]
}

/**
 * Base class for programmatic participants. Subclass it and override
 * `handleTask` and/or `handleMessage` — the base wires those into the
 * Participant interface and handles result envelope construction.
 *
 * Subclasses can also override the `onXxx` methods directly if they need
 * full control.
 */
export abstract class AgentParticipant implements Participant {
  readonly id: ParticipantId
  readonly kind = 'agent' as const
  readonly capabilities: readonly string[]

  constructor(opts: AgentOptions) {
    this.id = opts.id
    this.capabilities = opts.capabilities ?? []
  }

  async onMessage(msg: Message): Promise<void> {
    await this.handleMessage(msg)
  }

  async onTask(task: Task): Promise<TaskResult> {
    try {
      const output = await this.handleTask(task)
      return this.ok(task.id, output)
    } catch (err) {
      // Phase 11 M1 — SuspendTaskError is control flow, not a failure.
      // Re-throw so the scheduler frame above can park the task and
      // release the worker slot. Catching it here would silently turn
      // every suspend into a `failed` result.
      if (err instanceof SuspendTaskError) throw err
      return this.fail(task.id, err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Phase 11 M1 — Resume entry. Called by the scheduler after a
   * previous run threw `SuspendTaskError`. Default behaviour: delegate
   * to `handleResume(task, state)`, which itself defaults to
   * `handleTask(task)` — i.e. agents that don't override get a fresh
   * run, ignoring `state`. This preserves the contract "any agent can
   * be resumed even if it doesn't know it's been suspended."
   */
  async onResume(task: Task, state: unknown): Promise<TaskResult> {
    try {
      const output = await this.handleResume(task, state)
      return this.ok(task.id, output)
    } catch (err) {
      if (err instanceof SuspendTaskError) {
        // L11 — guard against an infinite re-suspend loop. The DEFAULT
        // `handleResume` just re-runs `handleTask` and ignores `state`, so a
        // participant that *suspends* in `handleTask` but never overrode
        // `handleResume` re-suspends identically on every wake — it can never
        // make progress, and the sweep re-parks it forever (a tight loop when
        // `resumeAt <= now`, a silent never-completing park otherwise).
        // Re-suspending on resume is only legitimate when `handleResume` is
        // OVERRIDDEN (heartbeat re-park, inbox re-wait): that path consumes
        // `state` and decides deliberately. The un-overridden default doing it
        // is always a programming error — fail loudly instead of looping.
        if (this.handleResume === AgentParticipant.prototype.handleResume) {
          return this.fail(
            task.id,
            `participant '${this.id}' suspended on resume via the default handleResume ` +
              `(handleTask re-threw SuspendTaskError) — it can never progress. Override ` +
              `handleResume to consume the carried state instead of re-running handleTask.`,
          )
        }
        // Overridden handleResume → a deliberate suspend-again. Re-throw so the
        // scheduler parks it for the next window.
        throw err
      }
      return this.fail(task.id, err instanceof Error ? err.message : String(err))
    }
  }

  onTaskCancelled?(taskId: TaskId, reason: string): void | Promise<void>
  onShutdown?(): void | Promise<void>

  /**
   * Override to consume broadcast / channel messages. Default: ignore.
   */
  protected handleMessage(_msg: Message): void | Promise<void> {
    return
  }

  /**
   * Override to do the actual work and return a result payload. The base
   * class wraps the return value (or thrown error) into a TaskResult.
   * Override `onTask` directly if you need custom envelopes (e.g. partial
   * results or cancellation).
   */
  protected abstract handleTask(task: Task): Promise<unknown> | unknown

  /**
   * Phase 11 M1 — Override to handle resume specially (e.g. read
   * `state` and skip a step that already ran). Default: re-runs
   * `handleTask(task)` from the top. Subclasses that persist working
   * memory (Phase 11 M4) override this to splice state back in.
   */
  protected handleResume(task: Task, _state: unknown): Promise<unknown> | unknown {
    return this.handleTask(task)
  }

  // result helpers --------------------------------------------------------

  protected ok(taskId: TaskId, output: unknown): TaskResult {
    return { kind: 'ok', taskId, by: this.id, output, ts: Date.now() }
  }

  protected fail(taskId: TaskId, error: string): TaskResult {
    return { kind: 'failed', taskId, by: this.id, error, ts: Date.now() }
  }
}
