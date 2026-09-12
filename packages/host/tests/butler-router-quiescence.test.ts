import { SuspendTaskError, type Participant, type Task, type TaskResult } from '@gotong/core'
import { describe, expect, it, vi } from 'vitest'
import { createButlerRouter } from '../src/butler-router.js'
import { ButlerUserActivity } from '../src/butler-user-activity.js'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const task = (userId = 'alice'): Task => ({
  id: 't', from: 'user:x', strategy: { kind: 'explicit', to: 'butler' },
  payload: 'synthetic', origin: { orgId: 'local', userId },
})
const result: TaskResult = { kind: 'ok', taskId: 't', by: 'butler', output: 'private-marker', ts: 1 }
const participant = (extra: Partial<Participant> = {}): Participant => ({
  id: 'butler', kind: 'agent', capabilities: ['chat'], onTask: async () => result, ...extra,
})

describe('router user quiescence', () => {
  it.each(['success', 'error', 'suspend'] as const)('drains tasks and resumes across routers: late %s', async mode => {
    const userActivity = new ButlerUserActivity()
    const a = deferred<TaskResult>()
    const b = deferred<TaskResult>()
    const shutdown = vi.fn()
    const createA = vi.fn((user: string) => participant({ onTask: () => user === 'alice' ? a.promise : Promise.resolve(result), onShutdown: shutdown }))
    const createB = vi.fn(() => participant({ onResume: () => b.promise, onShutdown: shutdown }))
    const one = createButlerRouter({ id: 'one', capabilities: [], userActivity, createForUser: createA })
    const two = createButlerRouter({ id: 'two', capabilities: [], userActivity, createForUser: createB })
    const p = one.onTask!(task()).catch(e => e)
    const r = two.onResume!(task(), { private: 'state' }).catch(e => e)
    const closed = userActivity.quiesce('alice')
    await expect(one.onTask!(task())).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await expect(two.onResume!(task(), {})).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await expect(one.onTask!(task('bob'))).resolves.toBe(result)
    a.resolve(result)
    expect(await p).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(shutdown).not.toHaveBeenCalled()
    if (mode === 'success') b.resolve(result)
    else b.reject(mode === 'suspend' ? new SuspendTaskError({ resumeAt: 1, state: 'private-marker' }) : new Error('private-marker'))
    const error = await r
    expect(error).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(error).not.toHaveProperty('cause')
    expect(error).not.toHaveProperty('state')
    await closed
    expect(shutdown).toHaveBeenCalledTimes(2)
    expect(one.size).toBe(1)
    expect(two.size).toBe(0)
    await expect(two.onTask!(task())).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(createA).toHaveBeenCalledTimes(2)
    expect(createB).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed instance for retirement retry, and uses the hook only for quiescence', async () => {
    const userActivity = new ButlerUserActivity()
    const shutdown = vi.fn()
    const b = participant({ onShutdown: shutdown })
    const retire = vi.fn().mockRejectedValueOnce(new Error('private')).mockResolvedValue(undefined)
    const router = createButlerRouter({ id: 'one', capabilities: [], userActivity, createForUser: () => b, retireForUser: retire })
    await router.onTask!(task())
    expect(retire).not.toHaveBeenCalled()
    await expect(userActivity.quiesce('alice')).rejects.toMatchObject({ code: 'BUTLER_USER_RETIRE_FAILED' })
    expect(router.size).toBe(1)
    await userActivity.quiesce('alice')
    expect(retire).toHaveBeenLastCalledWith('alice', b)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(router.size).toBe(0)
  })

  it.each(['cancel', 'shutdown'] as const)('drains in-flight %s callbacks and prevents later bypass writes', async mode => {
    const userActivity = new ButlerUserActivity()
    const gate = deferred()
    const entered = deferred()
    const alice = vi.fn(async () => { entered.resolve(); await gate.promise })
    const bob = vi.fn()
    const retire = vi.fn()
    const router = createButlerRouter({
      id: 'one', capabilities: [], userActivity, retireForUser: retire,
      createForUser: user => participant(mode === 'cancel'
        ? { onTaskCancelled: user === 'alice' ? alice : bob }
        : { onShutdown: user === 'alice' ? alice : bob }),
    })
    await router.onTask!(task())
    await router.onTask!(task('bob'))
    const invoke = () => mode === 'cancel' ? router.onTaskCancelled!('t', 'stop') : router.onShutdown!()
    const operation = invoke()
    const callback = operation.catch(e => e)
    await entered.promise
    const closed = userActivity.quiesce('alice')
    if (mode === 'shutdown') {
      const again = invoke()
      void again.catch(() => undefined)
      expect(again).toBe(operation)
    }
    else await expect(invoke()).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(alice).toHaveBeenCalledTimes(1)
    expect(bob).toHaveBeenCalledTimes(mode === 'shutdown' ? 0 : 1)
    expect(retire).not.toHaveBeenCalled()
    gate.resolve()
    expect(await callback).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await closed
    expect(bob).toHaveBeenCalledTimes(mode === 'shutdown' ? 1 : 2)
    expect(retire).toHaveBeenCalledTimes(1)
  })

  it('factory failure releases activity and closure rejects before any reconstruction', async () => {
    const userActivity = new ButlerUserActivity()
    const create = vi.fn(() => { throw new Error('factory') })
    const router = createButlerRouter({ id: 'one', capabilities: [], userActivity, createForUser: create })
    await expect(router.onTask!(task())).rejects.toThrow('factory')
    await userActivity.quiesce('alice')
    await expect(router.onResume!(task(), {})).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(router.size).toBe(0)
  })

  it('normal shutdown seals only this router, drains tasks and cancellations, and unregisters after last writes', async () => {
    const activity = new ButlerUserActivity()
    const register = vi.spyOn(activity, 'register')
    const taskGate = deferred()
    const cancelGate = deferred()
    const events: string[] = []
    const shutdown = vi.fn(() => { events.push('shutdown') })
    const create = vi.fn(() => participant({
      onTask: async () => { await taskGate.promise; events.push('task-write'); return result },
      onTaskCancelled: async () => { await cancelGate.promise; events.push('cancel-write') },
      onShutdown: shutdown,
    }))
    const one = createButlerRouter({ id: 'one', capabilities: [], userActivity: activity, createForUser: create })
    const two = createButlerRouter({ id: 'two', capabilities: [], userActivity: activity, createForUser: () => participant() })
    const pending = one.onTask!(task())
    const cancelling = one.onTaskCancelled!('t', 'stop')
    const stopping = one.onShutdown!()
    expect(one.onShutdown!()).toBe(stopping)
    await expect(one.onTask!(task())).rejects.toMatchObject({ code: 'BUTLER_ROUTER_CLOSED' })
    await expect(one.onResume!(task(), {})).rejects.toMatchObject({ code: 'BUTLER_ROUTER_CLOSED' })
    await expect(one.onTaskCancelled!('t', 'stop')).rejects.toMatchObject({ code: 'BUTLER_ROUTER_CLOSED' })
    await expect(two.onTask!(task())).resolves.toBe(result)
    expect(shutdown).not.toHaveBeenCalled()
    taskGate.resolve()
    expect(await pending).toBe(result)
    expect(shutdown).not.toHaveBeenCalled()
    cancelGate.resolve()
    await cancelling
    await stopping
    expect(events).toEqual(['task-write', 'cancel-write', 'shutdown'])
    expect(one.size).toBe(0)
    expect(create).toHaveBeenCalledTimes(1)
    expect(register.mock.results[0]!.value()).toBe(false)
    await activity.quiesce('alice')
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('registers router work before invoking a factory that synchronously starts shutdown', async () => {
    const gate = deferred()
    const shutdown = vi.fn()
    let stopping!: Promise<void>
    const router = createButlerRouter({ id: 'one', capabilities: [], createForUser: () => {
      stopping = router.onShutdown!()
      return participant({ onTask: async () => { await gate.promise; return result }, onShutdown: shutdown })
    } })
    const pending = router.onTask!(task())
    await Promise.resolve()
    await Promise.resolve()
    expect(shutdown).not.toHaveBeenCalled()
    gate.resolve()
    await pending
    await stopping
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(router.size).toBe(0)
  })

  it('normal shutdown keeps only failed resources for retry and does not reopen the router', async () => {
    const activity = new ButlerUserActivity()
    const alice = vi.fn().mockRejectedValueOnce(new Error('ordinary failure')).mockResolvedValue(undefined)
    const bob = vi.fn()
    const extra = vi.fn()
    const router = createButlerRouter({
      id: 'one', capabilities: [], userActivity: activity, retireForUser: extra,
      createForUser: user => participant({ onShutdown: user === 'alice' ? alice : bob }),
    })
    await router.onTask!(task())
    await router.onTask!(task('bob'))
    await expect(router.onShutdown!()).resolves.toBeUndefined()
    expect(router.size).toBe(1)
    expect(bob).toHaveBeenCalledTimes(1)
    await expect(router.onShutdown!()).resolves.toBeUndefined()
    expect(router.size).toBe(0)
    expect(alice).toHaveBeenCalledTimes(2)
    expect(bob).toHaveBeenCalledTimes(1)
    await expect(router.onTask!(task())).rejects.toMatchObject({ code: 'BUTLER_ROUTER_CLOSED' })
    await activity.quiesce('alice')
    expect(extra).not.toHaveBeenCalled()
  })

  it('quiescence during normal instance shutdown keeps retirement ownership without a second successful shutdown', async () => {
    const activity = new ButlerUserActivity()
    const register = vi.spyOn(activity, 'register')
    const shutdownGate = deferred()
    const shutdownEntered = deferred()
    const retireGate = deferred()
    const retireEntered = deferred()
    const shutdown = vi.fn(async () => { shutdownEntered.resolve(); await shutdownGate.promise })
    const extra = vi.fn(async () => { retireEntered.resolve(); await retireGate.promise })
    const router = createButlerRouter({ id: 'one', capabilities: [], userActivity: activity,
      createForUser: () => participant({ onShutdown: shutdown }), retireForUser: extra })
    await router.onTask!(task())
    const stopping = router.onShutdown!().catch(e => e)
    await shutdownEntered.promise
    const closed = activity.quiesce('alice')
    shutdownGate.resolve()
    await retireEntered.promise
    expect(await stopping).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(register.mock.results[0]!.value()).toBe(false)
    expect(router.size).toBe(1)
    expect(shutdown).toHaveBeenCalledTimes(1)
    retireGate.resolve()
    await closed
    expect(router.size).toBe(0)
    expect(extra).toHaveBeenCalledTimes(1)
  })

  it('quiescence before normal shutdown owns in-flight instances until all retirement finishes', async () => {
    const activity = new ButlerUserActivity()
    const taskGate = deferred()
    const shutdownGate = deferred()
    const shutdownEntered = deferred()
    const shutdown = vi.fn(async () => { shutdownEntered.resolve(); await shutdownGate.promise })
    const extra = vi.fn()
    const router = createButlerRouter({ id: 'one', capabilities: [], userActivity: activity,
      createForUser: () => participant({ onTask: async () => { await taskGate.promise; return result }, onShutdown: shutdown }),
      retireForUser: extra })
    const pending = router.onTask!(task()).catch(e => e)
    const closed = activity.quiesce('alice')
    const stopping = router.onShutdown!().catch(e => e)
    taskGate.resolve()
    expect(await pending).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await shutdownEntered.promise
    expect(await stopping).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(router.size).toBe(1)
    shutdownGate.resolve()
    await closed
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(extra).toHaveBeenCalledTimes(1)
    expect(router.size).toBe(0)
  })

  it('failed shutdown still attempts extra cleanup and retry cleans any writes from the retried shutdown', async () => {
    const activity = new ButlerUserActivity()
    let dirty = false
    let fail = true
    const shutdown = vi.fn(() => {
      dirty = true
      if (fail) { fail = false; throw new Error('private') }
    })
    const extra = vi.fn(() => { dirty = false })
    const router = createButlerRouter({ id: 'one', capabilities: [], userActivity: activity,
      createForUser: () => participant({ onShutdown: shutdown }), retireForUser: extra })
    await router.onTask!(task())
    await expect(activity.quiesce('alice')).rejects.toMatchObject({ code: 'BUTLER_USER_RETIRE_FAILED' })
    expect(extra).toHaveBeenCalledTimes(1)
    expect(dirty).toBe(false)
    await activity.quiesce('alice')
    expect(shutdown).toHaveBeenCalledTimes(2)
    expect(dirty).toBe(false)
    expect(extra).toHaveBeenCalledTimes(2)
    expect(router.size).toBe(0)
  })
})
