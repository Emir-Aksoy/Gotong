/**
 * HTTP tests for the EXCH-M1 member exchange-envelope routes:
 *
 *   GET  /api/me/exchange                → { available }   (SPA probe)
 *   POST /api/me/exchange/preview        → view + eligible targets (ZERO side-effect)
 *   POST /api/me/exchange/import         → { ok, id } | 403/409/400
 *   GET  /api/me/exchange/:id/result     → status view | ?download=1 raw bytes
 *
 * What the web layer must guarantee (the service is stubbed — its own behaviour
 * is covered by packages/host/tests/me-exchange-service.test.ts):
 *   - userId comes from the SESSION only; body/query cannot act as someone else
 *   - the import target resolves through the SAME evaluateMeSurface gate
 *     /api/me/dispatch uses (unknown / role-excluded / draft → 403, and the gate
 *     facts handed to the service come from the RESOLVED workflow, not the body)
 *   - preview targets carry ONLY { workflowId, label } (catalog discipline) and
 *     are narrowed to the envelope's capability when it names one
 *   - ExchangeError ducks map by code (replay→409 with status, others→400 with
 *     errors passthrough); unknown errors rethrow (500), never swallowed
 *   - no surface wired → probe { available:false }, POSTs/result 503 not_wired
 *   - shared me rate limiter guards both POST faces (429)
 *   - download=1 streams the EXACT archived envelope bytes as an attachment
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'

import { serveWeb, type WebServerHandle, type WorkflowSummary, type WorkflowSurface } from '../src/server.js'
import type { MeExchangeSurface } from '../src/exchange-routes.js'

/** The route detects the service's typed error by NAME (duck, no host import). */
class FakeExchangeError extends Error {
  override readonly name = 'ExchangeError'
  constructor(
    readonly code: 'invalid' | 'replay' | 'capability_mismatch' | 'not_dispatchable',
    message: string,
    readonly errors?: string[],
    readonly replayStatus?: string,
  ) {
    super(message)
  }
}

type PreviewView = Awaited<ReturnType<MeExchangeSurface['preview']>>
type ResultView = Awaited<ReturnType<MeExchangeSurface['result']>>

const VALID_PREVIEW: PreviewView = {
  valid: true,
  summary: { id: 'exg-aaaabbbbccccdddd0001', kind: 'request', title: '请分析一下', capability: 'market.analysis' },
  signature: { state: 'unsigned' },
  dispatchable: true,
}

/** Records the SERVER-pinned userId + exactly what the route forwarded. */
class StubExchange implements MeExchangeSurface {
  readonly previews: Array<{ userId: string; raw: string }> = []
  readonly imports: Array<{ userId: string; args: Record<string, unknown> }> = []
  readonly resultAsks: Array<{ userId: string; id: string }> = []
  previewView: PreviewView = VALID_PREVIEW
  importError: Error | undefined
  resultView: ResultView = { status: 'not_found' }

  async preview(userId: string, raw: string) {
    this.previews.push({ userId, raw })
    return this.previewView
  }

  async importRequest(userId: string, args: Record<string, unknown> & { raw: string }) {
    this.imports.push({ userId, args })
    if (this.importError) throw this.importError
    return { id: 'exg-aaaabbbbccccdddd0001' }
  }

  async result(userId: string, id: string) {
    this.resultAsks.push({ userId, id })
    return this.resultView
  }
}

/** Minimal live-catalog stub — the exchange gate only ever calls list(). */
class StubWorkflows implements WorkflowSurface {
  constructor(private readonly summaries: WorkflowSummary[]) {}
  async list(): Promise<WorkflowSummary[]> { return this.summaries }
  async listAll(): Promise<WorkflowSummary[]> { return this.summaries }
  async importFromText(): Promise<WorkflowSummary> { throw new Error('stub') }
  async remove(): Promise<void> { throw new Error('stub') }
  async listRuns(): Promise<[]> { return [] }
  async listRunsByUser(): Promise<[]> { return [] }
  async readRun(): Promise<null> { return null }
  async saveDraft(): Promise<WorkflowSummary> { throw new Error('stub') }
  async publish(): Promise<WorkflowSummary> { throw new Error('stub') }
  async submitReview(): Promise<WorkflowSummary> { throw new Error('stub') }
  async backToDraft(): Promise<WorkflowSummary> { throw new Error('stub') }
  async deprecate(): Promise<WorkflowSummary> { throw new Error('stub') }
  async archive(): Promise<WorkflowSummary> { throw new Error('stub') }
  async rollback(): Promise<WorkflowSummary> { throw new Error('stub') }
  async listRevisions(): Promise<[]> { return [] }
  async getState(): Promise<never> { throw new Error('stub') }
}

function wf(over: Partial<WorkflowSummary> & { id: string }): WorkflowSummary {
  return {
    participantId: `workflow:${over.id}`,
    triggerCapability: `cap-${over.id}`,
    stepCount: 1,
    file: null,
    state: 'published',
    ...over,
  }
}

/**
 * The catalog the gate is exercised against:
 *  - wf-analysis: member-runnable, capability matches the stub envelope; its
 *    inputSchema INCLUDES the scope field (the gate must drop it from copy ids)
 *  - wf-garden:   member-runnable, different capability
 *  - wf-admins:   role-gated to owner/admin (a member must get 403 / no target)
 *  - wf-draft:    declares surface.me but is NOT published (never member-facing)
 */
const CATALOG: WorkflowSummary[] = [
  wf({
    id: 'wf-analysis',
    triggerCapability: 'market.analysis',
    surfaceMe: {
      enabled: true,
      label: '行情分析',
      inputSchema: [{ id: 'question' }, { id: 'notes' }, { id: 'requester_id' }],
      userScopeField: 'requester_id',
    },
  }),
  wf({
    id: 'wf-garden',
    triggerCapability: 'garden.watering',
    surfaceMe: { enabled: true, label: '浇水', inputSchema: [{ id: 'plot' }] },
  }),
  wf({
    id: 'wf-admins',
    triggerCapability: 'market.analysis',
    surfaceMe: { enabled: true, label: '管理员专用', allowedRoles: ['owner', 'admin'] },
  }),
  wf({
    id: 'wf-draft',
    state: 'draft',
    triggerCapability: 'market.analysis',
    surfaceMe: { enabled: true, label: '草稿流' },
  }),
]

interface Boot {
  tmp: string
  server: WebServerHandle
  identity: IdentityStore
  memberCookie: string
  memberUserId: string
  stub: StubExchange | undefined
}

async function boot(
  opts: { withSurface?: boolean; rateMax?: number } = {},
): Promise<Boot> {
  const withSurface = opts.withSurface ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-me-exchange-'))
  const init = await Space.init(tmp, { name: 'me-exchange-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { token: adminToken } = await space.createAdmin('TestAdmin')
  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
  identity.bootstrap({ adminToken, ownerEmail: 'admin@local', ownerDisplayName: 'TestAdmin' })
  const member = identity.createUser({
    email: 'member@team.test',
    displayName: 'Member',
    password: 'member-strong-password',
    role: 'member',
  })

  const stub = withSurface ? new StubExchange() : undefined
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    workflows: new StubWorkflows(CATALOG),
    ...(stub ? { meExchange: stub } : {}),
    // The shared me limiter is per action:userId bucket, so the login POST
    // (separate bucket) is unaffected by a small max here.
    ...(opts.rateMax !== undefined ? { adminLoginRateLimit: { max: opts.rateMax, windowSec: 60 } } : {}),
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

describe('/api/me/exchange — envelope import/export (EXCH-M1)', () => {
  let b: Boot

  afterEach(async () => {
    await b.server.close()
    b.identity.close()
    await rm(b.tmp, { recursive: true, force: true })
  })

  async function req(
    method: string,
    path: string,
    opts: { auth?: boolean; body?: unknown } = {},
  ): Promise<{ status: number; json: any; res: Response }> {
    const res = await fetch(`${b.server.url}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...((opts.auth ?? true) ? { cookie: b.memberCookie } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })
    const json = await res.clone().json().catch(() => ({}))
    return { status: res.status, json, res }
  }

  it('unauthenticated → 401 on every face', async () => {
    b = await boot()
    expect((await req('GET', '/api/me/exchange', { auth: false })).status).toBe(401)
    expect((await req('POST', '/api/me/exchange/preview', { auth: false, body: { raw: '{}' } })).status).toBe(401)
    expect((await req('POST', '/api/me/exchange/import', { auth: false, body: { raw: '{}', workflowId: 'wf-analysis' } })).status).toBe(401)
    expect((await req('GET', '/api/me/exchange/exg-x/result', { auth: false })).status).toBe(401)
    expect(b.stub!.previews).toHaveLength(0)
    expect(b.stub!.imports).toHaveLength(0)
  })

  it('no surface wired → probe {available:false}, POSTs and result 503 not_wired', async () => {
    b = await boot({ withSurface: false })
    const probe = await req('GET', '/api/me/exchange')
    expect(probe.status).toBe(200)
    expect(probe.json).toEqual({ available: false })
    for (const [method, path, body] of [
      ['POST', '/api/me/exchange/preview', { raw: '{}' }],
      ['POST', '/api/me/exchange/import', { raw: '{}', workflowId: 'wf-analysis' }],
      ['GET', '/api/me/exchange/exg-x/result', undefined],
    ] as const) {
      const r = await req(method, path, body !== undefined ? { body } : {})
      expect(r.status).toBe(503)
      expect(r.json.code).toBe('not_wired')
    }
  })

  it('probe answers {available:true} when wired', async () => {
    b = await boot()
    const r = await req('GET', '/api/me/exchange')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ available: true })
  })

  it('preview pins the SESSION userId (body/query cannot act as someone else) and narrows targets to the envelope capability', async () => {
    b = await boot()
    const r = await req('POST', '/api/me/exchange/preview?userId=someone-else', {
      body: { raw: '{"fake":"envelope"}', userId: 'someone-else' },
    })
    expect(r.status).toBe(200)
    expect(b.stub!.previews).toEqual([{ userId: b.memberUserId, raw: '{"fake":"envelope"}' }])
    expect(r.json.valid).toBe(true)
    // capability 'market.analysis': wf-analysis matches; wf-garden is another
    // capability; wf-admins is role-gated; wf-draft is unpublished.
    expect(r.json.targets).toEqual([{ workflowId: 'wf-analysis', label: '行情分析' }])
    // Catalog discipline — nothing beyond id + label goes out.
    expect(Object.keys(r.json.targets[0]).sort()).toEqual(['label', 'workflowId'])
  })

  it('preview without an envelope capability lists every member-runnable workflow', async () => {
    b = await boot()
    b.stub!.previewView = {
      ...VALID_PREVIEW,
      summary: { id: 'exg-aaaabbbbccccdddd0001', kind: 'request', title: '无能力字段' },
    }
    const r = await req('POST', '/api/me/exchange/preview', { body: { raw: '{}' } })
    expect(r.status).toBe(200)
    expect(r.json.targets).toEqual([
      { workflowId: 'wf-analysis', label: '行情分析' },
      { workflowId: 'wf-garden', label: '浇水' },
    ])
  })

  it('preview of an invalid envelope carries the errors and NO targets', async () => {
    b = await boot()
    b.stub!.previewView = { valid: false, errors: ['id: must match ^exg-'], dispatchable: false }
    const r = await req('POST', '/api/me/exchange/preview', { body: { raw: 'not json' } })
    expect(r.status).toBe(200)
    expect(r.json.valid).toBe(false)
    expect(r.json.errors).toEqual(['id: must match ^exg-'])
    expect(r.json.targets).toEqual([])
  })

  it('preview with missing/empty raw → 400 bad_request (also on undecodable body)', async () => {
    b = await boot()
    for (const body of [{}, { raw: '' }, { raw: 42 }]) {
      const r = await req('POST', '/api/me/exchange/preview', { body })
      expect(r.status).toBe(400)
      expect(r.json.code).toBe('bad_request')
    }
    expect(b.stub!.previews).toHaveLength(0)
  })

  it('import resolves the target through the /me dispatch gate and forwards the RESOLVED facts', async () => {
    b = await boot()
    const r = await req('POST', '/api/me/exchange/import', {
      body: { raw: '{"the":"envelope"}', workflowId: 'wf-analysis' },
    })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, id: 'exg-aaaabbbbccccdddd0001' })
    expect(b.stub!.imports).toHaveLength(1)
    const call = b.stub!.imports[0]!
    expect(call.userId).toBe(b.memberUserId)
    // Gate facts come from the resolved workflow — the scope field is dropped
    // from the copy ids even though the author listed it in inputSchema.
    expect(call.args).toEqual({
      raw: '{"the":"envelope"}',
      workflowId: 'wf-analysis',
      capability: 'market.analysis',
      inputFieldIds: ['question', 'notes'],
      userScopeField: 'requester_id',
      label: '行情分析',
    })
  })

  it('import of a role-gated / draft / unknown workflow → 403 workflow_not_allowed, service never called', async () => {
    b = await boot()
    for (const workflowId of ['wf-admins', 'wf-draft', 'no-such-flow']) {
      const r = await req('POST', '/api/me/exchange/import', { body: { raw: '{}', workflowId } })
      expect(r.status).toBe(403)
      expect(r.json.code).toBe('workflow_not_allowed')
    }
    expect(b.stub!.imports).toHaveLength(0)
  })

  it('import replay → 409 with the original import status', async () => {
    b = await boot()
    b.stub!.importError = new FakeExchangeError('replay', 'already imported', undefined, 'done')
    const r = await req('POST', '/api/me/exchange/import', {
      body: { raw: '{}', workflowId: 'wf-analysis' },
    })
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('replay')
    expect(r.json.status).toBe('done')
  })

  it('import validation failure → 400 with the collected errors', async () => {
    b = await boot()
    b.stub!.importError = new FakeExchangeError('invalid', 'envelope rejected', ['title: too long'])
    const r = await req('POST', '/api/me/exchange/import', {
      body: { raw: '{}', workflowId: 'wf-analysis' },
    })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('invalid')
    expect(r.json.errors).toEqual(['title: too long'])
  })

  it('import capability mismatch → 400 (the service names only the envelope capability)', async () => {
    b = await boot()
    b.stub!.importError = new FakeExchangeError(
      'capability_mismatch',
      "the envelope asks for capability 'market.analysis', which this workflow does not provide",
    )
    const r = await req('POST', '/api/me/exchange/import', {
      body: { raw: '{}', workflowId: 'wf-garden' },
    })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('capability_mismatch')
    expect(r.json.error).toContain('market.analysis')
  })

  it('import with missing raw/workflowId → 400 bad_request', async () => {
    b = await boot()
    for (const body of [{}, { raw: '{}' }, { workflowId: 'wf-analysis' }, { raw: '', workflowId: '' }]) {
      const r = await req('POST', '/api/me/exchange/import', { body })
      expect(r.status).toBe(400)
      expect(r.json.code).toBe('bad_request')
    }
    expect(b.stub!.imports).toHaveLength(0)
  })

  it('result: not_found → 404; running/suspended → JSON view; session userId pinned', async () => {
    b = await boot()
    const miss = await req('GET', '/api/me/exchange/exg-unknown/result')
    expect(miss.status).toBe(404)
    expect(miss.json.code).toBe('not_found')

    b.stub!.resultView = { status: 'running', importedAt: '2026-08-14T03:00:00Z' }
    const running = await req('GET', '/api/me/exchange/exg-aaaabbbbccccdddd0001/result?userId=other')
    expect(running.status).toBe(200)
    expect(running.json).toEqual({ status: 'running', importedAt: '2026-08-14T03:00:00Z' })

    b.stub!.resultView = { status: 'suspended', importedAt: '2026-08-14T03:00:00Z', note: 'waiting on a human step' }
    const susp = await req('GET', '/api/me/exchange/exg-aaaabbbbccccdddd0001/result')
    expect(susp.status).toBe(200)
    expect(susp.json.status).toBe('suspended')

    // Every ask carried the SESSION userId, never the query one.
    expect(b.stub!.resultAsks.every((a) => a.userId === b.memberUserId)).toBe(true)
  })

  it('result download=1 streams the EXACT archived bytes as an attachment', async () => {
    b = await boot()
    const envelope = '{"schema":"gotong.envelope/v1","id":"exg-resultbytes0000001"}\n'
    b.stub!.resultView = { status: 'done', resultId: 'exg-resultbytes0000001', envelope }
    const r = await req('GET', '/api/me/exchange/exg-aaaabbbbccccdddd0001/result?download=1')
    expect(r.status).toBe(200)
    expect(r.res.headers.get('content-disposition')).toBe('attachment; filename="exg-resultbytes0000001.json"')
    expect(r.res.headers.get('cache-control')).toBe('no-store')
    expect(await r.res.text()).toBe(envelope)

    // Without the flag the same state answers the JSON view.
    const view = await req('GET', '/api/me/exchange/exg-aaaabbbbccccdddd0001/result')
    expect(view.status).toBe(200)
    expect(view.json.status).toBe('done')
    expect(view.json.resultId).toBe('exg-resultbytes0000001')
  })

  it('both POST faces share the me rate limiter (429 when exhausted)', async () => {
    b = await boot({ rateMax: 2 })
    expect((await req('POST', '/api/me/exchange/preview', { body: { raw: '{}' } })).status).toBe(200)
    expect((await req('POST', '/api/me/exchange/import', { body: { raw: '{}', workflowId: 'wf-analysis' } })).status).toBe(200)
    const r = await req('POST', '/api/me/exchange/preview', { body: { raw: '{}' } })
    expect(r.status).toBe(429)
    expect(r.json.code).toBe('rate_limited')
    // The limiter fired BEFORE the body/service — one preview call, not two.
    expect(b.stub!.previews).toHaveLength(1)
  })
})
