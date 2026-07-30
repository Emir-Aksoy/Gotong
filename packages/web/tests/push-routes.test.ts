/**
 * PUSH-M2 — HTTP tests for the member Web Push subscription routes:
 *
 *   GET  /api/me/push              → { available, publicKey?, count? }
 *   POST /api/me/push/subscribe    body = PushSubscription.toJSON()
 *   POST /api/me/push/unsubscribe  body = { endpoint }
 *
 * Pins: userId is SESSION-pinned (query userId ignored), no surface → GET is
 * an honest { available:false } while the POSTs 503, store refusals surface
 * as 400 via the duck `code:'invalid'` (web never imports host), and key
 * material travels IN only — GET discloses a count, never endpoints or keys.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type { MeNativePushSurface, MeWebPushSurface } from '../src/push-routes.js'

class DuckInvalid extends Error {
  readonly code = 'invalid'
}

class StubNativePush implements MeNativePushSurface {
  readonly added: Array<{ userId: string; input: unknown }> = []
  readonly removedCalls: Array<{ userId: string; token: string }> = []
  countValue = 1

  async count() {
    return this.countValue
  }
  async add(userId: string, input: unknown) {
    const token = (input as { token?: unknown } | null)?.token
    if (typeof token !== 'string' || !/^[0-9a-f]{16,}$/.test(token)) {
      throw new DuckInvalid('registration.token must be hex')
    }
    this.added.push({ userId, input })
    return { count: 1, replaced: false }
  }
  async remove(userId: string, token: string) {
    this.removedCalls.push({ userId, token })
    return { removed: token === 'a'.repeat(64) }
  }
}

class StubWebPush implements MeWebPushSurface {
  readonly added: Array<{ userId: string; input: unknown }> = []
  readonly removedCalls: Array<{ userId: string; endpoint: string }> = []
  readonly askedCount: string[] = []
  countValue = 2

  publicKey() {
    return 'BTESTPUBLICKEY'
  }
  async count(userId: string) {
    this.askedCount.push(userId)
    return this.countValue
  }
  async add(userId: string, input: unknown) {
    // Mirror the host store's choke point: reject a non-object loudly so the
    // route's 400 mapping is exercised end-to-end.
    if (typeof input !== 'object' || input === null) {
      throw new DuckInvalid('subscription must be an object')
    }
    this.added.push({ userId, input })
    return { count: 1, replaced: false }
  }
  async remove(userId: string, endpoint: string) {
    this.removedCalls.push({ userId, endpoint })
    return { removed: endpoint === 'https://push.example.net/known' }
  }
}

interface Boot {
  tmp: string
  server: WebServerHandle
  identity: IdentityStore
  memberCookie: string
  memberUserId: string
  stub: StubWebPush | undefined
  native: StubNativePush | undefined
}

async function boot(opts: { withSurface?: boolean; withNative?: boolean } = {}): Promise<Boot> {
  const withSurface = opts.withSurface ?? true
  const withNative = opts.withNative ?? false
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-me-push-'))
  const init = await Space.init(tmp, { name: 'me-push-test' })
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

  const stub = withSurface ? new StubWebPush() : undefined
  const native = withNative ? new StubNativePush() : undefined
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(stub ? { webPush: stub } : {}),
    ...(native ? { nativePush: native } : {}),
  })

  const loginRes = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'member@team.test', password: 'member-strong-password' }),
  })
  if (loginRes.status !== 200) throw new Error(`member login failed ${loginRes.status}`)
  const memberCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

  return { tmp, server, identity, memberCookie, memberUserId: member.id, stub, native }
}

describe('/api/me/push — Web Push subscription face (PUSH-M2)', () => {
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
    const res = await fetch(`${b.server.url}${opts.path ?? '/api/me/push'}`, {
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
    expect(b.stub!.askedCount).toHaveLength(0)
  })

  it('no surface wired: GET is an honest {available:false}, POSTs 503', async () => {
    b = await boot({ withSurface: false })
    const g = await req('GET')
    expect(g.status).toBe(200)
    expect(g.json).toEqual({ available: false, native: { available: false } })
    expect((await req('POST', { path: '/api/me/push/subscribe', body: {} })).status).toBe(503)
    expect(
      (await req('POST', { path: '/api/me/push/unsubscribe', body: { endpoint: 'x' } })).status,
    ).toBe(503)
    expect(
      (await req('POST', { path: '/api/me/push/native/register', body: { token: 'a'.repeat(64) } }))
        .status,
    ).toBe(503)
    expect(
      (await req('POST', { path: '/api/me/push/native/unregister', body: { token: 'x' } })).status,
    ).toBe(503)
  })

  it('GET discloses publicKey + device count — never endpoints or keys', async () => {
    b = await boot()
    const g = await req('GET')
    expect(g.status).toBe(200)
    expect(g.json).toEqual({
      available: true,
      publicKey: 'BTESTPUBLICKEY',
      count: 2,
      native: { available: false },
    })
    expect(b.stub!.askedCount).toEqual([b.memberUserId])
  })

  it('native surface is independent: web OFF + native ON is honest both ways (SHELL-M6)', async () => {
    b = await boot({ withSurface: false, withNative: true })
    const g = await req('GET')
    expect(g.json).toEqual({ available: false, native: { available: true, count: 1 } })
  })

  it('native register forwards the SESSION userId (query ignored); duck invalid → 400', async () => {
    b = await boot({ withNative: true })
    const token = 'a'.repeat(64)
    const r = await req('POST', {
      path: '/api/me/push/native/register?userId=someone-else',
      body: { token, platform: 'ios' },
    })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, count: 1, replaced: false })
    expect(b.native!.added).toEqual([
      { userId: b.memberUserId, input: { token, platform: 'ios' } },
    ])
    const bad = await req('POST', { path: '/api/me/push/native/register', body: { token: 'ZZ' } })
    expect(bad.status).toBe(400)
    expect(bad.json.error).toBe('invalid_registration')
  })

  it('native unregister requires { token } and reports removed honestly', async () => {
    b = await boot({ withNative: true })
    expect((await req('POST', { path: '/api/me/push/native/unregister', body: {} })).status).toBe(400)
    const known = await req('POST', {
      path: '/api/me/push/native/unregister',
      body: { token: 'a'.repeat(64) },
    })
    expect(known.json).toEqual({ ok: true, removed: true })
    const unknown = await req('POST', {
      path: '/api/me/push/native/unregister',
      body: { token: 'b'.repeat(64) },
    })
    expect(unknown.json).toEqual({ ok: true, removed: false })
    expect(b.native!.removedCalls.every((c) => c.userId === b.memberUserId)).toBe(true)
  })

  it('subscribe forwards the SESSION userId — query userId is ignored', async () => {
    b = await boot()
    const body = { endpoint: 'https://push.example.net/a', keys: { p256dh: 'k', auth: 'a' } }
    const r = await req('POST', {
      path: '/api/me/push/subscribe?userId=someone-else',
      body,
    })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, count: 1, replaced: false })
    expect(b.stub!.added).toEqual([{ userId: b.memberUserId, input: body }])
  })

  it("store refusals surface as 400 via the duck code:'invalid'", async () => {
    b = await boot()
    const r = await req('POST', { path: '/api/me/push/subscribe', body: 'garbage' })
    expect(r.status).toBe(400)
    expect(r.json.error).toBe('invalid_subscription')
    expect(b.stub!.added).toHaveLength(0)
  })

  it('unsubscribe requires { endpoint } and reports removed honestly', async () => {
    b = await boot()
    expect((await req('POST', { path: '/api/me/push/unsubscribe', body: {} })).status).toBe(400)
    const known = await req('POST', {
      path: '/api/me/push/unsubscribe',
      body: { endpoint: 'https://push.example.net/known' },
    })
    expect(known.json).toEqual({ ok: true, removed: true })
    const unknown = await req('POST', {
      path: '/api/me/push/unsubscribe',
      body: { endpoint: 'https://push.example.net/other' },
    })
    expect(unknown.json).toEqual({ ok: true, removed: false })
    expect(b.stub!.removedCalls.every((c) => c.userId === b.memberUserId)).toBe(true)
  })

  it('unknown /api/me/push/* subpaths fall through to the site 404', async () => {
    b = await boot()
    expect((await req('GET', { path: '/api/me/push/what' })).status).toBe(404)
    expect((await req('DELETE', { path: '/api/me/push' })).status).toBe(404)
  })
})
