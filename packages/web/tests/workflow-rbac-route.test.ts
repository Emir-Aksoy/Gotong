/**
 * Phase 19 P2-M5b — workflow resource RBAC (ownership) HTTP enforcement.
 *
 * Unlike workflow-lifecycle-route.test.ts (which wires a *fake* audit
 * identity), this suite boots a REAL `IdentityStore` so `ctx.grants` carries
 * the actual `WorkflowGrantStore`, plus a stub `WorkflowSurface` so the
 * lifecycle / import / delete routes resolve without `@aipehub/workflow`.
 *
 * The RBAC contract under test:
 *   - OPERATORS bypass grants entirely. Two kinds of operator:
 *       · v3 Space-admin Bearer (legacy host admin)        → isOperator
 *       · v4 org OWNER                                     → isOperator
 *     => every existing deployment / personal mode is a no-op (zero regression).
 *   - A v4 ADMIN (role='admin', NOT owner) is the only principal RBAC actually
 *     restricts: it passes `requireAdmin` (v4AdminFromRequest accepts owner|admin)
 *     yet `resolveActor` reports isOperator=false, so it needs a grant.
 *       · no grant            → 403 workflow_forbidden on lifecycle/delete/grants
 *       · editor grant        → lifecycle allowed; not enough to manage grants
 *       · owner grant         → may also manage the access list
 *   - IMPORT / DRAFT seeds the creating v4 user as the workflow's owner.
 *   - DELETE clears the workflow's grants (so a same-id re-import starts clean).
 *   - RBAC OFF (no identity wired) → grant routes 404; lifecycle unrestricted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'

import {
  serveWeb,
  type WebServerHandle,
  type WorkflowSummary,
  type WorkflowSurface,
} from '../src/server.js'

// --- minimal workflow surface stub -----------------------------------------
// Records calls; import/draft/lifecycle all succeed and echo `id` ('wf').

interface Call {
  method: string
  args: unknown[]
}

function makeStub(): { surface: WorkflowSurface; calls: Call[] } {
  const calls: Call[] = []
  const summary = (over: Partial<WorkflowSummary> = {}): WorkflowSummary => ({
    id: 'wf',
    participantId: 'workflow:wf',
    triggerCapability: 'run-wf',
    stepCount: 1,
    file: null,
    state: 'published',
    currentRevision: 1,
    ...over,
  })
  const rec = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args })
  }
  const surface: WorkflowSurface = {
    async list() { rec('list'); return [summary()] },
    async listAll() { rec('listAll'); return [summary()] },
    async importFromText(t) { rec('importFromText', t); return summary() },
    async remove(id) { rec('remove', id) },
    async listRuns(o) { rec('listRuns', o); return [] },
    async readRun(id) { rec('readRun', id); return null },
    async saveDraft(t, o) { rec('saveDraft', t, o); return summary({ state: 'draft', currentRevision: undefined }) },
    async publish(id, o) { rec('publish', id, o); return summary() },
    async submitReview(id, o) { rec('submitReview', id, o); return summary({ state: 'review' }) },
    async backToDraft(id, o) { rec('backToDraft', id, o); return summary({ state: 'draft' }) },
    async deprecate(id, o) { rec('deprecate', id, o); return summary({ state: 'deprecated' }) },
    async archive(id, o) { rec('archive', id, o); return summary({ state: 'archived' }) },
    async rollback(id, o) { rec('rollback', id, o); return summary({ currentRevision: 3 }) },
    async listRevisions(id) {
      rec('listRevisions', id)
      return [{ revision: 1, contentHash: 'h1', createdAt: 0, origin: 'import' }]
    },
    async getState(id) {
      rec('getState', id)
      return {
        workflowId: id,
        state: 'published',
        currentRevision: 1,
        headRevision: 1,
        triggerCapability: 'run-wf',
        revisions: [{ revision: 1, contentHash: 'h1', createdAt: 0, origin: 'import' }],
        history: [],
        legalActions: ['publish'],
        registered: true,
      }
    },
  }
  return { surface, calls }
}

interface BootResult {
  tmp: string
  hub: Hub
  identity: IdentityStore | undefined
  server: WebServerHandle
  baseUrl: string
  stub: { surface: WorkflowSurface; calls: Call[] }
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
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-wfrbac-'))
  const init = await Space.init(tmp, { name: 'wfrbac-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { token: v3Token } = await init.space.createAdmin('TestAdmin')
  const stub = makeStub()

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
    ownerCookie = `aipehub_identity=${identity.authenticatePassword({ email: 'owner@local', password: 'owner-password-123' }).token}`

    const a = identity.createUser({ email: 'admin-a@local', displayName: 'AdminA', role: 'admin', password: 'admin-a-password-123' })
    adminAUserId = a.id
    adminACookie = `aipehub_identity=${identity.authenticatePassword({ email: 'admin-a@local', password: 'admin-a-password-123' }).token}`

    const bUser = identity.createUser({ email: 'admin-b@local', displayName: 'AdminB', role: 'admin', password: 'admin-b-password-123' })
    adminBUserId = bUser.id
    adminBCookie = `aipehub_identity=${identity.authenticatePassword({ email: 'admin-b@local', password: 'admin-b-password-123' }).token}`
  }

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    workflows: stub.surface,
    ...(identity ? { identity } : {}),
  })
  return {
    tmp,
    hub,
    identity,
    server,
    baseUrl: server.url,
    stub,
    v3Token,
    ownerCookie,
    ownerUserId,
    adminACookie,
    adminAUserId,
    adminBCookie,
    adminBUserId,
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

describe('workflow RBAC — operator bypass (zero regression)', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('v3 Space-admin publishes without any grant → 200', async () => {
    const r = await asV3(b, 'POST', '/api/admin/workflows/wf/publish')
    expect(r.status).toBe(200)
  })

  it('v4 org owner publishes without any grant → 200', async () => {
    const r = await asCookie(b, b.ownerCookie, 'POST', '/api/admin/workflows/wf/publish')
    expect(r.status).toBe(200)
  })
})

describe('workflow RBAC — v4 admin (non-owner) is restricted', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('admin without a grant → 403 workflow_forbidden on publish', async () => {
    const r = await asCookie(b, b.adminACookie, 'POST', '/api/admin/workflows/wf/publish')
    expect(r.status).toBe(403)
    const j = await r.json()
    expect(j.code).toBe('workflow_forbidden')
    // the surface must NOT have been touched — the gate is before the call
    expect(b.stub.calls.find((c) => c.method === 'publish')).toBeUndefined()
  })

  it('an EDITOR grant lets the admin publish (200)', async () => {
    // operator seeds the grant, then admin acts
    const g = await asV3(b, 'POST', '/api/admin/workflows/wf/grants', { userId: b.adminAUserId, perm: 'editor' })
    expect(g.status).toBe(200)
    const r = await asCookie(b, b.adminACookie, 'POST', '/api/admin/workflows/wf/publish')
    expect(r.status).toBe(200)
    expect(b.stub.calls.find((c) => c.method === 'publish')).toBeDefined()
  })

  it('a VIEWER grant is NOT enough to publish (403)', async () => {
    await asV3(b, 'POST', '/api/admin/workflows/wf/grants', { userId: b.adminAUserId, perm: 'viewer' })
    const r = await asCookie(b, b.adminACookie, 'POST', '/api/admin/workflows/wf/publish')
    expect(r.status).toBe(403)
  })

  it('an EDITOR grant is NOT enough to DELETE the workflow (owner-gated, 403)', async () => {
    await asV3(b, 'POST', '/api/admin/workflows/wf/grants', { userId: b.adminAUserId, perm: 'editor' })
    const r = await asCookie(b, b.adminACookie, 'DELETE', '/api/admin/workflows/wf')
    expect(r.status).toBe(403)
    expect(b.stub.calls.find((c) => c.method === 'remove')).toBeUndefined()
  })
})

describe('workflow RBAC — import/draft seed the creator as owner', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('a v4 admin who imports becomes owner and can manage grants', async () => {
    const imp = await fetch(`${b.baseUrl}/api/admin/workflows/import`, {
      method: 'POST',
      headers: { cookie: b.adminACookie, 'content-type': 'text/plain' },
      body: 'schema: aipehub.workflow/v1',
    })
    expect(imp.status).toBe(200)
    // owner gate on the grant list now passes for adminA
    const list = await asCookie(b, b.adminACookie, 'GET', '/api/admin/workflows/wf/grants')
    expect(list.status).toBe(200)
    const j = await list.json()
    expect(j.grants).toEqual([
      expect.objectContaining({ workflowId: 'wf', userId: b.adminAUserId, perm: 'owner' }),
    ])
  })

  it('a v3-admin (operator) import does NOT seed a grant (operators manage by bypass)', async () => {
    await fetch(`${b.baseUrl}/api/admin/workflows/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.v3Token}`, 'content-type': 'text/plain' },
      body: 'schema: aipehub.workflow/v1',
    })
    // operator can still read the (empty) grant list
    const list = await asV3(b, 'GET', '/api/admin/workflows/wf/grants')
    expect(list.status).toBe(200)
    expect((await list.json()).grants).toEqual([])
    // but a fresh v4 admin can't touch it (no grant, not operator)
    const r = await asCookie(b, b.adminACookie, 'POST', '/api/admin/workflows/wf/publish')
    expect(r.status).toBe(403)
  })

  it('drafting also seeds the creator as owner', async () => {
    const d = await fetch(`${b.baseUrl}/api/admin/workflows/draft`, {
      method: 'POST',
      headers: { cookie: b.adminACookie, 'content-type': 'text/plain' },
      body: 'draft-yaml',
    })
    expect(d.status).toBe(200)
    const list = await asCookie(b, b.adminACookie, 'GET', '/api/admin/workflows/wf/grants')
    expect(list.status).toBe(200)
    expect((await list.json()).grants[0]).toMatchObject({ userId: b.adminAUserId, perm: 'owner' })
  })
})

describe('workflow RBAC — grant CRUD + access control', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('owner (operator) can POST then DELETE a grant', async () => {
    const post = await asV3(b, 'POST', '/api/admin/workflows/wf/grants', { userId: b.adminAUserId, perm: 'editor' })
    expect(post.status).toBe(200)
    expect((await post.json()).grants).toHaveLength(1)
    const del = await asV3(b, 'DELETE', `/api/admin/workflows/wf/grants/${b.adminAUserId}`)
    expect(del.status).toBe(200)
    expect((await del.json()).removed).toBe(true)
    // gone now
    const list = await asV3(b, 'GET', '/api/admin/workflows/wf/grants')
    expect((await list.json()).grants).toEqual([])
  })

  it('a non-owner v4 admin cannot read the grant list → 403', async () => {
    const r = await asCookie(b, b.adminBCookie, 'GET', '/api/admin/workflows/wf/grants')
    expect(r.status).toBe(403)
  })

  it('POST /grants validates perm and userId', async () => {
    const bad = await asV3(b, 'POST', '/api/admin/workflows/wf/grants', { userId: b.adminAUserId, perm: 'admin' })
    expect(bad.status).toBe(400)
    const noUser = await asV3(b, 'POST', '/api/admin/workflows/wf/grants', { perm: 'editor' })
    expect(noUser.status).toBe(400)
  })

  it('an owner grant lets a non-operator admin manage grants for others', async () => {
    // adminA imports → owner; adminA grants adminB editor
    await fetch(`${b.baseUrl}/api/admin/workflows/import`, {
      method: 'POST',
      headers: { cookie: b.adminACookie, 'content-type': 'text/plain' },
      body: 'schema: aipehub.workflow/v1',
    })
    const grant = await asCookie(b, b.adminACookie, 'POST', '/api/admin/workflows/wf/grants', {
      userId: b.adminBUserId,
      perm: 'editor',
    })
    expect(grant.status).toBe(200)
    const r = await asCookie(b, b.adminBCookie, 'POST', '/api/admin/workflows/wf/publish')
    expect(r.status).toBe(200)
  })

  it('DELETE workflow clears its grants', async () => {
    await asV3(b, 'POST', '/api/admin/workflows/wf/grants', { userId: b.adminAUserId, perm: 'editor' })
    const del = await asV3(b, 'DELETE', '/api/admin/workflows/wf')
    expect(del.status).toBe(200)
    // grants wiped → a re-read shows nothing
    const list = await asV3(b, 'GET', '/api/admin/workflows/wf/grants')
    expect((await list.json()).grants).toEqual([])
  })
})

describe('workflow RBAC — disabled when no identity store wired', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot({ withIdentity: false }) })
  afterEach(async () => { await teardown(b) })

  it('grant routes 404 (panel hidden) but lifecycle still works for the v3 admin', async () => {
    const grants = await asV3(b, 'GET', '/api/admin/workflows/wf/grants')
    expect(grants.status).toBe(404)
    const pub = await asV3(b, 'POST', '/api/admin/workflows/wf/publish')
    expect(pub.status).toBe(200)
  })
})
