/**
 * HTTP tests for the six-phase workflow wizard routes (WIZ-M4b) —
 * `/api/admin/workflows/wizard/{prepare,compose}` +
 * `/api/me/workflows/wizard/{prepare,compose,approve}`.
 *
 * Boots a real Space + Hub + IdentityStore + serveWeb with a FAKE
 * `WorkflowWizardSurface` (+ a fake `MeWorkflowCreateSurface` carrying
 * `createFromYaml` for approve) so we exercise the ROUTES — auth gates,
 * `by`/userId forcing, body coercion, ok:false-is-still-200 (wizard dialogue
 * states are not HTTP errors), approve's reason → status mapping, compose
 * rate limiting, degradation when unwired. The wizard pipeline itself
 * (catalog → assist → gap → repair) is covered by the host-side
 * workflow-wizard / wizard-wiring tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type { WizardComposeInput, WorkflowWizardSurface } from '../src/wizard-routes.js'
import type {
  MeWorkflowCreateSurface,
  MeWorkflowCreateResult,
  MeWorkflowExplainResult,
} from '../src/me-routes.js'

type ComposeResult = Awaited<ReturnType<WorkflowWizardSurface['compose']>>

/** Records every call so tests can assert `by`/userId forcing + coercion. */
class FakeWizard implements WorkflowWizardSurface {
  readonly prepareCalls: Array<{ task: string; by: string }> = []
  readonly composeCalls: WizardComposeInput[] = []

  prepareResult = {
    task: '给客户发周报',
    catalogText: '=== 本 hub 已有组件（现在就能用）===\n- 主笔手',
    questions: ['多久发一次?'],
    confirmText: '你要建的是: 给客户发周报',
    catalog: [] as unknown[],
  }
  composeResult: ComposeResult = {
    ok: true,
    yaml: 'schema: aipehub.workflow/v1\n',
    explanation: '先起草,再发送。',
    gapAnalysis: { ok: true, needs: [] },
    gapText: '✓ 全部满足',
    installTemplateRefs: [],
    repairRounds: 0,
  }

  async prepare(req: { task: string; by: string }) {
    this.prepareCalls.push(req)
    return this.prepareResult
  }
  async compose(req: WizardComposeInput): Promise<ComposeResult> {
    this.composeCalls.push(req)
    return this.composeResult
  }
}

/**
 * approve rides the SAME member surface as /create (`createFromYaml` is the
 * WIZ-M4a addition); create/explain throw so a route that strays off the
 * zero-LLM approve path fails the test loudly.
 */
class FakeCreate implements MeWorkflowCreateSurface {
  readonly fromYamlCalls: Array<{ yaml: string; userId: string }> = []
  fromYamlResult: MeWorkflowCreateResult = {
    ok: true,
    workflowId: 'wiz-flow',
    yaml: 'schema: aipehub.workflow/v1\n',
    explanation: '',
  }
  async create(): Promise<MeWorkflowCreateResult> {
    throw new Error('wizard approve must not call create()')
  }
  async explain(): Promise<MeWorkflowExplainResult> {
    throw new Error('wizard approve must not call explain()')
  }
  async createFromYaml(req: { yaml: string; userId: string }): Promise<MeWorkflowCreateResult> {
    this.fromYamlCalls.push(req)
    return this.fromYamlResult
  }
}

interface Boot {
  tmp: string
  hub: Hub
  identity: IdentityStore
  server: WebServerHandle
  adminId: string
  adminToken: string
  memberUserId: string
  memberCookie: string
  wizard: FakeWizard
  create: FakeCreate
}

async function boot(
  opts: {
    withWizard?: boolean
    withCreate?: boolean
    /** Wire workflowCreate WITHOUT createFromYaml (an old surface) — approve must 503. */
    createWithoutFromYaml?: boolean
    rateMax?: number
  } = {},
): Promise<Boot> {
  const withWizard = opts.withWizard ?? true
  const withCreate = opts.withCreate ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-wizard-'))
  const space = (await Space.init(tmp, { name: 'wizard-test' })).space
  const hub = new Hub({ space })
  await hub.start()

  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')
  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
  identity.bootstrap({ ownerEmail: 'admin@local', ownerDisplayName: 'TestAdmin' })
  const member = identity.createUser({
    email: 'member@team.test',
    displayName: 'Test Member',
    password: 'member-strong-password',
    role: 'member',
  })

  const wizard = new FakeWizard()
  const create = new FakeCreate()
  const createSurface: MeWorkflowCreateSurface | undefined = !withCreate
    ? undefined
    : opts.createWithoutFromYaml
      ? ({
          create: create.create.bind(create),
          explain: create.explain.bind(create),
        } as MeWorkflowCreateSurface)
      : create
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(withWizard ? { workflowWizard: wizard } : {}),
    ...(createSurface ? { workflowCreate: createSurface } : {}),
    ...(opts.rateMax ? { adminLoginRateLimit: { max: opts.rateMax, windowSec: 60 } } : {}),
  })

  const loginRes = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'member@team.test', password: 'member-strong-password' }),
  })
  if (loginRes.status !== 200) throw new Error(`member login failed: ${loginRes.status}`)
  const memberCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

  return {
    tmp,
    hub,
    identity,
    server,
    adminId: admin.id,
    adminToken,
    memberUserId: member.id,
    memberCookie,
    wizard,
    create,
  }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

const adminHeaders = (b: Boot) => ({
  authorization: `Bearer ${b.adminToken}`,
  'content-type': 'application/json',
})
const memberHeaders = (b: Boot) => ({
  cookie: b.memberCookie,
  'content-type': 'application/json',
})

// ---------------------------------------------------------------------------
// ADMIN — /api/admin/workflows/wizard/{prepare,compose}
// ---------------------------------------------------------------------------

describe('POST /api/admin/workflows/wizard/*', () => {
  let b: Boot
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(() => teardown(b))

  it('401 without admin auth (and never calls the surface)', async () => {
    const res = await fetch(`${b.server.url}/api/admin/workflows/wizard/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: '发周报' }),
    })
    expect(res.status).toBe(401)
    expect(b.wizard.prepareCalls).toHaveLength(0)
  })

  it('401 with only a member session (admin surface is admin-only)', async () => {
    const res = await fetch(`${b.server.url}/api/admin/workflows/wizard/prepare`, {
      method: 'POST',
      headers: memberHeaders(b),
      body: JSON.stringify({ task: '发周报' }),
    })
    expect(res.status).toBe(401)
    expect(b.wizard.prepareCalls).toHaveLength(0)
  })

  it('prepare forwards the trimmed task + forced admin id, returns the confirm card', async () => {
    const res = await fetch(`${b.server.url}/api/admin/workflows/wizard/prepare`, {
      method: 'POST',
      headers: adminHeaders(b),
      body: JSON.stringify({ task: '  给客户发周报  ', by: 'client-spoofed' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as typeof b.wizard.prepareResult
    expect(body.confirmText).toBe('你要建的是: 给客户发周报')
    expect(body.catalogText).toContain('主笔手')
    // `by` is the AUTHENTICATED admin, never a client-supplied value.
    expect(b.wizard.prepareCalls).toEqual([{ task: '给客户发周报', by: b.adminId }])
  })

  it('compose forwards clarifications/history/detail coerced; junk turns dropped', async () => {
    const res = await fetch(`${b.server.url}/api/admin/workflows/wizard/compose`, {
      method: 'POST',
      headers: adminHeaders(b),
      body: JSON.stringify({
        task: '发周报',
        clarifications: '每周五下午',
        detail: 'detailed',
        history: [
          { role: 'user', text: '建个发周报的' },
          { role: 'assistant', text: '好的,草稿如下', failed: true },
          { role: 'oracle', text: 'bad role' }, // dropped
          { role: 'user', text: 42 }, // dropped
          'garbage',
          null,
        ],
      }),
    })
    expect(res.status).toBe(200)
    expect(b.wizard.composeCalls).toEqual([
      {
        task: '发周报',
        by: b.adminId,
        clarifications: '每周五下午',
        detail: 'detailed',
        history: [
          { role: 'user', text: '建个发周报的' },
          { role: 'assistant', text: '好的,草稿如下', failed: true },
        ],
      },
    ])
  })

  it('compose ok:false (needs_user / exhausted) is still HTTP 200 — a dialogue state, not an error', async () => {
    b.wizard.composeResult = {
      ok: false,
      reason: 'exhausted',
      errorsText: '1. 步骤 review 引用了不存在的步骤输出',
      lastYaml: 'schema: aipehub.workflow/v1\n',
      repairRounds: 2,
    }
    const res = await fetch(`${b.server.url}/api/admin/workflows/wizard/compose`, {
      method: 'POST',
      headers: adminHeaders(b),
      body: JSON.stringify({ task: '发周报' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as ComposeResult).toMatchObject({ ok: false, reason: 'exhausted', repairRounds: 2 })
  })

  it('missing/blank task → 400 (never calls the surface)', async () => {
    for (const bodyJson of [{}, { task: '   ' }, { task: 7 }]) {
      const res = await fetch(`${b.server.url}/api/admin/workflows/wizard/compose`, {
        method: 'POST',
        headers: adminHeaders(b),
        body: JSON.stringify(bodyJson),
      })
      expect(res.status).toBe(400)
      expect((await res.json()) as { code?: string }).toMatchObject({ code: 'bad_request' })
    }
    expect(b.wizard.composeCalls).toHaveLength(0)
  })

  it('GET → 405; unknown sub-path → 404', async () => {
    const get = await fetch(`${b.server.url}/api/admin/workflows/wizard/prepare`, {
      headers: adminHeaders(b),
    })
    expect(get.status).toBe(405)
    const unknown = await fetch(`${b.server.url}/api/admin/workflows/wizard/publish`, {
      method: 'POST',
      headers: adminHeaders(b),
      body: JSON.stringify({ task: 'x' }),
    })
    expect(unknown.status).toBe(404)
  })

  it('503 code=not_wired when no wizard surface is injected', async () => {
    const b2 = await boot({ withWizard: false })
    try {
      const res = await fetch(`${b2.server.url}/api/admin/workflows/wizard/prepare`, {
        method: 'POST',
        headers: adminHeaders(b2),
        body: JSON.stringify({ task: '发周报' }),
      })
      expect(res.status).toBe(503)
      expect((await res.json()) as { code?: string }).toMatchObject({ code: 'not_wired' })
    } finally {
      await teardown(b2)
    }
  })
})

// ---------------------------------------------------------------------------
// MEMBER — /api/me/workflows/wizard/{prepare,compose,approve}
// ---------------------------------------------------------------------------

describe('POST /api/me/workflows/wizard/*', () => {
  let b: Boot
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(() => teardown(b))

  it('401 without a v4 session', async () => {
    for (const sub of ['prepare', 'compose', 'approve']) {
      const res = await fetch(`${b.server.url}/api/me/workflows/wizard/${sub}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: '发周报', yaml: 'x' }),
      })
      expect(res.status, sub).toBe(401)
    }
    expect(b.wizard.prepareCalls).toHaveLength(0)
    expect(b.create.fromYamlCalls).toHaveLength(0)
  })

  it('prepare forwards the task + forced SESSION userId', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/wizard/prepare`, {
      method: 'POST',
      headers: memberHeaders(b),
      body: JSON.stringify({ task: '整理我的待办', by: 'spoofed' }),
    })
    expect(res.status).toBe(200)
    expect(b.wizard.prepareCalls).toEqual([{ task: '整理我的待办', by: b.memberUserId }])
  })

  it('compose forwards coerced fields with the session userId; ok:false still 200', async () => {
    b.wizard.composeResult = {
      ok: false,
      reason: 'needs_user',
      explanation: '这个任务需要一个能发邮件的组件,目前目录里没有。',
      repairRounds: 0,
    }
    const res = await fetch(`${b.server.url}/api/me/workflows/wizard/compose`, {
      method: 'POST',
      headers: memberHeaders(b),
      body: JSON.stringify({
        task: '整理我的待办',
        clarifications: '',
        detail: 'verbose-please', // invalid → dropped
        history: [{ role: 'user', text: '来一版' }],
      }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as ComposeResult).toMatchObject({ ok: false, reason: 'needs_user' })
    // blank clarifications + invalid detail dropped; history kept.
    expect(b.wizard.composeCalls).toEqual([
      { task: '整理我的待办', by: b.memberUserId, history: [{ role: 'user', text: '来一版' }] },
    ])
  })

  it('compose is rate-limited (429 code=rate_limited once the bucket drains); prepare is not', async () => {
    const b2 = await boot({ rateMax: 2 })
    try {
      for (let i = 0; i < 2; i++) {
        const ok = await fetch(`${b2.server.url}/api/me/workflows/wizard/compose`, {
          method: 'POST',
          headers: memberHeaders(b2),
          body: JSON.stringify({ task: '发周报' }),
        })
        expect(ok.status).toBe(200)
      }
      const limited = await fetch(`${b2.server.url}/api/me/workflows/wizard/compose`, {
        method: 'POST',
        headers: memberHeaders(b2),
        body: JSON.stringify({ task: '发周报' }),
      })
      expect(limited.status).toBe(429)
      expect((await limited.json()) as { code?: string }).toMatchObject({ code: 'rate_limited' })
      expect(b2.wizard.composeCalls).toHaveLength(2)
      // prepare (零 LLM 盘点) shares no bucket with compose (烧 LLM).
      const prep = await fetch(`${b2.server.url}/api/me/workflows/wizard/prepare`, {
        method: 'POST',
        headers: memberHeaders(b2),
        body: JSON.stringify({ task: '发周报' }),
      })
      expect(prep.status).toBe(200)
    } finally {
      await teardown(b2)
    }
  })

  it('approve forwards yaml + forced session userId to createFromYaml (zero LLM)', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/wizard/approve`, {
      method: 'POST',
      headers: memberHeaders(b),
      body: JSON.stringify({ yaml: 'schema: aipehub.workflow/v1\n', userId: 'spoofed' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { workflowId?: string }).toMatchObject({
      ok: true,
      workflowId: 'wiz-flow',
    })
    expect(b.create.fromYamlCalls).toEqual([
      { yaml: 'schema: aipehub.workflow/v1\n', userId: b.memberUserId },
    ])
  })

  it('approve without yaml → 400 (never calls the surface)', async () => {
    for (const bodyJson of [{}, { yaml: '   ' }, { yaml: 7 }]) {
      const res = await fetch(`${b.server.url}/api/me/workflows/wizard/approve`, {
        method: 'POST',
        headers: memberHeaders(b),
        body: JSON.stringify(bodyJson),
      })
      expect(res.status).toBe(400)
    }
    expect(b.create.fromYamlCalls).toHaveLength(0)
  })

  it('approve maps deny reasons to the SAME statuses as /api/me/workflows/create', async () => {
    const cases: Array<[string, number]> = [
      ['cross_hub', 409],
      ['id_exists', 409],
      ['draft_cap', 429],
      ['parse_failed', 422],
      ['structure_failed', 422],
    ]
    for (const [reason, status] of cases) {
      b.create.fromYamlResult = { ok: false, reason, message: `${reason} boom` }
      const res = await fetch(`${b.server.url}/api/me/workflows/wizard/approve`, {
        method: 'POST',
        headers: memberHeaders(b),
        body: JSON.stringify({ yaml: 'schema: aipehub.workflow/v1\n' }),
      })
      expect(res.status, reason).toBe(status)
      expect((await res.json()) as { code?: string }).toMatchObject({ code: reason })
    }
  })

  it('approve → 503 when workflowCreate is wired WITHOUT createFromYaml (old surface)', async () => {
    const b2 = await boot({ createWithoutFromYaml: true })
    try {
      const res = await fetch(`${b2.server.url}/api/me/workflows/wizard/approve`, {
        method: 'POST',
        headers: memberHeaders(b2),
        body: JSON.stringify({ yaml: 'schema: aipehub.workflow/v1\n' }),
      })
      expect(res.status).toBe(503)
    } finally {
      await teardown(b2)
    }
  })

  it('wizard absent: prepare/compose 503 but approve (zero LLM) still lands', async () => {
    const b2 = await boot({ withWizard: false })
    try {
      const prep = await fetch(`${b2.server.url}/api/me/workflows/wizard/prepare`, {
        method: 'POST',
        headers: memberHeaders(b2),
        body: JSON.stringify({ task: '发周报' }),
      })
      expect(prep.status).toBe(503)
      const approve = await fetch(`${b2.server.url}/api/me/workflows/wizard/approve`, {
        method: 'POST',
        headers: memberHeaders(b2),
        body: JSON.stringify({ yaml: 'schema: aipehub.workflow/v1\n' }),
      })
      expect(approve.status).toBe(200)
      expect(b2.create.fromYamlCalls).toHaveLength(1)
    } finally {
      await teardown(b2)
    }
  })

  it('GET on a wizard path (wrong method) → 405', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/wizard/prepare`, {
      headers: memberHeaders(b),
    })
    expect(res.status).toBe(405)
  })
})
