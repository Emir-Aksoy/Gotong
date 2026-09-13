import { SuspendTaskError } from '@gotong/core'
import { describe, expect, it, vi } from 'vitest'
import { ButlerUserActivity } from '../src/butler-user-activity.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
function store() {
  return { assertOpen: vi.fn(async (_user: string) => {}), close: vi.fn(async (_user: string) => {}) }
}

describe('durable user admission', () => {
  it('checks before invoking work and keeps a rejected user closed in this instance', async () => {
    const disk = store()
    disk.assertOpen.mockRejectedValueOnce(new Error('private-marker', { cause: 'private-marker' }))
    const activity = new ButlerUserActivity(disk)
    const work = vi.fn()
    const error = await activity.run('alice', work).catch(e => e)
    expect(error).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(error).not.toHaveProperty('cause')
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain('private-marker')
    await expect(activity.run('alice', work)).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(work).not.toHaveBeenCalled()
    expect(disk.assertOpen).toHaveBeenCalledTimes(1)
    expect(() => activity.register('alice', vi.fn())).toThrow()
    await expect(activity.run('bob', () => 'ok')).resolves.toBe('ok')
  })

  it('counts a pending admission and never invokes it after local closure', async () => {
    const disk = store()
    const reading = deferred()
    const entered = deferred()
    disk.assertOpen.mockImplementationOnce(async () => { entered.resolve(); await reading.promise })
    const activity = new ButlerUserActivity(disk)
    const retire = vi.fn()
    activity.register('alice', retire)
    const work = vi.fn()
    const result = activity.run('alice', work).catch(e => e)
    await entered.promise
    const closed = activity.quiesce('alice')
    await vi.waitFor(() => expect(disk.close).toHaveBeenCalledWith('alice'))
    expect(retire).not.toHaveBeenCalled()
    reading.resolve()
    expect(await result).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await closed
    expect(work).not.toHaveBeenCalled()
    expect(retire).toHaveBeenCalledTimes(1)
  })

  it('rechecks local closure between a successful disk check and callback admission', async () => {
    const disk = store()
    const activity = new ButlerUserActivity(disk)
    let closing!: Promise<void>
    disk.assertOpen.mockImplementationOnce(async () => {
      queueMicrotask(() => queueMicrotask(() => { closing = activity.quiesce('alice') }))
    })
    const work = vi.fn()
    await expect(activity.run('alice', work)).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await closing
    expect(work).not.toHaveBeenCalled()
  })

  it.each(['success', 'reject', 'suspend'] as const)('checks durable state before releasing late %s', async mode => {
    const disk = store()
    const activity = new ButlerUserActivity(disk)
    const error = await activity.run('alice', async () => {
      disk.assertOpen.mockRejectedValue(new Error('private-disk-marker'))
      if (mode === 'suspend') throw new SuspendTaskError({ resumeAt: 1, state: { text: 'private-marker' } })
      if (mode === 'reject') throw new Error('private-marker')
      return 'private-marker'
    }).catch(e => e)
    expect(error).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain('private-marker')
    expect(disk.assertOpen).toHaveBeenCalledTimes(2)
  })

  it('preserves normal result and original work errors while durable state stays open', async () => {
    const disk = store()
    const activity = new ButlerUserActivity(disk)
    expect(await activity.run('alice', () => 42)).toBe(42)
    const failure = new Error('ordinary work failure')
    await expect(activity.run('alice', () => { throw failure })).rejects.toBe(failure)
    expect(disk.assertOpen).toHaveBeenCalledTimes(4)
    expect(disk.close).not.toHaveBeenCalled()
  })

  it('does not retire until persistence completes, and shares concurrent quiescence', async () => {
    const disk = store()
    const writing = deferred()
    const entered = deferred()
    disk.close.mockImplementationOnce(async () => { entered.resolve(); await writing.promise })
    const activity = new ButlerUserActivity(disk)
    const retire = vi.fn()
    const finalizer = vi.fn()
    activity.register('alice', retire)
    activity.registerFinalizer('alice', finalizer)
    const closing = activity.quiesce('alice')
    expect(activity.quiesce('alice')).toBe(closing)
    await entered.promise
    await expect(activity.run('alice', vi.fn())).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(retire).not.toHaveBeenCalled()
    expect(finalizer).not.toHaveBeenCalled()
    writing.resolve()
    await closing
    expect(retire).toHaveBeenCalledTimes(1)
    expect(finalizer).toHaveBeenCalledTimes(1)
  })

  it('keeps callbacks untouched after failed persistence and retries persistence before cleanup', async () => {
    const disk = store()
    disk.close.mockRejectedValueOnce(new Error('private-path', { cause: 'private-path' }))
    const activity = new ButlerUserActivity(disk)
    const events: string[] = []
    activity.register('alice', () => { events.push('retire') })
    activity.registerFinalizer('alice', () => { events.push('finalize') })
    const error = await activity.quiesce('alice').catch(e => e)
    expect(error).toMatchObject({ code: 'BUTLER_USER_ISOLATION_FAILED' })
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain('private-path')
    expect(events).toEqual([])
    await expect(activity.run('alice', vi.fn())).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    disk.close.mockImplementation(async () => { events.push('durable') })
    await activity.quiesce('alice')
    expect(events).toEqual(['durable', 'retire', 'finalize'])
    expect(disk.close).toHaveBeenCalledTimes(2)
  })
})
