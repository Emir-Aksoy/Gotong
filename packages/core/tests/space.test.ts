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
    expect(existsSync(space.paths.config + '.tmp')).toBe(false)
  })
})
