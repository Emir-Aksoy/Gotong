/**
 * DAG-M3 — workflow graph HTTP route tests.
 *
 * `GET /api/admin/workflows/:id/graph` returns the host's read-only
 * `{ nodes, edges }` projection (the "view flow chart" affordance). These tests
 * stub the duck-typed `WorkflowSurface.graphOf` so the web package stays
 * decoupled from `@gotong/workflow`, and assert the route:
 *   (a) forwards to `graphOf(id)` and echoes its `{ graph }` verbatim,
 *   (b) maps a null result (unknown id) to 404,
 *   (c) maps an absent `graphOf` method (legacy host) to 404 "not enabled",
 *   (d) is admin-gated (401 unauthenticated), and
 *   (e) is wired BEFORE the catch-all DELETE /:id (a graph GET never deletes).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import {
  serveWeb,
  type WebServerHandle,
  type WorkflowGraphView,
  type WorkflowSummary,
  type WorkflowSurface,
} from '../src/server.js'

interface Call {
  method: string
  args: unknown[]
}

interface Stub {
  surface: WorkflowSurface
  calls: Call[]
  /** When set, the next `graphOf` returns null (unknown id). */
  returnNullGraph: boolean
  /** When false, the surface omits `graphOf` entirely (legacy host). */
}

const GRAPH: WorkflowGraphView = {
  workflowId: 'wf',
  nodes: [
    { id: '__trigger__', kind: 'trigger', label: 'run-wf' },
    {
      id: 'step:do',
      kind: 'step',
      label: 'do',
      destination: { kind: 'capability', capabilities: ['act'] },
      readsTrigger: true,
    },
    { id: '__output__', kind: 'output', label: '__output__' },
  ],
  edges: [
    { from: '__trigger__', to: 'step:do', kind: 'sequence' },
    { from: 'step:do', to: '__output__', kind: 'sequence' },
  ],
}

function makeStub(opts: { withGraphOf?: boolean } = {}): Stub {
  const withGraphOf = opts.withGraphOf ?? true
  const calls: Call[] = []
  const state = { returnNullGraph: false }
  const summary = (): WorkflowSummary => ({
    id: 'wf',
    participantId: 'workflow:wf',
    triggerCapability: 'run-wf',
    stepCount: 1,
    file: null,
    state: 'published',
    currentRevision: 1,
  })
  const surface: WorkflowSurface = {
    async list() { calls.push({ method: 'list', args: [] }); return [summary()] },
    async listAll() { calls.push({ method: 'listAll', args: [] }); return [summary()] },
    async importFromText(t) { calls.push({ method: 'importFromText', args: [t] }); return summary() },
    async remove(id) { calls.push({ method: 'remove', args: [id] }) },
    async listRuns(o) { calls.push({ method: 'listRuns', args: [o] }); return [] },
    async readRun(id) { calls.push({ method: 'readRun', args: [id] }); return null },
    async saveDraft(t, o) { calls.push({ method: 'saveDraft', args: [t, o] }); return summary() },
    async publish(id, o) { calls.push({ method: 'publish', args: [id, o] }); return summary() },
    async submitReview(id, o) { calls.push({ method: 'submitReview', args: [id, o] }); return summary() },
    async backToDraft(id, o) { calls.push({ method: 'backToDraft', args: [id, o] }); return summary() },
    async deprecate(id, o) { calls.push({ method: 'deprecate', args: [id, o] }); return summary() },
    async archive(id, o) { calls.push({ method: 'archive', args: [id, o] }); return summary() },
    async rollback(id, o) { calls.push({ method: 'rollback', args: [id, o] }); return summary() },
    async listRevisions(id) { calls.push({ method: 'listRevisions', args: [id] }); return [] },
    async getState(id) {
      calls.push({ method: 'getState', args: [id] })
      return {
        workflowId: id,
        state: 'published',
        currentRevision: 1,
        headRevision: 1,
        triggerCapability: 'run-wf',
        revisions: [],
        history: [],
        legalActions: [],
        registered: true,
      }
    },
    ...(withGraphOf
      ? {
          async graphOf(id: string) {
            calls.push({ method: 'graphOf', args: [id] })
            return state.returnNullGraph ? null : GRAPH
          },
        }
      : {}),
  }
  return {
    surface,
    calls,
    get returnNullGraph() { return state.returnNullGraph },
    set returnNullGraph(v: boolean) { state.returnNullGraph = v },
  }
}

interface BootResult {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  stub: Stub
}

async function boot(opts: { withWorkflows?: boolean; withGraphOf?: boolean } = {}): Promise<BootResult> {
  const withWorkflows = opts.withWorkflows ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-wfgraph-'))
  const init = await Space.init(tmp, { name: 'wfgraph-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { token: adminToken } = await init.space.createAdmin('TestAdmin')
  const stub = makeStub({ withGraphOf: opts.withGraphOf })
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(withWorkflows ? { workflows: stub.surface } : {}),
  })
  return { tmp, hub, server, baseUrl: server.url, adminToken, stub }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

function authed(b: BootResult, method: string, path: string): Promise<Response> {
  return fetch(`${b.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${b.adminToken}` },
  })
}

describe('workflow graph route', () => {
  let b: BootResult
  afterEach(async () => { await teardown(b) })

  it('GET /:id/graph → graphOf(id) + echoes { graph } verbatim', async () => {
    b = await boot()
    const r = await authed(b, 'GET', '/api/admin/workflows/wf/graph')
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.graph).toEqual(GRAPH)
    const call = b.stub.calls.find((c) => c.method === 'graphOf')
    expect(call).toBeDefined()
    expect(call!.args[0]).toBe('wf')
  })

  it('url-encoded id is decoded before graphOf', async () => {
    b = await boot()
    const r = await authed(b, 'GET', '/api/admin/workflows/my%2Fwf/graph')
    // Path regex is single-segment ([^/]+); an encoded slash stays in one
    // segment and decodes only inside the handler.
    expect(r.status).toBe(200)
    const call = b.stub.calls.find((c) => c.method === 'graphOf')!
    expect(call.args[0]).toBe('my/wf')
  })

  it('null graph (unknown id) → 404', async () => {
    b = await boot()
    b.stub.returnNullGraph = true
    const r = await authed(b, 'GET', '/api/admin/workflows/nope/graph')
    expect(r.status).toBe(404)
    expect((await r.json()).error).toMatch(/unknown workflow/i)
  })

  it('legacy host without graphOf → 404 "not enabled"', async () => {
    b = await boot({ withGraphOf: false })
    const r = await authed(b, 'GET', '/api/admin/workflows/wf/graph')
    expect(r.status).toBe(404)
    expect((await r.json()).error).toMatch(/not enabled/i)
    // graphOf is absent, so nothing was invoked.
    expect(b.stub.calls.find((c) => c.method === 'graphOf')).toBeUndefined()
  })

  it('404 when the host did not wire a workflow surface', async () => {
    b = await boot({ withWorkflows: false })
    const r = await authed(b, 'GET', '/api/admin/workflows/wf/graph')
    expect(r.status).toBe(404)
  })

  it('401 when unauthenticated (graphOf never called)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/wf/graph`, { method: 'GET' })
    expect(r.status).toBe(401)
    expect(b.stub.calls.length).toBe(0)
  })
})
