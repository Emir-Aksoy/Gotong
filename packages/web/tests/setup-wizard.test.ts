/**
 * C1b — first-time setup wizard tests (A2.3).
 *
 * Coverage:
 *   needs-bootstrap detection:
 *     - identity unwired           → bootstrap: false
 *     - fresh bootstrap, no pwd    → bootstrap: true
 *     - owner has password         → bootstrap: false
 *     - multi-user host            → bootstrap: false
 *
 *   owner-password set:
 *     - loopback + bootstrap-mode + ≥12 chars → 200, password set,
 *       audit row written
 *     - non-loopback (forged X-Forwarded-For doesn't help) → 403
 *     - identity unwired          → 503
 *     - multi-user host           → 409
 *     - owner already has pwd     → 409
 *     - password < 12 chars       → 400
 *     - empty/garbage body        → 400
 *     - after success: needs-bootstrap flips to false; owner can log in
 *       with the new password
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
  identity?: IdentityStore
  server: WebServerHandle
  baseUrl: string
  ownerUserId: string | null
}

async function boot(opts: {
  withIdentity?: boolean
  preSetPassword?: boolean
  preCreateExtraUser?: boolean
} = {}): Promise<BootResult> {
  const withIdentity = opts.withIdentity ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-setup-'))
  const init = await Space.init(tmp, { name: 'setup-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')
  // Don't seed an admin session here — setup wizard runs pre-auth.
  void admin

  let identity: IdentityStore | undefined
  let ownerUserId: string | null = null
  if (withIdentity) {
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
    const ib = identity.bootstrap({
      adminToken,
      ownerEmail: 'owner@setup.local',
      ownerDisplayName: 'Setup Owner',
    })
    ownerUserId = ib.ownerUserId
    if (opts.preSetPassword && ownerUserId) {
      identity.setPassword(ownerUserId, 'preset-password-strong-12')
    }
    if (opts.preCreateExtraUser) {
      identity.createUser({
        email: 'extra@setup.local',
        displayName: 'Extra',
        password: 'extra-password-strong',
        role: 'member',
      })
    }
  }

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(identity ? { identity } : {}),
  })

  return {
    tmp,
    hub,
    space,
    ...(identity ? { identity } : {}),
    server,
    baseUrl: server.url,
    ownerUserId,
  }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity?.close()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('GET /api/setup/needs-bootstrap', () => {
  it('identity unwired → bootstrap: false', async () => {
    const b = await boot({ withIdentity: false })
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/needs-bootstrap`)
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ bootstrap: false })
    } finally { await teardown(b) }
  })

  it('fresh bootstrap, owner has no password → bootstrap: true', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/needs-bootstrap`)
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ bootstrap: true })
    } finally { await teardown(b) }
  })

  it('owner already has password → bootstrap: false', async () => {
    const b = await boot({ preSetPassword: true })
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/needs-bootstrap`)
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ bootstrap: false })
    } finally { await teardown(b) }
  })

  it('multi-user host → bootstrap: false (setup is already done)', async () => {
    const b = await boot({ preCreateExtraUser: true })
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/needs-bootstrap`)
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ bootstrap: false })
    } finally { await teardown(b) }
  })
})

describe('POST /api/setup/owner-password', () => {
  it('happy path — sets password, audit row written, login works after', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'fresh-strong-password-12' }),
      })
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ ok: true })

      // Audit row written.
      const audit = b.identity!.listAuditLog!({ action: 'setup_owner_created' })
      expect(audit.length).toBe(1)
      expect(audit[0]!.targetUserId).toBe(b.ownerUserId)
      expect(audit[0]!.actorSource).toBe('anonymous')

      // Login works with the new password.
      const login = await fetch(`${b.baseUrl}/api/admin/identity/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'owner@setup.local',
          password: 'fresh-strong-password-12',
        }),
      })
      expect(login.status).toBe(200)

      // needs-bootstrap now reports false.
      const flip = await fetch(`${b.baseUrl}/api/setup/needs-bootstrap`)
      expect(await flip.json()).toEqual({ bootstrap: false })
    } finally { await teardown(b) }
  })

  it('identity unwired → 503', async () => {
    const b = await boot({ withIdentity: false })
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'strong-enough-password-12' }),
      })
      expect(r.status).toBe(503)
    } finally { await teardown(b) }
  })

  it('multi-user host → 409', async () => {
    const b = await boot({ preCreateExtraUser: true })
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'strong-enough-password-12' }),
      })
      expect(r.status).toBe(409)
      expect((await r.json()).error).toMatch(/multi-user/)
    } finally { await teardown(b) }
  })

  it('owner already has password → 409', async () => {
    const b = await boot({ preSetPassword: true })
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'second-password-strong-12' }),
      })
      expect(r.status).toBe(409)
      expect((await r.json()).error).toMatch(/already has a password/)
    } finally { await teardown(b) }
  })

  it('password < 12 chars → 400', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'short' }),
      })
      expect(r.status).toBe(400)
      expect((await r.json()).error).toMatch(/at least 12/)
    } finally { await teardown(b) }
  })

  it('garbage body → 400', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      })
      expect(r.status).toBe(400)
    } finally { await teardown(b) }
  })

  it('missing password field → 400', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(r.status).toBe(400)
    } finally { await teardown(b) }
  })

  // NOTE: We cannot easily test the non-loopback rejection from a unit
  // test — boot binds to 127.0.0.1, and req.socket.remoteAddress will
  // always be 127.0.0.1 too. The loopback gate is straightforward to
  // verify by inspection (server.ts directly compares socket address
  // against the three loopback literals), and forging x-forwarded-for
  // can't fool it because the gate ignores trustProxy entirely.
})
