/**
 * HTTP tests for the Personal Butler M6c member privacy-view routes:
 *   GET    /api/me/butler/memory          → { profile, recent }
 *   GET    /api/me/butler/memory/export   → { entries }
 *   DELETE /api/me/butler/memory          → forget everything (被遗忘权)
 *   DELETE /api/me/butler/memory/:id      → forget one entry
 *
 * The web layer forces userId from the SESSION (never the body / query), maps
 * the host surface's status-coded errors to HTTP, degrades GET to an empty
 * snapshot when no surface is wired, and 503s on the mutating routes. A stub
 * ButlerMemorySurface records every call so we can assert the route passed the
 * session userId, not a spoofed one — the no-leak boundary at the route layer.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type {
  ButlerMemorySurface,
  ButlerMemorySnapshot,
  ButlerMemoryView,
} from '../src/me-routes.js'

class StubButlerMemory implements ButlerMemorySurface {
  readonly calls: Array<[string, ...unknown[]]> = []
  snapshot: ButlerMemorySnapshot = { profile: [], recent: [] }
  entries: ButlerMemoryView[] = []
  removed = true
  /** When set, the next call throws an error carrying this status. */
  throwStatus: number | null = null

  private boom(): void {
    if (this.throwStatus != null) {
      const s = this.throwStatus
      this.throwStatus = null
      throw Object.assign(new Error(`stub error ${s}`), { status: s })
    }
  }

  async read(userId: string): Promise<ButlerMemorySnapshot> {
    this.calls.push(['read', userId])
    this.boom()
    return this.snapshot
  }
  async export(userId: string): Promise<ButlerMemoryView[]> {
    this.calls.push(['export', userId])
    this.boom()
    return this.entries
  }
  async forget(userId: string, id: string): Promise<boolean> {
    this.calls.push(['forget', userId, id])
    this.boom()
    return this.removed
  }
  async forgetAll(userId: string): Promise<void> {
    this.calls.push(['forgetAll', userId])
    this.boom()
  }
}

function entry(id: string, kind: string, text: string): ButlerMemoryView {
  return { id, kind, text, ts: 1_780_000_000_000 }
}

interface Boot {
  tmp: string
  server: WebServerHandle
  identity: IdentityStore
  memberCookie: string
  memberUserId: string
  stub: StubButlerMemory | undefined
}

async function boot(opts: { withSurface?: boolean } = {}): Promise<Boot> {
  const withSurface = opts.withSurface ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-me-butler-'))
  const init = await Space.init(tmp, { name: 'me-butler-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')
  void admin
  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
  identity.bootstrap({ adminToken, ownerEmail: 'admin@local', ownerDisplayName: 'TestAdmin' })
  const member = identity.createUser({
    email: 'member@team.test',
    displayName: 'Member',
    password: 'member-strong-password',
    role: 'member',
  })

  const stub = withSurface ? new StubButlerMemory() : undefined
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(stub ? { butlerMemory: stub } : {}),
  })

  const loginRes = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'member@team.test', password: 'member-strong-password' }),
  })
  if (loginRes.status !== 200) throw new Error(`member login failed ${loginRes.status}`)
  const memberCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

  return { tmp, server, identity, memberCookie, memberUserId: member.id, stub }
}

describe('/api/me/butler/memory — member butler-memory privacy view (M6c)', () => {
  let b: Boot

  afterEach(async () => {
    await b.server.close()
    b.identity.close()
    await rm(b.tmp, { recursive: true, force: true })
  })

  async function req(
    b: Boot,
    method: string,
    path: string,
    auth = true,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${b.server.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { cookie: b.memberCookie } : {}) },
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, json }
  }

  it('unauthenticated → 401', async () => {
    b = await boot()
    expect((await req(b, 'GET', '/api/me/butler/memory', false)).status).toBe(401)
  })

  it('GET reads the snapshot for the SESSION user', async () => {
    b = await boot()
    b.stub!.snapshot = {
      profile: [entry('s1', 'semantic', '主人叫阿明,在做奶茶店项目')],
      recent: [entry('e1', 'episodic', '用户说他叫阿明')],
    }
    const r = await req(b, 'GET', '/api/me/butler/memory')
    expect(r.status).toBe(200)
    expect(r.json.profile).toHaveLength(1)
    expect(r.json.recent).toHaveLength(1)
    expect(b.stub!.calls).toContainEqual(['read', b.memberUserId])
  })

  it('GET /export returns everything for the SESSION user', async () => {
    b = await boot()
    b.stub!.entries = [entry('s1', 'semantic', 'p'), entry('e1', 'episodic', 'q')]
    const r = await req(b, 'GET', '/api/me/butler/memory/export')
    expect(r.status).toBe(200)
    expect(r.json.entries).toHaveLength(2)
    expect(b.stub!.calls).toContainEqual(['export', b.memberUserId])
  })

  it('carries the tiering projection (tier / level / importance) through the route (decision ③)', async () => {
    b = await boot()
    // The route echoes the surface view verbatim — assert the clustered fields
    // survive JSON serialization, while a flat entry stays flat (no bogus tags).
    const clustered: ButlerMemoryView = {
      id: 's1',
      kind: 'semantic',
      text: '阿明对花生过敏',
      ts: 1_780_000_000_000,
      tier: 'persona',
      level: 'profile',
      importance: 5,
    }
    b.stub!.snapshot = { profile: [clustered], recent: [entry('e1', 'episodic', '随手一记')] }
    const r = await req(b, 'GET', '/api/me/butler/memory')
    expect(r.status).toBe(200)
    expect(r.json.profile[0]).toMatchObject({ tier: 'persona', level: 'profile', importance: 5 })
    const flat = r.json.recent[0]
    expect(flat.tier).toBeUndefined()
    expect(flat.level).toBeUndefined()
  })

  it('carries the dreaming sweep summary (lastDream) through the route (MR2)', async () => {
    b = await boot()
    // The "上次复盘" line is read-only counts; assert it survives the route echo,
    // and that a snapshot without one simply omits the field (no bogus zeros).
    b.stub!.snapshot = {
      profile: [],
      recent: [],
      lastDream: { firedAt: 1_780_000_000_000, promoted: 3, pruned: 1 },
    }
    const withDream = await req(b, 'GET', '/api/me/butler/memory')
    expect(withDream.status).toBe(200)
    expect(withDream.json.lastDream).toEqual({ firedAt: 1_780_000_000_000, promoted: 3, pruned: 1 })

    b.stub!.snapshot = { profile: [], recent: [] }
    const noDream = await req(b, 'GET', '/api/me/butler/memory')
    expect(noDream.json.lastDream).toBeUndefined()
  })

  it('DELETE forgets one entry by path id (session user forced)', async () => {
    b = await boot()
    const r = await req(b, 'DELETE', '/api/me/butler/memory/e1')
    expect(r.status).toBe(200)
    expect(r.json.removed).toBe(true)
    expect(b.stub!.calls).toContainEqual(['forget', b.memberUserId, 'e1'])
  })

  it('DELETE (no id) forgets EVERYTHING for the session user', async () => {
    b = await boot()
    const r = await req(b, 'DELETE', '/api/me/butler/memory')
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(b.stub!.calls).toContainEqual(['forgetAll', b.memberUserId])
  })

  it('maps a status-coded surface error to HTTP', async () => {
    b = await boot()
    b.stub!.throwStatus = 404
    const r = await req(b, 'DELETE', '/api/me/butler/memory/not-there')
    expect(r.status).toBe(404)
  })

  it('without a wired surface → empty on GET, 503 on mutate', async () => {
    b = await boot({ withSurface: false })
    const get = await req(b, 'GET', '/api/me/butler/memory')
    expect(get.status).toBe(200)
    expect(get.json).toEqual({ profile: [], recent: [] })
    const exp = await req(b, 'GET', '/api/me/butler/memory/export')
    expect(exp.status).toBe(200)
    expect(exp.json).toEqual({ entries: [] })
    expect((await req(b, 'DELETE', '/api/me/butler/memory')).status).toBe(503)
    expect((await req(b, 'DELETE', '/api/me/butler/memory/x')).status).toBe(503)
  })
})
