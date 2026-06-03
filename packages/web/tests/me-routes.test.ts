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
 *   - /api/me/workflows — member-facing catalog DERIVED from surface.me
 *   - /api/me/dispatch forces payload[userScopeField] = userId (even if
 *     a member tries to spoof it), drops undeclared fields, and refuses
 *     any workflow that isn't member-facing for the caller's role
 *   - /api/me/growth-reports filters to caseId === userId
 *   - /api/me/growth-reports/download blocks cross-user paths
 *   - host without growthReports surface → 503 on /growth-reports*
 *   - GET /me → 301 redirect to / (legacy URL, folded into unified SPA in C1c)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix as posixPath } from 'node:path'

import {
  HumanParticipant,
  Hub,
  Space,
  type GrowthReportSummary,
  type GrowthReportsAdminSurface,
} from '@aipehub/core'
import { AUDIT_ACTIONS, openIdentityStore, type IdentityStore } from '@aipehub/identity'

import {
  serveWeb,
  type WebServerHandle,
  type WorkflowSummary,
  type WorkflowSurface,
  type WorkflowRunSummary,
} from '../src/server.js'

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
  /** Phase 19 P1-M2 — present when boot() was given `workflows`; seed runs here. */
  workflowSurface: StubWorkflowSurface | undefined
  /** Phase 19 P1-M4 — present when boot() was given `withUploads`. */
  uploads: StubUploads | undefined
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

/**
 * Minimal `WorkflowSurface` stub exposing a fixed list — enough to drive
 * the Phase 14 member-facing catalog (`/api/me/workflows`) without booting
 * a real WorkflowController. Write-side methods throw (unused here).
 */
class StubWorkflowSurface implements WorkflowSurface {
  /**
   * Phase 19 P1-M2 — seedable per-user run history. Tests push runs keyed by
   * the member's userId AFTER boot (the id is minted inside boot()), then hit
   * `/api/me/runs` / `/api/me/workflows` to verify scoping + catalog status.
   */
  readonly runsByUser: Record<string, WorkflowRunSummary[]> = {}
  constructor(private readonly summaries: WorkflowSummary[]) {}
  async list(): Promise<WorkflowSummary[]> {
    return this.summaries
  }
  async listAll(): Promise<WorkflowSummary[]> {
    return this.summaries
  }
  async importFromText(): Promise<WorkflowSummary> {
    throw new Error('stub: importFromText not supported')
  }
  async remove(): Promise<void> {
    throw new Error('stub: remove not supported')
  }
  async listRuns(): Promise<[]> {
    return []
  }
  async listRunsByUser(
    userId: string,
    opts?: { workflowId?: string; limit?: number },
  ): Promise<WorkflowRunSummary[]> {
    let rows = (this.runsByUser[userId] ?? []).slice().sort((a, b) => b.startedAt - a.startedAt)
    if (opts?.workflowId) rows = rows.filter((r) => r.workflowId === opts.workflowId)
    if (opts?.limit !== undefined) rows = rows.slice(0, opts.limit)
    return rows
  }
  async readRun(): Promise<null> {
    return null
  }
  // Phase 15 lifecycle methods — unused by /me (it only reads list()).
  async saveDraft(): Promise<WorkflowSummary> { throw new Error('stub: saveDraft') }
  async publish(): Promise<WorkflowSummary> { throw new Error('stub: publish') }
  async submitReview(): Promise<WorkflowSummary> { throw new Error('stub: submitReview') }
  async backToDraft(): Promise<WorkflowSummary> { throw new Error('stub: backToDraft') }
  async deprecate(): Promise<WorkflowSummary> { throw new Error('stub: deprecate') }
  async archive(): Promise<WorkflowSummary> { throw new Error('stub: archive') }
  async rollback(): Promise<WorkflowSummary> { throw new Error('stub: rollback') }
  async listRevisions(): Promise<[]> { return [] }
  async getState(): Promise<never> { throw new Error('stub: getState') }
}

/**
 * In-memory upload backing (Phase 19 P1-M4). Mirrors the host UploadSurface:
 * `put` writes the artifact under the optional `scope` prefix; `get` reads it
 * back or throws an ENOENT-shaped error the route maps to 404.
 */
class StubUploads {
  readonly store = new Map<string, { bytes: Uint8Array; mime: string }>()
  private seq = 0
  async put(params: { bytes: Uint8Array; declaredMime: string; filename?: string; by: string; scope?: string }) {
    const scopePart = params.scope ? `${params.scope}/` : ''
    const artifactId = `uploads/${scopePart}2026-06-01/${this.seq++}`
    this.store.set(artifactId, { bytes: params.bytes, mime: params.declaredMime })
    return { artifactId, mime: params.declaredMime, size: params.bytes.byteLength }
  }
  async get(artifactId: string): Promise<{ bytes: Uint8Array; mime: string }> {
    // Mirror the host artifact store, which `normalize`s the path (folding
    // `../`) before lookup. A traversal id must be refused by the ROUTE before
    // it reaches here — an exact-match Map would otherwise mask the IDOR by
    // missing on the un-normalised key.
    const hit = this.store.get(posixPath.normalize(artifactId))
    if (!hit) throw new Error('ENOENT: no such file')
    return hit
  }
}

/** Build a WorkflowSummary with sensible defaults; override what a test needs. */
function meWf(over: Partial<WorkflowSummary> & { id: string }): WorkflowSummary {
  return {
    participantId: `workflow:${over.id}`,
    triggerCapability: `cap-${over.id}`,
    stepCount: 1,
    file: null,
    ...over,
  }
}

async function boot(
  opts: {
    withGrowthReports?: boolean
    adminLoginRateLimit?: { max: number; windowSec: number }
    /** Phase 14 — member-facing workflow catalog source. */
    workflows?: WorkflowSummary[]
    /** Phase 19 P1-M3 — sanitized agent directory for /api/me/agents. */
    meAgents?: Array<{ id: string; label: string; capabilities: string[]; online: boolean; description?: string }>
    /** Phase 19 P1-M4 — wire an in-memory upload backing for /api/me/uploads. */
    withUploads?: boolean
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
  const workflowSurface = opts.workflows ? new StubWorkflowSurface(opts.workflows) : undefined
  const uploads = opts.withUploads ? new StubUploads() : undefined

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(withGrowthReports ? { growthReports } : {}),
    ...(workflowSurface ? { workflows: workflowSurface } : {}),
    ...(opts.meAgents ? { meAgents: { listForMembers: async () => opts.meAgents! } } : {}),
    ...(uploads ? { uploads } : {}),
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
    workflowSurface,
    uploads,
  }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('/me — page (C1c — legacy URL, now 301 redirect)', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('GET /me → 301 redirect to / (unified SPA)', async () => {
    const r = await fetch(`${b.baseUrl}/me`, { redirect: 'manual' })
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe('/')
  })

  it('GET /me/ (trailing slash) → 301 redirect to /', async () => {
    const r = await fetch(`${b.baseUrl}/me/`, { redirect: 'manual' })
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe('/')
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

describe('/api/me/workflows — member-facing catalog (Phase 14)', () => {
  // A spread of summaries exercising every catalog gate: enabled +
  // default role (visible), disabled (hidden), role-restricted (hidden
  // from member), no surface.me at all (hidden), and an enabled one
  // whose input fields fall back to trigger.payloadSchema.
  const WORKFLOWS: WorkflowSummary[] = [
    meWf({
      id: 'open-flow',
      name: 'Open Flow',
      triggerCapability: 'cap-open',
      surfaceMe: {
        enabled: true,
        label: '开放流程',
        description: 'anyone signed in',
        inputSchema: [
          { id: 'topic', type: 'text', label: '主题' },
          { id: 'notes', type: 'textarea' },
        ],
        userScopeField: 'case_id',
      },
    }),
    meWf({
      id: 'disabled-flow',
      surfaceMe: { enabled: false, label: 'should never show' },
    }),
    meWf({
      id: 'admin-only',
      surfaceMe: { enabled: true, allowedRoles: ['owner', 'admin'] },
    }),
    meWf({ id: 'no-surface' }), // no surfaceMe block at all
    meWf({
      id: 'fallback-flow',
      name: 'Fallback Flow',
      surfaceMe: { enabled: true }, // no inputSchema → use payloadSchema
      payloadSchema: [{ id: 'q', type: 'text' }],
    }),
  ]

  let b: BootResult
  beforeEach(async () => { b = await boot({ workflows: WORKFLOWS }) })
  afterEach(async () => { await teardown(b) })

  it('lists only enabled, role-allowed workflows (member sees open + fallback)', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/workflows`, {
      headers: { cookie: b.memberCookie },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      workflows: Array<{ id: string; label: string; description?: string; inputSchema: unknown[] }>
    }
    const ids = body.workflows.map((w) => w.id).sort()
    // disabled / admin-only / no-surface are all filtered out.
    expect(ids).toEqual(['fallback-flow', 'open-flow'])
  })

  it('exposes only public fields — never capability or userScopeField', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/workflows`, {
      headers: { cookie: b.memberCookie },
    })
    const body = (await r.json()) as { workflows: Array<Record<string, unknown>> }
    const open = body.workflows.find((w) => w.id === 'open-flow')!
    expect(open.label).toBe('开放流程')
    expect(open.description).toBe('anyone signed in')
    expect(open.inputSchema).toEqual([
      { id: 'topic', type: 'text', label: '主题' },
      { id: 'notes', type: 'textarea' },
    ])
    // Internal enforcement details must NOT leak to the client — exposing
    // them would hand a member the dispatch internals to probe.
    expect(open.capability).toBeUndefined()
    expect(open.userScopeField).toBeUndefined()
    expect(open.triggerCapability).toBeUndefined()
  })

  it('falls back to trigger.payloadSchema when surface.me omits inputSchema', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/workflows`, {
      headers: { cookie: b.memberCookie },
    })
    const body = (await r.json()) as {
      workflows: Array<{ id: string; label: string; inputSchema: unknown[] }>
    }
    const fb = body.workflows.find((w) => w.id === 'fallback-flow')!
    expect(fb.label).toBe('Fallback Flow') // me.label absent → workflow.name
    expect(fb.inputSchema).toEqual([{ id: 'q', type: 'text' }])
  })

  it('returns an empty catalog when the host wired no workflow surface', async () => {
    const b2 = await boot() // no workflows option → ctx.workflows undefined
    try {
      const r = await fetch(`${b2.baseUrl}/api/me/workflows`, {
        headers: { cookie: b2.memberCookie },
      })
      expect(r.status).toBe(200)
      const body = (await r.json()) as { workflows: unknown[] }
      expect(body.workflows).toEqual([])
    } finally {
      await teardown(b2)
    }
  })

  it('requires a v4 session (anonymous → 401)', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/workflows`)
    expect(r.status).toBe(401)
  })
})

describe('/api/me/runs — member run history (Phase 19 P1-M2)', () => {
  const WORKFLOWS: WorkflowSummary[] = [
    meWf({ id: 'open-flow', name: 'Open Flow', triggerCapability: 'cap-open', surfaceMe: { enabled: true, label: '开放流程', inputSchema: [{ id: 'topic', type: 'text' }] } }),
  ]
  const run = (over: Partial<WorkflowRunSummary> & { runId: string; workflowId: string; startedAt: number }): WorkflowRunSummary => ({
    triggeredByTaskId: `t-${over.runId}`,
    status: 'done',
    stepCount: 1,
    ...over,
  })

  let b: BootResult
  beforeEach(async () => { b = await boot({ workflows: WORKFLOWS }) })
  afterEach(async () => { await teardown(b) })

  it('returns only the caller\'s own runs, newest first', async () => {
    b.workflowSurface!.runsByUser[b.memberUserId] = [
      run({ runId: 'r1', workflowId: 'open-flow', startedAt: 100, status: 'done' }),
      run({ runId: 'r2', workflowId: 'open-flow', startedAt: 300, status: 'running' }),
    ]
    // Another user's run must never leak into the member's view.
    b.workflowSurface!.runsByUser[b.ownerUserId] = [
      run({ runId: 'r-owner', workflowId: 'open-flow', startedAt: 999 }),
    ]
    const r = await fetch(`${b.baseUrl}/api/me/runs`, { headers: { cookie: b.memberCookie } })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { runs: Array<{ runId: string; status: string; triggeredByTaskId?: string }> }
    expect(body.runs.map((x) => x.runId)).toEqual(['r2', 'r1'])
    // Public projection only — internal correlation id is dropped.
    expect('triggeredByTaskId' in body.runs[0]!).toBe(false)
  })

  it('enriches the catalog with the caller\'s latestStatus + lastRunAt', async () => {
    b.workflowSurface!.runsByUser[b.memberUserId] = [
      run({ runId: 'r1', workflowId: 'open-flow', startedAt: 100, status: 'done' }),
      run({ runId: 'r2', workflowId: 'open-flow', startedAt: 300, status: 'failed', error: 'boom' }),
    ]
    const r = await fetch(`${b.baseUrl}/api/me/workflows`, { headers: { cookie: b.memberCookie } })
    const body = (await r.json()) as { workflows: Array<{ id: string; latestStatus?: string; lastRunAt?: number }> }
    const open = body.workflows.find((w) => w.id === 'open-flow')!
    expect(open.latestStatus).toBe('failed') // newest (startedAt 300) wins
    expect(open.lastRunAt).toBe(300)
  })

  it('omits run status when the caller has no runs', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/workflows`, { headers: { cookie: b.memberCookie } })
    const body = (await r.json()) as { workflows: Array<{ id: string; latestStatus?: string }> }
    expect(body.workflows.find((w) => w.id === 'open-flow')!.latestStatus).toBeUndefined()
  })

  it('empty list + anonymous 401', async () => {
    const empty = await fetch(`${b.baseUrl}/api/me/runs`, { headers: { cookie: b.memberCookie } })
    expect((await empty.json() as { runs: unknown[] }).runs).toEqual([])
    const anon = await fetch(`${b.baseUrl}/api/me/runs`)
    expect(anon.status).toBe(401)
  })

  it('returns an empty list when the host wired no workflow surface', async () => {
    const b2 = await boot() // no workflows → ctx.runs undefined
    try {
      const r = await fetch(`${b2.baseUrl}/api/me/runs`, { headers: { cookie: b2.memberCookie } })
      expect(r.status).toBe(200)
      expect((await r.json() as { runs: unknown[] }).runs).toEqual([])
    } finally {
      await teardown(b2)
    }
  })
})

describe('/api/me/agents — sanitized agent directory (Phase 19 P1-M3)', () => {
  const AGENTS = [
    { id: 'writer-zh', label: '中文写作助手', capabilities: ['write-zh', 'summarize'], online: true },
    { id: 'tester', label: 'tester', capabilities: ['run-tests'], online: false },
  ]

  let b: BootResult
  beforeEach(async () => { b = await boot({ meAgents: AGENTS }) })
  afterEach(async () => { await teardown(b) })

  it('lists the sanitized agents for a member (label + capabilities + online)', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/agents`, { headers: { cookie: b.memberCookie } })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { agents: Array<Record<string, unknown>> }
    expect(body.agents.map((a) => a.id)).toEqual(['writer-zh', 'tester'])
    const w = body.agents[0]!
    expect(w.label).toBe('中文写作助手')
    expect(w.capabilities).toEqual(['write-zh', 'summarize'])
    expect(w.online).toBe(true)
    // Critical: no sensitive fields ever leak to a member.
    for (const key of ['managed', 'system', 'systemPrompt', 'apiKey', 'apiKeyHash', 'baseURL', 'model']) {
      expect(key in w).toBe(false)
    }
  })

  it('requires a v4 session (anonymous → 401)', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/agents`)
    expect(r.status).toBe(401)
  })

  it('returns an empty list when the host wired no agent surface', async () => {
    const b2 = await boot() // no meAgents → ctx.meAgents undefined
    try {
      const r = await fetch(`${b2.baseUrl}/api/me/agents`, { headers: { cookie: b2.memberCookie } })
      expect(r.status).toBe(200)
      expect((await r.json() as { agents: unknown[] }).agents).toEqual([])
    } finally {
      await teardown(b2)
    }
  })
})

describe('/api/me/uploads — member file uploads (Phase 19 P1-M4)', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot({ withUploads: true }) })
  afterEach(async () => { await teardown(b) })

  async function upload(body: string, headers: Record<string, string> = {}) {
    return fetch(`${b.baseUrl}/api/me/uploads?filename=note.txt`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'text/plain', ...headers },
      body,
    })
  }

  it('uploads under the caller\'s own scope and rounds-trips the download', async () => {
    const r = await upload('hello member')
    expect(r.status).toBe(200)
    const put = (await r.json()) as { artifactId: string; mime: string; size: number }
    // Scoped under the member's userId — not the flat admin namespace.
    expect(put.artifactId.startsWith(`uploads/me/${b.memberUserId}/`)).toBe(true)
    expect(put.size).toBe('hello member'.length)

    const dl = await fetch(`${b.baseUrl}/api/me/uploads?id=${encodeURIComponent(put.artifactId)}`, {
      headers: { cookie: b.memberCookie },
    })
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe('hello member')
  })

  it('refuses to download another user\'s artifact (isolation → 404)', async () => {
    // Seed an artifact under a DIFFERENT user's scope directly in the store.
    b.uploads!.store.set('uploads/me/someone-else/2026-06-01/0', {
      bytes: new TextEncoder().encode('secret'),
      mime: 'text/plain',
    })
    const dl = await fetch(`${b.baseUrl}/api/me/uploads?id=${encodeURIComponent('uploads/me/someone-else/2026-06-01/0')}`, {
      headers: { cookie: b.memberCookie },
    })
    expect(dl.status).toBe(404)
    // And the bytes never went out.
    expect(await dl.text()).not.toContain('secret')
  })

  it('refuses a `..` traversal id that startsWith() own scope but normalises into a sibling scope (IDOR)', async () => {
    // Victim file under a SIBLING member's (already-normalised) scope.
    b.uploads!.store.set('uploads/me/victim-user/2026-06-01/0', {
      bytes: new TextEncoder().encode('victim-secret'),
      mime: 'text/plain',
    })
    // Attacker id: startsWith(`uploads/me/<me>/`) is TRUE, yet the host store
    // folds `../` and would resolve into victim-user's scope. The route must
    // reject the `..` up front (before the prefix check + before get()).
    const evil = `uploads/me/${b.memberUserId}/../victim-user/2026-06-01/0`
    const dl = await fetch(`${b.baseUrl}/api/me/uploads?id=${encodeURIComponent(evil)}`, {
      headers: { cookie: b.memberCookie },
    })
    expect(dl.status).toBe(404)
    expect(await dl.text()).not.toContain('victim-secret')
  })

  it('rejects an empty body with 400', async () => {
    const r = await upload('')
    expect(r.status).toBe(400)
  })

  it('requires a v4 session (anonymous → 401)', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/uploads`, { method: 'POST', body: 'x' })
    expect(r.status).toBe(401)
  })

  it('503 when the host wired no upload backing', async () => {
    const b2 = await boot() // no withUploads → ctx.uploads undefined
    try {
      const r = await fetch(`${b2.baseUrl}/api/me/uploads`, {
        method: 'POST', headers: { cookie: b2.memberCookie }, body: 'x',
      })
      expect(r.status).toBe(503)
    } finally {
      await teardown(b2)
    }
  })
})

describe('/api/me — Phase 15 published-only gate', () => {
  // All target the `plan-personal-growth` capability boot() registers a stub
  // participant for, so a published one can actually dispatch. Every one
  // declares surface.me.enabled — only `state` differs, isolating the gate.
  const me = (id: string, state?: string): WorkflowSummary =>
    meWf({
      id,
      triggerCapability: 'plan-personal-growth',
      ...(state !== undefined ? { state } : {}),
      surfaceMe: { enabled: true, label: id, inputSchema: [{ id: 'topic', type: 'text' }] },
    })
  const STATEFUL: WorkflowSummary[] = [
    me('pub', 'published'),
    me('draft', 'draft'),
    me('review', 'review'),
    me('dep', 'deprecated'),
    me('arc', 'archived'),
    me('legacy'), // no state → legacy compat (allowed)
  ]

  let b: BootResult
  beforeEach(async () => { b = await boot({ workflows: STATEFUL }) })
  afterEach(async () => { await teardown(b) })

  it('catalog lists only published (+ legacy no-state)', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/workflows`, { headers: { cookie: b.memberCookie } })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { workflows: Array<{ id: string }> }
    expect(body.workflows.map((w) => w.id).sort()).toEqual(['legacy', 'pub'])
  })

  const dispatch = (b: BootResult, workflowId: string): Promise<Response> =>
    fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId, payload: { topic: 'x' } }),
    })

  it('dispatch to draft / review / deprecated / archived is denied (403)', async () => {
    for (const id of ['draft', 'review', 'dep', 'arc']) {
      const r = await dispatch(b, id)
      expect(r.status, `dispatch to ${id} should be 403`).toBe(403)
    }
  })

  it('dispatch to a published workflow passes the gate (200)', async () => {
    const r = await dispatch(b, 'pub')
    expect(r.status).toBe(200)
  })
})

// Member-facing workflows for the dispatch tests. All target the
// `plan-personal-growth` capability that boot() registers a stub
// participant for, so dispatched tasks land in the hub transcript where
// the spoof tests can inspect the forced scope key.
const DISPATCH_WORKFLOWS: WorkflowSummary[] = [
  meWf({
    id: 'growth',
    name: 'Growth',
    triggerCapability: 'plan-personal-growth',
    surfaceMe: {
      enabled: true,
      label: 'Growth',
      inputSchema: [
        { id: 'present_state', type: 'textarea' },
        { id: 'aspirations', type: 'textarea' },
      ],
      // userScopeField omitted → defaults to case_id
    },
  }),
  meWf({
    id: 'owner-scoped',
    name: 'Owner Scoped',
    triggerCapability: 'plan-personal-growth',
    surfaceMe: {
      enabled: true,
      label: 'Owner Scoped',
      inputSchema: [{ id: 'topic', type: 'text' }],
      userScopeField: 'owner_user_id', // alternate scope key
    },
  }),
  meWf({
    id: 'disabled',
    triggerCapability: 'plan-personal-growth',
    surfaceMe: { enabled: false },
  }),
  meWf({
    id: 'admins-only',
    triggerCapability: 'plan-personal-growth',
    surfaceMe: { enabled: true, allowedRoles: ['owner', 'admin'] },
  }),
  // A real workflow that simply never opted into /me — must be unrunnable.
  meWf({ id: 'no-surface', triggerCapability: 'plan-personal-growth' }),
]

describe('/api/me/dispatch — security contract', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot({ workflows: DISPATCH_WORKFLOWS }) })
  afterEach(async () => { await teardown(b) })

  it('dispatches a member-facing workflow; scope key forced to caller userId', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.memberCookie },
      body: JSON.stringify({
        workflowId: 'growth',
        payload: { present_state: 'a bit stuck', aspirations: 'next 12 weeks' },
      }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { ok: boolean; workflowId: string }
    expect(body.ok).toBe(true)
    expect(body.workflowId).toBe('growth')

    // The forced scope key (default case_id) lands on the dispatched task.
    const tasks = b.hub.tasks()
    const payload = tasks[tasks.length - 1]!.task.payload as Record<string, unknown>
    expect(payload.case_id).toBe(b.memberUserId) // <-- the security guarantee
    expect(payload.present_state).toBe('a bit stuck')
  })

  it('refuses a workflow that is not member-facing — disabled (403)', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.memberCookie },
      body: JSON.stringify({ workflowId: 'disabled', payload: {} }),
    })
    expect(r.status).toBe(403)
    const body = (await r.json()) as { code?: string }
    expect(body.code).toBe('workflow_not_allowed')
  })

  it('refuses a workflow with no surface.me declaration at all (403)', async () => {
    // The most important new invariant: opening to /me is opt-IN. A
    // workflow that never declared surface.me is unrunnable here, even
    // though it is otherwise a perfectly real, importable workflow.
    const r = await fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.memberCookie },
      body: JSON.stringify({ workflowId: 'no-surface', payload: {} }),
    })
    expect(r.status).toBe(403)
  })

  it('refuses a workflow whose allowedRoles exclude the caller (403)', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.memberCookie },
      body: JSON.stringify({ workflowId: 'admins-only', payload: {} }),
    })
    expect(r.status).toBe(403)
    const body = (await r.json()) as { code?: string }
    expect(body.code).toBe('workflow_not_allowed')
  })

  it('refuses an unknown workflowId (403)', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.memberCookie },
      body: JSON.stringify({ workflowId: 'does-not-exist', payload: {} }),
    })
    expect(r.status).toBe(403)
  })

  it('strips a spoofed case_id and undeclared fields (member cannot spoof)', async () => {
    const spoofed = 'someone-elses-case'
    const r = await fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.memberCookie },
      body: JSON.stringify({
        workflowId: 'growth',
        payload: {
          present_state: 'x',
          case_id: spoofed, // forced to userId regardless
          arbitrary_extra: 'should-not-survive', // not declared → dropped
        },
      }),
    })
    expect(r.status).toBe(200)

    // TaskView wraps the Task in `.task` — the payload lives there.
    const tasks = b.hub.tasks()
    const payload = tasks[tasks.length - 1]!.task.payload as Record<string, unknown>
    expect(payload.case_id).toBe(b.memberUserId)
    expect(payload.case_id).not.toBe(spoofed)
    expect(payload.arbitrary_extra).toBeUndefined()
    expect(payload.present_state).toBe('x')
  })

  it('forces an alternate scope key (owner_user_id) and ignores spoofing', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.memberCookie },
      body: JSON.stringify({
        workflowId: 'owner-scoped',
        payload: { topic: 'roadmap', owner_user_id: 'someone-else' },
      }),
    })
    expect(r.status).toBe(200)

    const tasks = b.hub.tasks()
    const payload = tasks[tasks.length - 1]!.task.payload as Record<string, unknown>
    expect(payload.owner_user_id).toBe(b.memberUserId) // forced on the declared key
    expect(payload.topic).toBe('roadmap')
    // The default case_id key is NOT set for a workflow using another scope key.
    expect(payload.case_id).toBeUndefined()
  })

  it('400 when workflowId is missing', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.memberCookie },
      body: JSON.stringify({ payload: {} }),
    })
    expect(r.status).toBe(400)
  })
})

describe('/api/me/dispatch — fail-closed when no workflow surface', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() }) // no workflows wired
  afterEach(async () => { await teardown(b) })

  it('refuses every dispatch (403) when the host wired no workflow surface', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.memberCookie },
      body: JSON.stringify({ workflowId: 'growth', payload: {} }),
    })
    expect(r.status).toBe(403)
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
    b = await boot({
      adminLoginRateLimit: { max: 2, windowSec: 60 },
      workflows: DISPATCH_WORKFLOWS,
    })
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
          workflowId: 'growth',
          payload: { present_state: 'p', aspirations: 'a' },
        }),
      })
    expect((await dispatch()).status).toBe(200)
    expect((await dispatch()).status).toBe(200)
    // Route B P1-M2 — the two allowed dispatches must NOT have written a
    // rate_limited row (only a reject does).
    expect(
      b.identity.listAuditLog!({ action: AUDIT_ACTIONS.RATE_LIMITED }).length,
    ).toBe(0)
    const r3 = await dispatch()
    expect(r3.status).toBe(429)
    expect(r3.headers.get('retry-after')).toBe('60')
    // P1-M2 — the reject is now typed + observable, not a bare text 429.
    expect((await r3.json()).code).toBe('rate_limited')
    const denied = b.identity.listAuditLog!({ action: AUDIT_ACTIONS.RATE_LIMITED })
    expect(denied.length).toBeGreaterThanOrEqual(1)
    expect(denied[0]).toMatchObject({
      actorUserId: b.memberUserId,
      success: false,
      metadata: { action: 'me-dispatch', scope: 'me' },
    })
  })
})

describe('/api/me/growth-reports — rate limit (AUDIT-P3-02)', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot({
      adminLoginRateLimit: { max: 2, windowSec: 60 },
      workflows: DISPATCH_WORKFLOWS,
    })
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
    // Route B P1-M2b — the two allowed reads must NOT have written a
    // rate_limited row (only a reject does).
    expect(
      b.identity.listAuditLog!({ action: AUDIT_ACTIONS.RATE_LIMITED }).length,
    ).toBe(0)
    const r3 = await list()
    expect(r3.status).toBe(429)
    expect(r3.headers.get('retry-after')).toBe('60')
    // P1-M2b — growth-reports routes through the SAME shared helper as
    // dispatch, so its reject is typed + observable too (not a bare text 429),
    // and the audit row carries this site's own action key.
    expect((await r3.json()).code).toBe('rate_limited')
    const denied = b.identity.listAuditLog!({ action: AUDIT_ACTIONS.RATE_LIMITED })
    expect(denied.length).toBeGreaterThanOrEqual(1)
    expect(denied[0]).toMatchObject({
      actorUserId: b.memberUserId,
      success: false,
      metadata: { action: 'me-reports', scope: 'me' },
    })
  })

  it('dispatch budget and reports budget are independent buckets', async () => {
    // Exhaust dispatch budget (2 hits).
    const dispatch = () =>
      fetch(`${b.baseUrl}/api/me/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: b.memberCookie },
        body: JSON.stringify({
          workflowId: 'growth',
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
