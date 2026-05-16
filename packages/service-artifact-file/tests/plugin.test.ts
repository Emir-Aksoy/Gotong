import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createLogger } from '@aipehub/core'
import { TrashRestoreConflictError } from '@aipehub/services-sdk'
import type { Owner } from '@aipehub/services-sdk'
import { ArtifactFilePlugin } from '../src/plugin.js'
import { ownerDir, trashEntryDir, trashMetaFile } from '../src/paths.js'

const logger = createLogger('artifact-file-plugin-test', { disabled: true })

let rootDir: string
let plugin: ArtifactFilePlugin
const owner: Owner = { kind: 'agent', id: 'industry-coach' }

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'aipe-art-plugin-'))
  plugin = new ArtifactFilePlugin()
  await plugin.init({
    rootDir, logger,
    hub: { now: () => Date.now(), publishEvent: () => undefined },
  })
})
afterEach(async () => {
  await plugin.shutdown()
  await rm(rootDir, { recursive: true, force: true })
})

describe('init', () => {
  it('creates rootDir + .trash', async () => {
    await expect(access(rootDir)).resolves.not.toThrow()
    await expect(access(join(rootDir, '.trash'))).resolves.not.toThrow()
  })

  it('reports declared metadata', () => {
    expect(plugin.type).toBe('artifact')
    expect(plugin.impl).toBe('file')
    expect(plugin.version).toMatch(/^0\./)
  })
})

describe('attach + handle reuse', () => {
  it('same owner gets same handle on repeat attach', async () => {
    const cfg = await plugin.validateConfig({})
    const a = await plugin.attach(owner, cfg)
    const b = await plugin.attach(owner, cfg)
    expect(b).toBe(a)
  })

  it('detach drops the cache', async () => {
    const cfg = await plugin.validateConfig({})
    const a = await plugin.attach(owner, cfg)
    await plugin.detach(owner)
    const b = await plugin.attach(owner, cfg)
    expect(b).not.toBe(a)
  })
})

describe('describe', () => {
  it('zero on never-attached owner', async () => {
    const snap = await plugin.describe({ kind: 'agent', id: 'never' })
    expect(snap.sizeBytes).toBe(0)
    expect(snap.itemCount).toBe(0)
  })

  it('reports size, itemCount, preview after writes', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    await h.write('one.md', '# one')
    // Linux ext4 / tmpfs report `mtimeMs` at ms granularity. Two writes inside
    // the same ms produce identical mtimes, the `>` tie-break in describe()
    // keeps `previewSource` on the first-walked file (alphabetical: `one.md`),
    // and the assertion below flips. Sleep one tick so mtimes are
    // distinguishable on the slowest CI filesystem. (Reproduced on Node 20
    // GHA runner 2026-05-14 — Node 22 happened to not tie on the same input.)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await h.write('two.md', '# two')
    const snap = await plugin.describe(owner)
    expect(snap.sizeBytes).toBeGreaterThan(0)
    expect(snap.itemCount).toBe(2)
    expect(snap.preview?.mime).toBe('text/markdown')
    // Most recent write should be 'two' since it's later.
    expect(snap.preview?.text).toMatch(/two/)
  })

  it('marks preview truncated when content exceeds the cap', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    const big = 'x'.repeat(64 * 1024)
    await h.write('big.md', big)
    const snap = await plugin.describe(owner)
    expect(snap.preview?.truncated).toBe(true)
  })

  it('binary preview returns base64', async () => {
    const cfg = await plugin.validateConfig({ allowedMimePrefixes: ['*'] })
    const h = await plugin.attach(owner, cfg)
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])  // jpeg magic
    await h.write('pic.jpg', bytes, { mime: 'image/jpeg' })
    const snap = await plugin.describe(owner)
    expect(snap.preview?.mime).toBe('image/jpeg')
    expect(snap.preview?.base64).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(snap.preview?.text).toBeUndefined()
  })
})

describe('softDelete → restore round-trip', () => {
  it('moves owner dir to .trash/<refId>/payload', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    await h.write('q1.md', 'data')
    await plugin.detach(owner)

    const ref = await plugin.softDelete(owner)
    expect(ref.id).toMatch(/^[0-9a-f]{16}$/)
    await expect(access(ownerDir(rootDir, owner))).rejects.toThrow(/ENOENT/)
    await expect(access(trashMetaFile(rootDir, ref.id))).resolves.not.toThrow()
    await expect(access(join(trashEntryDir(rootDir, ref.id), 'payload', 'q1.md')))
      .resolves.not.toThrow()
  })

  it('describe returns 0 after softDelete', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    await h.write('x.md', 'x')
    await plugin.detach(owner)
    await plugin.softDelete(owner)
    expect((await plugin.describe(owner)).sizeBytes).toBe(0)
  })

  it('softDelete twice same day → same id', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    await h.write('x.md', 'x')
    await plugin.detach(owner)
    const a = await plugin.softDelete(owner)
    const b = await plugin.softDelete(owner)
    expect(b.id).toBe(a.id)
  })

  it('restore brings the data back', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    await h.write('preserved.md', 'data')
    await plugin.detach(owner)
    const ref = await plugin.softDelete(owner)

    await plugin.restore(ref)
    const h2 = await plugin.attach(owner, cfg)
    expect(await h2.exists('preserved.md')).toBe(true)
    expect((await h2.read('preserved.md')).content).toBe('data')
  })

  it('restore into a re-taken slot throws', async () => {
    const cfg = await plugin.validateConfig({})
    const h1 = await plugin.attach(owner, cfg)
    await h1.write('one.md', 'one')
    await plugin.detach(owner)
    const ref = await plugin.softDelete(owner)

    const h2 = await plugin.attach(owner, cfg)
    await h2.write('two.md', 'two')

    await expect(plugin.restore(ref)).rejects.toThrow(TrashRestoreConflictError)
  })

  it('hardDelete removes the trash entry', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    await h.write('x.md', 'x')
    await plugin.detach(owner)
    const ref = await plugin.softDelete(owner)
    await plugin.hardDelete(ref)
    await expect(access(trashEntryDir(rootDir, ref.id))).rejects.toThrow(/ENOENT/)
  })
})

describe('listTrash', () => {
  it('returns refs after softDelete', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach({ kind: 'agent', id: 'a1' }, cfg)
    await h.write('x.md', 'x')
    await plugin.detach({ kind: 'agent', id: 'a1' })
    const ref = await plugin.softDelete({ kind: 'agent', id: 'a1' })
    expect((await plugin.listTrash()).map((r) => r.id)).toContain(ref.id)
  })

  it('returns [] when nothing trashed', async () => {
    expect(await plugin.listTrash()).toEqual([])
  })
})

describe('empty-owner softDelete', () => {
  it('returns a ref + writes meta.json + no payload dir', async () => {
    const ref = await plugin.softDelete({ kind: 'agent', id: 'fresh' })
    await expect(access(trashMetaFile(rootDir, ref.id))).resolves.not.toThrow()
    await expect(access(join(trashEntryDir(rootDir, ref.id), 'payload')))
      .rejects.toThrow(/ENOENT/)
  })
})

describe('shutdown', () => {
  it('drops the handle cache', async () => {
    const cfg = await plugin.validateConfig({})
    const a = await plugin.attach(owner, cfg)
    await plugin.shutdown()
    // After shutdown a fresh attach must build a new handle.
    await plugin.init({ rootDir, logger, hub: { now: () => Date.now(), publishEvent: () => undefined } })
    const b = await plugin.attach(owner, cfg)
    expect(b).not.toBe(a)
  })
})
