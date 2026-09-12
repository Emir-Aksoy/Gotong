import { SuspendTaskError } from '@gotong/core'
import { describe, expect, it, vi } from 'vitest'
import { ButlerUserActivity } from '../src/butler-user-activity.js'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('ButlerUserActivity', () => {
  it('skips every finalizer if any resource fails, then finalizes only after the successful retry', async () => {
    const activity = new ButlerUserActivity()
    const events: string[] = []
    const cleanup = vi.fn(() => { events.push('finalize') })
    activity.registerFinalizer('alice', cleanup)
    let fail = true
    const resource = vi.fn(() => {
      events.push('resource-write')
      if (fail) { fail = false; throw new Error('private-marker') }
    })
    const other = vi.fn(() => { events.push('other-resource') })
    activity.register('alice', resource)
    activity.register('alice', other)
    await expect(activity.quiesce('alice')).rejects.toMatchObject({ code: 'BUTLER_USER_RETIRE_FAILED' })
    expect(cleanup).not.toHaveBeenCalled()
    expect(other).toHaveBeenCalledTimes(1)
    await activity.quiesce('alice')
    expect(events).toEqual(['resource-write', 'other-resource', 'resource-write', 'finalize'])
    expect(resource).toHaveBeenCalledTimes(2)
    expect(other).toHaveBeenCalledTimes(1)
    await activity.quiesce('alice')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('runs finalizers serially, tries all after errors, and retries only failed finalizers', async () => {
    const activity = new ButlerUserActivity()
    const gate = deferred()
    const entered = deferred()
    const resource = vi.fn()
    const first = vi.fn().mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
      throw new Error('private-marker', { cause: 'private-marker' })
    }).mockResolvedValue(undefined)
    const second = vi.fn().mockImplementationOnce(() => { throw new Error('private-marker') }).mockReturnValue(undefined)
    const third = vi.fn()
    activity.register('alice', resource)
    const unregister = activity.registerFinalizer('alice', first)
    activity.registerFinalizer('alice', second)
    activity.registerFinalizer('alice', third)
    const closed = activity.quiesce('alice')
    const outcome = closed.catch(e => e)
    await entered.promise
    expect(activity.quiesce('alice')).toBe(closed)
    expect(unregister()).toBe(false)
    expect(second).not.toHaveBeenCalled()
    gate.resolve()
    const error = await outcome
    expect(error).toMatchObject({ code: 'BUTLER_USER_RETIRE_FAILED' })
    expect(error).not.toHaveProperty('cause')
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain('private-marker')
    expect(third).toHaveBeenCalledTimes(1)
    expect(unregister()).toBe(false)
    await expect(activity.run('alice', vi.fn())).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await activity.quiesce('alice')
    expect(resource).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)
    expect(third).toHaveBeenCalledTimes(1)
  })

  it('unregisters finalizers only for open users and keeps finalizer ownership user-scoped', async () => {
    const activity = new ButlerUserActivity()
    const removed = vi.fn()
    const alice = vi.fn()
    const bob = vi.fn()
    const unregister = activity.registerFinalizer('alice', removed)
    expect(unregister()).toBe(true)
    expect(unregister()).toBe(false)
    activity.registerFinalizer('alice', alice)
    activity.registerFinalizer('bob', bob)
    const closed = activity.quiesce('alice')
    expect(() => activity.registerFinalizer('alice', vi.fn())).toThrow()
    await closed
    expect(removed).not.toHaveBeenCalled()
    expect(alice).toHaveBeenCalledTimes(1)
    expect(bob).not.toHaveBeenCalled()
    await activity.quiesce('bob')
    expect(bob).toHaveBeenCalledTimes(1)
    const unknown = activity.quiesce('unknown')
    expect(() => activity.registerFinalizer('unknown', vi.fn())).toThrow()
    await unknown
  })

  it('does not finalize a resource-free user until their admitted work truly finishes', async () => {
    const activity = new ButlerUserActivity()
    const gate = deferred()
    const cleanup = vi.fn()
    activity.registerFinalizer('alice', cleanup)
    const work = activity.run('alice', () => gate.promise).catch(e => e)
    const closed = activity.quiesce('alice')
    await Promise.resolve()
    await Promise.resolve()
    expect(cleanup).not.toHaveBeenCalled()
    gate.resolve()
    expect(await work).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await closed
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('unregisters an open user resource without closing the user', async () => {
    const activity = new ButlerUserActivity()
    const retire = vi.fn()
    const unregister = activity.register('alice', retire)
    expect(unregister()).toBe(true)
    expect(unregister()).toBe(false)
    await expect(activity.run('alice', () => 'available')).resolves.toBe('available')
    await activity.quiesce('alice')
    expect(retire).not.toHaveBeenCalled()
  })

  it('cannot unregister resources after quiescence takes ownership, including on retry', async () => {
    const activity = new ButlerUserActivity()
    const gate = deferred()
    const work = activity.run('alice', () => gate.promise).catch(e => e)
    const retire = vi.fn().mockRejectedValueOnce(new Error('private')).mockResolvedValue(undefined)
    const unregister = activity.register('alice', retire)
    const closed = activity.quiesce('alice').catch(e => e)
    expect(unregister()).toBe(false)
    gate.resolve()
    await work
    expect(await closed).toMatchObject({ code: 'BUTLER_USER_RETIRE_FAILED' })
    expect(unregister()).toBe(false)
    await activity.quiesce('alice')
    expect(retire).toHaveBeenCalledTimes(2)
  })

  it('registers synchronously, drains all work, and permanently closes only the target user', async () => {
    const activity = new ButlerUserActivity()
    const a = deferred<string>()
    const b = deferred<string>()
    const retire = vi.fn()
    activity.register('alice', retire)
    const first = activity.run('alice', () => a.promise).catch(e => e)
    const second = activity.run('alice', () => b.promise).catch(e => e)
    const closed = activity.quiesce('alice')
    expect(activity.quiesce('alice')).toBe(closed)
    const work = vi.fn()
    await expect(activity.run('alice', work)).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(work).not.toHaveBeenCalled()
    expect(() => activity.register('alice', retire)).toThrow()
    expect(await activity.run('bob', () => 'available')).toBe('available')
    a.resolve('private result')
    expect(await first).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(retire).not.toHaveBeenCalled()
    b.resolve('private result two')
    expect(await second).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await closed
    await activity.quiesce('alice')
    expect(retire).toHaveBeenCalledTimes(1)
    await expect(activity.run('alice', work)).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
  })

  it.each(['success', 'reject', 'suspend', 'sync throw'] as const)('sanitizes late %s without content or cause', async mode => {
    const activity = new ButlerUserActivity()
    const gate = deferred<string>()
    const privateError = mode === 'suspend'
      ? new SuspendTaskError({ resumeAt: 1, state: { text: 'private-marker' } })
      : new Error('private-marker', { cause: 'private-marker' })
    let closed!: Promise<void>
    const result = activity.run('alice', () => {
      if (mode === 'sync throw') {
        closed = activity.quiesce('alice') // Deliberately do NOT await inside work.
        throw privateError
      }
      return gate.promise
    }).catch(e => e)
    closed ??= activity.quiesce('alice')
    if (mode === 'success') gate.resolve('private-marker')
    else if (mode !== 'sync throw') gate.reject(privateError)
    const error = await result
    expect(error.code).toBe('BUTLER_USER_QUIESCED')
    expect(error).not.toHaveProperty('cause')
    expect(error).not.toHaveProperty('state')
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain('private-marker')
    await closed
  })

  it.each(['sync', 'async'] as const)('releases the latch on ordinary %s failures without changing the error', async mode => {
    const activity = new ButlerUserActivity()
    const error = new Error('original')
    await expect(activity.run('alice', () => {
      if (mode === 'sync') throw error
      return Promise.reject(error)
    })).rejects.toBe(error)
    const retire = vi.fn()
    activity.register('alice', retire)
    await activity.quiesce('alice')
    expect(retire).toHaveBeenCalledTimes(1)
  })

  it('tries all resources, sanitizes retirement failures, and retries only failed resources', async () => {
    const activity = new ButlerUserActivity()
    const good = vi.fn()
    const bad = vi.fn().mockRejectedValueOnce(new Error('private-marker')).mockResolvedValue(undefined)
    const syncBad = vi.fn().mockImplementationOnce(() => { throw new Error('private-marker') }).mockReturnValue(undefined)
    activity.register('alice', bad)
    activity.register('alice', syncBad)
    activity.register('alice', good)
    const closed = activity.quiesce('alice')
    expect(activity.quiesce('alice')).toBe(closed)
    const error = await closed.catch(e => e)
    expect(error.code).toBe('BUTLER_USER_RETIRE_FAILED')
    expect(error).not.toHaveProperty('cause')
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain('private-marker')
    expect(good).toHaveBeenCalledTimes(1)
    await expect(activity.run('alice', vi.fn())).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await activity.quiesce('alice')
    expect(bad).toHaveBeenCalledTimes(2)
    expect(syncBad).toHaveBeenCalledTimes(2)
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('closes an unknown user immediately', async () => {
    const activity = new ButlerUserActivity()
    const closed = activity.quiesce('unknown')
    expect(() => activity.register('unknown', vi.fn())).toThrow()
    const work = vi.fn()
    await expect(activity.run('unknown', work)).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await closed
    expect(work).not.toHaveBeenCalled()
  })

  it('keeps quiescence pending while a resource is still retiring', async () => {
    const activity = new ButlerUserActivity()
    const gate = deferred()
    const started = deferred()
    activity.register('alice', () => { started.resolve(); return gate.promise })
    let done = false
    const closed = activity.quiesce('alice').then(() => { done = true })
    await started.promise
    expect(done).toBe(false)
    await expect(activity.run('alice', vi.fn())).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    gate.resolve()
    await closed
  })

  it('retires resources serially so same-owner cache cleanup cannot race', async () => {
    const activity = new ButlerUserActivity()
    const gate = deferred()
    const started = deferred()
    const second = vi.fn()
    activity.register('alice', () => { started.resolve(); return gate.promise })
    activity.register('alice', second)
    const closed = activity.quiesce('alice')
    await started.promise
    expect(second).not.toHaveBeenCalled()
    gate.resolve()
    await closed
    expect(second).toHaveBeenCalledTimes(1)
  })
})
