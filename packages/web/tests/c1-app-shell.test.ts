/**
 * C1a — unified SPA shell tests.
 *
 * Coverage:
 *   1. GET /  with no cookie         → serves worker.html (legacy, unchanged)
 *   2. GET /  with v4 member cookie  → serves app.html with role=member meta
 *   3. GET /  with v3 admin cookie   → serves app.html with role=owner meta
 *   4. GET /admin (no cookie)        → 401 prompt (unchanged)
 *   5. GET /admin (v3 admin cookie)  → app.html with role=owner meta
 *   6. GET /admin (v4 member cookie) → app.html with role=member meta
 *   7. Forged/garbage role on a hand-crafted cookie → meta resolves empty
 *      (anonymous fallback) — the SET enum gate works.
 *   8. app.html bytes contain the expected unified shell markers
 *      (tabbar with home/settings/users buttons, login-shell section).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'

interface BootResult {
  tmp: string
  hub: Hub
  space: Space
  identity: IdentityStore
  server: WebServerHandle
  baseUrl: string
  ownerUserId: string
  memberCookie: string
  adminCookie: string // v3
}

async function boot(): Promise<BootResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-c1-'))
  const init = await Space.init(tmp, { name: 'c1-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')
  const adminSid = 'c1-sid-' + Math.random().toString(36).slice(2)
  await space.addAdminSession(adminSid, admin.id)
  const adminCookie = `aipehub_admin=${adminSid}`

  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
  const ib = identity.bootstrap({
    adminToken,
    ownerEmail: 'owner@local',
    ownerDisplayName: 'Test Owner',
  })
  const ownerUserId = ib.ownerUserId!

  identity.createUser({
    email: 'm@c1.test',
    displayName: 'C1 Member',
    password: 'member-strong-password',
    role: 'member',
  })

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
  })

  // Mint a real v4 member session cookie via the live login route.
  const loginRes = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'm@c1.test',
      password: 'member-strong-password',
    }),
  })
  if (loginRes.status !== 200) {
    throw new Error(`boot: member login failed status=${loginRes.status}`)
  }
  const setCookie = loginRes.headers.get('set-cookie')!
  const memberCookie = setCookie.split(';')[0]!

  return {
    tmp,
    hub,
    space,
    identity,
    server,
    baseUrl: server.url,
    ownerUserId,
    memberCookie,
    adminCookie,
  }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

/** Extract the role meta value from a served HTML response. */
function metaRole(html: string): string {
  const m = html.match(/<meta name="x-aipehub-role" content="([^"]*)"/)
  return m ? m[1]! : '__missing__'
}

describe('C1 — unified SPA shell', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  describe('GET /', () => {
    it('no cookie → serves worker.html (legacy v3 anonymous join page)', async () => {
      const r = await fetch(`${b.baseUrl}/`)
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(html).toContain('AipeHub')
      // worker.html-specific marker — its title / nav are distinct from
      // app.html's tabbar with home/settings buttons.
      expect(html).not.toContain('x-aipehub-role')
    })

    it('v4 member cookie → serves app.html with role=member meta', async () => {
      const r = await fetch(`${b.baseUrl}/`, {
        headers: { cookie: b.memberCookie },
      })
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(metaRole(html)).toBe('member')
      // Sanity — unified shell markers visible.
      expect(html).toContain('data-tab="home"')
      expect(html).toContain('data-tab="settings"')
      expect(html).toContain('id="login-shell"')
    })

    it('v3 admin cookie → serves app.html with role=owner meta', async () => {
      const r = await fetch(`${b.baseUrl}/`, {
        headers: { cookie: b.adminCookie },
      })
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(metaRole(html)).toBe('owner')
    })
  })

  describe('GET /admin', () => {
    it('no cookie → 401 (unchanged from v3)', async () => {
      const r = await fetch(`${b.baseUrl}/admin`)
      expect(r.status).toBe(401)
    })

    it('v3 admin cookie → app.html with role=owner meta', async () => {
      const r = await fetch(`${b.baseUrl}/admin`, {
        headers: { cookie: b.adminCookie },
      })
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(metaRole(html)).toBe('owner')
      expect(html).toContain('data-tab="users"')
    })

    it('v4 member cookie → app.html with role=member meta (fallback path)', async () => {
      // /admin used to refuse non-admin cookies outright; C1 falls
      // through to the unified shell so members landing on the legacy
      // URL still get a usable page (the shell hides admin tabs for them).
      const r = await fetch(`${b.baseUrl}/admin`, {
        headers: { cookie: b.memberCookie },
      })
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(metaRole(html)).toBe('member')
    })
  })

  describe('role meta sanitisation', () => {
    it('garbage cookie value → meta resolves empty (anonymous fallback)', async () => {
      // Forge a v4-shaped cookie pointing at no session row. The token
      // looks valid; the lookup returns null; the helper falls through
      // to v3 (also absent); role becomes ''.
      const fakeCookie = 'aipehub_identity=000000000000000000000000000000000000000000000000'
      const r = await fetch(`${b.baseUrl}/`, {
        headers: { cookie: fakeCookie },
      })
      // Has SOME cookie → hits serveAppHtml path. v4 lookup misses,
      // v3 absent → role stays ''.
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(metaRole(html)).toBe('')
    })
  })

  describe('app.html structural sanity', () => {
    it('contains the unified tabbar with home/overview/agents/.../settings buttons', async () => {
      const r = await fetch(`${b.baseUrl}/`, {
        headers: { cookie: b.adminCookie },
      })
      const html = await r.text()
      for (const tab of [
        'home',
        'overview',
        'agents',
        'workflows',
        'tasks',
        'activity',
        'services',
        'users',
        'settings',
      ]) {
        expect(html).toContain(`data-tab="${tab}"`)
      }
    })

    it('every visible tabbar button carries a data-roles attribute', async () => {
      const r = await fetch(`${b.baseUrl}/`, {
        headers: { cookie: b.adminCookie },
      })
      const html = await r.text()
      // Pluck every <button class="tabbar-btn" ... data-tab="..."> and assert
      // each one also has data-roles= somewhere on the same line.
      const lines = html.split('\n').filter((l) => l.includes('class="tabbar-btn"'))
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        expect(line).toMatch(/data-roles=/)
      }
    })

    it('users tabbar button is owner-only (data-roles="owner")', async () => {
      const r = await fetch(`${b.baseUrl}/`, {
        headers: { cookie: b.adminCookie },
      })
      const html = await r.text()
      // Whitespace-tolerant — the line may have extra spaces depending
      // on indentation; the relevant marker is data-tab="users" co-occurring
      // with data-roles="owner".
      expect(html).toMatch(/data-tab="users"\s+data-roles="owner"/)
    })
  })
})
