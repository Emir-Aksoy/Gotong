/**
 * HTTP tests for the v5 A-M4 member agent access-grant routes:
 *   GET    /api/me/agents/:id/grants                 → { grants }
 *   POST   /api/me/agents/:id/grants                 → set a grant (201)
 *   DELETE /api/me/agents/:id/grants/:principalKey   → remove a grant
 *
 * The web layer shape-checks the body, forces userId from the SESSION (never
 * the body), passes the path agentId + principalKey through, maps the host
 * surface's status-coded errors to HTTP, and 503s on mutate when no surface is
 * wired. A stub MeAgentGrantsSurface records every call so we can assert the
 * route passed the session userId, not a spoofed one.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type {
  MeAgentGrantsSurface,
  MeGrantInput,
  MeGrantView,
} from '../src/me-routes.js'

class StubMeAgentGrants implements MeAgentGrantsSurface {
  readonly calls: Array<[string, ...unknown[]]> = []
  stored: MeGrantView[] = []
  /** When set, the next call throws an error carrying this status. */
  throwStatus: number | null = null

  private boom(): void {
    if (this.throwStatus != null) {
      const s = this.throwStatus
      this.throwStatus = null
      throw Object.assign(new Error(`stub error ${s}`), { status: s })
    }
  }

  async list(userId: string, agentId: string): Promise<MeGrantView[]> {
    this.calls.push(['list', userId, agentId])
    this.boom()
    return this.stored
  }
  async set(userId: string, agentId: string, input: MeGrantInput): Promise<MeGrantView> {
    this.calls.push(['set', userId, agentId, input])
    this.boom()
    return view(input.principalKind, input.principalId, input.perm)
  }
  async remove(userId: string, agentId: string, key: string): Promise<boolean> {
    this.calls.push(['remove', userId, agentId, key])
    this.boom()
    return true
  }
}

function view(kind: string, id: string, perm: string): MeGrantView {
  return {
    principalKind: kind,
    principalId: id,
    perm,
    principalKey: `${kind}:${id}`,
    grantedBy: 'system',
    grantedAt: 1_780_000_000_000,
    isSelf: false,
  }
}

interface Boot {
  tmp: string
  server: WebServerHandle
  identity: IdentityStore
  memberCookie: string
  memberUserId: string
  stub: StubMeAgentGrants | undefined
}

async function boot(opts: { withSurface?: boolean } = {}): Promise<Boot> {
  const withSurface = opts.withSurface ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-me-grant-'))
  const init = await Space.init(tmp, { name: 'me-grant-test' })
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

  const stub = withSurface ? new StubMeAgentGrants() : undefined
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(stub ? { meAgentGrants: stub } : {}),
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

describe('/api/me/agents/:id/grants — member agent sharing (v5 A-M4)', () => {
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
    const r = await req(b, 'GET', '/api/me/agents/a1/grants', undefined, false)
    expect(r.status).toBe(401)
  })

  it('GET returns the grants for the path agent (scoped to the session user)', async () => {
    b = await boot()
    b.stub!.stored = [view('user', 'bob', 'viewer')]
    const r = await req(b, 'GET', '/api/me/agents/me.alice.helper/grants')
    expect(r.status).toBe(200)
    expect(r.json.grants).toHaveLength(1)
    expect(b.stub!.calls).toContainEqual(['list', b.memberUserId, 'me.alice.helper'])
  })

  it('POST forces the SESSION userId + passes the path agentId', async () => {
    b = await boot()
    const r = await req(b, 'POST', '/api/me/agents/me.alice.helper/grants', {
      principalKind: 'user',
      principalId: 'bob',
      perm: 'owner',
      userId: 'attacker', // must be ignored
    })
    expect(r.status).toBe(201)
    const setCall = b.stub!.calls.find((c) => c[0] === 'set')!
    expect(setCall[1]).toBe(b.memberUserId)
    expect(setCall[2]).toBe('me.alice.helper')
    expect((setCall[3] as MeGrantInput).principalId).toBe('bob')
    expect((setCall[3] as MeGrantInput).perm).toBe('owner')
  })

  it('POST with a bad body → 400 and never reaches the surface', async () => {
    b = await boot()
    const r1 = await req(b, 'POST', '/api/me/agents/a1/grants', {
      principalKind: 'user',
      principalId: 'bob',
    }) // no perm
    expect(r1.status).toBe(400)
    const r2 = await req(b, 'POST', '/api/me/agents/a1/grants', {
      principalKind: 'martian',
      principalId: 'bob',
      perm: 'viewer',
    }) // bad kind
    expect(r2.status).toBe(400)
    const r3 = await req(b, 'POST', '/api/me/agents/a1/grants', {
      principalKind: 'user',
      principalId: 'bob',
      perm: 'god',
    }) // bad perm
    expect(r3.status).toBe(400)
    expect(b.stub!.calls.find((c) => c[0] === 'set')).toBeUndefined()
  })

  it('DELETE passes the path principalKey + session user; maps a 404', async () => {
    b = await boot()
    const ok = await req(b, 'DELETE', '/api/me/agents/me.alice.helper/grants/user%3Abob')
    expect(ok.status).toBe(200)
    expect(ok.json.removed).toBe(true)
    expect(b.stub!.calls).toContainEqual(['remove', b.memberUserId, 'me.alice.helper', 'user:bob'])

    b.stub!.throwStatus = 404
    const nope = await req(b, 'DELETE', '/api/me/agents/me.alice.helper/grants/user%3Acarol')
    expect(nope.status).toBe(404)
  })

  it('a host 400 (orphan guard) maps through on POST', async () => {
    b = await boot()
    b.stub!.throwStatus = 400
    const r = await req(b, 'POST', '/api/me/agents/a1/grants', {
      principalKind: 'user',
      principalId: 'alice',
      perm: 'editor',
    })
    expect(r.status).toBe(400)
  })

  it('without a wired surface → 503 on mutate, empty on read', async () => {
    b = await boot({ withSurface: false })
    expect(
      (await req(b, 'POST', '/api/me/agents/a1/grants', {
        principalKind: 'user',
        principalId: 'bob',
        perm: 'viewer',
      })).status,
    ).toBe(503)
    expect((await req(b, 'DELETE', '/api/me/agents/a1/grants/user%3Abob')).status).toBe(503)
    const get = await req(b, 'GET', '/api/me/agents/a1/grants')
    expect(get.status).toBe(200)
    expect(get.json.grants).toEqual([])
  })
})
