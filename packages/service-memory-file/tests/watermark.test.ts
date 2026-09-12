import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@gotong/core'
import type { MemoryKind, Owner } from '@gotong/services-sdk'
import { MemoryFileHandle, kindFile, ownerDir } from '../src/index.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const lstat = vi.fn(actual.lstat)
  const open = vi.fn(actual.open)
  const readFile = vi.fn(actual.readFile)
  return { ...actual, lstat, open, readFile, default: { ...actual.default, lstat, open, readFile } }
})
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

const logger = createLogger('watermark-test', { disabled: true })
const owner: Owner = { kind: 'user', id: 'alice' }
const kinds: MemoryKind[] = ['episodic', 'semantic']
let rootDir: string
const open = (who = owner, allowed = kinds) => new MemoryFileHandle({
  rootDir, owner: who, config: { kinds: allowed }, logger, now: () => 12,
})
beforeEach(async () => { rootDir = await fs.mkdtemp(join(tmpdir(), 'gotong-watermark-')) })
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(fs.lstat).mockImplementation(realFs.lstat).mockClear()
  vi.mocked(fs.open).mockImplementation(realFs.open).mockClear()
  vi.mocked(fs.readFile).mockImplementation(realFs.readFile).mockClear()
})

describe('cheap guarded file watermark', () => {
  it('is stable, scope-bound, and changes for ordinary writes and removal', async () => {
    const h = open()
    const missing = await h.watermark()
    expect(missing).toMatch(/^[a-f0-9]{64}$/)
    expect(await h.watermark()).toBe(missing)
    expect(await open({ kind: 'user', id: 'bob' }).watermark()).not.toBe(missing)
    expect(await open(owner, ['episodic']).watermark()).not.toBe(missing)
    const row = await h.remember({ kind: 'semantic', text: 'synthetic' })
    const written = await h.watermark()
    expect(written).not.toBe(missing)
    expect(await h.watermark()).toBe(written)
    await h.patchMeta(row.id, { important: true })
    const patched = await h.watermark()
    expect(patched).not.toBe(written)
    await h.forget(row.id)
    expect(await h.watermark()).not.toBe(patched)
    await h.clear()
    expect(await h.watermark()).toBe(missing)
  })

  it('uses generation as well as file stats and fences old handles', async () => {
    const h = open()
    await h.remember({ id: 'old', kind: 'semantic', text: 'synthetic' })
    const old = open()
    const before = await old.watermark()
    await h.applySnapshotMutation({ expectedRevision: (await h.snapshot()).revision,
      remove: [{ id: 'old', kind: 'semantic' }], rewrite: [], append: [], maxEntryBytes: 500 })
    await expect(old.watermark()).rejects.toMatchObject({ code: 'MUTATION_STALE_HANDLE' })
    expect(await h.watermark()).not.toBe(before)
    expect(await open().watermark()).toBe(await h.watermark())
  })

  it.each(['prepare', 'pending'])('never treats %s as a normal cache hit', async (name) => {
    const h = open()
    await h.remember({ kind: 'semantic', text: 'synthetic' })
    await h.watermark()
    await fs.writeFile(join(ownerDir(rootDir, owner), `.mutation.${name}`), '{}')
    await expect(h.watermark()).rejects.toMatchObject({ code: 'MUTATION_PENDING' })
    await expect(open().watermark()).rejects.toMatchObject({ code: 'MUTATION_PENDING' })
  })

  it('does not read JSONL contents, even for a large store', async () => {
    await fs.mkdir(ownerDir(rootDir, owner), { recursive: true })
    const path = kindFile(rootDir, owner, 'semantic')
    const rows = Array.from({ length: 150_000 }, (_, i) =>
      JSON.stringify({ id: String(i), kind: 'semantic', text: 'synthetic', ts: i })).join('\n')
    await fs.writeFile(path, rows)
    const generationPath = join(ownerDir(rootDir, owner), '.mutation.generation')
    await fs.writeFile(generationPath, '11111111-1111-4111-8111-111111111111')
    const direct = vi.mocked(fs.readFile).mockImplementation((async (target, options) => {
      if (String(target).endsWith('.jsonl')) throw new Error('unexpected direct content read')
      return realFs.readFile(target, options as never)
    }) as typeof fs.readFile)
    const opened = vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.jsonl')) throw new Error('unexpected JSONL open')
      return realFs.open(...args)
    }).mockClear()
    const h = open()
    expect(await h.watermark()).toBe(await h.watermark())
    expect(direct.mock.calls.some(([target]) => String(target).endsWith('.jsonl'))).toBe(false)
    expect(opened.mock.calls.map(([target]) => String(target))).toEqual([generationPath, generationPath])
  })

  it('changes with only generation, keeping every JSONL stat identical', async () => {
    await fs.mkdir(ownerDir(rootDir, owner), { recursive: true })
    const path = kindFile(rootDir, owner, 'semantic')
    await fs.writeFile(path, 'synthetic unchanged bytes')
    const generationPath = join(ownerDir(rootDir, owner), '.mutation.generation')
    await fs.writeFile(generationPath, '11111111-1111-4111-8111-111111111111')
    const beforeStats = await fs.lstat(path, { bigint: true })
    const before = await open().watermark()
    await fs.writeFile(generationPath, '22222222-2222-4222-8222-222222222222')
    expect(await fs.lstat(path, { bigint: true })).toEqual(beforeStats)
    expect(await open().watermark()).not.toBe(before)
  })

  it.each(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const)('binds %s independently', async (field) => {
    await open().remember({ kind: 'semantic', text: 'synthetic' })
    const path = kindFile(rootDir, owner, 'semantic')
    const h = open()
    const before = await h.watermark()
    vi.mocked(fs.lstat).mockImplementation((async (target, options) => {
      const s = await realFs.lstat(target, options as { bigint: true })
      if (String(target) !== path || !(options as { bigint?: boolean })?.bigint) return s
      return Object.assign(Object.create(s), { [field]: s[field] + 1n })
    }) as typeof fs.lstat)
    expect(await h.watermark()).not.toBe(before)
  })

  it('does not treat a non-ENOENT stat failure as an absent file', async () => {
    await open().remember({ kind: 'semantic', text: 'synthetic' })
    vi.mocked(fs.lstat).mockImplementation((async (target, options) => {
      if (String(target).endsWith('.jsonl') && (options as { bigint?: boolean })?.bigint) {
        throw Object.assign(new Error('synthetic-private-path'), { code: 'EACCES' })
      }
      return realFs.lstat(target, options as { bigint: true })
    }) as typeof fs.lstat)
    const failure = await open().watermark().catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'SNAPSHOT_IO_ERROR' })
    expect(String(failure)).not.toContain('synthetic-private-path')
    expect(failure).not.toHaveProperty('cause')
  })

  it('detaches owner and kinds from caller mutation', async () => {
    const mutableOwner = { ...owner }
    const mutableKinds = [...kinds]
    const h = open(mutableOwner, mutableKinds)
    const before = await h.watermark()
    mutableOwner.id = 'bob'
    mutableKinds.length = 0
    expect(await h.watermark()).toBe(before)
  })

  it('refuses a static kind symlink and a directory instead of a kind file', async () => {
    await fs.mkdir(ownerDir(rootDir, owner), { recursive: true })
    const outside = join(rootDir, 'outside')
    await fs.writeFile(outside, 'synthetic-private')
    const path = kindFile(rootDir, owner, 'semantic')
    await fs.symlink(outside, path)
    await expect(open().watermark()).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID_SCOPE' })
    expect(await fs.readFile(outside, 'utf8')).toBe('synthetic-private')
    await fs.unlink(path)
    await fs.mkdir(path)
    await expect(open().watermark()).rejects.toMatchObject({ code: 'SNAPSHOT_IO_ERROR' })
  })

  it('rejects invalid scope before state-path access', async () => {
    const fd = vi.spyOn(fs, 'open')
    await expect(open(owner, ['../escape' as MemoryKind]).watermark())
      .rejects.toMatchObject({ code: 'SNAPSHOT_INVALID_SCOPE' })
    expect(fd).not.toHaveBeenCalled()
  })
})
