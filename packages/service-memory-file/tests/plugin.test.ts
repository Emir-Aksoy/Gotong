import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createLogger } from '@aipehub/core'
import { TrashRestoreConflictError, ownerKey } from '@aipehub/services-sdk'
import type { Owner } from '@aipehub/services-sdk'
import { MemoryFilePlugin } from '../src/plugin.js'
import { kindFile, ownerDir, trashEntryDir, trashMetaFile } from '../src/paths.js'

const logger = createLogger('memory-file-plugin-test', { disabled: true })

let rootDir: string
let plugin: MemoryFilePlugin
const owner: Owner = { kind: 'agent', id: 'writer-zh' }

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'aipe-mem-plugin-'))
  plugin = new MemoryFilePlugin()
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

  it('reports declared type / impl / version', () => {
    expect(plugin.type).toBe('memory')
    expect(plugin.impl).toBe('file')
    expect(plugin.version).toMatch(/^0\./)
  })
})

describe('attach / detach', () => {
  it('returns a handle that can remember', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    const e = await h.remember({ kind: 'episodic', text: 'hi' })
    expect(e.id).toBeTypeOf('string')
  })

  it('returns the same handle on a repeat attach (cache hit)', async () => {
    const cfg = await plugin.validateConfig({})
    const a = await plugin.attach(owner, cfg)
    const b = await plugin.attach(owner, cfg)
    expect(b).toBe(a)
  })

  it('detach drops the cached handle', async () => {
    const cfg = await plugin.validateConfig({})
    const a = await plugin.attach(owner, cfg)
    await plugin.detach(owner)
    const b = await plugin.attach(owner, cfg)
    expect(b).not.toBe(a)
  })
})

describe('describe', () => {
  it('returns zero on a never-attached owner', async () => {
    const snap = await plugin.describe({ kind: 'agent', id: 'never' })
    expect(snap.sizeBytes).toBe(0)
    expect(snap.itemCount).toBe(0)
  })

  it('reports size + itemCount + preview after writes', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    await h.remember({ kind: 'episodic', text: 'one' })
    await h.remember({ kind: 'semantic', text: 'two' })
    const snap = await plugin.describe(owner)
    expect(snap.sizeBytes).toBeGreaterThan(0)
    expect(snap.itemCount).toBe(2)
    expect(snap.preview?.text).toMatch(/one|two/)
    expect(snap.preview?.mime).toBe('application/x-ndjson')
  })

  it('marks preview truncated when content exceeds the cap', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    // 64 KB of text → > 32 KB cap
    const bigText = 'x'.repeat(64 * 1024)
    await h.remember({ kind: 'episodic', text: bigText })
    const snap = await plugin.describe(owner)
    expect(snap.preview?.truncated).toBe(true)
  })
})

describe('softDelete → restore round-trip', () => {
  it('softDelete moves owner dir into .trash/<refId>/payload', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    await h.remember({ kind: 'episodic', text: 'will-be-trashed' })
    await plugin.detach(owner)

    const ref = await plugin.softDelete(owner)
    expect(ref.id).toMatch(/^[0-9a-f]{16}$/)
    expect(ref.expiresAt).toBeGreaterThan(ref.deletedAt)

    await expect(access(ownerDir(rootDir, owner))).rejects.toThrow(/ENOENT/)
    await expect(access(trashMetaFile(rootDir, ref.id))).resolves.not.toThrow()
    await expect(access(join(trashEntryDir(rootDir, ref.id), 'payload'))).resolves.not.toThrow()
  })

  it('describe returns 0 after softDelete', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    await h.remember({ kind: 'episodic', text: 'x' })
    await plugin.detach(owner)
    await plugin.softDelete(owner)
    const snap = await plugin.describe(owner)
    expect(snap.sizeBytes).toBe(0)
  })

  it('softDelete twice same day → same id, idempotent', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    await h.remember({ kind: 'episodic', text: 'x' })
    await plugin.detach(owner)
    const a = await plugin.softDelete(owner)
    const b = await plugin.softDelete(owner)
    expect(b.id).toBe(a.id)
  })

  it('restore brings the data back', async () => {
    const cfg = await plugin.validateConfig({})
    const h1 = await plugin.attach(owner, cfg)
    await h1.remember({ kind: 'episodic', text: 'restored-data' })
    await plugin.detach(owner)
    const ref = await plugin.softDelete(owner)

    await plugin.restore(ref)
    const h2 = await plugin.attach(owner, cfg)
    const items = await h2.list({})
    expect(items.map((x) => x.text)).toEqual(['restored-data'])
  })

  it('restore into a re-taken owner slot throws', async () => {
    const cfg = await plugin.validateConfig({})
    const h1 = await plugin.attach(owner, cfg)
    await h1.remember({ kind: 'episodic', text: 'first-life' })
    await plugin.detach(owner)
    const ref = await plugin.softDelete(owner)

    // Re-attach with new data (re-uses the same owner key).
    const h2 = await plugin.attach(owner, cfg)
    await h2.remember({ kind: 'episodic', text: 'second-life' })

    await expect(plugin.restore(ref)).rejects.toThrow(TrashRestoreConflictError)
  })

  it('hardDelete removes the trash entry from disk', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    await h.remember({ kind: 'episodic', text: 'x' })
    await plugin.detach(owner)
    const ref = await plugin.softDelete(owner)
    await plugin.hardDelete(ref)
    await expect(access(trashEntryDir(rootDir, ref.id))).rejects.toThrow(/ENOENT/)
  })
})

describe('softDelete-then-reattach-then-softDelete-same-day', () => {
  it('preserves the new data in a sibling payload-* dir', async () => {
    // Use a fixed clock so both deletes hash to the same bucket and
    // the test asserts the merge path deterministically.
    const fixedNow = 1_900_000_000_000
    const local = new MemoryFilePlugin()
    await local.init({
      rootDir, logger,
      hub: { now: () => fixedNow, publishEvent: () => undefined },
    })
    try {
      const cfg = await local.validateConfig({})
      const h1 = await local.attach(owner, cfg)
      await h1.remember({ kind: 'episodic', text: 'life-1' })
      await local.detach(owner)
      const ref1 = await local.softDelete(owner)

      // Reattach and add new data, then soft delete again same day.
      const h2 = await local.attach(owner, cfg)
      await h2.remember({ kind: 'episodic', text: 'life-2' })
      await local.detach(owner)
      const ref2 = await local.softDelete(owner)

      expect(ref2.id).toBe(ref1.id)
      // The new data should be in a sibling payload-* dir.
      const trash = trashEntryDir(rootDir, ref1.id)
      const dirStat = await stat(trash)
      expect(dirStat.isDirectory()).toBe(true)
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(trash)
      expect(entries).toContain('payload')
      expect(entries.some((e) => e.startsWith('payload-'))).toBe(true)

      // Cleanup so afterAll doesn't leak.
      await local.hardDelete(ref2)
    } finally {
      await local.shutdown()
    }
  })
})

describe('listTrash', () => {
  it('returns refs the plugin has created', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach({ kind: 'agent', id: 'a1' }, cfg)
    await h.remember({ kind: 'episodic', text: 'x' })
    await plugin.detach({ kind: 'agent', id: 'a1' })
    const ref = await plugin.softDelete({ kind: 'agent', id: 'a1' })

    const all = await plugin.listTrash()
    expect(all.map((r) => r.id)).toContain(ref.id)
  })

  it('returns [] when nothing trashed', async () => {
    expect(await plugin.listTrash()).toEqual([])
  })
})

describe('soft-delete with nothing to delete', () => {
  it('returns a ref but does not write a payload dir', async () => {
    const ref = await plugin.softDelete(owner)
    expect(ref.id).toMatch(/^[0-9a-f]{16}$/)
    await expect(access(join(trashEntryDir(rootDir, ref.id), 'payload')))
      .rejects.toThrow(/ENOENT/)
    // But meta.json exists so listTrash includes it.
    await expect(access(trashMetaFile(rootDir, ref.id))).resolves.not.toThrow()
  })
})

describe('owner key sanity (no path leakage)', () => {
  it('owner with slash in id stays inside rootDir', async () => {
    const cfg = await plugin.validateConfig({})
    const o: Owner = { kind: 'agent', id: 'org/team-1' }
    const h = await plugin.attach(o, cfg)
    await h.remember({ kind: 'episodic', text: 'nested-id' })
    // ownerKey is still well-formed
    expect(ownerKey(o)).toBe('agent/org/team-1')
    // The owner dir exists inside rootDir (slash treated as path).
    const path = kindFile(rootDir, o, 'episodic')
    expect(path.startsWith(rootDir)).toBe(true)
    const raw = await readFile(path, 'utf8')
    expect(raw).toMatch(/nested-id/)
  })
})
