import type {
  Message,
  Participant,
  ParticipantId,
  Task,
  TaskId,
  TaskResult,
} from '../types.js'

export interface HumanOptions {
  id: ParticipantId
  capabilities?: readonly string[]
}

interface PendingEntry {
  task: Task
  resolve: (r: TaskResult) => void
}

/**
 * Base class for human participants. The defining trait of a human is that
 * the response is asynchronous and externally driven: when the Hub calls
 * `onTask`, the call doesn't return until something outside (a UI, a CLI
 * prompt, a chat reply) tells it what the human decided.
 *
 * The base class implements this by parking each incoming task in a pending
 * map and resolving it lazily when an adapter calls `complete()` or
 * `reject()`. Adapters can also pull tasks off the FIFO via `next()`.
 *
 * The class is intentionally non-abstract — you can `new HumanParticipant`
 * directly for tests and demos. Real UI adapters subclass it.
 */
export class HumanParticipant implements Participant {
  readonly id: ParticipantId
  readonly kind = 'human' as const
  readonly capabilities: readonly string[]

  private readonly pendingTasks = new Map<TaskId, PendingEntry>()
  private readonly queue: Task[] = []
  private readonly waiters: Array<(task: Task) => void> = []

  constructor(opts: HumanOptions) {
    this.id = opts.id
    this.capabilities = opts.capabilities ?? []
  }

  // --- Participant interface ------------------------------------------------

  onTask(task: Task): Promise<TaskResult> {
    return new Promise<TaskResult>((resolve) => {
      this.pendingTasks.set(task.id, { task, resolve })
      const waiter = this.waiters.shift()
      if (waiter) {
        waiter(task)
      } else {
        this.queue.push(task)
      }
      this.onTaskAvailable(task)
    })
  }

  onTaskCancelled(taskId: TaskId, reason: string): void {
    const entry = this.pendingTasks.get(taskId)
    if (!entry) return
    this.pendingTasks.delete(taskId)
    const qi = this.queue.findIndex((t) => t.id === taskId)
    if (qi >= 0) this.queue.splice(qi, 1)
    entry.resolve({ kind: 'cancelled', taskId, reason, ts: Date.now() })
  }

  async onMessage(msg: Message): Promise<void> {
    this.onMessageAvailable(msg)
  }

  // --- adapter-facing API ---------------------------------------------------

  /**
   * Returns the next pending task in FIFO order. If none are pending, waits
   * until one arrives. Used by CLI / UI loops.
   */
  next(): Promise<Task> {
    const head = this.queue.shift()
    if (head) return Promise.resolve(head)
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  pending(): Task[] {
    return [...this.pendingTasks.values()].map((e) => e.task)
  }

  /** Resolve a pending task as successful with the given output. */
  complete(taskId: TaskId, output: unknown): boolean {
    const entry = this.pendingTasks.get(taskId)
    if (!entry) return false
    this.pendingTasks.delete(taskId)
    entry.resolve({ kind: 'ok', taskId, by: this.id, output, ts: Date.now() })
    return true
  }

  /** Resolve a pending task as failed with the given reason. */
  reject(taskId: TaskId, error: string): boolean {
    const entry = this.pendingTasks.get(taskId)
    if (!entry) return false
    this.pendingTasks.delete(taskId)
    entry.resolve({ kind: 'failed', taskId, by: this.id, error, ts: Date.now() })
    return true
  }

  // --- hooks for subclasses (UI adapters) ----------------------------------

  /** Called when a new task arrives. Override to push to a UI. */
  protected onTaskAvailable(_task: Task): void {
    return
  }

  /** Called when a channel message arrives. Override to display it. */
  protected onMessageAvailable(_msg: Message): void {
    return
  }
}
