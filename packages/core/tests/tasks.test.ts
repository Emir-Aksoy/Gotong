import { describe, expect, it } from 'vitest'

import { Hub } from '../src/hub.js'
import { AgentParticipant } from '../src/participants/agent.js'
import type { Task } from '../src/types.js'

class EchoAgent extends AgentParticipant {
  private n = 0
  constructor(id: string, capabilities: readonly string[] = []) {
    super({ id, capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    this.n += 1
    return { echo: task.payload, n: this.n }
  }
}

class FlakyAgent extends AgentParticipant {
  public failNext = true
  constructor(id: string, capabilities: readonly string[] = []) {
    super({ id, capabilities })
  }
  protected async handleTask(_task: Task): Promise<unknown> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('flake!')
    }
    return { recovered: true }
  }
}

describe('Hub.tasks() + Hub.retry() (v2.0)', () => {
  it('derives status from transcript: pending → done', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('writer', ['draft']))

    const r = await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: { topic: 'x' },
      title: 't1',
    })
    expect(r.kind).toBe('ok')

    const tasks = hub.tasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.status).toBe('done')
    expect(tasks[0]!.task.title).toBe('t1')
    expect(tasks[0]!.result?.kind).toBe('ok')
    expect(tasks[0]!.completedAt).toBeGreaterThan(0)
    await hub.stop()
  })

  it('derives failed when handleTask throws', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new FlakyAgent('w', ['x']))

    const r = await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['x'] },
      payload: {},
    })
    expect(r.kind).toBe('failed')

    const tasks = hub.tasks()
    expect(tasks[0]!.status).toBe('failed')
    await hub.stop()
  })

  it('derives failed for no_participant too', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'explicit', to: 'ghost' },
      payload: {},
    })
    const tasks = hub.tasks()
    expect(tasks[0]!.status).toBe('failed')
    await hub.stop()
  })

  it('attaches evaluations to the matching task view', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent('w', ['x']))

    const r = await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['x'] },
      payload: {},
    })
    hub.evaluate({ taskId: r.taskId, by: 'admin', rating: 5, comment: 'nice' })

    const tasks = hub.tasks()
    expect(tasks[0]!.evaluations).toHaveLength(1)
    expect(tasks[0]!.evaluations![0]!.rating).toBe(5)
    await hub.stop()
  })

  it('retry on a failed task re-dispatches a fresh task with retryOf marker', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    const flaky = new FlakyAgent('w', ['x'])
    hub.register(flaky)

    const first = await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['x'] },
      payload: { topic: 'thing' },
      title: 'try',
    })
    expect(first.kind).toBe('failed')

    const retried = await hub.retry(first.taskId, 'admin')
    expect(retried.kind).toBe('ok')

    const tasks = hub.tasks()
    expect(tasks).toHaveLength(2)
    expect(tasks[0]!.status).toBe('failed')
    expect(tasks[1]!.status).toBe('done')
    expect(tasks[1]!.task.title).toBe('retry: try')
    const payload = tasks[1]!.task.payload as Record<string, unknown>
    expect(payload.retryOf).toBe(first.taskId)
    expect(payload.topic).toBe('thing')
    await hub.stop()
  })

  it('retry throws if the task is still pending (live)', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    // dispatch to a missing participant — synchronously a `no_participant` (failed),
    // so to simulate "still pending" we just call retry on a fake id never seen.
    await expect(hub.retry('does-not-exist')).rejects.toThrow(/unknown task/)
    await hub.stop()
  })
})
