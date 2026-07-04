/**
 * Phase 15 M6 — workflow lifecycle HTTP route tests.
 *
 * The host injects a duck-typed `WorkflowSurface` (the `WorkflowController`).
 * These tests stub it so the web package stays decoupled from `@gotong/workflow`
 * — they assert the routes (a) forward to the right surface method with the
 * acting admin stamped as `by`, (b) parse the publish/rollback bodies, and
 * (c) map the surface's duck-typed error `code` to the right HTTP status.
 *
 * Routes under test (all admin-gated, all before the catch-all DELETE /:id):
 *   POST /api/admin/workflows/draft
 *   POST /api/admin/workflows/:id/{review,draft,publish,deprecate,archive,rollback}
 *   GET  /api/admin/workflows/:id/revisions
 *   GET  /api/admin/workflows/:id/state
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import {
  serveWeb,
  type IdentitySurface,
  type WebServerHandle,
  type WorkflowSummary,
  type WorkflowSurface,
} from '../src/server.js'

class CodedError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

interface Call {
  method: string
  args: unknown[]
}

interface Stub {
  surface: WorkflowSurface
  calls: Call[]
  /** Make the next call to `method` throw `err`. */
  throwOn(method: string, err: Error): void
}

function makeStub(): Stub {
  const calls: Call[] = []
  const throwers = new Map<string, Error>()
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
    const err = throwers.get(method)
    if (err) {
      throwers.delete(method)
      throw err
    }
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
        legalActions: ['publish', 'deprecate', 'rollback'],
        registered: true,
      }
    },
  }
  return { surface, calls, throwOn: (m, e) => throwers.set(m, e) }
}

// --- audit capture (P2-M2) -------------------------------------------------
// A minimal `writeAuditLog` sink that records the rows the workflow routes
// emit. Cast to IdentitySurface at the serveWeb boundary; the routes only
// ever call writeAuditLog, so nothing else needs stubbing.

interface AuditRow {
  action: string
  actorSource: string
  actorUserId?: string | null
  metadata?: Record<string, unknown> | null
  success?: boolean
}

interface AuditCapture {
  rows: AuditRow[]
  surface: { writeAuditLog(input: AuditRow): unknown }
}

function makeAuditCapture(opts: { throwOnce?: boolean } = {}): AuditCapture {
  const rows: AuditRow[] = []
  let pendingThrow = opts.throwOnce ?? false
  return {
    rows,
    surface: {
      writeAuditLog(input: AuditRow) {
        if (pendingThrow) {
          pendingThrow = false
          throw new Error('audit insert failed')
        }
        rows.push(input)
        return { id: 'audit-row', ts: 0 }
      },
    },
  }
}

interface BootResult {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  adminId: string
  stub: Stub
}

async function boot(
  opts: { withWorkflows?: boolean; audit?: AuditCapture } = {},
): Promise<BootResult> {
  const withWorkflows = opts.withWorkflows ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-wflc-'))
  const init = await Space.init(tmp, { name: 'wflc-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { admin, token: adminToken } = await init.space.createAdmin('TestAdmin')
  const stub = makeStub()
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(withWorkflows ? { workflows: stub.surface } : {}),
    // P2-M2 — the workflow routes source their audit sink from `ctx.identity`
    // (writeAuditLog is the only method they touch). The v3 Space-admin Bearer
    // resolves before any v4 identity method, so this partial stub is safe.
    ...(opts.audit ? { identity: opts.audit.surface as unknown as IdentitySurface } : {}),
  })
  return { tmp, hub, server, baseUrl: server.url, adminToken, adminId: admin.id, stub }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

function authed(b: BootResult, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${b.adminToken}` }
  let payload: string | undefined
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  return fetch(`${b.baseUrl}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) })
}

describe('workflow lifecycle routes', () => {
  let b: BootResult
  afterEach(async () => { await teardown(b) })

  // --- routing: each action → the matching surface method ------------------

  const transitions: Array<{ action: string; method: string }> = [
    { action: 'review', method: 'submitReview' },
    { action: 'draft', method: 'backToDraft' },
    { action: 'deprecate', method: 'deprecate' },
    { action: 'archive', method: 'archive' },
  ]
  for (const { action, method } of transitions) {
    it(`POST /:id/${action} → ${method}(id, { by: admin })`, async () => {
      b = await boot()
      const r = await authed(b, 'POST', `/api/admin/workflows/wf/${action}`)
      expect(r.status).toBe(200)
      const j = await r.json()
      expect(j.ok).toBe(true)
      expect(j.workflow.id).toBe('wf')
      const call = b.stub.calls.find((c) => c.method === method)
      expect(call).toBeDefined()
      expect(call!.args[0]).toBe('wf')
      expect(call!.args[1]).toEqual({ by: b.adminId })
    })
  }

  it('GET /api/admin/workflows → listAll() (the admin panel shows drafts, not just live)', async () => {
    b = await boot()
    const r = await authed(b, 'GET', '/api/admin/workflows')
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(Array.isArray(j.workflows)).toBe(true)
    // The operator's full view comes from `listAll`, NOT the live-only `list`
    // (which still backs the /me member catalog).
    expect(b.stub.calls.find((c) => c.method === 'listAll')).toBeDefined()
    expect(b.stub.calls.find((c) => c.method === 'list')).toBeUndefined()
  })

  it('POST /:id/publish with a { text } body → publish(id, { text, by })', async () => {
    b = await boot()
    const r = await authed(b, 'POST', '/api/admin/workflows/wf/publish', { text: 'yaml-here' })
    expect(r.status).toBe(200)
    const call = b.stub.calls.find((c) => c.method === 'publish')!
    expect(call.args[0]).toBe('wf')
    expect(call.args[1]).toEqual({ text: 'yaml-here', by: b.adminId })
  })

  it('POST /:id/publish with no body → publish(id, { by }) (promote head)', async () => {
    b = await boot()
    const r = await authed(b, 'POST', '/api/admin/workflows/wf/publish')
    expect(r.status).toBe(200)
    const call = b.stub.calls.find((c) => c.method === 'publish')!
    expect(call.args[1]).toEqual({ by: b.adminId })
  })

  it('POST /:id/rollback with { targetRevision } → rollback(id, { targetRevision, by })', async () => {
    b = await boot()
    const r = await authed(b, 'POST', '/api/admin/workflows/wf/rollback', { targetRevision: 1 })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.workflow.currentRevision).toBe(3)
    const call = b.stub.calls.find((c) => c.method === 'rollback')!
    expect(call.args[1]).toEqual({ targetRevision: 1, by: b.adminId })
  })

  it('POST /:id/rollback without targetRevision → 400, surface not called', async () => {
    b = await boot()
    const r = await authed(b, 'POST', '/api/admin/workflows/wf/rollback', {})
    expect(r.status).toBe(400)
    expect(b.stub.calls.find((c) => c.method === 'rollback')).toBeUndefined()
  })

  it('POST /api/admin/workflows/draft → saveDraft(text, { by })', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/draft`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.adminToken}`, 'content-type': 'text/plain' },
      body: 'draft-yaml',
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.workflow.state).toBe('draft')
    const call = b.stub.calls.find((c) => c.method === 'saveDraft')!
    expect(call.args[0]).toBe('draft-yaml')
    expect(call.args[1]).toEqual({ by: b.adminId })
  })

  // --- GET reads -----------------------------------------------------------

  it('GET /:id/revisions → { revisions }', async () => {
    b = await boot()
    const r = await authed(b, 'GET', '/api/admin/workflows/wf/revisions')
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.revisions).toEqual([{ revision: 1, contentHash: 'h1', createdAt: 0, origin: 'import' }])
    expect(b.stub.calls.find((c) => c.method === 'listRevisions')!.args[0]).toBe('wf')
  })

  it('GET /:id/state → { lifecycle }', async () => {
    b = await boot()
    const r = await authed(b, 'GET', '/api/admin/workflows/wf/state')
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.lifecycle).toMatchObject({ workflowId: 'wf', state: 'published', registered: true })
    expect(j.lifecycle.legalActions).toContain('publish')
  })

  // --- error mapping (duck-typed `code` → HTTP status) ---------------------

  it('illegal_transition → 409', async () => {
    b = await boot()
    b.stub.throwOn('archive', new CodedError("can't archive from published", 'illegal_transition'))
    const r = await authed(b, 'POST', '/api/admin/workflows/wf/archive')
    expect(r.status).toBe(409)
    expect((await r.json()).error).toMatch(/archive/i)
  })

  it('capability_immutable → 409', async () => {
    b = await boot()
    b.stub.throwOn('publish', new CodedError('capability is frozen', 'capability_immutable'))
    const r = await authed(b, 'POST', '/api/admin/workflows/wf/publish', { text: 'y' })
    expect(r.status).toBe(409)
  })

  it('unknown_workflow → 404', async () => {
    b = await boot()
    b.stub.throwOn('deprecate', new CodedError("unknown workflow 'wf'", 'unknown_workflow'))
    const r = await authed(b, 'POST', '/api/admin/workflows/wf/deprecate')
    expect(r.status).toBe(404)
  })

  it('revision_missing (bad rollback target) → 400', async () => {
    b = await boot()
    b.stub.throwOn('rollback', new CodedError('no revision 9', 'revision_missing'))
    const r = await authed(b, 'POST', '/api/admin/workflows/wf/rollback', { targetRevision: 9 })
    expect(r.status).toBe(400)
  })

  it('unknown_workflow on GET /:id/state → 404', async () => {
    b = await boot()
    b.stub.throwOn('getState', new CodedError('unknown', 'unknown_workflow'))
    const r = await authed(b, 'GET', '/api/admin/workflows/wf/state')
    expect(r.status).toBe(404)
  })

  // --- auth / surface presence --------------------------------------------

  it('401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/wf/publish`, { method: 'POST' })
    expect(r.status).toBe(401)
    expect(b.stub.calls.length).toBe(0)
  })

  it('404 when the host did not wire a workflow surface', async () => {
    b = await boot({ withWorkflows: false })
    const r = await authed(b, 'POST', '/api/admin/workflows/wf/publish')
    expect(r.status).toBe(404)
    expect((await r.json()).error).toMatch(/not enabled/i)
  })
})

describe('workflow lifecycle audit (P2-M2)', () => {
  let b: BootResult
  afterEach(async () => { await teardown(b) })

  it('publish writes one governance row (actor + workflowId + revision)', async () => {
    const audit = makeAuditCapture()
    b = await boot({ audit })
    const r = await authed(b, 'POST', '/api/admin/workflows/wf/publish')
    expect(r.status).toBe(200)
    expect(audit.rows).toHaveLength(1)
    const row = audit.rows[0]!
    expect(row.action).toBe('workflow_publish')
    expect(row.actorSource).toBe('v4-session')
    expect(row.actorUserId).toBe(b.adminId)
    expect(row.metadata).toMatchObject({ workflowId: 'wf', revision: 1 })
    expect(row.success).toBe(true)
  })

  it('import writes a workflow_import row', async () => {
    const audit = makeAuditCapture()
    b = await boot({ audit })
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.adminToken}`, 'content-type': 'text/plain' },
      body: 'schema: gotong.workflow/v1',
    })
    expect(r.status).toBe(200)
    expect(audit.rows.map((x) => x.action)).toEqual(['workflow_import'])
    expect(audit.rows[0]!.metadata).toMatchObject({ workflowId: 'wf' })
  })

  it('rollback row records the revision it rolled to', async () => {
    const audit = makeAuditCapture()
    b = await boot({ audit })
    const r = await authed(b, 'POST', '/api/admin/workflows/wf/rollback', { targetRevision: 1 })
    expect(r.status).toBe(200)
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]!.action).toBe('workflow_rollback')
    // stub.rollback returns summary({ currentRevision: 3 }) — the audit row
    // must pin the revision new runs now bind to, not the rollback target.
    expect(audit.rows[0]!.metadata).toMatchObject({ workflowId: 'wf', revision: 3 })
  })

  it('authoring churn (review / draft) writes NO audit row', async () => {
    const audit = makeAuditCapture()
    b = await boot({ audit })
    await authed(b, 'POST', '/api/admin/workflows/wf/review')
    await authed(b, 'POST', '/api/admin/workflows/wf/draft')
    expect(audit.rows).toHaveLength(0)
  })

  it('a failing audit sink never fails the transition', async () => {
    const audit = makeAuditCapture({ throwOnce: true })
    b = await boot({ audit })
    const r = await authed(b, 'POST', '/api/admin/workflows/wf/publish')
    expect(r.status).toBe(200) // transition succeeded before the audit attempt
    expect(audit.rows).toHaveLength(0) // the throw prevented the row
  })

  it('no audit sink wired → transition still 200 (unaudited)', async () => {
    b = await boot() // no identity surface
    const r = await authed(b, 'POST', '/api/admin/workflows/wf/publish')
    expect(r.status).toBe(200)
  })
})
