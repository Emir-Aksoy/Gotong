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
      // Re-throw suspend so an agent can chain `suspendAgain` — useful
      // when the wake-up condition still isn't met and the agent wants
      // to sleep another window.
      if (err instanceof SuspendTaskError) throw err
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
