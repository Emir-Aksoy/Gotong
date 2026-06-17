/**
 * HTTP tests for the GO-LIVE GL-1c member IM-linking routes:
 *   GET    /api/me/im                              → { enabled, bindings }
 *   POST   /api/me/im/binding-code                 → mint a code (201)
 *   DELETE /api/me/im/bindings/:platform/:userId   → disconnect one the caller owns
 *
 * Same contract as the credential routes: userId is forced from the SESSION
 * (never the body/query), the host surface's status-coded errors map to HTTP,
 * and mutate routes 503 when no surface is wired. A stub MeImSurface records
 * every call so we can assert the route passed the session userId and decoded
 * the path segments.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type { MeImSurface, MeImBindingView } from '../src/me-routes.js'

class StubMeIm implements MeImSurface {
  readonly calls: Array<[string, ...unknown[]]> = []
  isEnabled = true
  bindings: MeImBindingView[] = []
  /** When set, the next call throws an error carrying this status. */
  throwStatus: number | null = null

  private boom(): void {
    if (this.throwStatus != null) {
      const s = this.throwStatus
      this.throwStatus = null
      throw Object.assign(new Error(`stub error ${s}`), { status: s })
    }
  }

  enabled(): boolean {
    return this.isEnabled
  }
  async listBindings(userId: string): Promise<MeImBindingView[]> {
    this.calls.push(['listBindings', userId])
    this.boom()
    return this.bindings
  }
  async issueCode(userId: string): Promise<{ code: string; expiresAt: number }> {
    this.calls.push(['issueCode', userId])
    this.boom()
    return { code: '123456', expiresAt: 1_780_000_600_000 }
  }
  async removeBinding(
    userId: string,
    platform: string,
    platformUserId: string,
  ): Promise<boolean> {
    this.calls.push(['removeBinding', userId, platform, platformUserId])
    this.boom()
    return true
  }
}

interface Boot {
  tmp: string
  server: WebServerHandle
  identity: IdentityStore
  memberCookie: string
  memberUserId: string
  stub: StubMeIm | undefined
}

async function boot(opts: { withSurface?: boolean } = {}): Promise<Boot> {
  const withSurface = opts.withSurface ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-me-im-'))
  const init = await Space.init(tmp, { name: 'me-im-test' })
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

  const stub = withSurface ? new StubMeIm() : undefined
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(stub ? { meIm: stub } : {}),
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

describe('/api/me/im — member IM-account linking (GO-LIVE GL-1c)', () => {
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
    body?: unknown,
    auth = true,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${b.server.url}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth ? { cookie: b.memberCookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, json }
  }

  it('unauthenticated → 401', async () => {
    b = await boot()
    const r = await req(b, 'GET', '/api/me/im', undefined, false)
    expect(r.status).toBe(401)
  })

  it('GET returns enabled + the caller’s own bindings (scoped to session user)', async () => {
    b = await boot()
    b.stub!.bindings = [
      { platform: 'telegram', platformUserId: '1001', displayName: 'Me', createdAt: 1_780_000_000_000 },
    ]
    const r = await req(b, 'GET', '/api/me/im')
    expect(r.status).toBe(200)
    expect(r.json.enabled).toBe(true)
    expect(r.json.bindings).toHaveLength(1)
    expect(b.stub!.calls).toContainEqual(['listBindings', b.memberUserId])
  })

  it('POST mints a code for the SESSION user (201)', async () => {
    b = await boot()
    const r = await req(b, 'POST', '/api/me/im/binding-code', { userId: 'attacker' })
    expect(r.status).toBe(201)
    expect(r.json.ok).toBe(true)
    expect(r.json.code).toBe('123456')
    expect(typeof r.json.expiresAt).toBe('number')
    // The surface was called with the session user, not the spoofed body userId.
    expect(b.stub!.calls).toContainEqual(['issueCode', b.memberUserId])
  })

  it('DELETE decodes the path segments + session user; maps a 404 from the surface', async () => {
    b = await boot()
    const ok = await req(b, 'DELETE', '/api/me/im/bindings/telegram/1001')
    expect(ok.status).toBe(200)
    expect(ok.json.removed).toBe(true)
    expect(b.stub!.calls).toContainEqual(['removeBinding', b.memberUserId, 'telegram', '1001'])

    // A binding the caller doesn't own → host throws 404 → route forwards it.
    b.stub!.throwStatus = 404
    const nope = await req(b, 'DELETE', '/api/me/im/bindings/telegram/9999')
    expect(nope.status).toBe(404)
  })

  it('without a wired surface → 503 on mutate, empty/disabled on read', async () => {
    b = await boot({ withSurface: false })
    expect((await req(b, 'POST', '/api/me/im/binding-code')).status).toBe(503)
    expect((await req(b, 'DELETE', '/api/me/im/bindings/telegram/1001')).status).toBe(503)
    const get = await req(b, 'GET', '/api/me/im')
    expect(get.status).toBe(200)
    expect(get.json.enabled).toBe(false)
    expect(get.json.bindings).toEqual([])
  })
})
