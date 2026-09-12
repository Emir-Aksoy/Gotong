import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@gotong/core'
import { MemoryFileHandle, MemoryFileMutationError, MemoryFileSnapshotError, ownerDir, kindFile } from '@gotong/service-memory-file'
import type { MemoryEntry, MemoryKind } from '@gotong/services-sdk'
import { FileBackedInvertedIndex, openButlerRecallIndex, type PersistedRecallIndex, type RecallIndexIo } from '../src/butler-recall-index.js'
import { createRecallIndexIo } from '../src/butler-recall-index-io.js'

const logger = createLogger('recall-retirement-test', { disabled: true })
const row: MemoryEntry = { id: 'old', kind: 'semantic', text: 'private synthetic apples', ts: 10 }
const retired = { code: 'RECALL_INDEX_RETIRED' }
const cleanupFailed = { code: 'RECALL_INDEX_CLEANUP_FAILED' }
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fake(overrides: Partial<RecallIndexIo> = {}): RecallIndexIo {
  return { loadAll: async () => [row], watermark: async () => 'same', ...overrides }
}

/** Capture source/cache versions before the gate so late completion is deterministic. */
function versionedStore() {
  type Operation = 'loadPersisted' | 'loadAll' | 'persist'
  let version = 0
  let persisted: PersistedRecallIndex | null = null
  const counts = { loadPersisted: 0, loadAll: 0, persist: 0, purge: 0 }
  const gates = new Map<string, { started: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> }>()
  const events: string[] = []
  async function wait(operation: Operation) {
    const gate = gates.get(`${operation}:${++counts[operation]}`)
    if (gate) { gate.started.resolve(); await gate.release.promise }
  }
  const io: RecallIndexIo = {
    watermark: async () => `v${version}`,
    loadPersisted: async () => {
      const captured = structuredClone(persisted)
      await wait('loadPersisted')
      return captured
    },
    loadAll: async () => {
      const captured = [{ ...row, id: `v${version}` }]
      await wait('loadAll')
      return captured
    },
    persist: async (data) => {
      const captured = structuredClone(data)
      await wait('persist')
      persisted = captured
      events.push(`persist:${data.watermark}`)
    },
    removePersisted: async () => { counts.purge++; persisted = null; events.push('purge') },
  }
  return {
    io, counts, events,
    get persisted() { return persisted },
    advance() { version++ },
    pause(operation: Operation, call = 1) {
      const gate = { started: deferred(), release: deferred() }
      gates.set(`${operation}:${call}`, gate)
      return gate
    },
  }
}

function concurrentReads(index: FileBackedInvertedIndex, id: string) {
  return [index.allEntries(), index.lookupByIds([id]), index.retriever().retrieve({ text: 'apples' })]
}

describe('recall refresh generations after clear', () => {
  it.each(['loadPersisted', 'loadAll', 'persist'] as const)(
    'refreshes the new generation once for all post-clear readers after old %s finishes', async (stage) => {
      const store = versionedStore()
      const gate = store.pause(stage)
      const index = new FileBackedInvertedIndex(store.io)
      const old = index.ensureFresh()
      await gate.started.promise
      store.advance()
      index.clear()
      const readers = concurrentReads(index, 'v1')
      gate.release.resolve()
      const results = await Promise.all(readers)
      await old
      expect(results.map((rows) => rows.map((entry) => entry.id))).toEqual([['v1'], ['v1'], ['v1']])
      expect(store.counts.loadAll).toBe(stage === 'loadPersisted' ? 1 : 2)
      expect(store.counts.loadPersisted).toBe(1)
      expect(store.counts.persist).toBe(stage === 'persist' ? 2 : 1)
      expect(store.persisted?.watermark).toBe('v1')
      expect(store.persisted?.snapshot.entries.map((entry) => entry.id)).toEqual(['v1'])
    },
  )

  it('coalesces the latest generation after repeated clears without making interrupted callers rebuild', async () => {
    const store = versionedStore()
    const first = store.pause('loadAll')
    const second = store.pause('loadAll', 2)
    const index = new FileBackedInvertedIndex(store.io)
    const old = index.ensureFresh()
    await first.started.promise
    store.advance()
    index.clear()
    const middle = index.allEntries()
    first.release.resolve()
    expect(await Promise.race([second.started.promise.then(() => 'refreshing'), middle.then(() => 'returned')]))
      .toBe('refreshing')
    store.advance()
    index.clear()
    const latest = concurrentReads(index, 'v2')
    second.release.resolve()
    const results = await Promise.all(latest)
    await Promise.all([old, middle])
    expect(results.map((rows) => rows.map((entry) => entry.id))).toEqual([['v2'], ['v2'], ['v2']])
    expect(store.counts).toEqual({ loadPersisted: 1, loadAll: 3, persist: 1, purge: 0 })
    expect(store.persisted?.watermark).toBe('v2')
  })

  it.each(['loadAll', 'persist'] as const)('retirement drains the second refresh during %s and blocks every waiting reader', async (stage) => {
    const store = versionedStore()
    const first = store.pause('loadAll')
    const second = store.pause(stage, stage === 'loadAll' ? 2 : 1)
    const index = new FileBackedInvertedIndex(store.io)
    const old = index.ensureFresh().catch((error: unknown) => error)
    await first.started.promise
    store.advance()
    index.clear()
    const readers = concurrentReads(index, 'v1').map((result) => result.catch((error: unknown) => error))
    first.release.resolve()
    expect(await Promise.race([second.started.promise.then(() => 'refreshing'), readers[0]!.then(() => 'returned')]))
      .toBe('refreshing')
    const cleanup = index.retire()
    expect(index.size).toBe(0)
    await expect(index.assertUsable()).rejects.toMatchObject(retired)
    expect(store.counts.purge).toBe(0)
    second.release.resolve()
    await cleanup
    for (const result of await Promise.all(readers)) expect(result).toMatchObject(retired)
    await old
    expect(store.persisted).toBeNull()
    expect(store.events).toEqual(stage === 'persist' ? ['persist:v1', 'purge'] : ['purge'])
    expect(store.counts.loadAll).toBe(2)
    expect(index.size).toBe(0)
  })
})

describe('recall index instance retirement', () => {
  it('retires synchronously, is irreversible, and permits no-cache/idempotent retirement', async () => {
    const index = new FileBackedInvertedIndex(fake())
    await index.ensureFresh()
    const done = index.retire()
    expect(index.size).toBe(0)
    await expect(index.assertUsable()).rejects.toMatchObject(retired)
    await done
    await index.retire()
    index.clear()
    for (const op of [() => index.ensureFresh(), () => index.allEntries(),
      () => index.lookupByIds(['old']), () => index.retriever().retrieve({ text: 'apples' })]) {
      await expect(op()).rejects.toMatchObject(retired)
    }
  })

  it.each(['persist', 'loadPersisted'] as const)('refuses retirement with %s but no purge implementation', async (method) => {
    const io = fake(method === 'persist' ? { persist: async () => {} } : { loadPersisted: async () => null })
    const index = new FileBackedInvertedIndex(io)
    await expect(index.retire()).rejects.toMatchObject({ code: 'RECALL_INDEX_RETIRE_UNSUPPORTED' })
    await expect(index.assertUsable()).rejects.toMatchObject(retired)
  })

  it('shares concurrent cleanup, sanitizes failures, and retries without reopening', async () => {
    const gate = deferred()
    const purge = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined)
    const index = new FileBackedInvertedIndex(fake({ removePersisted: purge }))
    const first = index.retire()
    const second = index.retire()
    expect(second).toBe(first)
    const failure = first.catch((error: unknown) => error)
    gate.reject(new Error('/private/synthetic-secret cause'))
    const error = await failure
    expect(error).toMatchObject(cleanupFailed)
    expect(String(error)).not.toContain('synthetic-secret')
    expect(error).not.toHaveProperty('cause')
    await index.retire()
    await index.retire()
    expect(purge).toHaveBeenCalledTimes(2)
    await expect(index.assertUsable()).rejects.toMatchObject(retired)
  })

  it.each(['loadPersisted', 'loadAll', 'persist'] as const)('drains active %s before purging and blocks late publication', async (stage) => {
    const started = deferred()
    const gate = deferred()
    const events: string[] = []
    const io = fake({
      loadPersisted: async () => null,
      persist: async () => {},
      removePersisted: async () => { events.push('purge') },
    })
    if (stage === 'loadPersisted') io.loadPersisted = async () => {
      started.resolve(); await gate.promise; events.push('settled')
      return { watermark: 'same', snapshot: { version: 1, entries: [row] } }
    }
    if (stage === 'loadAll') io.loadAll = async () => { started.resolve(); await gate.promise; events.push('settled'); return [row] }
    if (stage === 'persist') io.persist = async () => { started.resolve(); await gate.promise; events.push('settled') }
    const index = new FileBackedInvertedIndex(io)
    const refresh = index.ensureFresh().catch((error: unknown) => error)
    await started.promise
    const cleanup = index.retire()
    expect(index.size).toBe(0)
    expect(events).toEqual([])
    gate.resolve()
    await cleanup
    expect(await refresh).toMatchObject(retired)
    expect(events).toEqual(['settled', 'purge'])
    expect(index.size).toBe(0)
  })

  it('clear cancels delayed rebuilding without deleting the persisted cache or retiring', async () => {
    const started = deferred()
    const gate = deferred()
    const purge = vi.fn()
    const persist = vi.fn()
    let rows = [row]
    const index = new FileBackedInvertedIndex(fake({
      loadAll: async () => { const captured = rows; started.resolve(); await gate.promise; return captured },
      persist, removePersisted: purge,
    }))
    const refresh = index.ensureFresh()
    await started.promise
    index.clear()
    rows = []
    gate.resolve()
    await refresh
    expect(index.size).toBe(0)
    expect(persist).not.toHaveBeenCalled()
    expect(purge).not.toHaveBeenCalled()
    await expect(index.assertUsable()).resolves.toBeUndefined()
    expect(await index.allEntries()).toEqual([])
  })

  it.each(['retire', 'pending'] as const)('does not return late asynchronous fusion hits after %s', async (action) => {
    const started = deferred()
    const gate = deferred()
    let pending = false
    const index = new FileBackedInvertedIndex(fake({ assertUsable: async () => {
      if (pending) throw new MemoryFileMutationError('MUTATION_PENDING')
    } }), logger, { embed: async (texts) => {
      started.resolve(); await gate.promise; return texts.map(() => [1, 0])
    } })
    const result = index.retriever().retrieve({ text: 'apples' }).catch((error: unknown) => error)
    await started.promise
    if (action === 'retire') await index.retire()
    else pending = true
    gate.resolve()
    expect(await result).toMatchObject(action === 'retire' ? retired : { code: 'MUTATION_PENDING' })
  })

  it('rechecks retirement after an in-flight IO guard', async () => {
    const started = deferred()
    const gate = deferred()
    const index = new FileBackedInvertedIndex(fake({ assertUsable: async () => { started.resolve(); await gate.promise } }))
    const check = index.assertUsable().catch((error: unknown) => error)
    await started.promise
    await index.retire()
    gate.resolve()
    expect(await check).toMatchObject(retired)
  })

  it.each(['loadPersisted', 'persist'] as const)('does not swallow typed guard failures from %s', async (stage) => {
    const error = new MemoryFileMutationError('MUTATION_PENDING')
    const io = fake(stage === 'persist'
      ? { persist: async () => { throw error } }
      : { loadPersisted: async () => { throw error } })
    await expect(new FileBackedInvertedIndex(io).ensureFresh()).rejects.toBe(error)
  })

  it.each(['loadPersisted', 'watermark', 'loadAll', 'persist'] as const)(
    'guards before warm reads and after %s even when the watermark matches', async (stage) => {
      let blocked = false
      const io = fake({
        assertUsable: async () => { if (blocked) throw new MemoryFileSnapshotError('SNAPSHOT_IO_ERROR') },
      })
      if (stage === 'loadPersisted') io.loadPersisted = async () => {
        blocked = true; return { watermark: 'same', snapshot: { version: 1, entries: [row] } }
      }
      if (stage === 'watermark') io.watermark = async () => { blocked = true; return 'same' }
      if (stage === 'loadAll') io.loadAll = async () => { blocked = true; return [row] }
      if (stage === 'persist') io.persist = async () => { blocked = true }
      const index = new FileBackedInvertedIndex(io)
      await expect(index.ensureFresh()).rejects.toMatchObject({ code: 'SNAPSHOT_IO_ERROR' })
      expect(index.size).toBe(0)
      const read = vi.fn()
      io.loadPersisted = read
      await expect(new FileBackedInvertedIndex(io).ensureFresh()).rejects.toMatchObject({ code: 'SNAPSHOT_IO_ERROR' })
      expect(read).not.toHaveBeenCalled()
    },
  )

  it.each(['loadPersisted', 'persist'] as const)('keeps ordinary %s errors optional only while the guard stays usable', async (stage) => {
    let blocked = false
    const io = fake({ assertUsable: async () => {
      if (blocked) throw new MemoryFileMutationError('MUTATION_PENDING')
    } })
    io[stage] = async () => { throw new Error('optional cache failure') }
    await expect(new FileBackedInvertedIndex(io, logger).allEntries()).resolves.toEqual([row])
    io[stage] = async () => { blocked = true; throw new Error('optional cache failure') }
    await expect(new FileBackedInvertedIndex(io, logger).allEntries()).rejects.toMatchObject({ code: 'MUTATION_PENDING' })
  })

  it('drains a rejecting refresh without treating it as a failed purge', async () => {
    const started = deferred()
    const gate = deferred()
    const purge = vi.fn().mockResolvedValue(undefined)
    const index = new FileBackedInvertedIndex(fake({
      loadAll: async () => { started.resolve(); await gate.promise; return [row] }, removePersisted: purge,
    }))
    const refresh = index.ensureFresh().catch((error: unknown) => error)
    await started.promise
    const cleanup = index.retire()
    gate.reject(new MemoryFileSnapshotError('SNAPSHOT_INVALID_DATA'))
    await expect(cleanup).resolves.toBeUndefined()
    expect(await refresh).toBeInstanceOf(Error)
    expect(purge).toHaveBeenCalledOnce()
  })

  it.each(['allEntries', 'lookupByIds'] as const)('rechecks the guard after %s awaits freshness', async (method) => {
    let blocked = false
    const index = new FileBackedInvertedIndex(fake({ assertUsable: async () => {
      if (blocked) throw new MemoryFileMutationError('MUTATION_STALE_HANDLE')
    } }))
    await index.ensureFresh()
    vi.spyOn(index, 'ensureFresh').mockImplementation(async () => { blocked = true })
    await expect(method === 'allEntries' ? index.allEntries() : index.lookupByIds(['old']))
      .rejects.toMatchObject({ code: 'MUTATION_STALE_HANDLE' })
  })
})

describe('recall retirement real files', () => {
  let rootDir: string
  const owner = { kind: 'user', id: 'alice' } as const
  const kinds: MemoryKind[] = ['semantic', 'episodic']
  const file = (name: string, userId = 'alice') => join(ownerDir(rootDir, { kind: 'user', id: userId }), name)
  const handle = () => new MemoryFileHandle({ rootDir, owner, config: { kinds }, logger })
  const open = (userId = 'alice') => openButlerRecallIndex({ rootDir, userId, kinds, logger })
  beforeEach(async () => {
    rootDir = await fs.mkdtemp(join(tmpdir(), 'gotong-recall-retirement-'))
    await handle().remember(row)
  })
  afterEach(() => vi.restoreAllMocks())

  it('removes only the owner cache and known atomic/legacy temps, even partial temps', async () => {
    const index = open()
    await index.ensureFresh()
    expect((await fs.stat(file('recall-index.json'))).mode & 0o777).toBe(0o600)
    const temps = ['recall-index.json.123.ab123.abcdef.tmp', 'recall-index.json.tmp']
    for (const name of temps) await fs.writeFile(file(name), '{partial private')
    await fs.writeFile(file('unrelated.txt'), 'keep')
    const before = await fs.readFile(kindFile(rootDir, owner, 'semantic'))
    await open('bob').ensureFresh()
    // Empty namespaces need not create a cache; explicitly seed an unrelated one.
    await fs.mkdir(ownerDir(rootDir, { kind: 'user', id: 'bob' }), { recursive: true })
    await fs.writeFile(file('recall-index.json', 'bob'), 'unrelated-byte-content')
    await index.retire()
    await index.retire()
    for (const name of ['recall-index.json', ...temps]) await expect(fs.lstat(file(name))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(file('unrelated.txt'), 'utf8')).toBe('keep')
    expect(await fs.readFile(file('recall-index.json', 'bob'), 'utf8')).toBe('unrelated-byte-content')
    expect(await fs.readFile(kindFile(rootDir, owner, 'semantic'))).toEqual(before)
    await open('absent').retire()
  })

  it.each(['pending', 'stale'] as const)('rejects a previously warm cache under %s barriers', async (barrier) => {
    const index = open()
    await index.ensureFresh()
    const cached = await fs.readFile(file('recall-index.json'))
    if (barrier === 'pending') await fs.writeFile(file('.mutation.pending'), 'blocked')
    else {
      const writer = handle()
      await writer.applySnapshotMutation({ expectedRevision: (await writer.snapshot()).revision,
        remove: [], rewrite: [{ ...row, text: 'corrected synthetic pears' }], append: [], maxEntryBytes: 4096 })
    }
    const code = barrier === 'pending' ? 'MUTATION_PENDING' : 'MUTATION_STALE_HANDLE'
    for (const op of [() => index.assertUsable(), () => index.allEntries(),
      () => index.lookupByIds(['old']), () => index.retriever().retrieve({ text: 'apples' })]) {
      await expect(op()).rejects.toMatchObject({ code })
    }
    expect(await fs.readFile(file('recall-index.json'))).toEqual(cached)
    if (barrier === 'stale') {
      await index.retire()
      await expect(fs.lstat(file('recall-index.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      await expect(open().ensureFresh()).rejects.toMatchObject({ code })
      await expect(index.retire()).rejects.toMatchObject(cleanupFailed)
      expect(await fs.readFile(file('recall-index.json'))).toEqual(cached)
    }
  })

  it('uses a strict snapshot, never a permissive JSONL fallback', async () => {
    await fs.appendFile(kindFile(rootDir, owner, 'semantic'), '{bad json\n')
    await expect(open().ensureFresh()).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID_DATA' })
    await expect(fs.lstat(file('recall-index.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps kind/owner scope stable when the caller mutates options', async () => {
    const selected: MemoryKind[] = ['semantic']
    const options = { rootDir, userId: 'alice', kinds: selected }
    const index = openButlerRecallIndex(options)
    selected[0] = 'episodic'
    options.userId = 'bob'
    options.rootDir = join(rootDir, 'elsewhere')
    expect((await index.allEntries()).map((entry) => entry.id)).toEqual(['old'])
    const episodic = openButlerRecallIndex({ rootDir, userId: 'alice', kinds: ['episodic'], logger })
    expect(await episodic.allEntries()).toEqual([])
    expect((await open().allEntries()).map((entry) => entry.id)).toEqual(['old'])
  })

  it.each(['recall-index.json.unknown.tmp', 'recall-index.json-malformed.tmp', 'recall-index.json.123.ab123.abcdef.tmp', 'recall-index.json'])(
    'preflights %s before deleting any cache or temp', async (badName) => {
      const index = open()
      await index.ensureFresh()
      const safeTemp = file('recall-index.json.456.xyz.123abc.tmp')
      await fs.writeFile(safeTemp, 'owned-temp')
      const target = join(rootDir, 'outside')
      await fs.writeFile(target, 'target-untouched')
      if (badName.endsWith('unknown.tmp') || badName.endsWith('-malformed.tmp')) await fs.writeFile(file(badName), 'unknown')
      else {
        if (badName === 'recall-index.json') await fs.unlink(file(badName))
        await fs.symlink(target, file(badName))
      }
      const before = (await fs.readdir(ownerDir(rootDir, owner))).sort()
      await expect(index.retire()).rejects.toMatchObject(cleanupFailed)
      expect((await fs.readdir(ownerDir(rootDir, owner))).sort()).toEqual(before)
      expect(await fs.readFile(safeTemp, 'utf8')).toBe('owned-temp')
      expect(await fs.readFile(target, 'utf8')).toBe('target-untouched')
    },
  )

  it('refuses redirected owner directories before warm cache IO', async () => {
    await open().ensureFresh()
    const dir = ownerDir(rootDir, owner)
    const moved = join(rootDir, 'moved')
    await fs.rename(dir, moved)
    await fs.symlink(moved, dir)
    const cache = await fs.readFile(join(moved, 'recall-index.json'))
    const index = open()
    await expect(index.ensureFresh()).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID_SCOPE' })
    await expect(index.retire()).rejects.toMatchObject(cleanupFailed)
    expect(await fs.readFile(join(moved, 'recall-index.json'))).toEqual(cache)
  })

  it.each(['unlink', 'sync'] as const)('propagates strict %s failure and retries cleanup', async (stage) => {
    const index = open()
    await index.ensureFresh()
    if (stage === 'unlink') vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('private path'))
    else {
      const original = fs.open
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const fd = await original(...args)
        if (args[0] === ownerDir(rootDir, owner) && typeof args[1] === 'number' && (args[1] & constants.O_DIRECTORY)) {
          vi.spyOn(fd, 'sync').mockRejectedValueOnce(new Error('private sync failure'))
        }
        return fd
      })
    }
    await expect(index.retire()).rejects.toMatchObject(cleanupFailed)
    await expect(index.assertUsable()).rejects.toMatchObject(retired)
    vi.restoreAllMocks()
    await index.retire()
    await expect(fs.lstat(file('recall-index.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retire then file mutation then fresh factory never recalls the removed row', async () => {
    const old = open()
    expect((await old.allEntries()).map((entry) => entry.id)).toEqual(['old'])
    await old.retire()
    const writer = handle()
    await writer.applySnapshotMutation({ expectedRevision: (await writer.snapshot()).revision,
      remove: [{ id: 'old', kind: 'semantic' }], rewrite: [], append: [], maxEntryBytes: 4096 })
    await expect(old.retriever().retrieve({ text: 'apples' })).rejects.toMatchObject(retired)
    expect(await open().retriever().retrieve({ text: 'apples' })).toEqual([])
  })

  it.each(['loadPersisted', 'persist'] as const)('waits for real %s IO before purging its on-disk bytes', async (stage) => {
    if (stage === 'loadPersisted') await open().ensureFresh()
    const io = createRecallIndexIo({ rootDir, userId: 'alice', kinds, logger })
    const started = deferred()
    const gate = deferred()
    if (stage === 'loadPersisted') {
      const original = io.loadPersisted!
      io.loadPersisted = async () => { const cached = await original(); started.resolve(); await gate.promise; return cached }
    } else {
      const original = io.persist!
      io.persist = async (data) => { await original(data); started.resolve(); await gate.promise }
    }
    const index = new FileBackedInvertedIndex(io, logger)
    const refresh = index.ensureFresh().catch((error: unknown) => error)
    await started.promise
    const cache = await fs.readFile(file('recall-index.json'))
    const cleanup = index.retire()
    expect(await fs.readFile(file('recall-index.json'))).toEqual(cache)
    gate.resolve()
    await cleanup
    expect(await refresh).toMatchObject(retired)
    expect(index.size).toBe(0)
    await expect(fs.lstat(file('recall-index.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('warm starts without snapshot JSONL reads and rebuilds a corrupt derived cache', async () => {
    await open().ensureFresh()
    const snapshot = vi.spyOn(MemoryFileHandle.prototype, 'snapshot')
    expect((await open().allEntries()).map((entry) => entry.id)).toEqual(['old'])
    expect(snapshot).not.toHaveBeenCalled()
    await fs.writeFile(file('recall-index.json'), '{partial cache')
    expect((await open().allEntries()).map((entry) => entry.id)).toEqual(['old'])
    expect(snapshot).toHaveBeenCalledOnce()
  })

  it('rejects symlinked cache targets before read or persist with zero target writes', async () => {
    const target = join(rootDir, 'target')
    await fs.writeFile(target, 'unrelated-secret')
    await fs.symlink(target, file('recall-index.json'))
    const io = createRecallIndexIo({ rootDir, userId: 'alice', kinds, logger })
    await expect(io.loadPersisted!()).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID_SCOPE' })
    await expect(io.persist!({ watermark: 'same', snapshot: { version: 1, entries: [row] } }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_INVALID_SCOPE' })
    await expect(open().ensureFresh()).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID_SCOPE' })
    expect(await fs.readFile(target, 'utf8')).toBe('unrelated-secret')
    expect((await fs.lstat(file('recall-index.json'))).isSymbolicLink()).toBe(true)
  })

  it('rejects invalid kinds before touching any existing cache', async () => {
    await open().ensureFresh()
    const before = await fs.readFile(file('recall-index.json'))
    const index = openButlerRecallIndex({ rootDir, userId: 'alice', kinds: ['../escape' as MemoryKind], logger })
    await expect(index.ensureFresh()).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID_SCOPE' })
    await expect(index.retire()).rejects.toMatchObject(cleanupFailed)
    expect(await fs.readFile(file('recall-index.json'))).toEqual(before)
  })
})
