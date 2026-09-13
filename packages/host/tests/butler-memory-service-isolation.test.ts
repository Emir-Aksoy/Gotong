import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@gotong/core'
import type { MemoryHandle } from '@gotong/services-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HostButlerMemoryService } from '../src/butler-memory-service.js'
import { ButlerUserActivity } from '../src/butler-user-activity.js'
import { FileButlerUserIsolation } from '../src/butler-user-isolation.js'
import * as memory from '../src/personal-butler-memory.js'
import * as dreams from '../src/personal-butler-dreams.js'
import * as skills from '../src/personal-butler-skills.js'
import * as status from '../src/personal-butler-status.js'
import * as obsidian from '../src/butler-obsidian.js'

const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return logger },
}
const operations = ['read', 'export', 'forget', 'forgetAll'] as const
type Operation = typeof operations[number]
const closedError = { code: 'BUTLER_USER_QUIESCED' }

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function observe(promise: Promise<unknown>) {
  let settled = false
  const outcome = promise.then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  ).finally(() => { settled = true })
  return { outcome, get settled() { return settled } }
}

function tick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function expectScrubbed(outcome: unknown) {
  expect(outcome).toMatchObject({ error: closedError })
  const error = (outcome as { error: Error }).error
  expect(error).not.toHaveProperty('cause')
  expect(error).not.toHaveProperty('state')
  expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain('private-marker')
}

// Inspect private retention without adding a production-only testing surface.
function caches(service: HostButlerMemoryService) {
  return service as unknown as {
    handles: Map<string, MemoryHandle>
    diaries: Map<string, dreams.ButlerDreamDiary>
    skillFiles: Map<string, skills.ButlerSkillFile>
    statusFiles: Map<string, status.ButlerStatusFile>
    registeredUsers: Set<string>
  }
}

describe('HostButlerMemoryService user isolation', () => {
  let rootDir: string
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'gotong-memory-service-isolation-'))
  })
  afterEach(() => { vi.restoreAllMocks() })

  async function seed(userId: string) {
    const handle = memory.openButlerMemory({ rootDir, userId, logger })
    return handle.remember({ kind: 'semantic', text: `${userId} private-marker` })
  }

  function invoke(service: HostButlerMemoryService, op: Operation, userId: string, id: string) {
    return op === 'forget' ? service.forget(userId, id) : service[op](userId)
  }

  it.each(operations)('durably blocks %s before opening any user resource; another user works', async op => {
    const alice = await seed('alice')
    const bob = await seed('bob')
    await new ButlerUserActivity(new FileButlerUserIsolation(rootDir)).quiesce('alice')
    const opens = [
      vi.spyOn(memory, 'openButlerMemory'),
      vi.spyOn(dreams, 'openButlerDreamDiary'),
      vi.spyOn(skills, 'openButlerSkillFile'),
      vi.spyOn(status, 'openButlerStatusFile'),
      vi.spyOn(obsidian, 'openButlerObsidianProjector'),
      vi.spyOn(obsidian, 'projectButlerMemoryVault'),
    ]
    // No injected registry: a newly constructed service must check disk itself.
    const service = new HostButlerMemoryService({ rootDir, logger })
    expectScrubbed(await observe(invoke(service, op, 'alice', alice.id)).outcome)
    for (const open of opens) expect(open).not.toHaveBeenCalled()
    const result = await invoke(service, op, 'bob', bob.id)
    if (op === 'read') expect(result).toMatchObject({ profile: [{ id: bob.id }] })
    if (op === 'export') expect(result).toMatchObject([{ id: bob.id }])
    if (op === 'forget') expect(result).toBe(true)
    if (op === 'forgetAll') expect(await service.export('bob')).toEqual([])
    for (const open of opens) {
      expect(open.mock.calls.every(([opts]) => opts.userId === 'bob')).toBe(true)
    }
  })

  it.each(operations)('a durable marker also blocks %s on an already-cached service', async op => {
    const alice = await seed('alice')
    const service = new HostButlerMemoryService({ rootDir, logger })
    await service.read('alice')
    const handle = caches(service).handles.get('alice')!
    const reads = vi.spyOn(handle, 'recall')
    const lists = vi.spyOn(handle, 'list')
    const forget = vi.spyOn(handle, 'forget')
    const clear = vi.spyOn(handle, 'clear')
    await new FileButlerUserIsolation(rootDir).close('alice')
    expectScrubbed(await observe(invoke(service, op, 'alice', alice.id)).outcome)
    for (const access of [reads, lists, forget, clear]) expect(access).not.toHaveBeenCalled()
  })

  async function sharedService() {
    // Disk admission is tested above; here disk latency must not mask a missing drain.
    const userActivity = new ButlerUserActivity()
    const service = new HostButlerMemoryService({ rootDir, logger, userActivity })
    const alice = await seed('alice')
    await seed('bob')
    await service.read('alice')
    await service.read('bob')
    return { service, userActivity, alice }
  }

  for (const op of ['read', 'export'] as const) {
    it.each(['success', 'error'] as const)(`drains slow ${op} and scrubs late %s`, async mode => {
      const { service, userActivity } = await sharedService()
      const started = deferred()
      const release = deferred()
      const handle = caches(service).handles.get('alice')!
      if (op === 'read') {
        const recall = handle.recall.bind(handle)
        vi.spyOn(handle, 'recall').mockImplementationOnce(async opts => {
          started.resolve()
          await release.promise
          return recall(opts)
        })
      } else {
        const list = handle.list.bind(handle)
        vi.spyOn(handle, 'list').mockImplementationOnce(async opts => {
          started.resolve()
          await release.promise
          return list(opts)
        })
      }
      const work = observe(service[op]('alice'))
      await started.promise
      const retired = vi.fn()
      userActivity.register('alice', retired)
      const closing = observe(userActivity.quiesce('alice'))
      try {
        await tick()
        expect(closing.settled).toBe(false)
        expect(retired).not.toHaveBeenCalled()
        expect(caches(service).handles.has('alice')).toBe(true)
        await expect(service.export('alice')).rejects.toMatchObject(closedError)
        expect((await service.read('bob')).profile).toHaveLength(1)
      } finally {
        if (mode === 'error') release.reject(new Error('private-marker', { cause: 'private-marker' }))
        else release.resolve()
        await work.outcome
        await closing.outcome
      }
      expectScrubbed(await work.outcome)
      expect(await closing.outcome).toEqual({ value: undefined })
      expect(retired).toHaveBeenCalledTimes(1)
      expect(caches(service).handles.has('alice')).toBe(false)
      expect(caches(service).handles.has('bob')).toBe(true)
    })
  }

  it.each(['success', 'error'] as const)('keeps forget projection in the drain and scrubs late %s', async mode => {
    const { service, userActivity, alice } = await sharedService()
    const started = deferred()
    const release = deferred()
    vi.spyOn(obsidian, 'projectButlerMemoryVault').mockImplementationOnce(async () => {
      started.resolve()
      await release.promise
    })
    const work = observe(service.forget('alice', alice.id))
    await started.promise
    expect(await caches(service).handles.get('alice')!.list({ limit: 1000 })).toEqual([])
    const closing = observe(userActivity.quiesce('alice'))
    try {
      await tick()
      expect(closing.settled).toBe(false)
      expect(caches(service).handles.has('alice')).toBe(true)
    } finally {
      if (mode === 'error') release.reject(new Error('private-marker', { cause: 'private-marker' }))
      else release.resolve()
      await work.outcome
      await closing.outcome
    }
    expectScrubbed(await work.outcome)
    expect(await closing.outcome).toEqual({ value: undefined })
    expect(caches(service).handles.has('alice')).toBe(false)
  })

  it.each((['memory', 'diary', 'skill', 'status', 'vault'] as const)
    .flatMap(phase => [false, true].map(fails => ({ phase, fails }))))(
    'keeps forgetAll $phase removal inside the complete operation; fails = $fails', async ({ phase, fails }) => {
      const { service, userActivity } = await sharedService()
      // Populate all four cache families without reaching into their constructors.
      await service.forgetAll('alice')
      await seed('alice')
      const started = deferred()
      const release = deferred()
      async function pause() { started.resolve(); await release.promise }
      const retained = caches(service)
      if (phase === 'memory') vi.spyOn(retained.handles.get('alice')!, 'clear').mockImplementationOnce(pause)
      if (phase === 'diary') vi.spyOn(retained.diaries.get('alice')!, 'remove').mockImplementationOnce(pause)
      if (phase === 'skill') vi.spyOn(retained.skillFiles.get('alice')!, 'remove').mockImplementationOnce(pause)
      if (phase === 'status') vi.spyOn(retained.statusFiles.get('alice')!, 'remove').mockImplementationOnce(pause)
      const openProjector = obsidian.openButlerObsidianProjector
      const projection = vi.spyOn(obsidian, 'openButlerObsidianProjector').mockImplementation(opts => {
        const projector = openProjector(opts)
        if (phase === 'vault') vi.spyOn(projector, 'removeMemoryProjections').mockImplementationOnce(pause)
        return projector
      })
      const work = observe(service.forgetAll('alice'))
      await started.promise
      const closing = observe(userActivity.quiesce('alice'))
      try {
        await tick()
        expect(closing.settled).toBe(false)
        expect(retained.handles.has('alice')).toBe(true)
      } finally {
        if (fails) release.reject(new Error('private-marker', { cause: 'private-marker' }))
        else release.resolve()
        await work.outcome
        await closing.outcome
      }
      expectScrubbed(await work.outcome)
      expect(await closing.outcome).toEqual({ value: undefined })
      expect(projection).toHaveBeenCalledTimes(!fails || phase === 'vault' ? 1 : 0)
      for (const cache of [retained.handles, retained.diaries, retained.skillFiles, retained.statusFiles]) {
        expect(cache.has('alice')).toBe(false)
      }
      expect(retained.handles.has('bob')).toBe(true)
    },
  )

  it.each(['async failure', 'sync failure'] as const)(
    'settles every started read branch before propagating %s or retiring', async mode => {
      const { service, userActivity } = await sharedService()
      const retained = caches(service)
      const failure = new Error('private-marker', { cause: 'private-marker' })
      const failed = vi.spyOn(retained.handles.get('alice')!, 'recall').mockImplementationOnce(() => {
        if (mode === 'sync failure') throw failure
        return Promise.reject(failure)
      })
      const diaryStarted = deferred()
      const statusStarted = deferred()
      const diaryRelease = deferred<null>()
      const statusRelease = deferred<null>()
      vi.spyOn(retained.diaries.get('alice')!, 'readLatest').mockImplementationOnce(() => {
        diaryStarted.resolve()
        return diaryRelease.promise
      })
      vi.spyOn(retained.statusFiles.get('alice')!, 'read').mockImplementationOnce(() => {
        statusStarted.resolve()
        return statusRelease.promise
      })
      const work = observe(service.read('alice'))
      let closing: ReturnType<typeof observe> | undefined
      try {
        await tick()
        expect(work.settled).toBe(false)
        await diaryStarted.promise
        await statusStarted.promise
        expect(failed).toHaveBeenCalledTimes(2)
        closing = observe(userActivity.quiesce('alice'))
        diaryRelease.resolve(null)
        await tick()
        expect(closing.settled).toBe(false)
        expect(work.settled).toBe(false)
        expect(retained.diaries.has('alice')).toBe(true)
      } finally {
        diaryRelease.resolve(null)
        statusRelease.resolve(null)
        await work.outcome
        await closing?.outcome
      }
      expectScrubbed(await work.outcome)
      expect(retained.diaries.has('alice')).toBe(false)
    },
  )

  it('preserves an ordinary read error, but only after its other branches settle', async () => {
    const { service } = await sharedService()
    const failure = new Error('ordinary read failure')
    const release = deferred<null>()
    vi.spyOn(caches(service).handles.get('alice')!, 'recall').mockRejectedValueOnce(failure)
    vi.spyOn(caches(service).statusFiles.get('alice')!, 'read').mockReturnValueOnce(release.promise)
    const work = observe(service.read('alice'))
    try {
      await tick()
      expect(work.settled).toBe(false)
    } finally {
      release.resolve(null)
      await work.outcome
    }
    expect(await work.outcome).toEqual({ error: failure })
  })

  it('registers one retirement per user and drops only that user caches and bookkeeping after drain', async () => {
    const userActivity = new ButlerUserActivity(new FileButlerUserIsolation(rootDir))
    const register = vi.spyOn(userActivity, 'register')
    const service = new HostButlerMemoryService({ rootDir, logger, userActivity })
    for (const userId of ['alice', 'bob']) {
      await Promise.all([service.read(userId), service.export(userId), service.forget(userId, 'absent')])
      await service.forgetAll(userId)
      await service.read(userId)
    }
    expect(register.mock.calls.map(([userId]) => userId)).toEqual(['alice', 'bob'])
    const retained = caches(service)
    const maps = [retained.handles, retained.diaries, retained.skillFiles, retained.statusFiles]
    const bobValues = maps.map(cache => cache.get('bob'))
    await userActivity.quiesce('alice')
    expect(retained.registeredUsers).toEqual(new Set(['bob']))
    for (const [index, cache] of maps.entries()) {
      expect([...cache.keys()]).toEqual(['bob'])
      expect(cache.get('bob')).toBe(bobValues[index])
    }
    await service.read('bob')
    await userActivity.quiesce('alice')
    expect(register).toHaveBeenCalledTimes(2)
    await userActivity.quiesce('bob')
    expect(retained.registeredUsers.size).toBe(0)
    for (const cache of maps) expect(cache.size).toBe(0)
  })
})
