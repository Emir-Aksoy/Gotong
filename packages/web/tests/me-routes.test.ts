/**
 * HTTP tests for `/api/me/*` — member-facing surface.
 *
 * We boot a real Space + Hub + IdentityStore + serveWeb (mirrors the
 * identity-routes tests). A stub `GrowthReportsAdminSurface` is wired
 * via `serveWeb({ growthReports })` to verify per-user filtering and
 * the cross-user ACL.
 *
 * Coverage focus:
 *   - /api/me/* without v4 session → 401
 *   - /api/me/allowed-workflows catalog
 *   - /api/me/dispatch forces case_id = userId (even if member tries to
 *     spoof it), drops payload fields not in the allowlist, and refuses
 *     un-allowlisted workflowIds
 *   - /api/me/growth-reports filters to caseId === userId
 *   - /api/me/growth-reports/download blocks cross-user paths
 *   - host without growthReports surface → 503 on /growth-reports*
 *   - GET /me serves the static page
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HumanParticipant,
  Hub,
  Space,
  type GrowthReportSummary,
  type GrowthReportsAdminSurface,
} from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'

interface BootResult {
  tmp: string
  hub: Hub
  space: Space
  identity: IdentityStore
  server: WebServerHandle
  baseUrl: string
  ownerUserId: string
  // member that the tests can log in as
  memberUserId: string
  memberCookie: string
  growthReports: StubGrowthReports
}

class StubGrowthReports implements GrowthReportsAdminSurface {
  // Pre-seeded by tests via push(). Each entry's path is the caseId-keyed
  // shape `reports/<caseId>/<file>.md`.
  readonly entries: GrowthReportSummary[] = []
  readonly markdownByPath = new Map<string, string>()

  async list(): Promise<ReadonlyArray<GrowthReportSummary>> {
    return this.entries
  }
  async read(path: string): Promise<{ readonly markdown: string }> {
    const md = this.markdownByPath.get(path)
    if (md === undefined) throw new Error(`stub: no markdown for ${path}`)
    return { markdown: md }
  }
}

async function boot(
  opts: {
    withGrowthReports?: boolean
    adminLoginRateLimit?: { max: number; windowSec: number }
  } = {},
): Promise<BootResult> {
  const withGrowthReports = opts.withGrowthReports ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-me-'))
  const init = await Space.init(tmp, { name: 'me-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  // Register a stub participant claiming the PG trigger capability so
  // hub.dispatch finds a target. Without this, dispatch resolves to
  // 'no_participant' and returns an error — fine for the /me tests we
  // care about (we just want to verify the dispatch went through),
  // but easier to test if it succeeds quietly.
  hub.register(
    new HumanParticipant({
      id: 'pg-stub-participant',
      capabilities: ['plan-personal-growth'],
    }),
  )

  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')
  const adminSid = 'a-me-sid-' + Math.random().toString(36).slice(2)
  await space.addAdminSession(adminSid, admin.id)
  const adminCookie = `aipehub_admin=${adminSid}`

  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
  const ib = identity.bootstrap({
    adminToken,
    ownerEmail: 'admin@local',
    ownerDisplayName: 'TestAdmin',
  })
  const ownerUserId = ib.ownerUserId!

  // Create a member + set password directly via the store (skips the
  // owner-only POST /users round trip the identity-routes tests do).
  const member = identity.createUser({
    email: 'member@team.test',
    displayName: 'Test Member',
    password: 'member-strong-password',
    role: 'member',
  })
  const memberUserId = member.id

  const growthReports = new StubGrowthReports()

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(withGrowthReports ? { growthReports } : {}),
    ...(opts.adminLoginRateLimit
      ? { adminLoginRateLimit: opts.adminLoginRateLimit }
      : {}),
  })

  // Pre-cook the member's v4 session cookie via password login on the
  // running server so the cookie is correctly minted + persisted in
  // the store.
  const loginRes = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'member@team.test',
      password: 'member-strong-password',
    }),
  })
  if (loginRes.status !== 200) {
    throw new Error(`boot: member login failed status=${loginRes.status}`)
  }
  const setCookie = loginRes.headers.get('set-cookie')!
  const memberCookie = setCookie.split(';')[0]!

  // Silence unused-var lint — adminCookie is part of BootResult conceptually
  // (test scaffolding may use it later) but here we drop it to avoid an
  // unused field on the result shape.
  void adminCookie

  return {
    tmp,
    hub,
    space,
    identity,
    server,
    baseUrl: server.url,
    ownerUserId,
    memberUserId,
    memberCookie,
    growthReports,
  }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('/me — page', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('GET /me serves the static page (200 + HTML)', async () => {
    const r = await fetch(`${b.baseUrl}/me`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/text\/html/)
    const body = await r.text()
    expect(body).toContain('AipeHub')
    expect(body).toContain('我的工作流')
  })
})

describe('/api/me/* — auth gate', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('anonymous request to /api/me/dispatch → 401', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId: 'personal-growth-flow', payload: {} }),
    })
    expect(r.status).toBe(401)
    const body = (await r.json()) as { code?: string }
    expect(body.code).toBe('authentication_required')
  })

  it('anonymous request to /api/me/growth-reports → 401', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/growth-reports`)
    expect(r.status).toBe(401)
  })

  it('v3-admin cookie alone (no v4 user) is NOT accepted by /api/me/*', async () => {
    // The v3 admin cookie has no v4 user id to scope by — /me intentionally
    // refuses it. This is the security contract we're verifying.
    const v3Admin = (await b.space.admins())[0]!
    const adminSid = 'a-test-2-' + Math.random().toString(36).slice(2)
    await b.space.addAdminSession(adminSid, v3Admin.id)
    const r = await fetch(`${b.baseUrl}/api/me/growth-reports`, {
      headers: { cookie: `aipehub_admin=${adminSid}` },
    })
    expect(r.status).toBe(401)
  })
})

describe('/api/me/allowed-workflows', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('returns the personal-growth-flow allowlist entry', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/allowed-workflows`, {
      headers: { cookie: b.memberCookie },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      workflows: Array<{ workflowId: string; capability: string; payloadFields: string[]; label: string }>
    }
    const pg = body.workflows.find((w) => w.workflowId === 'personal-growth-flow')
    expect(pg).toBeTruthy()
    expect(pg!.capability).toBe('plan-personal-growth')
    expect(pg!.payloadFields).toEqual(
      expect.arrayContaining([
        'present_state', 'aspirations', 'struggles', 'focus_request',
      ]),
    )
  })
})

describe('/api/me/dispatch — security contract', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('dispatches PG with case_id forced to caller userId', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: b.memberCookie,
      },
      body: JSON.stringify({
        workflowId: 'personal-growth-flow',
        payload: { present_state: 'a bit stuck', focus_request: 'next 12 weeks' },
      }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { ok: boolean; caseId: string; workflowId: string }
    expect(body.ok).toBe(true)
    expect(body.caseId).toBe(b.memberUserId) // <-- the security guarantee
    expect(body.workflowId).toBe('personal-growth-flow')
  })

  it('refuses to dispatch a workflowId NOT in the allowlist (403)', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: b.memberCookie,
      },
      body: JSON.stringify({ workflowId: 'arbitrary-workflow', payload: {} }),
    })
    expect(r.status).toBe(403)
    const body = (await r.json()) as { code?: string; allowed?: string[] }
    expect(body.code).toBe('workflow_not_allowed')
    expect(body.allowed).toContain('personal-growth-flow')
  })

  it('strips body.payload.case_id (member cannot spoof another user)', async () => {
    // Inspect the hub transcript to find the dispatched task and verify
    // its payload.case_id is the caller's userId, NOT the spoofed value.
    const spoofed = 'someone-elses-case'
    const r = await fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: b.memberCookie,
      },
      body: JSON.stringify({
        workflowId: 'personal-growth-flow',
        payload: {
          present_state: 'x',
          case_id: spoofed,
          // Smuggled field NOT in payloadFields — should also be dropped.
          arbitrary_extra: 'should-not-survive',
        },
      }),
    })
    expect(r.status).toBe(200)

    // Pull the dispatched task back from the hub transcript. The
    // TaskView wraps the Task in `.task` — the payload lives there.
    const tasks = b.hub.tasks()
    const lastTask = tasks[tasks.length - 1]
    expect(lastTask).toBeTruthy()
    const payload = lastTask!.task.payload as Record<string, unknown>
    expect(payload.case_id).toBe(b.memberUserId)
    expect(payload.case_id).not.toBe(spoofed)
    expect(payload.arbitrary_extra).toBeUndefined()
    expect(payload.present_state).toBe('x')
  })

  it('400 when workflowId is missing', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: b.memberCookie,
      },
      body: JSON.stringify({ payload: {} }),
    })
    expect(r.status).toBe(400)
  })
})

describe('/api/me/growth-reports — per-user filter + ACL', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('filters reports to caseId === userId', async () => {
    // Seed three reports: two for the member, one for another user.
    const otherUserId = 'some-other-user'
    b.growthReports.entries.push(
      { path: `reports/${b.memberUserId}/r1.md`, caseId: b.memberUserId, ts: 1, sizeBytes: 100 },
      { path: `reports/${b.memberUserId}/r2.md`, caseId: b.memberUserId, ts: 2, sizeBytes: 200 },
      { path: `reports/${otherUserId}/x.md`, caseId: otherUserId, ts: 3, sizeBytes: 300 },
    )
    const r = await fetch(`${b.baseUrl}/api/me/growth-reports`, {
      headers: { cookie: b.memberCookie },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { reports: GrowthReportSummary[] }
    expect(body.reports.length).toBe(2)
    expect(body.reports.every((rep) => rep.caseId === b.memberUserId)).toBe(true)
  })

  it('download blocks cross-user path with 403 (cross_user_forbidden)', async () => {
    const otherUserId = 'some-other-user'
    b.growthReports.markdownByPath.set(
      `reports/${otherUserId}/secret.md`,
      'should-not-be-readable',
    )
    const r = await fetch(
      `${b.baseUrl}/api/me/growth-reports/download?path=${encodeURIComponent(
        `reports/${otherUserId}/secret.md`,
      )}`,
      { headers: { cookie: b.memberCookie } },
    )
    expect(r.status).toBe(403)
    const body = (await r.json()) as { code?: string }
    expect(body.code).toBe('cross_user_forbidden')
  })

  it("download serves the caller's own report as text/markdown", async () => {
    const ownPath = `reports/${b.memberUserId}/mine.md`
    b.growthReports.markdownByPath.set(ownPath, '# my growth report\n\nhello')
    const r = await fetch(
      `${b.baseUrl}/api/me/growth-reports/download?path=${encodeURIComponent(ownPath)}`,
      { headers: { cookie: b.memberCookie } },
    )
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/text\/markdown/)
    expect(r.headers.get('content-disposition')).toContain('attachment')
    expect(await r.text()).toContain('# my growth report')
  })

  it('download rejects path-traversal attempts (400)', async () => {
    const r = await fetch(
      `${b.baseUrl}/api/me/growth-reports/download?path=${encodeURIComponent(
        '../../etc/passwd',
      )}`,
      { headers: { cookie: b.memberCookie } },
    )
    expect(r.status).toBe(400)
  })

  it('download with missing path query returns 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/growth-reports/download`, {
      headers: { cookie: b.memberCookie },
    })
    expect(r.status).toBe(400)
  })
})

describe('/api/me/growth-reports — host without growthReports surface', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot({ withGrowthReports: false }) })
  afterEach(async () => { await teardown(b) })

  it('list returns 503 cleanly when surface is unwired', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/growth-reports`, {
      headers: { cookie: b.memberCookie },
    })
    expect(r.status).toBe(503)
  })

  it('download returns 503 cleanly when surface is unwired', async () => {
    const r = await fetch(
      `${b.baseUrl}/api/me/growth-reports/download?path=reports/x/y.md`,
      { headers: { cookie: b.memberCookie } },
    )
    expect(r.status).toBe(503)
  })
})

// ---------------------------------------------------------------------------
// AUDIT-P3-01 / AUDIT-P3-02 — /me rate-limit coverage
// ---------------------------------------------------------------------------

describe('/api/me/dispatch — rate limit (AUDIT-P3-01)', () => {
  let b: BootResult
  beforeEach(async () => {
    // Tight budget so we can prove the cap with a small loop. 2 hits
    // allowed per minute; 3rd should 429.
    b = await boot({ adminLoginRateLimit: { max: 2, windowSec: 60 } })
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('returns 429 after the per-user budget is exhausted', async () => {
    const dispatch = () =>
      fetch(`${b.baseUrl}/api/me/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: b.memberCookie },
        body: JSON.stringify({
          workflowId: 'personal-growth-flow',
          payload: { present_state: 'p', aspirations: 'a' },
        }),
      })
    expect((await dispatch()).status).toBe(200)
    expect((await dispatch()).status).toBe(200)
    const r3 = await dispatch()
    expect(r3.status).toBe(429)
    expect(r3.headers.get('retry-after')).toBe('60')
  })
})

describe('/api/me/growth-reports — rate limit (AUDIT-P3-02)', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot({ adminLoginRateLimit: { max: 2, windowSec: 60 } })
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('returns 429 after the per-user budget is exhausted', async () => {
    const list = () =>
      fetch(`${b.baseUrl}/api/me/growth-reports`, {
        headers: { cookie: b.memberCookie },
      })
    expect((await list()).status).toBe(200)
    expect((await list()).status).toBe(200)
    expect((await list()).status).toBe(429)
  })

  it('dispatch budget and reports budget are independent buckets', async () => {
    // Exhaust dispatch budget (2 hits).
    const dispatch = () =>
      fetch(`${b.baseUrl}/api/me/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: b.memberCookie },
        body: JSON.stringify({
          workflowId: 'personal-growth-flow',
          payload: { present_state: 'p', aspirations: 'a' },
        }),
      })
    expect((await dispatch()).status).toBe(200)
    expect((await dispatch()).status).toBe(200)
    expect((await dispatch()).status).toBe(429)
    // Reports should still have full budget — different namespace key.
    const r = await fetch(`${b.baseUrl}/api/me/growth-reports`, {
      headers: { cookie: b.memberCookie },
    })
    expect(r.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// AUDIT-P3-07 — security headers on static assets
// ---------------------------------------------------------------------------

describe('static asset security headers (AUDIT-P3-07)', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('GET /me ships X-Frame-Options, X-Content-Type-Options, Referrer-Policy', async () => {
    const r = await fetch(`${b.baseUrl}/me`)
    expect(r.status).toBe(200)
    expect(r.headers.get('x-frame-options')).toBe('DENY')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('GET /invite ships the same baseline headers', async () => {
    const r = await fetch(`${b.baseUrl}/invite/inv_anything`)
    expect(r.status).toBe(200)
    expect(r.headers.get('x-frame-options')).toBe('DENY')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('referrer-policy')).toBe('no-referrer')
  })
})

// ---------------------------------------------------------------------------
// AUDIT-P3-05 — invite.html has the referrer no-referrer meta
// ---------------------------------------------------------------------------

describe('/invite — referrer meta (AUDIT-P3-05)', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('invite.html includes <meta name="referrer" content="no-referrer">', async () => {
    const r = await fetch(`${b.baseUrl}/invite/inv_anything`)
    const html = await r.text()
    expect(html).toMatch(/meta\s+name=["']referrer["']\s+content=["']no-referrer["']/)
  })
})
