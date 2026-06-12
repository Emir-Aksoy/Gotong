/**
 * HTTP tests for the v5 A-M3 member credential routes:
 *   GET    /api/me/credentials            → { credentials, providers }
 *   POST   /api/me/credentials            → store a key (201)
 *   DELETE /api/me/credentials/:id        → revoke a key the caller owns
 *
 * The web layer shape-checks the body, forces userId from the SESSION (never
 * the body), maps the host surface's status-coded errors to HTTP, and 503s on
 * mutate when no surface is wired. A stub MeCredentialsSurface records every
 * call so we can assert the route passed the session userId, not a spoofed one.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type {
  MeCredentialsSurface,
  MeCredentialInput,
  MeCredentialView,
} from '../src/me-routes.js'

class StubMeCredentials implements MeCredentialsSurface {
  readonly calls: Array<[string, ...unknown[]]> = []
  providerList = ['anthropic', 'openai']
  stored: MeCredentialView[] = []
  /** When set, the next mutating call throws an error carrying this status. */
  throwStatus: number | null = null

  private boom(): void {
    if (this.throwStatus != null) {
      const s = this.throwStatus
      this.throwStatus = null
      throw Object.assign(new Error(`stub error ${s}`), { status: s })
    }
  }

  async providers(): Promise<string[]> {
    this.calls.push(['providers'])
    return this.providerList
  }
  async list(userId: string): Promise<MeCredentialView[]> {
    this.calls.push(['list', userId])
    this.boom()
    return this.stored
  }
  async create(userId: string, input: MeCredentialInput): Promise<MeCredentialView> {
    this.calls.push(['create', userId, input])
    this.boom()
    return view(`vault-${userId}-${input.provider}`, input.provider, input.label ?? null)
  }
  async remove(userId: string, credentialId: string): Promise<boolean> {
    this.calls.push(['remove', userId, credentialId])
    this.boom()
    return true
  }
}

function view(id: string, provider: string, label: string | null): MeCredentialView {
  return { id, provider, label, createdAt: 1_780_000_000_000, lastUsedAt: null }
}

interface Boot {
  tmp: string
  server: WebServerHandle
  identity: IdentityStore
  memberCookie: string
  memberUserId: string
  stub: StubMeCredentials | undefined
}

async function boot(opts: { withSurface?: boolean } = {}): Promise<Boot> {
  const withSurface = opts.withSurface ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-me-cred-'))
  const init = await Space.init(tmp, { name: 'me-cred-test' })
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

  const stub = withSurface ? new StubMeCredentials() : undefined
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(stub ? { meCredentials: stub } : {}),
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

describe('/api/me/credentials — member BYO key CRUD (v5 A-M3)', () => {
  let b: Boot

  afterEach(async () => {
    await b.server.close()
    // Close the SQLite store before rm — Windows can't unlink an open
    // database file (EBUSY), unlike Linux/macOS.
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
    const r = await req(b, 'GET', '/api/me/credentials', undefined, false)
    expect(r.status).toBe(401)
  })

  it('GET returns the caller’s credentials + the provider allow-list', async () => {
    b = await boot()
    b.stub!.stored = [view('v1', 'anthropic', 'my key')]
    const r = await req(b, 'GET', '/api/me/credentials')
    expect(r.status).toBe(200)
    expect(r.json.credentials).toHaveLength(1)
    expect(r.json.providers).toEqual(['anthropic', 'openai'])
    expect(b.stub!.calls).toContainEqual(['list', b.memberUserId])
  })

  it('POST forces the SESSION userId (ignores any body userId)', async () => {
    b = await boot()
    const r = await req(b, 'POST', '/api/me/credentials', {
      provider: 'anthropic',
      apiKey: 'sk-ant-secret',
      label: 'home',
      userId: 'attacker', // must be ignored
    })
    expect(r.status).toBe(201)
    const createCall = b.stub!.calls.find((c) => c[0] === 'create')!
    expect(createCall[1]).toBe(b.memberUserId)
    expect((createCall[2] as MeCredentialInput).provider).toBe('anthropic')
    expect((createCall[2] as MeCredentialInput).apiKey).toBe('sk-ant-secret')
  })

  it('POST with a bad body → 400 and never reaches the surface', async () => {
    b = await boot()
    const r1 = await req(b, 'POST', '/api/me/credentials', { provider: 'anthropic' }) // no apiKey
    expect(r1.status).toBe(400)
    const r2 = await req(b, 'POST', '/api/me/credentials', { apiKey: 'sk-x' }) // no provider
    expect(r2.status).toBe(400)
    expect(b.stub!.calls.find((c) => c[0] === 'create')).toBeUndefined()
  })

  it('DELETE passes the path id + session user; maps a 404 from the surface', async () => {
    b = await boot()
    const ok = await req(b, 'DELETE', '/api/me/credentials/v1')
    expect(ok.status).toBe(200)
    expect(ok.json.removed).toBe(true)
    expect(b.stub!.calls).toContainEqual(['remove', b.memberUserId, 'v1'])

    b.stub!.throwStatus = 404
    const nope = await req(b, 'DELETE', '/api/me/credentials/not-mine')
    expect(nope.status).toBe(404)
  })

  it('without a wired surface → 503 on mutate, empty on read', async () => {
    b = await boot({ withSurface: false })
    expect(
      (await req(b, 'POST', '/api/me/credentials', { provider: 'anthropic', apiKey: 'sk' })).status,
    ).toBe(503)
    expect((await req(b, 'DELETE', '/api/me/credentials/x')).status).toBe(503)
    const get = await req(b, 'GET', '/api/me/credentials')
    expect(get.status).toBe(200)
    expect(get.json.credentials).toEqual([])
    expect(get.json.providers).toEqual([])
  })
})
