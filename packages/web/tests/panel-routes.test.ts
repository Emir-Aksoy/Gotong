/**
 * HTTP tests for the SDUI member panel route (SDUI-M2):
 *
 *   GET /api/me/panel  →  { schemaVersion, config, source }
 *
 * The web layer forces userId from the SESSION (never body / query), 503s when
 * no surface is wired (setting-ops posture — the SPA then shows "not enabled"
 * instead of a broken panel), and rejects non-GET verbs. A stub surface
 * records calls so we can assert the route passed the session userId.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type { MePanelSurface } from '../src/panel-routes.js'

class StubPanel implements MePanelSurface {
  readonly calls: string[] = []
  source: 'default' | 'member' | 'fallback' = 'default'
  /** When set, the next call throws. */
  boom = false

  async panel(userId: string) {
    this.calls.push(userId)
    if (this.boom) {
      this.boom = false
      throw new Error('panel store exploded')
    }
    return {
      schemaVersion: 1,
      config: { schemaVersion: 1, sections: [{ components: [{ type: 'chat' }] }] },
      source: this.source,
    }
  }
}

interface Boot {
  tmp: string
  server: WebServerHandle
  identity: IdentityStore
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

  return { tmp, server, identity, memberCookie, memberUserId: member.id, stub }
}

describe('/api/me/panel — SDUI member panel config (M2)', () => {
  let b: Boot

  afterEach(async () => {
    await b.server.close()
    b.identity.close()
    await rm(b.tmp, { recursive: true, force: true })
  })

  async function req(
    method: string,
    auth = true,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${b.server.url}/api/me/panel`, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { cookie: b.memberCookie } : {}) },
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, json }
  }

  it('unauthenticated → 401', async () => {
    b = await boot()
    expect((await req('GET', false)).status).toBe(401)
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

  it('non-GET → 405 (no write face until the M3 store)', async () => {
    b = await boot()
    const r = await req('POST')
    expect(r.status).toBe(405)
    expect(b.stub!.calls).toHaveLength(0)
  })

  it('surface throw → 500, error message surfaced', async () => {
    b = await boot()
    b.stub!.boom = true
    const r = await req('GET')
    expect(r.status).toBe(500)
    expect(r.json.error).toContain('exploded')
  })
})
