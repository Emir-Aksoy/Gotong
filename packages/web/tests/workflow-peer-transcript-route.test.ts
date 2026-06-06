/**
 * v5 Stream G day-5 M5 — cross-hub transcript-chain route tests.
 *
 * GET /api/admin/workflows/runs/:id/steps/:stepId/peer-transcript
 *
 * The host injects a duck-typed `WorkflowSurface` whose optional
 * `fetchPeerStepTranscript` resolves a cross-hub step's `executedBy` +
 * `peerTaskId`, reaches the peer link, and calls the opt-in `peer.transcript`
 * rpc. These tests stub that method so the web package stays decoupled from the
 * host. They assert the route (a) forwards run/step ids verbatim (URL-decoded),
 * (b) maps `unknown_run` / `unknown_step` to 404, (c) rides the SOFT verdicts
 * (`not_cross_hub` / `no_link` / `fetch_failed` — the peer not sharing) back as
 * 200 so the UI renders the reason inline, and (d) answers 404 when the host
 * built no resolver (the method is absent), and is admin-gated.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'

import { serveWeb, type WebServerHandle, type WorkflowSurface } from '../src/server.js'

interface Call {
  runId: string
  stepId: string
}

/** Build a WorkflowSurface that only implements what the route touches. */
function makeStub(opts: {
  result?: unknown
  omitMethod?: boolean
}): { surface: WorkflowSurface; calls: Call[] } {
  const calls: Call[] = []
  const base = {
    async fetchPeerStepTranscript(runId: string, stepId: string) {
      calls.push({ runId, stepId })
      return opts.result
    },
  }
  // `omitMethod` simulates a single-hub host built without a peer-link resolver
  // — the controller never gets the optional method, so the route 404s.
  const surface = (opts.omitMethod ? {} : base) as unknown as WorkflowSurface
  return { surface, calls }
}

interface BootResult {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  calls: Call[]
}

async function boot(opts: { result?: unknown; omitMethod?: boolean } = {}): Promise<BootResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-wfpx-'))
  const init = await Space.init(tmp, { name: 'wfpx-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { token: adminToken } = await init.space.createAdmin('TestAdmin')
  const { surface, calls } = makeStub(opts)
  const server = await serveWeb(hub, { host: '127.0.0.1', port: 0, workflows: surface })
  return { tmp, hub, server, baseUrl: server.url, adminToken, calls }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

function authed(b: BootResult, path: string): Promise<Response> {
  return fetch(`${b.baseUrl}${path}`, { headers: { authorization: `Bearer ${b.adminToken}` } })
}

const PATH = (run: string, step: string) =>
  `/api/admin/workflows/runs/${run}/steps/${step}/peer-transcript`

describe('cross-hub transcript-chain route', () => {
  let b: BootResult
  afterEach(async () => { await teardown(b) })

  it('forwards a successful slice verbatim (200)', async () => {
    const slice = {
      hubId: 'hubB',
      protocolVersion: '1',
      taskId: 'peer-task-1',
      events: [{ seq: 1, ts: 10, kind: 'task', data: { id: 'peer-task-1' } }],
      truncated: false,
      generatedAt: 123,
    }
    b = await boot({ result: { ok: true, slice } })
    const r = await authed(b, PATH('run1', 'review'))
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.ok).toBe(true)
    expect(j.slice.hubId).toBe('hubB')
    expect(j.slice.events).toHaveLength(1)
    // Run + step ids reach the surface verbatim.
    expect(b.calls).toEqual([{ runId: 'run1', stepId: 'review' }])
  })

  it('URL-decodes run and step ids before forwarding', async () => {
    b = await boot({ result: { ok: true, slice: {} } })
    const r = await authed(b, PATH(encodeURIComponent('run/A'), encodeURIComponent('step b')))
    expect(r.status).toBe(200)
    expect(b.calls).toEqual([{ runId: 'run/A', stepId: 'step b' }])
  })

  it('maps unknown_run → 404', async () => {
    b = await boot({ result: { ok: false, code: 'unknown_run', message: "unknown run 'x'" } })
    const r = await authed(b, PATH('x', 'review'))
    expect(r.status).toBe(404)
    const j = await r.json()
    expect(j.code).toBe('unknown_run')
  })

  it('maps unknown_step → 404', async () => {
    b = await boot({ result: { ok: false, code: 'unknown_step', message: "unknown step 'z'" } })
    const r = await authed(b, PATH('run1', 'z'))
    expect(r.status).toBe(404)
    const j = await r.json()
    expect(j.code).toBe('unknown_step')
  })

  // The soft verdicts are NOT errors — a same-hub step, a disconnected peer, or
  // a peer that hasn't opted into sharing. They ride back 200 so the UI renders
  // the reason inline rather than treating it as a failed request.
  for (const code of ['not_cross_hub', 'no_link', 'fetch_failed']) {
    it(`rides ${code} back as 200 with ok:false`, async () => {
      b = await boot({ result: { ok: false, code, message: 'reason text' } })
      const r = await authed(b, PATH('run1', 'review'))
      expect(r.status).toBe(200)
      const j = await r.json()
      expect(j.ok).toBe(false)
      expect(j.code).toBe(code)
      expect(j.message).toBe('reason text')
    })
  }

  it('404s when the host omits fetchPeerStepTranscript (single-hub)', async () => {
    b = await boot({ omitMethod: true })
    const r = await authed(b, PATH('run1', 'review'))
    expect(r.status).toBe(404)
    // The surface method was never reachable, so nothing was recorded.
    expect(b.calls).toHaveLength(0)
  })

  it('requires admin auth (401 without a Bearer)', async () => {
    b = await boot({ result: { ok: true, slice: {} } })
    const r = await fetch(`${b.baseUrl}${PATH('run1', 'review')}`)
    expect(r.status).toBe(401)
    expect(b.calls).toHaveLength(0)
  })
})
