import { describe, expect, it } from 'vitest'

import { PriorityQueueScheduler } from '../src/priority-scheduler.js'
import type { Scheduler } from '../src/scheduler.js'
import type { Task, TaskResult } from '../src/types.js'

function makeTask(
  id: string,
  opts: { priority?: number; deadlineMs?: number; payload?: unknown } = {},
): Task {
  return {
    id,
    from: 'system',
    strategy: { kind: 'explicit', to: 'a' },
    payload: opts.payload ?? null,
    deadlineMs: opts.deadlineMs,
    priority: opts.priority,
    createdAt: Date.now(),
  }
}

function ok(taskId: string): TaskResult {
  return { kind: 'ok', taskId, by: 'a', output: null, ts: Date.now() }
}

/**
 * Inner scheduler stub: records every dispatch, holds them open until the
 * test resolves them explicitly. Lets tests control ordering precisely.
 */
class ManualScheduler implements Scheduler {
  public dispatchedOrder: string[] = []
  private pending = new Map<string, (r: TaskResult) => void>()
  public delayMs = 0

  dispatch(task: Task): Promise<TaskResult> {
    this.dispatchedOrder.push(task.id)
    return new Promise<TaskResult>((resolve) => {
      const finish = () => {
        this.pending.delete(task.id)
        resolve(ok(task.id))
      }
      this.pending.set(task.id, finish)
      if (this.delayMs > 0) {
        setTimeout(finish, this.delayMs)
      }
    })
  }

  resolve(taskId: string): void {
    const r = this.pending.get(taskId)
    if (r) r()
  }

  resolveAll(): void {
    for (const r of this.pending.values()) r()
    this.pending.clear()
  }
}

describe('PriorityQueueScheduler', () => {
  it('passes a single task through unchanged when nothing is contended', async () => {
    const inner = new ManualScheduler()
    const sched = new PriorityQueueScheduler(inner)
    const p = sched.dispatch(makeTask('t1'))
    // Inner saw it
    expect(inner.dispatchedOrder).toEqual(['t1'])
    inner.resolve('t1')
    const r = await p
    expect(r.kind).toBe('ok')
  })

  it('serializes when maxConcurrent=1 and orders by priority desc among queued tasks', async () => {
    const inner = new ManualScheduler()
    const sched = new PriorityQueueScheduler(inner, { maxConcurrent: 1 })
    // First task locks the only slot; others wait in the queue.
    const p1 = sched.dispatch(makeTask('t-low', { priority: 0 }))
    // Give the scheduler a microtask to start the first one.
    await Promise.resolve()
    expect(inner.dispatchedOrder).toEqual(['t-low'])

    // Three more tasks arrive in low->high priority order.
    const p2 = sched.dispatch(makeTask('t-mid', { priority: 5 }))
    const p3 = sched.dispatch(makeTask('t-high', { priority: 10 }))
    const p4 = sched.dispatch(makeTask('t-also-mid', { priority: 5 }))
    // None of them should have hit the inner yet.
    await Promise.resolve()
    expect(inner.dispatchedOrder).toEqual(['t-low'])

    // Release t-low; the scheduler should dispatch t-high next, then a t-mid pair.
    inner.resolve('t-low')
    await p1
    // microtask drain
    await new Promise((r) => setTimeout(r, 5))
    expect(inner.dispatchedOrder).toEqual(['t-low', 't-high'])
    inner.resolve('t-high')
    await p3
    await new Promise((r) => setTimeout(r, 5))
    // ties: 't-mid' arrived before 't-also-mid', so should run first
    expect(inner.dispatchedOrder).toEqual(['t-low', 't-high', 't-mid'])
    inner.resolve('t-mid')
    await p2
    await new Promise((r) => setTimeout(r, 5))
    expect(inner.dispatchedOrder).toEqual(['t-low', 't-high', 't-mid', 't-also-mid'])
    inner.resolve('t-also-mid')
    await p4
  })

  it('respects maxConcurrent — never more than N in flight', async () => {
    const inner = new ManualScheduler()
    const sched = new PriorityQueueScheduler(inner, { maxConcurrent: 2 })
    const ps = [
      sched.dispatch(makeTask('t1')),
      sched.dispatch(makeTask('t2')),
      sched.dispatch(makeTask('t3')),
      sched.dispatch(makeTask('t4')),
    ]
    await Promise.resolve()
    // first two should be in flight
    expect(inner.dispatchedOrder).toEqual(['t1', 't2'])
    expect(sched.inflight()).toBe(2)
    expect(sched.size()).toBe(2)
    inner.resolve('t1')
    await ps[0]
    await new Promise((r) => setTimeout(r, 5))
    // one slot freed -> t3 starts
    expect(inner.dispatchedOrder).toEqual(['t1', 't2', 't3'])
    inner.resolveAll()
    await new Promise((r) => setTimeout(r, 5))
    // t2 + t3 resolved -> t4 was just dispatched and is now pending. Drain it.
    inner.resolveAll()
    await Promise.all(ps)
    expect(inner.dispatchedOrder).toEqual(['t1', 't2', 't3', 't4'])
  })

  it('rejects a task whose deadline is already in the past at submit time', async () => {
    const inner = new ManualScheduler()
    const sched = new PriorityQueueScheduler(inner)
    const result = await sched.dispatch(
      makeTask('expired', { deadlineMs: Date.now() - 1000 }),
    )
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toBe('deadline_expired')
      expect(result.by).toBe('scheduler')
    }
    expect(inner.dispatchedOrder).toEqual([])
  })

  it("rejects a task whose deadline expires while it's waiting in the queue", async () => {
    const inner = new ManualScheduler()
    const sched = new PriorityQueueScheduler(inner, { maxConcurrent: 1 })
    // Lock the slot with a task that won't finish.
    const p1 = sched.dispatch(makeTask('blocker'))
    // Queue a doomed one — deadline is 40ms out, but blocker holds the slot indefinitely.
    const p2 = sched.dispatch(makeTask('doomed', { deadlineMs: Date.now() + 40 }))
    // Wait past the deadline, then release the blocker so the queue flushes.
    await new Promise((r) => setTimeout(r, 80))
    inner.resolve('blocker')
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.kind).toBe('ok')
    expect(r2.kind).toBe('failed')
    if (r2.kind === 'failed') {
      expect(r2.error).toBe('deadline_expired_while_queued')
    }
    // doomed never reached the inner scheduler
    expect(inner.dispatchedOrder).toEqual(['blocker'])
  })

  it('throws when constructed with maxConcurrent <= 0', () => {
    const inner = new ManualScheduler()
    expect(() => new PriorityQueueScheduler(inner, { maxConcurrent: 0 })).toThrow(
      /maxConcurrent/,
    )
    expect(() => new PriorityQueueScheduler(inner, { maxConcurrent: -2 })).toThrow(
      /maxConcurrent/,
    )
  })

  it('forwards inner-scheduler errors as failed TaskResults', async () => {
    const failing: Scheduler = {
      dispatch: () => Promise.reject(new Error('inner blew up')),
    }
    const sched = new PriorityQueueScheduler(failing)
    const r = await sched.dispatch(makeTask('t1'))
    expect(r.kind).toBe('failed')
    if (r.kind === 'failed') {
      expect(r.error).toContain('inner blew up')
      expect(r.by).toBe('scheduler')
    }
  })

  it('passes priority and deadline through unchanged on the Task type', () => {
    const t = makeTask('t1', { priority: 7, deadlineMs: Date.now() + 1000 })
    expect(t.priority).toBe(7)
    expect(t.deadlineMs).toBeGreaterThan(Date.now())
  })
})
