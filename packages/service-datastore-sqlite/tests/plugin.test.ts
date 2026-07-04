import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createLogger } from '@gotong/core'
import { TrashRestoreConflictError } from '@gotong/services-sdk'
import type { Owner } from '@gotong/services-sdk'
import { DatastoreSqlitePlugin } from '../src/plugin.js'
import { ownerDir, trashEntryDir, trashMetaFile } from '../src/paths.js'

const logger = createLogger('datastore-sqlite-plugin-test', { disabled: true })

let rootDir: string
let plugin: DatastoreSqlitePlugin
const owner: Owner = { kind: 'agent', id: 'industry-coach' }

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'gotong-ds-plugin-'))
  plugin = new DatastoreSqlitePlugin()
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
    expect(plugin.type).toBe('datastore')
    expect(plugin.impl).toBe('sqlite')
    expect(plugin.version).toMatch(/^0\./)
  })
})

describe('attach', () => {
  it('returns the same handle on repeat attach for same (owner, name)', async () => {
    const cfg = await plugin.validateConfig({ name: 'cases' })
    const a = await plugin.attach(owner, cfg)
    const b = await plugin.attach(owner, cfg)
    expect(b).toBe(a)
  })

  it('different name → different handle, both on the same owner', async () => {
    const cfg1 = await plugin.validateConfig({ name: 'cases' })
    const cfg2 = await plugin.validateConfig({ name: 'sessions' })
    const a = await plugin.attach(owner, cfg1)
    const b = await plugin.attach(owner, cfg2)
    expect(a).not.toBe(b)
    expect(a.name).toBe('cases')
    expect(b.name).toBe('sessions')
  })

  it('persists per-name to separate .sqlite files', async () => {
    const cfg1 = await plugin.validateConfig({ name: 'cases' })
    const cfg2 = await plugin.validateConfig({ name: 'sessions' })
    const a = await plugin.attach(owner, cfg1)
    const b = await plugin.attach(owner, cfg2)
    await a.kv.set('industry', 'baker')
    await b.kv.set('user', 'admin')
    // Cross-handle reads must NOT see the other store's keys.
    expect(await a.kv.get('user')).toBeUndefined()
    expect(await b.kv.get('industry')).toBeUndefined()
    expect(await a.kv.get('industry')).toBe('baker')
    expect(await b.kv.get('user')).toBe('admin')
  })

  it('detach closes every handle for the owner', async () => {
    const cfg1 = await plugin.validateConfig({ name: 'cases' })
    const cfg2 = await plugin.validateConfig({ name: 'sessions' })
    const a = await plugin.attach(owner, cfg1)
    await plugin.attach(owner, cfg2)
    await plugin.detach(owner)
    // Re-attach should yield NEW handles (cache cleared).
    const a2 = await plugin.attach(owner, cfg1)
    expect(a2).not.toBe(a)
  })

  // D4: pre-3.1 two parallel attach() calls for the same (owner, name)
  // both passed the cache check, both `await mkdir()`, and both opened
  // their own SQLite connection. The second `handles.set()` orphaned
  // the first handle — its sqlite connection stayed open and leaked
  // for the life of the process. Now attaches are deduped through
  // an in-flight promise cache.
  it('parallel attach(same owner+name) returns the same handle (D4)', async () => {
    const cfg = await plugin.validateConfig({ name: 'shared' })
    const [a, b, c] = await Promise.all([
      plugin.attach(owner, cfg),
      plugin.attach(owner, cfg),
      plugin.attach(owner, cfg),
    ])
    expect(b).toBe(a)
    expect(c).toBe(a)
  })
})

describe('describe', () => {
  it('zero on never-attached owner', async () => {
    const snap = await plugin.describe({ kind: 'agent', id: 'never' })
    expect(snap.sizeBytes).toBe(0)
    expect(snap.itemCount).toBe(0)
  })

  it('counts each .sqlite as one item, sums sizes', async () => {
    const cfg1 = await plugin.validateConfig({ name: 'cases' })
    const cfg2 = await plugin.validateConfig({ name: 'sessions' })
    const a = await plugin.attach(owner, cfg1)
    const b = await plugin.attach(owner, cfg2)
    await a.kv.set('x', 'y')
    await b.kv.set('x', 'y')
    const snap = await plugin.describe(owner)
    expect(snap.itemCount).toBe(2)
    expect(snap.sizeBytes).toBeGreaterThan(0)
  })
})

describe('softDelete + restore round-trip', () => {
  it('moves owner dir to .trash/<refId>/payload', async () => {
    const cfg = await plugin.validateConfig({ name: 'cases' })
    const h = await plugin.attach(owner, cfg)
    await h.kv.set('industry', 'baker')
    await plugin.detach(owner)

    const ref = await plugin.softDelete(owner)
    expect(ref.id).toMatch(/^[0-9a-f]{16}$/)
    await expect(access(ownerDir(rootDir, owner))).rejects.toThrow(/ENOENT/)
    await expect(access(trashMetaFile(rootDir, ref.id))).resolves.not.toThrow()
    await expect(access(join(trashEntryDir(rootDir, ref.id), 'payload', 'cases.sqlite')))
      .resolves.not.toThrow()
  })

  it('describe returns 0 after softDelete', async () => {
    const cfg = await plugin.validateConfig({ name: 'cases' })
    const h = await plugin.attach(owner, cfg)
    await h.kv.set('industry', 'baker')
    await plugin.detach(owner)
    await plugin.softDelete(owner)
    expect((await plugin.describe(owner)).sizeBytes).toBe(0)
  })

  it('softDelete twice same day → same id', async () => {
    const cfg = await plugin.validateConfig({ name: 'cases' })
    const h = await plugin.attach(owner, cfg)
    await h.kv.set('industry', 'baker')
    await plugin.detach(owner)
    const a = await plugin.softDelete(owner)
    const b = await plugin.softDelete(owner)
    expect(b.id).toBe(a.id)
  })

  it('restore brings the data back', async () => {
    const cfg = await plugin.validateConfig({ name: 'cases' })
    const h = await plugin.attach(owner, cfg)
    await h.kv.set('industry', 'baker')
    await plugin.detach(owner)
    const ref = await plugin.softDelete(owner)

    await plugin.restore(ref)
    const h2 = await plugin.attach(owner, cfg)
    expect(await h2.kv.get('industry')).toBe('baker')
  })

  it('restore into a re-taken slot throws', async () => {
    const cfg = await plugin.validateConfig({ name: 'cases' })
    const h1 = await plugin.attach(owner, cfg)
    await h1.kv.set('one', 'one')
    await plugin.detach(owner)
    const ref = await plugin.softDelete(owner)

    const h2 = await plugin.attach(owner, cfg)
    await h2.kv.set('two', 'two')

    await expect(plugin.restore(ref)).rejects.toThrow(TrashRestoreConflictError)
  })

  it('hardDelete removes the trash entry', async () => {
    const cfg = await plugin.validateConfig({ name: 'cases' })
    const h = await plugin.attach(owner, cfg)
    await h.kv.set('x', 'y')
    await plugin.detach(owner)
    const ref = await plugin.softDelete(owner)
    await plugin.hardDelete(ref)
    await expect(access(trashEntryDir(rootDir, ref.id))).rejects.toThrow(/ENOENT/)
  })
})

describe('listTrash', () => {
  it('returns refs after softDelete', async () => {
    const cfg = await plugin.validateConfig({ name: 'cases' })
    const o = { kind: 'agent', id: 'a1' } as const
    const h = await plugin.attach(o, cfg)
    await h.kv.set('x', 'y')
    await plugin.detach(o)
    const ref = await plugin.softDelete(o)
    expect((await plugin.listTrash()).map((r) => r.id)).toContain(ref.id)
  })

  it('returns [] when nothing trashed', async () => {
    expect(await plugin.listTrash()).toEqual([])
  })
})

describe('shutdown', () => {
  it('clears the handle cache + closes connections', async () => {
    const cfg = await plugin.validateConfig({ name: 'cases' })
    const a = await plugin.attach(owner, cfg)
    await plugin.shutdown()
    // re-init for the next attach (the plugin is single-instance)
    await plugin.init({
      rootDir, logger,
      hub: { now: () => Date.now(), publishEvent: () => undefined },
    })
    const b = await plugin.attach(owner, cfg)
    expect(b).not.toBe(a)
  })
})
