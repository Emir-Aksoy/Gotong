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

  // result helpers --------------------------------------------------------

  protected ok(taskId: TaskId, output: unknown): TaskResult {
    return { kind: 'ok', taskId, by: this.id, output, ts: Date.now() }
  }

  protected fail(taskId: TaskId, error: string): TaskResult {
    return { kind: 'failed', taskId, by: this.id, error, ts: Date.now() }
  }
}
