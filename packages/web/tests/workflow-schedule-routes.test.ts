/**
 * LIFE-L1-M3 — /api/admin/workflow-schedules/* routes (the web CRUD + manual
 * fire surface over the host's zero-LLM schedule files).
 *
 * Validation, file IO, and the single dispatch path (sweeper.fireNow → the
 * run_my_workflow member gate) live host-side and are unit-tested in
 * host/tests/workflow-schedule-{sweeper,admin}.test.ts. Here we pin only the
 * web seam, exactly like setting-route.test.ts:
 *
 *   • requireAdmin gate → 401 unauthenticated
 *   • 503 when no surface wired
 *   • GET list / POST upsert / DELETE :id echo the surface
 *   • POST upsert surfaces the host's refusal of an untrustworthy row as 400
 *   • POST :id/fire maps the failure ladder: not_found 404 / unrunnable 409 /
 *     dispatch_failed 500 — and echoes a successful manual fire
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import {
  serveWeb,
  type WebServerHandle,
  type WorkflowScheduleAdminSurface,
  type WorkflowScheduleView,
} from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  surfaceCalls: string[]
}

/** In-memory stub of the host surface — one valid row, host-shaped answers. */
function stubSurface(calls: string[]): WorkflowScheduleAdminSurface {
  const rows = new Map<string, WorkflowScheduleView>([
    [
      'sched-1',
      {
        id: 'sched-1',
        workflowId: 'wf-brief',
        userId: 'u-emir',
        cadence: { kind: 'daily', hour: 8, tzOffsetMinutes: 480 },
        enabled: true,
        valid: true,
        lastFiredMark: '2026-07-05',
      },
    ],
  ])
  return {
    async list() {
      calls.push('list')
      return [...rows.values()]
    },
    async upsert(raw) {
      calls.push('upsert')
      const r = (raw ?? {}) as Record<string, unknown>
      if (typeof r.workflowId !== 'string' || !r.cadence) {
        return { ok: false, error: 'invalid_schedule' }
      }
      const view: WorkflowScheduleView = {
        id: typeof r.id === 'string' ? r.id : 'sched-minted',
        workflowId: r.workflowId,
        userId: String(r.userId ?? ''),
        cadence: r.cadence,
        enabled: r.enabled === true,
        valid: true,
      }
      rows.set(view.id, view)
      return { ok: true, schedule: view }
    },
    async remove(id) {
      calls.push(`remove:${id}`)
      return rows.delete(id)
    },
    async fire(id) {
      calls.push(`fire:${id}`)
      if (id === 'sched-gone') return { ok: false, reason: 'not_found' }
      if (id === 'sched-draft') return { ok: false, reason: 'unrunnable' }
      if (id === 'sched-boom') return { ok: false, reason: 'dispatch_failed' }
      return { ok: true, scheduleId: id, workflowId: 'wf-brief', userId: 'u-emir', mark: '2026-07-06' }
    },
  }
}

async function boot(opts: { wired?: boolean } = {}): Promise<Boot> {
  const wired = opts.wired ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-wfsched-'))
  const init = await Space.init(tmp, { name: 'wfsched-route-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { token: adminToken } = await init.space.createAdmin('TestAdmin')
  const surfaceCalls: string[] = []
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(wired ? { workflowSchedules: stubSurface(surfaceCalls) } : {}),
  })
  return { tmp, hub, server, baseUrl: server.url, adminToken, surfaceCalls }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

const auth = (b: Boot) => ({ authorization: `Bearer ${b.adminToken}` })
const jsonHeaders = (b: Boot) => ({ ...auth(b), 'content-type': 'application/json' })
const BASE = '/api/admin/workflow-schedules'

describe('/api/admin/workflow-schedules/* (LIFE-L1-M3)', () => {
  let b: Boot
  afterEach(async () => {
    await teardown(b)
  })

  it('401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}`)
    expect(r.status).toBe(401)
    expect(b.surfaceCalls).toEqual([])
  })

  it('503 when the surface is not wired', async () => {
    b = await boot({ wired: false })
    const r = await fetch(`${b.baseUrl}${BASE}`, { headers: auth(b) })
    expect(r.status).toBe(503)
  })

  it('GET lists rows with the fact-file mark beside the intent', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${BASE}`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { schedules: WorkflowScheduleView[] }
    expect(body.schedules).toHaveLength(1)
    expect(body.schedules[0]).toMatchObject({ id: 'sched-1', lastFiredMark: '2026-07-05' })
  })

  it('POST upserts a row; the host refusal of a bad row surfaces as 400', async () => {
    b = await boot()
    const ok = await fetch(`${b.baseUrl}${BASE}`, {
      method: 'POST',
      headers: jsonHeaders(b),
      body: JSON.stringify({
        workflowId: 'wf-brief',
        userId: 'u-emir',
        cadence: { kind: 'daily', hour: 8 },
        enabled: true,
      }),
    })
    expect(ok.status).toBe(200)
    const created = (await ok.json()) as { schedule: WorkflowScheduleView }
    expect(created.schedule.id).toBe('sched-minted')

    const bad = await fetch(`${b.baseUrl}${BASE}`, {
      method: 'POST',
      headers: jsonHeaders(b),
      body: JSON.stringify({ note: 'no workflowId, no cadence' }),
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_schedule')

    const notJson = await fetch(`${b.baseUrl}${BASE}`, {
      method: 'POST',
      headers: jsonHeaders(b),
      body: '{{{',
    })
    expect(notJson.status).toBe(400)
  })

  it('DELETE removes by id; absent id → 404', async () => {
    b = await boot()
    const gone = await fetch(`${b.baseUrl}${BASE}/nope`, { method: 'DELETE', headers: auth(b) })
    expect(gone.status).toBe(404)
    const ok = await fetch(`${b.baseUrl}${BASE}/sched-1`, { method: 'DELETE', headers: auth(b) })
    expect(ok.status).toBe(200)
    expect(b.surfaceCalls).toContain('remove:sched-1')
  })

  it('POST /:id/fire echoes a manual fire and maps the failure ladder', async () => {
    b = await boot()
    const ok = await fetch(`${b.baseUrl}${BASE}/sched-1/fire`, { method: 'POST', headers: auth(b) })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ ok: true, scheduleId: 'sched-1', mark: '2026-07-06' })

    const cases: Array<[string, number]> = [
      ['sched-gone', 404],
      ['sched-draft', 409],
      ['sched-boom', 500],
    ]
    for (const [id, status] of cases) {
      const r = await fetch(`${b.baseUrl}${BASE}/${id}/fire`, { method: 'POST', headers: auth(b) })
      expect(r.status).toBe(status)
    }
  })

  it('405 on wrong collection method; 404 on a bogus subpath', async () => {
    b = await boot()
    const put = await fetch(`${b.baseUrl}${BASE}`, { method: 'PUT', headers: auth(b) })
    expect(put.status).toBe(405)
    const bogus = await fetch(`${b.baseUrl}${BASE}/a/b/c`, { headers: auth(b) })
    expect(bogus.status).toBe(404)
  })
})
