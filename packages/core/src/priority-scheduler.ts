import type { Scheduler } from './scheduler.js'
import type { Task, TaskResult } from './types.js'

export interface PriorityQueueSchedulerOptions {
  /**
   * Maximum number of tasks the inner scheduler is allowed to dispatch
   * concurrently. Tasks past this cap wait in the priority queue.
   *
   * Default: `Infinity` (no concurrency limit — pure priority ordering).
   *
   * Tip: set to `1` to serialize, or to N to let at most N tasks run at
   * once globally. Per-participant fairness is the inner scheduler's job;
   * this layer is global.
   */
  maxConcurrent?: number
}

interface QueueEntry {
  task: Task
  enqueuedAt: number
  resolve: (r: TaskResult) => void
}

/**
 * Scheduler wrapper that adds two things on top of an existing one:
 *
 *   1. **Priority ordering.** Tasks waiting in the queue are dispatched in
 *      `(priority desc, createdAt asc)` order — higher-priority tasks jump
 *      the queue but ties preserve FIFO. Tasks without a `priority` field
 *      default to 0.
 *
 *   2. **Deadline enforcement.** A task whose `deadlineMs` is already in
 *      the past at submit-time or at dequeue-time resolves immediately as
 *      `{ kind: 'failed', error: 'deadline_expired'... }` without touching
 *      a participant. Lets you set "best-effort within 5s" semantics.
 *
 * The inner scheduler (typically `DefaultScheduler`) does the actual
 * routing — explicit, capability, broadcast — unchanged. This wrapper just
 * controls *when* it gets called.
 *
 * Concurrency: `maxConcurrent` bounds how many tasks may be in flight at
 * any moment. Default is `Infinity` (no cap; the queue is just the
 * priority lane). Set to `1` for strict serial behavior, or to a finite N
 * for back-pressure.
 *
 * Usage:
 *
 * ```ts
 * import { Hub, Space, DefaultScheduler, PriorityQueueScheduler } from '@aipehub/core'
 *
 * const { space } = await Space.openOrInit('./.aipehub', { name: 'demo' })
 * const hub = new Hub({
 *   space,
 *   schedulerFactory: (registry, invoke, notifyCancel) =>
 *     new PriorityQueueScheduler(
 *       new DefaultScheduler(registry, invoke, notifyCancel),
 *       { maxConcurrent: 4 },
 *     ),
 * })
 * ```
 */
export class PriorityQueueScheduler implements Scheduler {
  private readonly queue: QueueEntry[] = []
  private running = 0
  private readonly maxConcurrent: number

  constructor(
    private readonly inner: Scheduler,
    opts: PriorityQueueSchedulerOptions = {},
  ) {
    this.maxConcurrent = opts.maxConcurrent ?? Infinity
    if (this.maxConcurrent <= 0) {
      throw new Error(
        `PriorityQueueScheduler: maxConcurrent must be > 0, got ${this.maxConcurrent}`,
      )
    }
  }

  dispatch(task: Task): Promise<TaskResult> {
    if (isExpired(task)) {
      return Promise.resolve(deadlineExpired(task.id, 'submit'))
    }
    return new Promise<TaskResult>((resolve) => {
      this.queue.push({ task, enqueuedAt: Date.now(), resolve })
      // Stable-sort by (priority desc, enqueuedAt asc).
      // Array.prototype.sort is stable in modern V8 / Node 20+, so equal
      // priorities preserve enqueue order automatically — but we sort by
      // a tuple anyway for defence-in-depth across runtimes.
      this.queue.sort((a, b) => {
        const pa = a.task.priority ?? 0
        const pb = b.task.priority ?? 0
        if (pa !== pb) return pb - pa
        return a.enqueuedAt - b.enqueuedAt
      })
      this.tryFlush()
    })
  }

  /** Read-only snapshot of the current queue depth (after deadline drops). */
  size(): number {
    return this.queue.length
  }

  /** Read-only count of tasks currently in flight in the inner scheduler. */
  inflight(): number {
    return this.running
  }

  // --- internals -----------------------------------------------------------

  private tryFlush(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift()!
      const { task, resolve } = entry
      // Deadline may have passed while the task was queued.
      if (isExpired(task)) {
        resolve(deadlineExpired(task.id, 'queue'))
        continue
      }
      this.running++
      this.inner
        .dispatch(task)
        .then(
          (result) => resolve(result),
          (err) =>
            resolve({
              kind: 'failed',
              taskId: task.id,
              by: 'scheduler',
              error: err instanceof Error ? err.message : String(err),
              ts: Date.now(),
            }),
        )
        .finally(() => {
          this.running--
          // Recurse via microtask to flush the next item without deepening
          // the stack on bursty workloads.
          queueMicrotask(() => this.tryFlush())
        })
    }
  }
}

function isExpired(task: Task): boolean {
  return task.deadlineMs !== undefined && Date.now() > task.deadlineMs
}

function deadlineExpired(
  taskId: string,
  phase: 'submit' | 'queue',
): TaskResult {
  return {
    kind: 'failed',
    taskId,
    by: 'scheduler',
    error: phase === 'submit' ? 'deadline_expired' : 'deadline_expired_while_queued',
    ts: Date.now(),
  }
}
