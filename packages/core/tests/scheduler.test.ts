import { describe, expect, it, vi } from 'vitest'

import { Registry } from '../src/registry.js'
import {
  DefaultScheduler,
  type CancelNotifier,
  type TaskInvoker,
} from '../src/scheduler.js'
import type {
  DispatchStrategy,
  Participant,
  Task,
  TaskResult,
} from '../src/types.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function makeTask(strategy: DispatchStrategy, id = 't-1'): Task {
  return {
    id,
    from: 'system',
    strategy,
    payload: {},
    createdAt: Date.now(),
  }
}

function makeAgent(
  id: string,
  capabilities: readonly string[] = [],
  hasOnTask = true,
): Participant {
  const p: Participant = {
    id,
    kind: 'agent',
    capabilities,
  }
  if (hasOnTask) {
    // attach an onTask so registry-side checks see it. Actual responses come
    // from the mocked invoker, not this stub.
    p.onTask = async () => ({
      kind: 'ok',
      taskId: 'unused',
      by: id,
      output: null,
      ts: Date.now(),
    })
  }
  return p
}

describe('DefaultScheduler', () => {
  it('explicit to a nonexistent id returns no_participant', async () => {
    const registry = new Registry()
    const invoke = vi.fn<Parameters<TaskInvoker>, ReturnType<TaskInvoker>>()
    const notifyCancel: CancelNotifier = () => {}
    const s = new DefaultScheduler(registry, invoke, notifyCancel)

    const result = await s.dispatch(makeTask({ kind: 'explicit', to: 'ghost' }))
    expect(result.kind).toBe('no_participant')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('explicit to a participant without onTask returns no_participant', async () => {
    const registry = new Registry()
    registry.register(makeAgent('a', [], false))
    const invoke = vi.fn<Parameters<TaskInvoker>, ReturnType<TaskInvoker>>()
    const s = new DefaultScheduler(registry, invoke, () => {})

    const result = await s.dispatch(makeTask({ kind: 'explicit', to: 'a' }))
    expect(result.kind).toBe('no_participant')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('explicit happy path returns ok', async () => {
    const registry = new Registry()
    const agent = makeAgent('a')
    registry.register(agent)
    const invoke: TaskInvoker = async (p, task) => ({
      kind: 'ok',
      taskId: task.id,
      by: p.id,
      output: 42,
      ts: Date.now(),
    })
    const s = new DefaultScheduler(registry, invoke, () => {})

    const result = await s.dispatch(makeTask({ kind: 'explicit', to: 'a' }))
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('a')
      expect(result.output).toBe(42)
    }
  })

  it('capability with no eligible participant returns no_participant', async () => {
    const registry = new Registry()
    registry.register(makeAgent('a', ['draft']))
    const invoke = vi.fn<Parameters<TaskInvoker>, ReturnType<TaskInvoker>>()
    const s = new DefaultScheduler(registry, invoke, () => {})

    const result = await s.dispatch(
      makeTask({ kind: 'capability', capabilities: ['review'] }),
    )
    expect(result.kind).toBe('no_participant')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('capability picks the least-loaded eligible participant', async () => {
    const registry = new Registry()
    registry.register(makeAgent('busy', ['draft']))
    registry.register(makeAgent('idle', ['draft']))
    registry.incLoad('busy')
    registry.incLoad('busy')
    registry.incLoad('idle')

    const invoke = vi.fn<Parameters<TaskInvoker>, ReturnType<TaskInvoker>>(
      async (p, task) => ({
        kind: 'ok',
        taskId: task.id,
        by: p.id,
        output: null,
        ts: Date.now(),
      }),
    )
    const s = new DefaultScheduler(registry, invoke, () => {})

    const result = await s.dispatch(
      makeTask({ kind: 'capability', capabilities: ['draft'] }),
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('idle')
    }
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0]?.[0].id).toBe('idle')
  })

  it('broadcast: first ok wins; other candidates receive notifyCancel', async () => {
    const registry = new Registry()
    registry.register(makeAgent('a', ['x']))
    registry.register(makeAgent('b', ['x']))
    registry.register(makeAgent('c', ['x']))

    const invoke: TaskInvoker = async (p, task) => {
      if (p.id === 'a') {
        await sleep(50)
        return {
          kind: 'ok',
          taskId: task.id,
          by: p.id,
          output: 'first',
          ts: Date.now(),
        }
      }
      await sleep(150)
      return {
        kind: 'ok',
        taskId: task.id,
        by: p.id,
        output: 'late',
        ts: Date.now(),
      }
    }
    const cancelled: Array<{ id: string; taskId: string; reason: string }> = []
    const notifyCancel: CancelNotifier = (id, taskId, reason) => {
      cancelled.push({ id, taskId, reason })
    }
    const s = new DefaultScheduler(registry, invoke, notifyCancel)

    const result = await s.dispatch(
      makeTask({ kind: 'broadcast', capabilities: ['x'] }),
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(result.by).toBe('a')
    expect(cancelled.map((c) => c.id).sort()).toEqual(['b', 'c'])
    for (const c of cancelled) {
      expect(c.taskId).toBe('t-1')
      expect(c.reason).toMatch(/lost broadcast/)
    }
  })

  it('broadcast: every candidate failing -> final result is failed', async () => {
    const registry = new Registry()
    registry.register(makeAgent('a'))
    registry.register(makeAgent('b'))

    const invoke: TaskInvoker = async (p, task) => ({
      kind: 'failed',
      taskId: task.id,
      by: p.id,
      error: `${p.id} no good`,
      ts: Date.now(),
    })
    const cancelled = vi.fn<Parameters<CancelNotifier>, ReturnType<CancelNotifier>>()
    const s = new DefaultScheduler(registry, invoke, cancelled)

    const result = await s.dispatch(makeTask({ kind: 'broadcast' }))
    expect(result.kind).toBe('failed')
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('broadcast with zero eligible candidates returns no_participant', async () => {
    const registry = new Registry()
    // register an agent but require a capability it lacks
    registry.register(makeAgent('a', ['draft']))
    const invoke = vi.fn<Parameters<TaskInvoker>, ReturnType<TaskInvoker>>()
    const s = new DefaultScheduler(registry, invoke, () => {})

    const result = await s.dispatch(
      makeTask({ kind: 'broadcast', capabilities: ['nope'] }),
    )
    expect(result.kind).toBe('no_participant')
    expect(invoke).not.toHaveBeenCalled()
  })

  // Task.deadlineMs is a wire-type contract since v0.7: a task already past
  // its absolute deadline must NEVER reach a participant. Folded into
  // DefaultScheduler by the 2026-06 audit (was PriorityQueueScheduler-only).
  describe('deadlineMs enforcement', () => {
    it('a task past its deadline fails with deadline_expired before any invoke', async () => {
      const registry = new Registry()
      registry.register(makeAgent('a'))
      const invoke = vi.fn<Parameters<TaskInvoker>, ReturnType<TaskInvoker>>()
      const s = new DefaultScheduler(registry, invoke, () => {})

      const task = makeTask({ kind: 'explicit', to: 'a' })
      const expired: Task = { ...task, deadlineMs: Date.now() - 1 }
      const result = await s.dispatch(expired)
      expect(result.kind).toBe('failed')
      if (result.kind === 'failed') {
        expect(result.error).toBe('deadline_expired')
        expect(result.by).toBe('scheduler')
      }
      expect(invoke).not.toHaveBeenCalled()
    })

    it('a task with a future deadline dispatches normally', async () => {
      const registry = new Registry()
      const agent = makeAgent('a')
      registry.register(agent)
      const invoke: TaskInvoker = async (p, task) => ({
        kind: 'ok',
        taskId: task.id,
        by: p.id,
        output: 'done',
        ts: Date.now(),
      })
      const s = new DefaultScheduler(registry, invoke, () => {})

      const task = makeTask({ kind: 'explicit', to: 'a' })
      const fresh: Task = { ...task, deadlineMs: Date.now() + 60_000 }
      const result = await s.dispatch(fresh)
      expect(result.kind).toBe('ok')
    })

    it('a task without a deadline is unaffected', async () => {
      const registry = new Registry()
      registry.register(makeAgent('a'))
      const invoke: TaskInvoker = async (p, task) => ({
        kind: 'ok',
        taskId: task.id,
        by: p.id,
        output: null,
        ts: Date.now(),
      })
      const s = new DefaultScheduler(registry, invoke, () => {})

      const result = await s.dispatch(makeTask({ kind: 'explicit', to: 'a' }))
      expect(result.kind).toBe('ok')
    })
  })
})
