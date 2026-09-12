import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@gotong/core'
import type { MemoryEntry, MemoryKind, Owner } from '@gotong/services-sdk'
import { MemoryFileHandle, kindFile, ownerDir } from '../src/index.js'
import type { MemoryFileConfig } from '../src/index.js'

const logger = createLogger('mutation-test', { disabled: true })
const owner: Owner = { kind: 'agent', id: 'synthetic' }
const kinds: MemoryKind[] = ['episodic', 'semantic', 'working']
let rootDir: string
const entry = (id: string, kind: MemoryKind = 'episodic'): MemoryEntry => ({
  id, kind, text: `synthetic-${id}`, ts: 10,
})
function handle(target = owner, config: MemoryFileConfig = { kinds }) {
  return new MemoryFileHandle({ rootDir, owner: target, config, logger, now: () => 42 })
}
async function seed(rows = [entry('old'), entry('keep'), entry('s', 'semantic')]) {
  await fs.mkdir(ownerDir(rootDir, owner), { recursive: true })
  for (const kind of kinds) {
    const raw = rows.filter((e) => e.kind === kind).map((e) => JSON.stringify(e) + ' \r\n').join('')
    await fs.writeFile(kindFile(rootDir, owner, kind), raw)
  }
}
async function input(h: MemoryFileHandle) {
  return { expectedRevision: (await h.snapshot()).revision,
    remove: [{ id: 'old', kind: 'episodic' as const }],
    rewrite: [{ ...entry('s', 'semantic'), text: 'corrected' }],
    append: [{ kind: 'working' as const, text: 'new', meta: { nested: ['original'] } }],
    maxEntryBytes: 4096 }
}
async function normalOps(h: MemoryFileHandle, code: string) {
  for (const op of [() => h.snapshot(), () => h.list(), () => h.recall({}),
    () => h.remember(entry('old')), () => h.forget('old'),
    () => h.patchMeta('old', {}), () => h.clear()]) {
    await expect(op()).rejects.toMatchObject({ code })
  }
}
async function directoryBytes() {
  const dir = ownerDir(rootDir, owner)
  const names = (await fs.readdir(dir)).sort()
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await fs.readFile(join(dir, name), 'utf8')])))
}
beforeEach(async () => { rootDir = await fs.mkdtemp(join(tmpdir(), 'gotong-mutation-')); await seed() })
afterEach(() => vi.restoreAllMocks())

describe('snapshot mutation', () => {
  it('commits multiple kinds, preserves untouched raw lines, and generates full append entries', async () => {
    const h = handle()
    const before = await h.snapshot()
    const result = await h.applySnapshotMutation(await input(h))
    expect(result.entries.map((e) => e.text)).toEqual(['new', 'synthetic-keep', 'corrected'])
    expect(result.entries[0]).toMatchObject({ id: expect.any(String), ts: 42, kind: 'working' })
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(result.revision).not.toBe(before.revision)
    expect(await h.snapshot()).toEqual(result)
    expect(await handle().snapshot()).toEqual(result)
    expect(await fs.readFile(kindFile(rootDir, owner, 'episodic'), 'utf8'))
      .toBe(JSON.stringify(entry('keep')) + ' \r\n')
    expect(JSON.stringify(await directoryBytes())).not.toContain('synthetic-old')
  })

  it('rejects revision conflicts with zero writes', async () => {
    const h = handle()
    const change = await input(h)
    await h.remember({ kind: 'working', text: 'later' })
    const before = await directoryBytes()
    await expect(h.applySnapshotMutation(change)).rejects.toMatchObject({ code: 'MUTATION_CONFLICT' })
    expect(await directoryBytes()).toEqual(before)
  })

  it('invalidates every operation on previously read handles but not new handles or other owners', async () => {
    const old = handle()
    const cached = (await old.list())[0]!
    const other = handle({ kind: 'agent', id: 'other' })
    await other.snapshot()
    const h = handle()
    await h.applySnapshotMutation(await input(h))
    await normalOps(old, 'MUTATION_STALE_HANDLE')
    await expect(old.remember(cached)).rejects.toMatchObject({ code: 'MUTATION_STALE_HANDLE' })
    expect((await handle().snapshot()).entries.some((e) => e.id === 'old')).toBe(false)
    await expect(other.remember({ kind: 'working', text: 'independent' })).resolves.toMatchObject({ text: 'independent' })
  })

  it('binds revisions to owner, kind scope, and generation even if content returns to prior bytes', async () => {
    const otherOwner: Owner = { kind: 'agent', id: 'other' }
    await fs.mkdir(ownerDir(rootDir, otherOwner), { recursive: true })
    for (const kind of kinds) await fs.copyFile(kindFile(rootDir, owner, kind), kindFile(rootDir, otherOwner, kind))
    const h = handle()
    const before = await h.snapshot()
    expect((await handle(otherOwner).snapshot()).revision).not.toBe(before.revision)
    await h.applySnapshotMutation(await input(h))
    await seed()
    expect((await h.snapshot()).revision).not.toBe(before.revision)
  })

  it.each(['duplicate', 'missing', 'kind', 'unconfigured', 'empty', 'overflow', 'id-collision'])('rejects %s before publishing', async (which) => {
    const h = which === 'unconfigured' ? handle(owner, { kinds: ['episodic'] }) : handle()
    const change = await input(h)
    if (which === 'duplicate') change.remove.push(change.remove[0]!)
    if (which === 'missing') change.remove[0]!.id = 'missing'
    if (which === 'kind') change.remove[0]!.kind = '../escape' as 'episodic'
    if (which === 'empty') change.rewrite[0]!.text = ''
    if (which === 'overflow') change.maxEntryBytes = 1
    if (which === 'id-collision') Object.assign(change.append[0]!, { id: 'keep' })
    const before = await directoryBytes()
    await expect(h.applySnapshotMutation(change)).rejects.toMatchObject({
      code: which === 'overflow' ? 'MUTATION_OVERFLOW' : 'MUTATION_INVALID',
    })
    expect(await directoryBytes()).toEqual(before)
  })

  it.each(['prepare', 'kind', 'generation', 'cleanup'])('fails closed at %s and recovers forward idempotently', async (stage) => {
    const h = handle()
    const change = await input(h)
    const before = await directoryBytes()
    const rename = fs.rename
    const unlink = fs.unlink
    if (stage === 'cleanup') {
      vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
        if (String(path).endsWith('.mutation.pending')) throw new Error('synthetic-old private failure')
        return unlink(path)
      })
    } else {
      let kindsWritten = 0
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if ((stage === 'prepare' && String(to).endsWith('.mutation.pending'))
          || (stage === 'kind' && String(to).endsWith('.jsonl') && kindsWritten++ === 1)
          || (stage === 'generation' && String(to).endsWith('.mutation.generation'))) {
          throw new Error('synthetic-old private failure')
        }
        return rename(from, to)
      })
    }
    const error = await h.applySnapshotMutation(change).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'MUTATION_IO_ERROR' })
    expect(String(error)).not.toContain('synthetic-old')
    expect(String(error)).not.toContain(rootDir)
    vi.restoreAllMocks()
    if (stage === 'prepare') {
      for (const kind of kinds) expect((await directoryBytes())[`${kind}.jsonl`]).toBe(before[`${kind}.jsonl`])
      await handle().recoverMutation()
      expect((await h.snapshot()).entries).toHaveLength(3)
    } else {
      await normalOps(h, 'MUTATION_PENDING')
      await normalOps(handle(), 'MUTATION_PENDING')
      await expect(handle({ kind: 'agent', id: 'other' }).list()).resolves.toEqual([])
      const files = await directoryBytes()
      for (const [name, raw] of Object.entries(files)) {
        if (!name.endsWith('.jsonl')) expect(raw).not.toContain('synthetic-old')
      }
      const fresh = handle()
      const recovered = await fresh.recoverMutation()
      expect(recovered.entries.some((e) => e.id === 'old')).toBe(false)
      expect(await fresh.recoverMutation()).toEqual(recovered)
      expect(await handle().snapshot()).toEqual(recovered)
      await normalOps(h, 'MUTATION_STALE_HANDLE')
    }
  })

  it('checks all affected hashes before recovery writes and refuses external drift', async () => {
    const h = handle()
    const change = await input(h)
    const rename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('semantic.jsonl')) throw new Error('injected')
      return rename(from, to)
    })
    await expect(h.applySnapshotMutation(change)).rejects.toMatchObject({ code: 'MUTATION_IO_ERROR' })
    vi.restoreAllMocks()
    await fs.writeFile(kindFile(rootDir, owner, 'working'), JSON.stringify(entry('drift', 'working')) + '\n')
    const before = await directoryBytes()
    await expect(handle().recoverMutation()).rejects.toMatchObject({ code: 'MUTATION_RECOVERY_CONFLICT' })
    expect(await directoryBytes()).toEqual(before)
  })

  it('detaches queued mutation input, including nested metadata', async () => {
    const h = handle()
    const change = await input(h)
    const promise = h.applySnapshotMutation(change)
    change.remove[0]!.id = 'keep'
    change.rewrite[0]!.text = 'not approved'
    change.append[0]!.meta.nested[0] = 'not approved'
    const result = await promise
    expect(result.entries.map((e) => e.text)).toEqual(['new', 'synthetic-keep', 'corrected'])
    expect(result.entries[0]!.meta).toEqual({ nested: ['original'] })
  })

  it('freezes external configuration and owner before any read or queued operation', async () => {
    const mutableOwner = { ...owner }
    const config = { kinds: [...kinds], maxEpisodicBytes: 10000 }
    const h = handle(mutableOwner, config)
    const change = await input(h)
    const running = h.applySnapshotMutation(change)
    mutableOwner.id = 'other'
    config.kinds.splice(0, 3, 'working')
    config.maxEpisodicBytes = 1
    const result = await running
    expect(await h.snapshot()).toEqual(result)
    expect(await handle().snapshot()).toEqual(result)
  })

  it('budgets append after its ID and timestamp exist, and does not truncate unrelated rows', async () => {
    const h = handle()
    const change = await input(h)
    change.remove = []
    change.rewrite = []
    change.maxEntryBytes = Buffer.byteLength(JSON.stringify(change.append[0]))
    const before = await directoryBytes()
    await expect(h.applySnapshotMutation(change)).rejects.toMatchObject({ code: 'MUTATION_OVERFLOW' })
    expect(await directoryBytes()).toEqual(before)
    const capped = handle(owner, { kinds, maxSemanticBytes: 1 })
    await expect(capped.applySnapshotMutation(await input(capped))).rejects.toMatchObject({ code: 'MUTATION_OVERFLOW' })
    expect(await directoryBytes()).toEqual(before)
  })

  it('preserves an untouched kind byte-for-byte even when it already exceeds its configured cap', async () => {
    const h = handle(owner, { kinds, maxSemanticBytes: 1 })
    const change = await input(h)
    change.rewrite = []
    const before = await fs.readFile(kindFile(rootDir, owner, 'semantic'))
    await h.applySnapshotMutation(change)
    expect(await fs.readFile(kindFile(rootDir, owner, 'semantic'))).toEqual(before)
  })

  it.each(['duplicate-existing', 'overlap', 'duplicate-append', 'invalid-meta', 'invalid-ts', 'non-json'])('rejects %s without writes', async (which) => {
    if (which === 'duplicate-existing') await seed([entry('old'), entry('old'), entry('s', 'semantic')])
    const h = handle()
    const change = await input(h)
    if (which === 'overlap') change.rewrite.push(entry('old'))
    if (which === 'duplicate-append') change.append.push(change.append[0]!)
    if (which === 'duplicate-append') for (const e of change.append) Object.assign(e, { id: 'same' })
    if (which === 'invalid-meta') Object.assign(change.rewrite[0]!, { meta: [] })
    if (which === 'invalid-ts') change.rewrite[0]!.ts = Number.NaN
    if (which === 'non-json') Object.assign(change.append[0]!.meta, { value: BigInt(1) })
    const before = await directoryBytes()
    await expect(h.applySnapshotMutation(change)).rejects.toMatchObject({ code: 'MUTATION_INVALID' })
    expect(await directoryBytes()).toEqual(before)
  })

  it.each(['owner', 'kinds', 'schema', 'hash', 'duplicate-kind', 'content', 'extra'])('refuses corrupted journal %s without writes', async (which) => {
    const h = handle()
    const change = await input(h)
    const rename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('.jsonl')) throw new Error('injected')
      return rename(from, to)
    })
    await expect(h.applySnapshotMutation(change)).rejects.toMatchObject({ code: 'MUTATION_IO_ERROR' })
    vi.restoreAllMocks()
    const path = join(ownerDir(rootDir, owner), '.mutation.pending')
    const journal = JSON.parse(await fs.readFile(path, 'utf8'))
    if (which === 'owner') journal.owner = 'agent:other'
    if (which === 'kinds') journal.kinds = ['episodic']
    if (which === 'schema') journal.schema = 2
    if (which === 'hash') journal.changes[0].before = 'invalid'
    if (which === 'duplicate-kind') journal.changes.push(journal.changes[0])
    if (which === 'content') journal.changes[0].content = 'broken'
    if (which === 'extra') journal.path = '../outside'
    await fs.writeFile(path, JSON.stringify(journal))
    const before = await directoryBytes()
    await expect(handle().recoverMutation()).rejects.toMatchObject({ code: 'MUTATION_RECOVERY_CONFLICT' })
    expect(await directoryBytes()).toEqual(before)
  })

  it('uses private exclusive prepare and cleans a failed pre-publish write', async () => {
    const h = handle()
    const change = await input(h)
    const open = fs.open
    let observed = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.mutation.prepare')) {
        observed = true
        expect(args[2]).toBe(0o600)
        throw new Error('synthetic-old')
      }
      return open(...args)
    })
    const before = await directoryBytes()
    await expect(h.applySnapshotMutation(change)).rejects.toMatchObject({ code: 'MUTATION_IO_ERROR' })
    expect(observed).toBe(true)
    expect(await directoryBytes()).toEqual(before)
  })

  it('retains pending if the final snapshot read fails after main files and generation are written', async () => {
    const h = handle()
    const change = await input(h)
    const fd = await fs.open(kindFile(rootDir, owner, 'episodic'), 'r')
    const prototype = Object.getPrototypeOf(fd)
    await fd.close()
    const read = prototype.readFile
    const rename = fs.rename
    let generationWritten = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (String(to).endsWith('.mutation.generation')) generationWritten = true
    })
    vi.spyOn(prototype, 'readFile').mockImplementation(function (this: typeof fd, ...args) {
      if (generationWritten) throw new Error('synthetic-old private read failure')
      return Reflect.apply(read, this, args)
    })
    await expect(h.applySnapshotMutation(change)).rejects.toMatchObject({ code: 'MUTATION_IO_ERROR' })
    vi.restoreAllMocks()
    await normalOps(handle(), 'MUTATION_PENDING')
    expect((await handle().recoverMutation()).entries.some((e) => e.id === 'old')).toBe(false)
  })

  it('sanitizes generation read I/O failures for every normal operation', async () => {
    const h = handle()
    await h.applySnapshotMutation(await input(h))
    const fd = await fs.open(kindFile(rootDir, owner, 'episodic'), 'r')
    const prototype = Object.getPrototypeOf(fd)
    await fd.close()
    vi.spyOn(prototype, 'readFile').mockRejectedValue(new Error(`synthetic-old ${rootDir}`))
    for (const op of [() => h.snapshot(), () => h.list(), () => h.remember(entry('old'))]) {
      const error = await op().catch((e: unknown) => e)
      expect(error).toMatchObject({ code: 'MUTATION_IO_ERROR' })
      expect(error).not.toHaveProperty('cause')
      expect(String(error)).not.toContain(rootDir)
      expect(String(error)).not.toContain('synthetic-old')
    }
  })

  it.each(['publish', 'kind', 'generation', 'cleanup'])('retains pending on %s directory-sync failure', async (stage) => {
    const h = handle()
    const change = await input(h)
    const fd = await fs.open(ownerDir(rootDir, owner), 'r')
    const prototype = Object.getPrototypeOf(fd)
    const original = prototype.sync
    await fd.close()
    const failAt = { publish: 1, kind: 2, generation: 5, cleanup: 6 }[stage]!
    let count = 0
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: typeof fd) {
      if ((await this.stat()).isDirectory() && ++count === failAt) throw new Error('synthetic-old sync')
      return Reflect.apply(original, this, [])
    })
    await expect(h.applySnapshotMutation(change)).rejects.toMatchObject({ code: 'MUTATION_IO_ERROR' })
    expect(count).toBeGreaterThanOrEqual(failAt)
    vi.restoreAllMocks()
    await normalOps(h, 'MUTATION_PENDING')
    expect((await handle().recoverMutation()).entries.some((e) => e.id === 'old')).toBe(false)
  })

  it.each(['prepare', 'generation', 'pending', 'kind'])('refuses a static %s symlink without modifying its target', async (which) => {
    const h = handle()
    const change = await input(h)
    const outside = join(rootDir, 'synthetic-outside')
    await fs.writeFile(outside, 'synthetic-private-outside')
    const path = which === 'kind' ? kindFile(rootDir, owner, 'working')
      : join(ownerDir(rootDir, owner), `.mutation.${which}`)
    if (which === 'kind') await fs.unlink(path)
    await fs.symlink(outside, path)
    for (const op of [() => h.snapshot(), () => h.list(), () => h.remember(entry('old')),
      () => h.applySnapshotMutation(change), () => h.recoverMutation()]) {
      await expect(op()).rejects.toThrow()
    }
    expect(await fs.readFile(outside, 'utf8')).toBe('synthetic-private-outside')
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(true)
  })

  it.each(['owner', 'kind'])('checks invalid runtime %s before all normal state-path I/O', async (which) => {
    const invalidOwner = { kind: '../escape' as Owner['kind'], id: 'synthetic' }
    const h = which === 'owner' ? handle(invalidOwner) : handle(owner, { kinds: ['../escape' as MemoryKind] })
    const open = vi.spyOn(fs, 'open')
    await normalOps(h, 'SNAPSHOT_INVALID_SCOPE')
    expect(open).not.toHaveBeenCalled()
  })

  it('does not overwrite or clean unknown prepare files and exposes no raw snapshot state', async () => {
    const h = handle()
    const change = await input(h)
    expect(Object.keys(await h.snapshot()).sort()).toEqual(['entries', 'revision'])
    const path = join(ownerDir(rootDir, owner), '.mutation.prepare')
    await fs.writeFile(path, 'synthetic-unknown')
    await expect(h.applySnapshotMutation(change)).rejects.toMatchObject({ code: 'MUTATION_PENDING' })
    await expect(h.recoverMutation()).rejects.toMatchObject({ code: 'MUTATION_RECOVERY_CONFLICT' })
    expect(await fs.readFile(path, 'utf8')).toBe('synthetic-unknown')
  })

  it('allows explicit trusted recovery to rebind a stale handle and can retry an interrupted recovery', async () => {
    const old = handle()
    await old.snapshot()
    const h = handle()
    const change = await input(h)
    const rename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('working.jsonl')) throw new Error('injected')
      return rename(from, to)
    })
    await expect(h.applySnapshotMutation(change)).rejects.toMatchObject({ code: 'MUTATION_IO_ERROR' })
    await expect(old.recoverMutation()).rejects.toMatchObject({ code: 'MUTATION_IO_ERROR' })
    vi.restoreAllMocks()
    const after = await old.recoverMutation()
    expect(await old.snapshot()).toEqual(after)
    expect(after.entries.some((e) => e.id === 'old')).toBe(false)
    const current = handle()
    const next = { expectedRevision: after.revision, remove: [{ id: 'keep', kind: 'episodic' as const }],
      rewrite: [], append: [], maxEntryBytes: 1000 }
    await current.applySnapshotMutation(next)
    await expect(old.list()).rejects.toMatchObject({ code: 'MUTATION_STALE_HANDLE' })
    const rebound = await old.recoverMutation()
    expect(await old.snapshot()).toEqual(rebound)
  })

  it('tracks crash-left after-images through recovery so a second deletion leaves no old text in temps', async () => {
    const h = handle()
    const change = await input(h)
    const rename = fs.rename
    const unlink = fs.unlink
    let abandoned = ''
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('episodic.jsonl')) {
        abandoned = String(from)
        throw new Error('simulated crash before rename')
      }
      return rename(from, to)
    })
    vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
      if (String(path) === abandoned) throw new Error('simulated crash before cleanup')
      return unlink(path)
    })
    await expect(h.applySnapshotMutation(change)).rejects.toMatchObject({ code: 'MUTATION_IO_ERROR' })
    vi.restoreAllMocks()
    expect(await fs.readFile(abandoned, 'utf8')).toContain('synthetic-keep')
    const fresh = handle()
    const recovered = await fresh.recoverMutation()
    await fresh.applySnapshotMutation({ expectedRevision: recovered.revision,
      remove: [{ id: 'keep', kind: 'episodic' }], rewrite: [], append: [], maxEntryBytes: 4096 })
    const files = await directoryBytes()
    expect(JSON.stringify(files)).not.toContain('synthetic-keep')
    expect(Object.keys(files).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it.each(['corrupt', 'unknown'])('preflights %s crash temp before ANY recovery write or cleanup', async (which) => {
    const h = handle()
    const change = await input(h)
    const rename = fs.rename
    const unlink = fs.unlink
    let abandoned = ''
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('working.jsonl')) {
        abandoned = String(from)
        throw new Error('simulated crash')
      }
      return rename(from, to)
    })
    vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
      if (String(path) === abandoned) throw new Error('simulated crash')
      return unlink(path)
    })
    await expect(h.applySnapshotMutation(change)).rejects.toMatchObject({ code: 'MUTATION_IO_ERROR' })
    vi.restoreAllMocks()
    if (which === 'corrupt') await fs.writeFile(abandoned, 'synthetic-drift')
    else await fs.writeFile(join(ownerDir(rootDir, owner), '.mutation-unknown.tmp'), 'synthetic-foreign')
    const before = await directoryBytes()
    await expect(handle().recoverMutation()).rejects.toMatchObject({ code: 'MUTATION_RECOVERY_CONFLICT' })
    expect(await directoryBytes()).toEqual(before)
  })

  it('makes pending unlink the last fallible operation without rebuilding the released barrier', async () => {
    const h = handle()
    const change = await input(h)
    const unlink = fs.unlink
    const open = fs.open
    let released = false
    let postReleaseOpen = 0
    vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
      await unlink(path)
      if (String(path).endsWith('.mutation.pending')) released = true
    })
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (released) { postReleaseOpen++; throw new Error('synthetic post-release sync and marker rebuild failure') }
      return open(...args)
    })
    await expect(h.applySnapshotMutation(change)).resolves.toMatchObject({ entries: expect.any(Array) })
    expect(released).toBe(true)
    expect(postReleaseOpen).toBe(0)
  })

  it('rejects resurrected pending with after-generation and legitimately restored before-bytes without writes', async () => {
    const initial = { ...entry('s', 'semantic'), meta: { status: 'before' } }
    await fs.writeFile(kindFile(rootDir, owner, 'semantic'), JSON.stringify(initial) + '\n')
    const h = handle()
    const before = await fs.readFile(kindFile(rootDir, owner, 'semantic'))
    const change = { expectedRevision: (await h.snapshot()).revision, remove: [],
      rewrite: [{ ...initial, meta: { status: 'after' } }], append: [], maxEntryBytes: 4096 }
    const pendingPath = join(ownerDir(rootDir, owner), '.mutation.pending')
    const unlink = fs.unlink
    let oldPending!: Buffer
    vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
      if (String(path) === pendingPath) oldPending = await fs.readFile(path)
      return unlink(path)
    })
    await h.applySnapshotMutation(change)
    vi.restoreAllMocks()
    await h.patchMeta('s', { status: 'before' })
    expect(await fs.readFile(kindFile(rootDir, owner, 'semantic'))).toEqual(before)
    await fs.writeFile(pendingPath, oldPending)
    const untouched = await directoryBytes()
    await expect(handle().recoverMutation()).rejects.toMatchObject({ code: 'MUTATION_RECOVERY_CONFLICT' })
    expect(await directoryBytes()).toEqual(untouched)
    await normalOps(h, 'MUTATION_PENDING')
  })

  it('recovers an unchanged after-generation when a released pending reappears after power loss', async () => {
    const h = handle()
    const pendingPath = join(ownerDir(rootDir, owner), '.mutation.pending')
    const unlink = fs.unlink
    let oldPending!: Buffer
    vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
      if (String(path) === pendingPath) oldPending = await fs.readFile(path)
      return unlink(path)
    })
    const after = await h.applySnapshotMutation(await input(h))
    vi.restoreAllMocks()
    await fs.writeFile(pendingPath, oldPending)
    expect(await handle().recoverMutation()).toEqual(after)
    expect(await handle().snapshot()).toEqual(after)
  })
})
