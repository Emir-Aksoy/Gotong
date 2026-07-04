import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createLogger } from '@gotong/core'
import { TrashRestoreConflictError, ownerKey } from '@gotong/services-sdk'
import type { Owner } from '@gotong/services-sdk'
import { MemoryFilePlugin } from '../src/plugin.js'
import { kindFile, ownerDir, trashEntryDir, trashMetaFile } from '../src/paths.js'

const logger = createLogger('memory-file-plugin-test', { disabled: true })

let rootDir: string
let plugin: MemoryFilePlugin
const owner: Owner = { kind: 'agent', id: 'writer-zh' }

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'gotong-mem-plugin-'))
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

// D3: pre-3.1 the unconditional `rm -rf trashDir` at the end of
// `restore()` silently destroyed any `payload-<ts>/` siblings created
// by same-day re-deletes. A user who softDeleted, rewrote, softDeleted
// again, then restored, lost the second batch of data with no warning.
// The fix: keep the trash entry alive when siblings remain so they're
// recoverable.
describe('restore preserves sibling payload-* (D3)', () => {
  it('restoring after same-day re-delete leaves siblings in trash', async () => {
    const fixedNow = 1_910_000_000_000
    const local = new MemoryFilePlugin()
    await local.init({
      rootDir, logger,
      hub: { now: () => fixedNow, publishEvent: () => undefined },
    })
    try {
      const cfg = await local.validateConfig({})
      const h1 = await local.attach(owner, cfg)
      await h1.remember({ kind: 'episodic', text: 'first-batch' })
      await local.detach(owner)
      const ref1 = await local.softDelete(owner)

      // Re-attach and add new data, then soft delete again same day.
      const h2 = await local.attach(owner, cfg)
      await h2.remember({ kind: 'episodic', text: 'second-batch' })
      await local.detach(owner)
      const ref2 = await local.softDelete(owner)
      expect(ref2.id).toBe(ref1.id) // same trash entry

      // Restore: should pull the canonical `payload/` back but leave
      // the `payload-*` sibling alone.
      await local.restore(ref1)

      const { readdir } = await import('node:fs/promises')
      const remaining = await readdir(trashEntryDir(rootDir, ref1.id))
      expect(remaining.some((e) => e.startsWith('payload-'))).toBe(true)
      // meta.json still present so listTrash continues to surface it.
      expect(remaining).toContain('meta.json')

      const all = await local.listTrash()
      expect(all.map((r) => r.id)).toContain(ref1.id)

      // Cleanup
      await local.hardDelete(ref1)
    } finally {
      await local.shutdown()
    }
  })

  it('restore with no siblings still removes the trash entry cleanly', async () => {
    const cfg = await plugin.validateConfig({})
    const h = await plugin.attach(owner, cfg)
    await h.remember({ kind: 'episodic', text: 'only-batch' })
    await plugin.detach(owner)
    const ref = await plugin.softDelete(owner)

    await plugin.restore(ref)

    await expect(access(trashEntryDir(rootDir, ref.id))).rejects.toThrow(/ENOENT/)
    expect(await plugin.listTrash()).toEqual([])
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
  // Pre-3.1 this test documented that slashes-in-id were "treated as
  // path" — i.e. an Owner.id like `org/team-1` was silently joined
  // into the rootDir tree as a nested directory. That was an
  // isolation hole: any caller (a buggy host wiring, a future
  // workflow-id that happened to look like a path, a hostile
  // sidecar) could escape into another tenant's tree by crafting
  // an Owner.id with `..`. The plugin's `ownerDir` now calls
  // `assertSafeOwnerId` first; the SDK-level `resolveOwner` does
  // the same. This test now asserts the new contract: a slash in
  // Owner.id is rejected at attach time.
  it('attach() rejects Owner.id containing a path separator', async () => {
    const cfg = await plugin.validateConfig({})
    const o: Owner = { kind: 'agent', id: 'org/team-1' }
    await expect(plugin.attach(o, cfg)).rejects.toThrow(/path separators/)
  })

  it('attach() rejects Owner.id == ".." (escape attempt)', async () => {
    const cfg = await plugin.validateConfig({})
    const o: Owner = { kind: 'agent', id: '..' }
    await expect(plugin.attach(o, cfg)).rejects.toThrow(/relative-path segment/)
  })

  it('attach() rejects Owner.id with a null byte', async () => {
    const cfg = await plugin.validateConfig({})
    const o: Owner = { kind: 'agent', id: 'normal escape' }
    await expect(plugin.attach(o, cfg)).rejects.toThrow(/null byte/)
  })

  it('ownerKey on a forbidden id is still defined (key format unchanged)', () => {
    // ownerKey is a pure formatter — kept permissive so it stays
    // useful for log lines / parseOwnerKey symmetry. The path
    // layer is what blocks the dangerous id from becoming a real
    // directory; ownerKey is allowed to render it.
    expect(ownerKey({ kind: 'agent', id: 'org/team-1' })).toBe('agent/org/team-1')
  })
})
