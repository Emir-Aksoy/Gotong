/**
 * HTTP tests for the SDUI member panel routes (SDUI-M2 read + SDUI-M3 write):
 *
 *   GET /api/me/panel                       → { schemaVersion, config, source }
 *   PUT /api/me/panel { libraryId }         → switch to an installed shape
 *   PUT /api/me/panel { reset: true }       → back to the built-in default
 *   GET /api/me/panel/library               → { panels: [{id,title,description?}] }
 *   PUT /api/admin/panel/users/:id          → owner installs a shape for a member
 *
 * The web layer forces userId from the SESSION (never body / query) on the /me
 * face, 503s when no surface is wired, maps store errors by duck `code`
 * (not_found→404, invalid/too_large→400), and the admin face sits behind
 * requireAdmin (member cookie → 401). The member write face is deliberately
 * narrow: free-form config PUT is NOT exposed in M3.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type { MePanelSurface } from '../src/panel-routes.js'

const CFG = { schemaVersion: 1, sections: [{ components: [{ type: 'chat' }] }] }

class StoreError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'too_large',
    message: string,
  ) {
    super(message)
  }
}

class StubPanel implements MePanelSurface {
  readonly calls: string[] = []
  readonly applied: Array<{ userId: string; libraryId: string }> = []
  readonly resets: string[] = []
  source: 'default' | 'member' | 'fallback' = 'default'
  library: Array<{ id: string; title: string; description?: string }> = [
    { id: 'farm', title: '农事面', description: '给父亲' },
  ]
  /** When set, the next panel() call throws. */
  boom = false

  async panel(userId: string) {
    this.calls.push(userId)
    if (this.boom) {
      this.boom = false
      throw new Error('panel store exploded')
    }
    return { schemaVersion: 1, config: CFG, source: this.source }
  }

  async resetPanel(userId: string) {
    this.resets.push(userId)
    this.source = 'default'
  }

  async listLibrary() {
    return this.library
  }

  async applyLibrary(userId: string, libraryId: string) {
    if (!this.library.some((e) => e.id === libraryId)) {
      throw new StoreError('not_found', 'unknown library panel')
    }
    this.applied.push({ userId, libraryId })
    this.source = 'member'
    return { schemaVersion: 1, config: CFG, source: 'member' as const }
  }
}

interface Boot {
  tmp: string
  server: WebServerHandle
  identity: IdentityStore
  adminToken: string
  memberCookie: string
  memberUserId: string
  stub: StubPanel | undefined
}

async function boot(opts: { withSurface?: boolean } = {}): Promise<Boot> {
  const withSurface = opts.withSurface ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-me-panel-'))
  const init = await Space.init(tmp, { name: 'me-panel-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { token: adminToken } = await space.createAdmin('TestAdmin')
  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
  identity.bootstrap({ adminToken, ownerEmail: 'admin@local', ownerDisplayName: 'TestAdmin' })
  const member = identity.createUser({
    email: 'member@team.test',
    displayName: 'Member',
    password: 'member-strong-password',
    role: 'member',
  })

  const stub = withSurface ? new StubPanel() : undefined
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(stub ? { mePanel: stub } : {}),
  })

  const loginRes = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'member@team.test', password: 'member-strong-password' }),
  })
  if (loginRes.status !== 200) throw new Error(`member login failed ${loginRes.status}`)
  const memberCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

  return { tmp, server, identity, adminToken, memberCookie, memberUserId: member.id, stub }
}

describe('/api/me/panel — SDUI member panel config (M2 read + M3 write)', () => {
  let b: Boot

  afterEach(async () => {
    await b.server.close()
    b.identity.close()
    await rm(b.tmp, { recursive: true, force: true })
  })

  async function req(
    method: string,
    opts: { auth?: boolean; path?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${b.server.url}${opts.path ?? '/api/me/panel'}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...((opts.auth ?? true) ? { cookie: b.memberCookie } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, json }
  }

  it('unauthenticated → 401', async () => {
    b = await boot()
    expect((await req('GET', { auth: false })).status).toBe(401)
    expect(b.stub!.calls).toHaveLength(0)
  })

  it('GET returns the resolved panel for the SESSION user', async () => {
    b = await boot()
    const r = await req('GET')
    expect(r.status).toBe(200)
    expect(r.json.schemaVersion).toBe(1)
    expect(r.json.source).toBe('default')
    expect(r.json.config.sections).toHaveLength(1)
    // Server-pinned identity: the surface saw the session user, not client input.
    expect(b.stub!.calls).toEqual([b.memberUserId])
  })

  it("echoes source 'fallback' verbatim (SPA renders the loud degrade notice)", async () => {
    b = await boot()
    b.stub!.source = 'fallback'
    const r = await req('GET')
    expect(r.status).toBe(200)
    expect(r.json.source).toBe('fallback')
  })

  it('no surface wired → 503 (setting-ops posture)', async () => {
    b = await boot({ withSurface: false })
    const r = await req('GET')
    expect(r.status).toBe(503)
    expect(r.json.error).toContain('not enabled')
  })

  it('surface throw → 500, error message surfaced', async () => {
    b = await boot()
    b.stub!.boom = true
    const r = await req('GET')
    expect(r.status).toBe(500)
    expect(r.json.error).toContain('exploded')
  })

  // ── M3 write face ─────────────────────────────────────────────────────────

  it('PUT { libraryId } applies the shape for the SESSION user', async () => {
    b = await boot()
    const r = await req('PUT', { body: { libraryId: 'farm' } })
    expect(r.status).toBe(200)
    expect(r.json.source).toBe('member')
    expect(b.stub!.applied).toEqual([{ userId: b.memberUserId, libraryId: 'farm' }])
  })

  it('PUT { libraryId } for an unknown shape → 404 via the duck code', async () => {
    b = await boot()
    const r = await req('PUT', { body: { libraryId: 'nope' } })
    expect(r.status).toBe(404)
    expect(b.stub!.applied).toHaveLength(0)
  })

  it('PUT { reset: true } resets then returns the (default) panel', async () => {
    b = await boot()
    const r = await req('PUT', { body: { reset: true } })
    expect(r.status).toBe(200)
    expect(r.json.source).toBe('default')
    expect(b.stub!.resets).toEqual([b.memberUserId])
  })

  it('PUT with any other body → 400 (free-form config is NOT a member face)', async () => {
    b = await boot()
    expect((await req('PUT', { body: { config: CFG } })).status).toBe(400)
    expect((await req('PUT', { body: {} })).status).toBe(400)
    expect(b.stub!.applied).toHaveLength(0)
    expect(b.stub!.resets).toHaveLength(0)
  })

  it('DELETE → 405 (only GET / PUT exist)', async () => {
    b = await boot()
    const r = await req('DELETE')
    expect(r.status).toBe(405)
    expect(b.stub!.calls).toHaveLength(0)
  })

  it('GET /api/me/panel/library lists installed shapes; non-GET → 405', async () => {
    b = await boot()
    const r = await req('GET', { path: '/api/me/panel/library' })
    expect(r.status).toBe(200)
    expect(r.json.panels).toEqual([{ id: 'farm', title: '农事面', description: '给父亲' }])
    expect((await req('PUT', { path: '/api/me/panel/library', body: {} })).status).toBe(405)
  })

  // ── M3 admin install face ─────────────────────────────────────────────────

  it('admin PUT /api/admin/panel/users/:id installs a shape for that member', async () => {
    b = await boot()
    const res = await fetch(
      `${b.server.url}/api/admin/panel/users/${encodeURIComponent(b.memberUserId)}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${b.adminToken}`,
        },
        body: JSON.stringify({ libraryId: 'farm' }),
      },
    )
    expect(res.status).toBe(200)
    expect(b.stub!.applied).toEqual([{ userId: b.memberUserId, libraryId: 'farm' }])
  })

  it('member cookie on the admin face → 401 (requireAdmin gate)', async () => {
    b = await boot()
    const res = await fetch(`${b.server.url}/api/admin/panel/users/${b.memberUserId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: b.memberCookie },
      body: JSON.stringify({ libraryId: 'farm' }),
    })
    expect(res.status).toBe(401)
    expect(b.stub!.applied).toHaveLength(0)
  })

  it('admin POST on the admin face → 405 (PUT only)', async () => {
    b = await boot()
    const res = await fetch(`${b.server.url}/api/admin/panel/users/${b.memberUserId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${b.adminToken}`,
      },
      body: JSON.stringify({ libraryId: 'farm' }),
    })
    expect(res.status).toBe(405)
  })
})
