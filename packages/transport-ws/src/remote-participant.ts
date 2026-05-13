import type {
  Message,
  Participant,
  ParticipantId,
  Task,
  TaskId,
  TaskResult,
} from '@aipehub/core'
import type { ServerFrame } from '@aipehub/protocol'

interface PendingTask {
  resolve: (r: TaskResult) => void
}

/**
 * A Participant that lives in the Hub's registry but whose work is actually
 * performed across a WebSocket. From the Hub's perspective it looks like
 * any other AgentParticipant; `onTask` writes a TASK frame and parks the
 * promise until a matching RESULT frame comes back.
 *
 * The class is owned by Session — Session creates it on HELLO and disposes
 * it on disconnect via `failAllPending`.
 */
export class RemoteAgentParticipant implements Participant {
  readonly id: ParticipantId
  readonly kind = 'agent' as const
  readonly capabilities: readonly string[]

  private readonly pending = new Map<TaskId, PendingTask>()

  constructor(
    private readonly opts: {
      id: ParticipantId
      capabilities: readonly string[]
      send: (frame: ServerFrame) => void
    },
  ) {
    this.id = opts.id
    this.capabilities = opts.capabilities
  }

  onTask(task: Task): Promise<TaskResult> {
    return new Promise<TaskResult>((resolve) => {
      this.pending.set(task.id, { resolve })
      try {
        this.opts.send({ type: 'TASK', recipient: this.id, task })
      } catch (err) {
        this.pending.delete(task.id)
        resolve({
          kind: 'failed',
          taskId: task.id,
          by: this.id,
          error: err instanceof Error ? err.message : String(err),
          ts: Date.now(),
        })
      }
    })
  }

  async onMessage(msg: Message): Promise<void> {
    this.opts.send({ type: 'MESSAGE', recipient: this.id, msg })
  }

  onTaskCancelled(taskId: TaskId, reason: string): void {
    try {
      this.opts.send({ type: 'CANCEL', recipient: this.id, taskId, reason })
    } catch (err) {
      console.error(`[remote-participant ${this.id}] CANCEL send failed:`, err)
    }
    const entry = this.pending.get(taskId)
    if (entry) {
      this.pending.delete(taskId)
      entry.resolve({ kind: 'cancelled', taskId, reason, ts: Date.now() })
    }
  }

  /** Resolve a pending task with the result that just arrived over the wire. */
  tryResolveTask(result: TaskResult): boolean {
    const entry = this.pending.get(result.taskId)
    if (!entry) return false
    this.pending.delete(result.taskId)
    entry.resolve(result)
    return true
  }

  /** Resolve all pending tasks as failures when the underlying connection dies. */
  failAllPending(reason: string): void {
    for (const [taskId, entry] of this.pending) {
      entry.resolve({
        kind: 'failed',
        taskId,
        by: this.id,
        error: reason,
        ts: Date.now(),
      })
    }
    this.pending.clear()
  }

  pendingCount(): number {
    return this.pending.size
  }
}
