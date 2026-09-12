import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, open, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLogger } from '@gotong/core'
import type { MemoryEntry, MemoryKind, Owner } from '@gotong/services-sdk'
import * as memoryFile from '../src/index.js'

const logger = createLogger('memory-file-snapshot-test', { disabled: true })
const owner: Owner = { kind: 'agent', id: 'synthetic-owner' }
let rootDir: string

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'gotong-memory-snapshot-'))
})

function handle(kinds: MemoryKind[] = ['episodic', 'semantic', 'working'], target = owner) {
  return new memoryFile.MemoryFileHandle({ rootDir, owner: target, config: { kinds }, logger, now: () => 42 })
}

function entry(id: string, ts: number, kind: MemoryKind = 'episodic'): MemoryEntry {
  return { id, ts, kind, text: `synthetic ${id}`, meta: { source: 'fixture' } }
}

async function seed(raw: string | Buffer, kind: MemoryKind = 'episodic', target = owner) {
  await mkdir(memoryFile.ownerDir(rootDir, target), { recursive: true })
  const path = memoryFile.kindFile(rootDir, target, kind)
  await writeFile(path, raw)
  return path
}

async function expectFailure(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => undefined, (cause: unknown) => cause)
  expect(error).toBeInstanceOf(memoryFile.MemoryFileSnapshotError)
  expect(error).toMatchObject({ code })
  expect(Object.keys(error as object)).toEqual(['code'])
  expect(error).not.toHaveProperty('cause')
  expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_MARKER')
  expect(String(error)).not.toContain(rootDir)
}

describe('MemoryFileHandle.snapshot', () => {
  it('reads 150000 legal rows without exceeding the JavaScript argument limit', async () => {
    const rows = Array.from({ length: 150000 }, (_, i) => ({ id: String(i), kind: 'working', text: 'x', ts: i }))
    await seed(rows.map((e) => JSON.stringify(e)).join('\n') + '\n', 'working')
    const snapshot = await handle().snapshot()
    expect(snapshot.entries).toHaveLength(150000)
    expect(snapshot.entries[0]).toEqual(rows.at(-1))
    expect(snapshot.entries.at(-1)).toEqual(rows[0])
  })

  it('returns every entry beyond 10000 newest first without changing list/recall caps', async () => {
    const entries = Array.from({ length: 10_037 }, (_, i) => entry(`row-${i}`, i))
    await seed(entries.map((value) => JSON.stringify(value)).join('\n') + '\n')
    const h = handle()
    const snapshot = await h.snapshot()
    expect(snapshot.entries).toEqual([...entries].reverse())
    expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(await h.list({ limit: 20_000 })).toHaveLength(500)
    expect(await h.recall({ k: 20_000 })).toHaveLength(200)
  })

  it('combines configured kinds but isolates owners and unconfigured files', async () => {
    const episodic = entry('e', 10)
    const semantic = entry('s', 30, 'semantic')
    await seed(JSON.stringify(episodic))
    await seed(JSON.stringify(semantic), 'semantic')
    await seed('SYNTHETIC_PRIVATE_MARKER broken json', 'working')
    await seed('SYNTHETIC_PRIVATE_MARKER other owner', 'episodic', { kind: 'agent', id: 'other' })
    await seed('SYNTHETIC_PRIVATE_MARKER other namespace', 'episodic', { kind: 'user', id: owner.id })
    const h = handle(['semantic', 'episodic'])
    const first = await h.snapshot()
    expect(first.entries).toEqual([semantic, episodic])
    await seed('unconfigured modification', 'working')
    expect(await h.snapshot()).toEqual(first)
    expect(await handle(['episodic', 'semantic']).snapshot()).toEqual(first)
    expect((await handle(['episodic']).snapshot()).entries).toEqual([episodic])
  })

  it('handles missing files, zero-byte files and empty kind sets', async () => {
    const h = handle()
    const missing = await h.snapshot()
    expect(missing.entries).toEqual([])
    expect(missing.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(await h.snapshot()).toEqual(missing)
    await seed('')
    const empty = await h.snapshot()
    expect(empty.entries).toEqual([])
    expect(empty.revision).not.toBe(missing.revision)
    expect((await handle([]).snapshot()).entries).toEqual([])
  })

  it('hashes raw bytes, not parsed entries or mtime, and stays stable across handles', async () => {
    const raw = JSON.stringify(entry('e', 1))
    const path = await seed(raw + '\n')
    const h = handle()
    const original = await h.snapshot()
    await utimes(path, 1, 1)
    expect(await handle().snapshot()).toEqual(original)
    await writeFile(path, raw + ' \n')
    await utimes(path, 1, 1)
    const whitespace = await h.snapshot()
    expect(whitespace.entries).toEqual(original.entries)
    expect(whitespace.revision).not.toBe(original.revision)
    await writeFile(path, JSON.stringify(entry('e', 2)) + '\n')
    expect((await h.snapshot()).revision).not.toBe(whitespace.revision)
    await writeFile(path, raw + '\n')
    expect(await h.snapshot()).toEqual(original)
  })

  it('includes empty configured kinds in the revision', async () => {
    expect((await handle(['episodic']).snapshot()).revision)
      .not.toBe((await handle(['episodic', 'semantic']).snapshot()).revision)
  })

  it('observes earlier cross-handle writes and blocks later writes until its read finishes', async () => {
    const writer = handle()
    const reader = handle()
    const write = writer.remember({ id: 'queued', kind: 'episodic', text: 'before' })
    const beforePatch = reader.snapshot()
    const patch = writer.patchMeta('queued', { corrected: true })
    const afterPatch = reader.snapshot()
    const forget = writer.forget('queued')
    const afterForget = reader.snapshot()
    const [persisted, first, patched, second, , third] = await Promise.all([
      write, beforePatch, patch, afterPatch, forget, afterForget,
    ])
    expect(first.entries).toEqual([persisted])
    expect(patched).toBe(true)
    expect(second.entries).toEqual([{ ...persisted, meta: { corrected: true } }])
    expect(second.revision).not.toBe(first.revision)
    expect(third.entries).toEqual([])
  })

  it.each(['id', 'kind'] as const)('keeps its original scope when the caller mutates owner.%s', async (field) => {
    const original: Owner = { kind: 'agent', id: 'alice' }
    const supplied: { kind: Owner['kind']; id: string } = { ...original }
    const h = handle(['episodic'], supplied)
    const aliceEntry = entry('alice-entry', 1)
    await seed(JSON.stringify(aliceEntry) + '\n', 'episodic', original)
    const before = await h.snapshot()
    if (field === 'id') supplied.id = 'bob'
    else supplied.kind = 'user'
    await seed(JSON.stringify(entry('other-scope', 2)), 'episodic', supplied)

    expect(await h.snapshot()).toEqual(before)
    const added = await h.remember({ kind: 'episodic', text: 'still alice' })
    expect((await handle(['episodic'], original).snapshot()).entries).toEqual([added, aliceEntry])
    expect((await handle(['episodic'], supplied).snapshot()).entries.map((value) => value.id))
      .toEqual(['other-scope'])
  })

  it('cannot read Bob through Alice while a Bob write is queued behind a blocked read', async () => {
    const supplied = { kind: 'agent' as const, id: 'alice' }
    const aliceEntry = entry('alice-entry', 1)
    await seed(JSON.stringify(aliceEntry) + '\n', 'episodic', supplied)
    const alice = handle(['episodic'], supplied)
    const bobOwner: Owner = { kind: 'agent', id: 'bob' }
    const bobPath = await seed(JSON.stringify(entry('bob-entry', 2)) + '\n', 'episodic', bobOwner)
    const bob = handle(['episodic'], bobOwner)
    const file = await open(bobPath, 'r')
    const prototype = Object.getPrototypeOf(file)
    const originalRead = prototype.readFile
    await file.close()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const resume = new Promise<void>((resolve) => { release = resolve })
    // Hold a real snapshot read inside Bob's public queue, with his write behind it.
    const read = vi.spyOn(prototype, 'readFile').mockImplementationOnce(async function (this: typeof file, ...args) {
      entered()
      await resume
      return Reflect.apply(originalRead, this, args)
    })
    const blockingRead = bob.snapshot()
    let writeFinished = false
    const queuedWrite = bob.remember({ kind: 'episodic', text: 'queued for bob' })
      .then((value) => { writeFinished = true; return value })
    try {
      await started
      supplied.id = 'bob'
      const snapshot = await alice.snapshot()
      expect(writeFinished).toBe(false)
      expect(snapshot.entries).toEqual([aliceEntry])
    } finally {
      release()
      await Promise.allSettled([blockingRead, queuedWrite])
      read.mockRestore()
    }
    await expect(blockingRead).resolves.toMatchObject({ entries: [entry('bob-entry', 2)] })
    const persisted = await queuedWrite
    expect((await bob.snapshot()).entries).toEqual([persisted, entry('bob-entry', 2)])
  })

  const valid = entry('SYNTHETIC_PRIVATE_MARKER', 1)
  const invalidRows: Array<[string, string]> = [
    ['broken JSON', '{SYNTHETIC_PRIVATE_MARKER'],
    ['null', 'null'],
    ['array', '[]'],
    ['primitive', '42'],
    ['blank interior row', ''],
    ['whitespace row', '   '],
    ['missing id', JSON.stringify({ ...valid, id: undefined })],
    ['empty id', JSON.stringify({ ...valid, id: '' })],
    ['non-string id', JSON.stringify({ ...valid, id: 4 })],
    ['missing text', JSON.stringify({ ...valid, text: undefined })],
    ['empty text', JSON.stringify({ ...valid, text: '' })],
    ['non-string text', JSON.stringify({ ...valid, text: [] })],
    ['missing kind', JSON.stringify({ ...valid, kind: undefined })],
    ['unknown kind', JSON.stringify({ ...valid, kind: 'other' })],
    ['mismatched kind', JSON.stringify({ ...valid, kind: 'semantic' })],
    ['missing ts', JSON.stringify({ ...valid, ts: undefined })],
    ['null ts', JSON.stringify({ ...valid, ts: null })],
    ['string ts', JSON.stringify({ ...valid, ts: '1' })],
    ['infinite ts', JSON.stringify(valid).replace('"ts":1', '"ts":1e999')],
    ['negative infinite ts', JSON.stringify(valid).replace('"ts":1', '"ts":-1e999')],
    ['null meta', JSON.stringify({ ...valid, meta: null })],
    ['array meta', JSON.stringify({ ...valid, meta: [] })],
    ['string meta', JSON.stringify({ ...valid, meta: 'SYNTHETIC_PRIVATE_MARKER' })],
    ['number meta', JSON.stringify({ ...valid, meta: 2 })],
  ]

  it.each(invalidRows)('rejects %s without returning a partial snapshot or raw error data', async (_label, raw) => {
    await seed(JSON.stringify(entry('good', 0)) + '\n' + raw + '\n')
    await expectFailure(handle().snapshot(), 'SNAPSHOT_INVALID_DATA')
  })

  it('accepts optional meta and valid CRLF records without a final newline', async () => {
    const rows = [{ id: 'a', text: 'a', kind: 'episodic', ts: 0 }, entry('b', 2)]
    await seed(rows.map((value) => JSON.stringify(value)).join('\r\n'))
    expect((await handle().snapshot()).entries).toEqual([...rows].reverse())
  })

  it('rejects invalid UTF-8 rather than replacing bytes inside a valid JSON string', async () => {
    await seed(Buffer.concat([
      Buffer.from('{"id":"synthetic","text":"'),
      Buffer.from([0xff]),
      Buffer.from('","kind":"episodic","ts":1}\n'),
    ]))
    await expectFailure(handle().snapshot(), 'SNAPSHOT_INVALID_DATA')
  })

  it('rejects I/O errors instead of treating them as an empty kind', async () => {
    await mkdir(memoryFile.kindFile(rootDir, owner, 'semantic'), { recursive: true })
    await seed(JSON.stringify(entry('good', 1)))
    await expectFailure(handle().snapshot(), 'SNAPSHOT_IO_ERROR')
  })

  it('does not hide a non-directory owner path as ENOENT', async () => {
    await mkdir(join(rootDir, 'agent'))
    await writeFile(memoryFile.ownerDir(rootDir, owner), 'SYNTHETIC_PRIVATE_MARKER')
    await expectFailure(handle().snapshot(), 'SNAPSHOT_IO_ERROR')
  })

  it.each(['EACCES', 'EIO'])('fails closed on an underlying %s read error', async (code) => {
    const path = await seed(JSON.stringify(entry('good', 1)))
    const file = await open(path, 'r')
    const prototype = Object.getPrototypeOf(file)
    await file.close()
    // Inject at the descriptor boundary so the test also works under root.
    const read = vi.spyOn(prototype, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('SYNTHETIC_PRIVATE_MARKER'), { code }),
    )
    try {
      await expectFailure(handle().snapshot(), 'SNAPSHOT_IO_ERROR')
      expect(read).toHaveBeenCalledOnce()
    } finally {
      read.mockRestore()
    }
  })

  it('recovers the shared queue after a failed snapshot', async () => {
    await seed('null')
    await expectFailure(handle().snapshot(), 'SNAPSHOT_INVALID_DATA')
    await handle().clear()
    await handle().remember({ kind: 'episodic', text: 'after failure' })
    expect((await handle().snapshot()).entries.map((value) => value.text)).toEqual(['after failure'])
  })

  it('rejects a runtime kind path escape before reading it', async () => {
    await expectFailure(handle(['../../SYNTHETIC_PRIVATE_MARKER' as MemoryKind]).snapshot(), 'SNAPSHOT_INVALID_SCOPE')
  })

  it('preserves ownerDir validation against an unsafe owner id', () => {
    expect(() => handle(['episodic'], { kind: 'agent', id: '../outside' })).toThrow()
  })

  it('rejects a runtime owner kind path escape', async () => {
    const target: Owner = { kind: 'agent/../../SYNTHETIC_PRIVATE_MARKER' as Owner['kind'], id: 'owner' }
    await expectFailure(handle(['episodic'], target).snapshot(), 'SNAPSHOT_INVALID_SCOPE')
  })

  it.each(['file', 'owner', 'namespace'] as const)('does not follow a new out-of-scope %s symlink', async (target) => {
    const outside = await mkdtemp(join(tmpdir(), 'gotong-memory-snapshot-outside-'))
    await writeFile(join(outside, 'episodic.jsonl'), JSON.stringify(entry('outside', 1)))
    if (target === 'namespace') {
      await symlink(outside, join(rootDir, 'agent'))
    } else if (target === 'owner') {
      await mkdir(join(rootDir, 'agent'))
      await symlink(outside, memoryFile.ownerDir(rootDir, owner))
    } else {
      await mkdir(memoryFile.ownerDir(rootDir, owner), { recursive: true })
      await symlink(join(outside, 'episodic.jsonl'), memoryFile.kindFile(rootDir, owner, 'episodic'))
    }
    await expectFailure(handle().snapshot(), 'SNAPSHOT_INVALID_SCOPE')
  })
})
