/**
 * HTTP tests for the v5 A-M2 member agent self-service routes:
 *   GET    /api/me/agents/providers
 *   GET    /api/me/agents/owned
 *   POST   /api/me/agents
 *   PUT    /api/me/agents/:id
 *   DELETE /api/me/agents/:id
 *
 * The web layer only shape-checks the body, forces userId from the SESSION
 * (never the body), maps the host surface's status-coded errors to HTTP, and
 * 503s when no surface is wired. A stub MeAgentAdminSurface records every call
 * so we can assert the route passed the session userId, not a spoofed one.
 *
 * The read-only directory GET /api/me/agents (P1-M3) is asserted unaffected.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type {
  MeAgentAdminSurface,
  MeAgentInput,
  MeOwnedAgentView,
} from '../src/me-routes.js'

class StubMeAgentAdmin implements MeAgentAdminSurface {
  readonly calls: Array<[string, ...unknown[]]> = []
  providers = ['anthropic', 'mock']
  owned: MeOwnedAgentView[] = []
  /** When set, the next mutating call throws an error carrying this status. */
  throwStatus: number | null = null

  private boom(): void {
    if (this.throwStatus != null) {
      const s = this.throwStatus
      this.throwStatus = null
      throw Object.assign(new Error(`stub error ${s}`), { status: s })
    }
  }

  async availableProviders(): Promise<string[]> {
    this.calls.push(['availableProviders'])
    return this.providers
  }
  async listOwned(userId: string): Promise<MeOwnedAgentView[]> {
    this.calls.push(['listOwned', userId])
    this.boom()
    return this.owned
  }
  async read(userId: string, agentId: string): Promise<MeOwnedAgentView> {
    this.calls.push(['read', userId, agentId])
    this.boom()
    return view(agentId, 'L', ['c'], 'S', 'mock')
  }
  async create(userId: string, input: MeAgentInput): Promise<MeOwnedAgentView> {
    this.calls.push(['create', userId, input])
    this.boom()
    return view(`me.${userId}.${input.id}`, input.label, input.capabilities, input.system, input.provider)
  }
  async update(
    userId: string,
    agentId: string,
    input: Partial<Omit<MeAgentInput, 'id'>>,
  ): Promise<MeOwnedAgentView> {
    this.calls.push(['update', userId, agentId, input])
    this.boom()
    return view(agentId, input.label ?? 'L', input.capabilities ?? ['c'], input.system ?? 'S', input.provider ?? 'mock')
  }
  async remove(userId: string, agentId: string): Promise<boolean> {
    this.calls.push(['remove', userId, agentId])
    this.boom()
    return true
  }
}

function view(
  id: string,
  label: string,
  capabilities: string[],
  system: string,
  provider: string,
): MeOwnedAgentView {
  return { id, label, capabilities, online: true, provider, system, createdAt: '2026-06-02T00:00:00.000Z' }
}

interface Boot {
  tmp: string
  server: WebServerHandle
  identity: IdentityStore
  memberCookie: string
  memberUserId: string
  stub: StubMeAgentAdmin | undefined
}

async function boot(opts: { withSurface?: boolean } = {}): Promise<Boot> {
  const withSurface = opts.withSurface ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-me-agent-'))
  const init = await Space.init(tmp, { name: 'me-agent-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')
  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
  identity.bootstrap({ adminToken, ownerEmail: 'admin@local', ownerDisplayName: 'TestAdmin' })
  const member = identity.createUser({
    email: 'member@team.test',
    displayName: 'Member',
    password: 'member-strong-password',
    role: 'member',
  })

  const stub = withSurface ? new StubMeAgentAdmin() : undefined
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(stub ? { meAgentAdmin: stub } : {}),
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

describe('/api/me/agents — member self-service CRUD (v5 A-M2)', () => {
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
    const r = await req(b, 'GET', '/api/me/agents/owned', undefined, false)
    expect(r.status).toBe(401)
  })

  it('GET /providers + /owned pass through the surface', async () => {
    b = await boot()
    b.stub!.owned = [view('me.x.a', 'A', ['chat'], 'sys', 'mock')]
    const p = await req(b, 'GET', '/api/me/agents/providers')
    expect(p.status).toBe(200)
    expect(p.json.providers).toEqual(['anthropic', 'mock'])
    const o = await req(b, 'GET', '/api/me/agents/owned')
    expect(o.status).toBe(200)
    expect(o.json.agents).toHaveLength(1)
    expect(b.stub!.calls).toContainEqual(['listOwned', b.memberUserId])
  })

  it('POST create forces the SESSION userId (ignores any body userId)', async () => {
    b = await boot()
    const r = await req(b, 'POST', '/api/me/agents', {
      id: 'writer',
      label: '写手',
      capabilities: ['write-zh'],
      system: 'You write.',
      provider: 'mock',
      userId: 'attacker', // must be ignored — userId comes from the session
    })
    expect(r.status).toBe(201)
    const createCall = b.stub!.calls.find((c) => c[0] === 'create')!
    expect(createCall[1]).toBe(b.memberUserId)
    expect((createCall[2] as MeAgentInput).id).toBe('writer')
    // composed id reflects the session user, never 'attacker'
    expect(r.json.agent.id).toBe(`me.${b.memberUserId}.writer`)
  })

  it('POST with a bad body → 400 and never reaches the surface', async () => {
    b = await boot()
    const r = await req(b, 'POST', '/api/me/agents', { id: 'x', label: 'L', capabilities: ['c'] }) // no system/provider
    expect(r.status).toBe(400)
    expect(b.stub!.calls.find((c) => c[0] === 'create')).toBeUndefined()
  })

  it('PUT ignores a client-supplied id in the body; passes path id + session user', async () => {
    b = await boot()
    const r = await req(b, 'PUT', '/api/me/agents/me.u.writer', {
      id: 'hacked',
      system: 'new prompt',
    })
    expect(r.status).toBe(200)
    const call = b.stub!.calls.find((c) => c[0] === 'update')!
    expect(call[1]).toBe(b.memberUserId)
    expect(call[2]).toBe('me.u.writer')
    expect((call[3] as Record<string, unknown>).id).toBeUndefined()
  })

  it('DELETE passes the path id + session user', async () => {
    b = await boot()
    const r = await req(b, 'DELETE', '/api/me/agents/me.u.writer')
    expect(r.status).toBe(200)
    expect(r.json.removed).toBe(true)
    expect(b.stub!.calls).toContainEqual(['remove', b.memberUserId, 'me.u.writer'])
  })

  it('GET /api/me/agents/:id reads through the surface (the viewer floor, P1-M1c)', async () => {
    b = await boot()
    const r = await req(b, 'GET', '/api/me/agents/me.u.writer')
    expect(r.status).toBe(200)
    expect(r.json.agent.id).toBe('me.u.writer')
    expect(b.stub!.calls).toContainEqual(['read', b.memberUserId, 'me.u.writer'])
    // the exact /owned + /providers GETs are matched first — the single-segment
    // read pattern must never have swallowed them (the /owned test above pins it).
  })

  it('maps the surface status-coded error (404) to HTTP', async () => {
    b = await boot()
    b.stub!.throwStatus = 404
    const r = await req(b, 'DELETE', '/api/me/agents/me.u.nope')
    expect(r.status).toBe(404)
  })

  it('without a wired surface → 503 on mutate, empty on read', async () => {
    b = await boot({ withSurface: false })
    expect((await req(b, 'POST', '/api/me/agents', { id: 'x', label: 'L', capabilities: ['c'], system: 's', provider: 'mock' })).status).toBe(503)
    expect((await req(b, 'PUT', '/api/me/agents/x', { system: 's' })).status).toBe(503)
    expect((await req(b, 'DELETE', '/api/me/agents/x')).status).toBe(503)
    const owned = await req(b, 'GET', '/api/me/agents/owned')
    expect(owned.status).toBe(200)
    expect(owned.json.agents).toEqual([])
  })

  it('the read-only directory GET /api/me/agents is unaffected', async () => {
    b = await boot()
    // No meAgents surface wired in this boot → degrades to empty list (P1-M3),
    // and is NOT intercepted by the new /owned + /providers routes.
    const r = await req(b, 'GET', '/api/me/agents')
    expect(r.status).toBe(200)
    expect(r.json.agents).toEqual([])
  })
})
