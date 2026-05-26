/**
 * Phase 7 M5 — org mode routes.
 *
 * Coverage:
 *   - GET /api/me/mode requires sign-in (401 anon)
 *   - GET /api/me/mode returns { mode, canUpgrade } with canUpgrade
 *     only true for owner+personal
 *   - POST /api/admin/identity/org-mode owner-gated
 *   - POST /api/admin/identity/org-mode rejects invalid mode
 *   - POST flip writes audit row
 *   - SPA bootstrap state: fresh host is personal, single owner can
 *     see canUpgrade=true
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space } from '@aipehub/core'
import { MASTER_KEY_LEN_BYTES, openIdentityStore } from '@aipehub/identity'
import { randomBytes } from 'node:crypto'

import { serveWeb, type WebServerHandle } from '../src/index.js'

interface Bench {
  baseUrl: string
  server: WebServerHandle
  hub: Hub
  tmpDir: string
  ownerCookie: string
  identity: ReturnType<typeof openIdentityStore>
}

async function boot(): Promise<Bench> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-org-mode-'))
  const init = await Space.init(tmp, { name: 'mode-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const identity = openIdentityStore({
    dbPath: join(tmp, 'identity.sqlite'),
    masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
  })
  // Bootstrap a single owner + password so we can log in.
  const r = identity.bootstrap({ ownerEmail: 'owner@solo.test' })
  identity.setPassword(r.ownerUserId!, 'owner-passw0rd-long')

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
  })
  const port = server.port
  const baseUrl = `http://127.0.0.1:${port}`
  // Log in to get a session cookie.
  const loginRes = await fetch(`${baseUrl}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@solo.test', password: 'owner-passw0rd-long' }),
  })
  if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status}`)
  const setCookie = loginRes.headers.get('set-cookie') ?? ''
  const m = /aipehub_identity=([^;]+)/.exec(setCookie)
  if (!m) throw new Error('no identity cookie in login response')
  const ownerCookie = `aipehub_identity=${m[1]}`
  return { baseUrl, server, hub, tmpDir: tmp, ownerCookie, identity }
}

describe('Phase 7 M5 — org mode routes', () => {
  let b: Bench
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await b.server.close()
    await b.hub.stop()
    b.identity.close()
    await rm(b.tmpDir, { recursive: true, force: true })
  })

  describe('GET /api/me/mode', () => {
    it('anonymous → 401', async () => {
      const r = await fetch(`${b.baseUrl}/api/me/mode`)
      expect(r.status).toBe(401)
    })

    it('signed-in owner on fresh host → personal + canUpgrade=true', async () => {
      const r = await fetch(`${b.baseUrl}/api/me/mode`, {
        headers: { cookie: b.ownerCookie },
      })
      expect(r.status).toBe(200)
      const body = (await r.json()) as { mode: string; canUpgrade: boolean }
      expect(body.mode).toBe('personal')
      expect(body.canUpgrade).toBe(true)
    })

    it('after creating an invite → team + canUpgrade=false', async () => {
      // createInvitation auto-flips mode (Phase 7 M4)
      b.identity.createInvitation({ email: 'invitee@team.test' })
      const r = await fetch(`${b.baseUrl}/api/me/mode`, {
        headers: { cookie: b.ownerCookie },
      })
      const body = (await r.json()) as { mode: string; canUpgrade: boolean }
      expect(body.mode).toBe('team')
      expect(body.canUpgrade).toBe(false)
    })
  })

  describe('POST /api/admin/identity/org-mode', () => {
    it('owner can flip personal → team + writes audit', async () => {
      const r = await fetch(`${b.baseUrl}/api/admin/identity/org-mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: b.ownerCookie },
        body: JSON.stringify({ mode: 'team' }),
      })
      expect(r.status).toBe(200)
      const body = (await r.json()) as { mode: string }
      expect(body.mode).toBe('team')
      // Confirm via getOrgMode that the flip stuck.
      expect(b.identity.getOrgMode()).toBe('team')
      // Audit row written.
      const audits = b.identity.listAuditLog({ action: 'org_set_mode' })
      expect(audits.length).toBe(1)
      const meta = audits[0]!.metadata as { from: string; to: string }
      expect(meta.from).toBe('personal')
      expect(meta.to).toBe('team')
    })

    it('rejects invalid mode (400)', async () => {
      const r = await fetch(`${b.baseUrl}/api/admin/identity/org-mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: b.ownerCookie },
        body: JSON.stringify({ mode: 'somethingelse' }),
      })
      expect(r.status).toBe(400)
      const body = (await r.json()) as { code: string }
      expect(body.code).toBe('invalid_input')
    })

    it('anonymous → 403 (owner gate)', async () => {
      // /api/admin/identity/* routes use the owner gate (403), not
      // the /me-style 401. Documented in identity-routes.ts line 717.
      const r = await fetch(`${b.baseUrl}/api/admin/identity/org-mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'team' }),
      })
      expect(r.status).toBe(403)
    })

    it('flipping back personal → team → personal works', async () => {
      // up
      await fetch(`${b.baseUrl}/api/admin/identity/org-mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: b.ownerCookie },
        body: JSON.stringify({ mode: 'team' }),
      })
      expect(b.identity.getOrgMode()).toBe('team')
      // down
      await fetch(`${b.baseUrl}/api/admin/identity/org-mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: b.ownerCookie },
        body: JSON.stringify({ mode: 'personal' }),
      })
      expect(b.identity.getOrgMode()).toBe('personal')
      // 2 audit rows.
      expect(b.identity.listAuditLog({ action: 'org_set_mode' }).length).toBe(2)
    })
  })
})
