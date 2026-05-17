import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Space } from '../src/space.js'

describe('Space (v2.0 — file-first persistence)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipehub-space-'))
    // tmpdir hands back an existing dir; remove and let init recreate
    await rm(root, { recursive: true, force: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('init writes space.json + config.json + empty admins/agents/workers + runtime/ + services/', async () => {
    const { space, adminToken } = await Space.init(root, { name: 'test', description: 'hi' })
    expect(adminToken).toBeNull()
    expect(existsSync(space.paths.space)).toBe(true)
    expect(existsSync(space.paths.config)).toBe(true)
    expect(existsSync(space.paths.admins)).toBe(true)
    expect(existsSync(space.paths.agents)).toBe(true)
    expect(existsSync(space.paths.workers)).toBe(true)
    expect(existsSync(space.paths.runtime.pendingApps)).toBe(true)
    // services/ is created empty up-front so the host's bootstrapServices
    // doesn't need to mkdir on every boot.
    expect(existsSync(space.paths.services)).toBe(true)
    const meta = JSON.parse(readFileSync(space.paths.space, 'utf8'))
    expect(meta.name).toBe('test')
    expect(meta.description).toBe('hi')
  })

  it('init with adminDisplayName mints a token + admin record', async () => {
    const { space, adminToken, adminId } = await Space.init(root, {
      name: 'test',
      adminDisplayName: 'Emir',
    })
    expect(adminToken).toHaveLength(64) // 32 bytes hex = 64 chars
    expect(adminId).toBe('admin')
    const admins = await space.admins()
    expect(admins).toHaveLength(1)
    expect(admins[0]!.displayName).toBe('Emir')
    // token is hashed, never stored plain
    expect(admins[0]!.tokenHash.startsWith('sha256:')).toBe(true)
    expect(admins[0]!.tokenHash).not.toContain(adminToken!)
  })

  it('verifyAdminToken returns the matching admin (constant-time)', async () => {
    const { space, adminToken } = await Space.init(root, {
      name: 'test',
      adminDisplayName: 'Emir',
    })
    const ok = await space.verifyAdminToken(adminToken!)
    expect(ok?.displayName).toBe('Emir')
    const bad = await space.verifyAdminToken('not-a-token')
    expect(bad).toBeNull()
    const empty = await space.verifyAdminToken(undefined)
    expect(empty).toBeNull()
  })

  it('createAdmin generates unique ids (admin, admin-2, admin-3, …)', async () => {
    const { space } = await Space.init(root, { name: 'test' })
    const a = await space.createAdmin('Alice')
    const b = await space.createAdmin('Bob')
    const c = await space.createAdmin('Carol')
    expect([a.admin.id, b.admin.id, c.admin.id]).toEqual(['admin', 'admin-2', 'admin-3'])
    expect(a.token).not.toBe(b.token)
  })

  it('Space.init throws if the directory is already initialised', async () => {
    await Space.init(root, { name: 'test' })
    await expect(Space.init(root, { name: 'again' })).rejects.toThrow(/already initialised/)
  })

  it('openOrInit returns the existing space on a second open', async () => {
    const first = await Space.openOrInit(root, { name: 'test', adminDisplayName: 'Emir' })
    expect(first.adminToken).not.toBeNull()
    const second = await Space.openOrInit(root, { name: 'ignored' })
    expect(second.adminToken).toBeNull()
    expect((await second.space.meta()).name).toBe('test')
  })

  it('workers: create + verify + remove + touch', async () => {
    const { space } = await Space.init(root, { name: 'test' })
    const { worker, token } = await space.createWorker('alice', ['approve', 'review'])
    expect(worker.id).toBe('alice')
    expect(worker.capabilities).toEqual(['approve', 'review'])
    expect(await space.verifyWorkerToken(token)).not.toBeNull()
    expect(await space.verifyWorkerToken('wrong')).toBeNull()

    await space.touchWorker('alice')
    const ws = await space.workers()
    expect(ws[0]!.lastSeen).toBeTruthy()

    expect(await space.removeWorker('alice')).toBe(true)
    expect(await space.workers()).toHaveLength(0)
    expect(await space.removeWorker('alice')).toBe(false)
  })

  it('workers: re-using an id throws', async () => {
    const { space } = await Space.init(root, { name: 'test' })
    await space.createWorker('bob', [])
    await expect(space.createWorker('bob', [])).rejects.toThrow(/already taken/)
  })

  it('agents: upsert is idempotent on id, preserves createdAt', async () => {
    const { space } = await Space.init(root, { name: 'test' })
    const r1 = await space.upsertAgent({ id: 'writer', allowedCapabilities: ['draft'] })
    const created1 = r1.createdAt
    // some clock tick
    await new Promise((r) => setTimeout(r, 5))
    const r2 = await space.upsertAgent({ id: 'writer', allowedCapabilities: ['draft', 'review'] })
    expect(r2.createdAt).toBe(created1) // preserved
    expect(r2.allowedCapabilities).toEqual(['draft', 'review'])
    expect(await space.agents()).toHaveLength(1)
  })

  it('config: defaults + updateConfig merges patch', async () => {
    const { space } = await Space.init(root, { name: 'test' })
    const c0 = await space.config()
    expect(c0.gating).toBe('admin-approval')
    expect(c0.webPort).toBe(3000)

    const c1 = await space.updateConfig({ webPort: 3100 })
    expect(c1.webPort).toBe(3100)
    expect(c1.gating).toBe('admin-approval')

    // persisted across re-open
    const fresh = await Space.open(root)
    expect((await fresh.config()).webPort).toBe(3100)
  })

  it('pending-apps: write/read round-trip', async () => {
    const { space } = await Space.init(root, { name: 'test' })
    expect(await space.pendingApps()).toEqual([])
    await space.writePendingApps([
      {
        id: 'app-1',
        agents: [{ id: 'writer', capabilities: ['draft'] }],
        pendingSince: 1234,
      },
    ])
    const apps = await space.pendingApps()
    expect(apps).toHaveLength(1)
    expect(apps[0]!.id).toBe('app-1')
  })

  it('admin sessions: add + find + remove', async () => {
    const { space } = await Space.init(root, { name: 'test', adminDisplayName: 'Emir' })
    await space.addAdminSession('sid-1', 'admin')
    const found = await space.findAdminSession('sid-1')
    expect(found?.principalId).toBe('admin')
    expect(await space.findAdminSession('does-not-exist')).toBeNull()
    expect(await space.removeAdminSession('sid-1')).toBe(true)
    expect(await space.findAdminSession('sid-1')).toBeNull()
  })

  it('atomic writes: tmp file does not survive a successful write', async () => {
    const { space } = await Space.init(root, { name: 'test' })
    await space.updateConfig({ webPort: 4242 })
    // Pre-3.1 the temp name was fixed (`<path>.tmp`); post-D1 it gets
    // a unique pid+nanotime+random suffix so concurrent writers don't
    // collide. Either way, the rename should have cleared the tmp.
    const { readdirSync } = await import('node:fs')
    const { basename, dirname } = await import('node:path')
    const dir = dirname(space.paths.config)
    const base = basename(space.paths.config)
    const stragglers = readdirSync(dir).filter(
      (f) => f.startsWith(base) && f !== base,
    )
    expect(stragglers).toEqual([])
  })

  // D1: two concurrent writes to the same Space file used to collide
  // because both built `<path>.tmp` — second writeFile clobbered the
  // first mid-rename and the rename moved a partially-written tmp
  // over the live file. Now each writer gets a unique tmp suffix,
  // both finish, last rename wins, no half-written JSON.
  it('two parallel updateConfig writes both succeed without corruption', async () => {
    const { space } = await Space.init(root, { name: 'test' })
    await Promise.all([
      space.updateConfig({ webPort: 5000 }),
      space.updateConfig({ webPort: 6000 }),
      space.updateConfig({ webPort: 7000 }),
      space.updateConfig({ webPort: 8000 }),
    ])
    // File must be a valid JSON document — none of the parallel
    // writers should have left a torn write behind.
    const final = await space.config()
    expect([5000, 6000, 7000, 8000]).toContain(final.webPort)
  })

  // D2: read-modify-write methods (upsertAgent, createWorker, …)
  // used to drop updates when callers raced — both reads saw the same
  // list, both modifications dropped to the same in-memory copy,
  // both writes overwrote each other. `withFileLock` serialises the
  // RMW window so every concurrent upsert ends up in the file.
  it('parallel upsertAgent calls all land in the file (no lost writes)', async () => {
    const { space } = await Space.init(root, { name: 'test' })
    const N = 20
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        space.upsertAgent({
          id: `agent-${i}`,
          allowedCapabilities: ['cap'],
        }),
      ),
    )
    const agents = await space.agents()
    expect(agents.length).toBe(N)
    const ids = agents.map((a) => a.id).sort()
    expect(ids).toEqual(
      Array.from({ length: N }, (_, i) => `agent-${i}`).sort(),
    )
  })

  it('parallel createWorker calls all persist (no lost workers)', async () => {
    const { space } = await Space.init(root, { name: 'test' })
    const N = 10
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        space.createWorker(`w-${i}`, ['cap']),
      ),
    )
    const workers = await space.workers()
    expect(workers.length).toBe(N)
  })

  // D2 corollary: createWorker enforces id uniqueness via
  // `workers.some((w) => w.id === id)` — without a lock, two parallel
  // calls for the same id used to both pass the dup check and write
  // duplicate rows. Now exactly one wins.
  it('parallel createWorker(same id) wins exactly once', async () => {
    const { space } = await Space.init(root, { name: 'test' })
    const results = await Promise.allSettled([
      space.createWorker('alice', []),
      space.createWorker('alice', []),
      space.createWorker('alice', []),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)
    expect(await space.workers()).toHaveLength(1)
  })
})
