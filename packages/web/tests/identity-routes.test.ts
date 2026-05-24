/**
 * HTTP-level tests for /api/admin/identity/* routes.
 *
 * Boots a real Space + Hub + IdentityStore + serveWeb and drives
 * `fetch` against it. We test:
 *   - 503 when serveWeb wasn't given an identity instance
 *   - owner gate (v3 admin OR v4 session unlocks; nothing else does)
 *   - login / logout / me round trips
 *   - users CRUD (list / create / patch role / patch password)
 *   - credentials (list / issue api key / revoke)
 *   - IdentityError code → HTTP status mapping
 *
 * Test isolation: each test gets a fresh tmpdir + fresh Space + fresh
 * IdentityStore at `:memory:` (well, on-disk inside the tmpdir).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space, type AdminRecord } from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'

interface BootResult {
  tmp: string
  hub: Hub
  space: Space
  identity: IdentityStore | undefined
  server: WebServerHandle
  baseUrl: string
  admin: AdminRecord
  adminToken: string
  adminCookie: string
  ownerUserId: string | null
}

async function boot(opts: { withIdentity?: boolean } = {}): Promise<BootResult> {
  const withIdentity = opts.withIdentity ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-identity-'))
  const init = await Space.init(tmp, { name: 'identity-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')
  const adminSid = 'a-test-sid-' + Math.random().toString(36).slice(2)
  await space.addAdminSession(adminSid, admin.id)
  const adminCookie = `aipehub_admin=${adminSid}`

  let identity: IdentityStore | undefined
  let ownerUserId: string | null = null
  if (withIdentity) {
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
    const ib = identity.bootstrap({
      adminToken,
      ownerEmail: 'admin@local',
      ownerDisplayName: 'TestAdmin',
    })
    ownerUserId = ib.ownerUserId
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
    identity,
    server,
    baseUrl: server.url,
    admin,
    adminToken,
    adminCookie,
    ownerUserId,
  }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  if (b.identity) b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('/api/admin/identity/* — service availability', () => {
  it('returns 503 when serveWeb was not given an identity store', async () => {
    const b = await boot({ withIdentity: false })
    try {
      const r = await fetch(`${b.baseUrl}/api/admin/identity/users`, {
        headers: { cookie: b.adminCookie },
      })
      expect(r.status).toBe(503)
    } finally {
      await teardown(b)
    }
  })
})

describe('/api/admin/identity/* — owner gate', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('rejects unauthenticated request with 403', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/users`)
    expect(r.status).toBe(403)
  })

  it('accepts v3 admin cookie (v3 admin == v4 owner)', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/users`, {
      headers: { cookie: b.adminCookie },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      users: Array<{ user: { id: string }; role: string | null }>
    }
    expect(Array.isArray(body.users)).toBe(true)
    expect(body.users.length).toBeGreaterThanOrEqual(1)
    expect(body.users[0]!.user.id).toBeTypeOf('string')
  })

  it('accepts v3 admin Bearer token (the same migrated token)', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/users`, {
      headers: { authorization: `Bearer ${b.adminToken}` },
    })
    expect(r.status).toBe(200)
  })

  it('accepts v4 session cookie after password login', async () => {
    // Owner sets up their own password via the v3-admin path.
    const pwRes = await fetch(
      `${b.baseUrl}/api/admin/identity/users/${b.ownerUserId}`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          cookie: b.adminCookie,
        },
        body: JSON.stringify({ password: 'long-enough-password' }),
      },
    )
    expect(pwRes.status).toBe(200)

    // Login via v4 surface.
    const loginRes = await fetch(`${b.baseUrl}/api/admin/identity/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@local',
        password: 'long-enough-password',
      }),
    })
    expect(loginRes.status).toBe(200)
    const setCookie = loginRes.headers.get('set-cookie')
    expect(setCookie).toMatch(/^aipehub_identity=/)
    const sessCookie = setCookie!.split(';')[0]! // "aipehub_identity=ses_..."

    // Use the v4 cookie to hit an owner-only route.
    const listRes = await fetch(`${b.baseUrl}/api/admin/identity/users`, {
      headers: { cookie: sessCookie },
    })
    expect(listRes.status).toBe(200)
  })
})

describe('login / logout / me', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('login with wrong password returns 401 + IdentityError code', async () => {
    // Set a password first.
    await fetch(`${b.baseUrl}/api/admin/identity/users/${b.ownerUserId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: b.adminCookie,
      },
      body: JSON.stringify({ password: 'real-password-here' }),
    })

    const r = await fetch(`${b.baseUrl}/api/admin/identity/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@local', password: 'wrong-pw' }),
    })
    expect(r.status).toBe(401)
    const body = (await r.json()) as { code?: string }
    expect(body.code).toBe('authentication_failed')
  })

  it('login with missing fields returns 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(400)
  })

  it('logout clears the v4 cookie (Max-Age=0)', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/logout`, {
      method: 'POST',
    })
    expect(r.status).toBe(200)
    const setCookie = r.headers.get('set-cookie')
    expect(setCookie).toContain('aipehub_identity=')
    expect(setCookie).toContain('Max-Age=0')
  })

  it('me via v3 admin returns { authSource: "v3-admin", role: "owner" }', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/me`, {
      headers: { cookie: b.adminCookie },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { authSource: string; role: string }
    expect(body.authSource).toBe('v3-admin')
    expect(body.role).toBe('owner')
  })
})

describe('users CRUD', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('GET /users returns the owner user', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/users`, {
      headers: { cookie: b.adminCookie },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      users: Array<{ user: { email: string }; role: string | null }>
    }
    expect(body.users.length).toBe(1)
    expect(body.users[0]!.user.email).toBe('admin@local')
    expect(body.users[0]!.role).toBe('owner')
  })

  it('POST /users creates a new user; duplicate email returns 409', async () => {
    const create = await fetch(`${b.baseUrl}/api/admin/identity/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.adminCookie },
      body: JSON.stringify({
        email: 'alice@team.test',
        displayName: 'Alice',
        password: 'a-long-enough-pw',
        role: 'member',
      }),
    })
    expect(create.status).toBe(201)
    const cb = (await create.json()) as { user: { id: string; email: string } }
    expect(cb.user.email).toBe('alice@team.test')

    const dup = await fetch(`${b.baseUrl}/api/admin/identity/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.adminCookie },
      body: JSON.stringify({ email: 'alice@team.test' }),
    })
    expect(dup.status).toBe(409)
    const dupBody = (await dup.json()) as { code?: string }
    expect(dupBody.code).toBe('duplicate_email')
  })

  it('POST /users rejects bad role with 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.adminCookie },
      body: JSON.stringify({ email: 'bob@x.test', role: 'godmode' }),
    })
    expect(r.status).toBe(400)
    const body = (await r.json()) as { code?: string }
    expect(body.code).toBe('invalid_role')
  })

  it('PATCH /users/:id changes role', async () => {
    const create = await fetch(`${b.baseUrl}/api/admin/identity/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.adminCookie },
      body: JSON.stringify({ email: 'carol@x.test' }),
    })
    const { user } = (await create.json()) as { user: { id: string } }

    const patch = await fetch(
      `${b.baseUrl}/api/admin/identity/users/${user.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: b.adminCookie },
        body: JSON.stringify({ role: 'admin' }),
      },
    )
    expect(patch.status).toBe(200)
    const body = (await patch.json()) as { role: string }
    expect(body.role).toBe('admin')
  })
})

describe('credentials', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('issue api-key returns the key once + lists + revokes', async () => {
    const issue = await fetch(
      `${b.baseUrl}/api/admin/identity/users/${b.ownerUserId}/api-key`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: b.adminCookie },
        body: JSON.stringify({ label: 'CI runner' }),
      },
    )
    expect(issue.status).toBe(201)
    const issued = (await issue.json()) as {
      key: string
      credentialId: string
    }
    expect(issued.key).toMatch(/^aipk_/)
    expect(typeof issued.credentialId).toBe('string')

    // List shows the new credential without leaking the hash identifier.
    const list = await fetch(
      `${b.baseUrl}/api/admin/identity/users/${b.ownerUserId}/credentials`,
      { headers: { cookie: b.adminCookie } },
    )
    expect(list.status).toBe(200)
    const lb = (await list.json()) as {
      credentials: Array<{ kind: string; identifier: string | null; label: string | null }>
    }
    const apiCred = lb.credentials.find((c) => c.label === 'CI runner')
    expect(apiCred?.kind).toBe('api_key')
    expect(apiCred?.identifier).toBeNull() // hash hidden

    // Revoke.
    const del = await fetch(
      `${b.baseUrl}/api/admin/identity/credentials/${issued.credentialId}`,
      { method: 'DELETE', headers: { cookie: b.adminCookie } },
    )
    expect(del.status).toBe(200)
  })

  it('credentials list for unknown user returns []', async () => {
    const r = await fetch(
      `${b.baseUrl}/api/admin/identity/users/nonexistent/credentials`,
      { headers: { cookie: b.adminCookie } },
    )
    expect(r.status).toBe(200)
    const body = (await r.json()) as { credentials: unknown[] }
    expect(body.credentials).toEqual([])
  })

  it('issue api-key for unknown user returns 404', async () => {
    const r = await fetch(
      `${b.baseUrl}/api/admin/identity/users/ghost-user/api-key`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: b.adminCookie },
      },
    )
    expect(r.status).toBe(404)
    const body = (await r.json()) as { code?: string }
    expect(body.code).toBe('user_not_found')
  })
})

describe('unknown identity route returns 404', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('GET /api/admin/identity/whatever returns 404', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/whatever`, {
      headers: { cookie: b.adminCookie },
    })
    expect(r.status).toBe(404)
  })
})
