/**
 * v5 E4-M1 — agent resource RBAC (ownership) HTTP enforcement.
 *
 * Mirrors workflow-rbac-route.test.ts but for the managed-agent admin routes
 * (`/api/admin/agents/*`). Boots a REAL IdentityStore so `ctx.agentGrants`
 * carries the actual agent-grant facade, plus a REAL Space — `mock`-provider
 * agents persist without an API key when no lifecycle is wired, so the routes
 * resolve end-to-end without an LLM.
 *
 * The RBAC contract under test (identical shape to workflows):
 *   - OPERATORS bypass grants entirely:
 *       · v3 Space-admin Bearer (legacy host admin)        → isOperator
 *       · v4 org OWNER                                     → isOperator
 *     => every existing deployment / personal mode is a no-op (zero regression).
 *   - A v4 ADMIN (role='admin', NOT owner) is the only restricted principal: it
 *     passes `requireAdmin` yet `resolveActor` reports isOperator=false.
 *       · no grant     → 403 agent_forbidden on PUT / DELETE / export / grants
 *       · viewer grant → may export; not enough to PUT
 *       · editor grant → may PUT; not enough to DELETE (owner-gated)
 *       · owner grant  → may DELETE and manage the access list
 *   - CREATE seeds the creating v4 user as the agent's owner.
 *   - DELETE clears the agent's grants (so a same-id re-create starts clean).
 *   - RBAC OFF (no identity wired) → grant routes 404; CRUD unrestricted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'

// A mock-provider managed agent — persists without a key (no lifecycle wired).
const base = { provider: 'mock', system: 'you are a test agent', capabilities: ['chat'] }

interface BootResult {
  tmp: string
  hub: Hub
  space: Space
  identity: IdentityStore | undefined
  server: WebServerHandle
  baseUrl: string
  /** v3 Space-admin Bearer — an operator (bypasses RBAC). */
  v3Token: string
  /** v4 org owner session cookie — an operator. */
  ownerCookie: string
  ownerUserId: string
  /** v4 admin (role='admin', NOT owner) — the principal RBAC restricts. */
  adminACookie: string
  adminAUserId: string
  /** a second v4 admin — for grant CRUD between users. */
  adminBCookie: string
  adminBUserId: string
}

async function boot(opts: { withIdentity?: boolean } = {}): Promise<BootResult> {
  const withIdentity = opts.withIdentity ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-agrbac-'))
  const init = await Space.init(tmp, { name: 'agrbac-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const { token: v3Token } = await space.createAdmin('TestAdmin')

  let identity: IdentityStore | undefined
  let ownerCookie = ''
  let ownerUserId = ''
  let adminACookie = ''
  let adminAUserId = ''
  let adminBCookie = ''
  let adminBUserId = ''
  if (withIdentity) {
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
    const ib = identity.bootstrap({ ownerEmail: 'owner@local', ownerDisplayName: 'Owner' })
    ownerUserId = ib.ownerUserId!
    identity.setPassword(ownerUserId, 'owner-password-123')
    ownerCookie = `gotong_identity=${identity.authenticatePassword({ email: 'owner@local', password: 'owner-password-123' }).token}`

    const a = identity.createUser({ email: 'admin-a@local', displayName: 'AdminA', role: 'admin', password: 'admin-a-password-123' })
    adminAUserId = a.id
    adminACookie = `gotong_identity=${identity.authenticatePassword({ email: 'admin-a@local', password: 'admin-a-password-123' }).token}`

    const bUser = identity.createUser({ email: 'admin-b@local', displayName: 'AdminB', role: 'admin', password: 'admin-b-password-123' })
    adminBUserId = bUser.id
    adminBCookie = `gotong_identity=${identity.authenticatePassword({ email: 'admin-b@local', password: 'admin-b-password-123' }).token}`
  }

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(identity ? { identity } : {}),
  })
  return {
    tmp, hub, space, identity, server, baseUrl: server.url,
    v3Token, ownerCookie, ownerUserId,
    adminACookie, adminAUserId, adminBCookie, adminBUserId,
  }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  if (b.identity) b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

/** fetch with a v4 identity cookie. */
function asCookie(b: BootResult, cookie: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { cookie }
  let payload: string | undefined
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  return fetch(`${b.baseUrl}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) })
}

/** fetch with the v3 Space-admin Bearer token. */
function asV3(b: BootResult, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${b.v3Token}` }
  let payload: string | undefined
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  return fetch(`${b.baseUrl}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) })
}

/** Seed a real mock agent through the v3 operator (no owner grant is seeded). */
async function seedAgent(b: BootResult, id: string): Promise<void> {
  const r = await asV3(b, 'POST', '/api/admin/agents', { ...base, id })
  if (r.status !== 200) throw new Error(`seedAgent ${id} → ${r.status}`)
}

const editBody = (id: string) => ({ ...base, id, system: 'edited prompt' })

describe('agent RBAC — operator bypass (zero regression)', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot(); await seedAgent(b, 'a1') })
  afterEach(async () => { await teardown(b) })

  it('v3 Space-admin edits without any grant → 200', async () => {
    const r = await asV3(b, 'PUT', '/api/admin/agents/a1', editBody('a1'))
    expect(r.status).toBe(200)
  })

  it('v4 org owner edits without any grant → 200', async () => {
    const r = await asCookie(b, b.ownerCookie, 'PUT', '/api/admin/agents/a1', editBody('a1'))
    expect(r.status).toBe(200)
  })

  it('v3 Space-admin deletes without any grant → 200', async () => {
    const r = await asV3(b, 'DELETE', '/api/admin/agents/a1')
    expect(r.status).toBe(200)
    expect((await b.space.agents()).some((a) => a.id === 'a1')).toBe(false)
  })
})

describe('agent RBAC — v4 admin (non-owner) is restricted', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot(); await seedAgent(b, 'a1') })
  afterEach(async () => { await teardown(b) })

  it('admin without a grant → 403 agent_forbidden on edit', async () => {
    const r = await asCookie(b, b.adminACookie, 'PUT', '/api/admin/agents/a1', editBody('a1'))
    expect(r.status).toBe(403)
    expect((await r.json()).code).toBe('agent_forbidden')
    // the agent was untouched — the gate is before the upsert
    const rec = (await b.space.agents()).find((a) => a.id === 'a1')
    expect(rec?.managed.system).toBe('you are a test agent')
  })

  it('admin without a grant → 403 on export and DELETE', async () => {
    const exp = await asCookie(b, b.adminACookie, 'GET', '/api/admin/agents/a1/export')
    expect(exp.status).toBe(403)
    const del = await asCookie(b, b.adminACookie, 'DELETE', '/api/admin/agents/a1')
    expect(del.status).toBe(403)
    expect((await b.space.agents()).some((a) => a.id === 'a1')).toBe(true)
  })

  it('a VIEWER grant allows export but NOT edit', async () => {
    await asV3(b, 'POST', '/api/admin/agents/a1/grants', { userId: b.adminAUserId, perm: 'viewer' })
    const exp = await asCookie(b, b.adminACookie, 'GET', '/api/admin/agents/a1/export')
    expect(exp.status).toBe(200)
    const put = await asCookie(b, b.adminACookie, 'PUT', '/api/admin/agents/a1', editBody('a1'))
    expect(put.status).toBe(403)
  })

  it('an EDITOR grant allows edit but NOT delete (owner-gated)', async () => {
    await asV3(b, 'POST', '/api/admin/agents/a1/grants', { userId: b.adminAUserId, perm: 'editor' })
    const put = await asCookie(b, b.adminACookie, 'PUT', '/api/admin/agents/a1', editBody('a1'))
    expect(put.status).toBe(200)
    const del = await asCookie(b, b.adminACookie, 'DELETE', '/api/admin/agents/a1')
    expect(del.status).toBe(403)
    expect((await b.space.agents()).some((a) => a.id === 'a1')).toBe(true)
  })

  it('an OWNER grant allows delete', async () => {
    await asV3(b, 'POST', '/api/admin/agents/a1/grants', { userId: b.adminAUserId, perm: 'owner' })
    const del = await asCookie(b, b.adminACookie, 'DELETE', '/api/admin/agents/a1')
    expect(del.status).toBe(200)
    expect((await b.space.agents()).some((a) => a.id === 'a1')).toBe(false)
  })
})

describe('agent RBAC — create seeds the creator as owner', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('a v4 admin who creates an agent becomes owner and can manage grants', async () => {
    const c = await asCookie(b, b.adminACookie, 'POST', '/api/admin/agents', { ...base, id: 'mine' })
    expect(c.status).toBe(200)
    // owner gate on the grant list now passes for adminA
    const list = await asCookie(b, b.adminACookie, 'GET', '/api/admin/agents/mine/grants')
    expect(list.status).toBe(200)
    expect((await list.json()).grants).toEqual([
      expect.objectContaining({ agentId: 'mine', userId: b.adminAUserId, perm: 'owner' }),
    ])
  })

  it('a v3-admin (operator) create does NOT seed a grant (operators manage by bypass)', async () => {
    await seedAgent(b, 'opless')
    // operator can still read the (empty) grant list
    const list = await asV3(b, 'GET', '/api/admin/agents/opless/grants')
    expect(list.status).toBe(200)
    expect((await list.json()).grants).toEqual([])
    // but a fresh v4 admin can't touch it (no grant, not operator)
    const put = await asCookie(b, b.adminACookie, 'PUT', '/api/admin/agents/opless', editBody('opless'))
    expect(put.status).toBe(403)
  })
})

describe('agent RBAC — grant CRUD + access control', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot(); await seedAgent(b, 'a1') })
  afterEach(async () => { await teardown(b) })

  it('owner (operator) can POST then DELETE a grant', async () => {
    const post = await asV3(b, 'POST', '/api/admin/agents/a1/grants', { userId: b.adminAUserId, perm: 'editor' })
    expect(post.status).toBe(200)
    expect((await post.json()).grants).toHaveLength(1)
    const del = await asV3(b, 'DELETE', `/api/admin/agents/a1/grants/${b.adminAUserId}`)
    expect(del.status).toBe(200)
    expect((await del.json()).removed).toBe(true)
    const list = await asV3(b, 'GET', '/api/admin/agents/a1/grants')
    expect((await list.json()).grants).toEqual([])
  })

  it('a non-owner v4 admin cannot read the grant list → 403', async () => {
    const r = await asCookie(b, b.adminBCookie, 'GET', '/api/admin/agents/a1/grants')
    expect(r.status).toBe(403)
  })

  it('POST /grants validates perm and userId', async () => {
    const bad = await asV3(b, 'POST', '/api/admin/agents/a1/grants', { userId: b.adminAUserId, perm: 'admin' })
    expect(bad.status).toBe(400)
    const noUser = await asV3(b, 'POST', '/api/admin/agents/a1/grants', { perm: 'editor' })
    expect(noUser.status).toBe(400)
  })

  it('an owner grant lets a non-operator admin manage grants for others', async () => {
    // adminA creates → owner; adminA grants adminB editor; adminB may then edit
    const c = await asCookie(b, b.adminACookie, 'POST', '/api/admin/agents', { ...base, id: 'shared' })
    expect(c.status).toBe(200)
    const grant = await asCookie(b, b.adminACookie, 'POST', '/api/admin/agents/shared/grants', {
      userId: b.adminBUserId, perm: 'editor',
    })
    expect(grant.status).toBe(200)
    const r = await asCookie(b, b.adminBCookie, 'PUT', '/api/admin/agents/shared', editBody('shared'))
    expect(r.status).toBe(200)
  })

  it('DELETE agent clears its grants', async () => {
    await asV3(b, 'POST', '/api/admin/agents/a1/grants', { userId: b.adminAUserId, perm: 'editor' })
    const del = await asV3(b, 'DELETE', '/api/admin/agents/a1')
    expect(del.status).toBe(200)
    // re-create the same id and read grants → wiped (no stale editor grant)
    await seedAgent(b, 'a1')
    const list = await asV3(b, 'GET', '/api/admin/agents/a1/grants')
    expect((await list.json()).grants).toEqual([])
  })
})

describe('agent RBAC — disabled when no identity store wired', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot({ withIdentity: false }); await seedAgent(b, 'a1') })
  afterEach(async () => { await teardown(b) })

  it('grant routes 404 (panel hidden) but CRUD still works for the v3 admin', async () => {
    const grants = await asV3(b, 'GET', '/api/admin/agents/a1/grants')
    expect(grants.status).toBe(404)
    const put = await asV3(b, 'PUT', '/api/admin/agents/a1', editBody('a1'))
    expect(put.status).toBe(200)
    const del = await asV3(b, 'DELETE', '/api/admin/agents/a1')
    expect(del.status).toBe(200)
  })
})
