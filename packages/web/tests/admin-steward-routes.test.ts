/**
 * HTTP tests for `/api/admin/steward/{plan,apply}` — the OPERATOR-console hub
 * steward ("管家") routes (SW-M9 A-M6). Site-wide twin of the member surface
 * (`/api/me/steward/*`), behind `requireAdmin` + a resolved operator `userId`.
 *
 * Boots a real Space + Hub + IdentityStore + serveWeb with a FAKE operator
 * `MeHubStewardSurface` (the operator service satisfies the SAME duck type), so
 * we exercise the ROUTES — the two server-side gates, userId forcing, verbatim
 * action pass-through, validation, status → HTTP mapping, and the two 503
 * degradations — WITHOUT the host's operator classify → site-wide-services →
 * approval pipeline (that's the A-M7 operator E2E gate).
 *
 * The two gates this pins (both server-side, never trusting the body):
 *   1. `requireAdmin` — no admin auth → 401.
 *   2. a resolved operator `userId` — the approval inbox is a PERSON's inbox.
 *      An owner v4 session resolves to that user's id (the happy path); a v3-only
 *      Space admin (Bearer admin token, no v4 user row) passes requireAdmin but
 *      resolves to `userId: null` → 503 `no_operator_identity` (R2), because there
 *      is no `/me` inbox to park a second-confirmation into.
 *   3. no operator steward wired → 503 `not_wired` (checked before the userId gate,
 *      so even an owner gets `not_wired` when the host wired none).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type {
  MeHubStewardSurface,
  MeHubStewardPlanResult,
  MeHubStewardApplyResult,
  StewardHistoryTurn,
} from '../src/me-routes.js'

/** A plain Error carrying an HTTP status, mirroring what the host services throw. */
function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

/** Records every call so the tests can assert userId forcing + verbatim pass-through. */
class FakeOperatorSteward implements MeHubStewardSurface {
  readonly planCalls: Array<{
    userId: string
    instruction: string
    history?: StewardHistoryTurn[]
  }> = []
  readonly applyCalls: Array<{ userId: string; action: unknown }> = []

  planThrows: Error | null = null
  applyThrows: Error | null = null

  planResult: MeHubStewardPlanResult = {
    reply: '我可以帮你建一个站点级的工单助手。',
    actions: [
      {
        action: {
          kind: 'create_agent',
          handle: 'support-bot', // operator: the handle is the FULL id (verbatim)
          label: '工单助手',
          provider: 'anthropic',
          system: '你负责把工单分流。',
          capabilities: ['triage'],
        },
        tier: 'safe',
        summary: '建一个站点级助手「工单助手」。',
      },
    ],
  }
  applyResult: MeHubStewardApplyResult = {
    status: 'done',
    tier: 'safe',
    result: { kind: 'create_agent', agent: { id: 'support-bot', handle: 'support-bot' } },
  }

  async plan(input: {
    userId: string
    instruction: string
    history?: StewardHistoryTurn[]
  }): Promise<MeHubStewardPlanResult> {
    this.planCalls.push(input)
    if (this.planThrows) throw this.planThrows
    return this.planResult
  }
  async apply(input: { userId: string; action: unknown }): Promise<MeHubStewardApplyResult> {
    this.applyCalls.push(input)
    if (this.applyThrows) throw this.applyThrows
    return this.applyResult
  }
}

interface Boot {
  tmp: string
  hub: Hub
  identity: IdentityStore
  server: WebServerHandle
  /** The operator (owner-role v4 user) — passes requireAdmin AND resolves to a userId. */
  operatorUserId: string
  operatorCookie: string
  /** A v3-only Space admin token (Bearer) — passes requireAdmin but resolves to NO v4 user. */
  adminToken: string
  steward: FakeOperatorSteward
}

async function boot(opts: { withSteward?: boolean } = {}): Promise<Boot> {
  const withSteward = opts.withSteward ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-admin-steward-'))
  const space = (await Space.init(tmp, { name: 'admin-steward-test' })).space
  const hub = new Hub({ space })
  await hub.start()

  const { token: adminToken } = await space.createAdmin('TestAdmin')
  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
  identity.bootstrap({ adminToken, ownerEmail: 'admin@local', ownerDisplayName: 'TestAdmin' })
  // The operator console is an owner's seat — an owner v4 session both passes
  // requireAdmin (v4AdminFromRequest accepts owner/admin) and resolves to a userId
  // (resolveResourceActor → { userId, isOperator: true }). Bootstrap's owner has no
  // credentials, so we create a logged-in owner of our own.
  const operator = identity.createUser({
    email: 'operator@team.test',
    displayName: 'Test Operator',
    password: 'operator-strong-password',
    role: 'owner',
  })

  const steward = new FakeOperatorSteward()
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(withSteward ? { operatorSteward: steward } : {}),
  })

  const loginRes = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'operator@team.test', password: 'operator-strong-password' }),
  })
  if (loginRes.status !== 200) throw new Error(`operator login failed: ${loginRes.status}`)
  const operatorCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

  return { tmp, hub, identity, server, operatorUserId: operator.id, operatorCookie, adminToken, steward }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('/api/admin/steward/plan', () => {
  let b: Boot
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(() => teardown(b))

  it('401 without any admin auth (requireAdmin gate)', async () => {
    const res = await fetch(`${b.server.url}/api/admin/steward/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '建个站点助手' }),
    })
    expect(res.status).toBe(401)
    expect(b.steward.planCalls).toHaveLength(0)
  })

  it('POST forwards the instruction + forced operator userId, returns the proposal', async () => {
    const res = await fetch(`${b.server.url}/api/admin/steward/plan`, {
      method: 'POST',
      headers: { cookie: b.operatorCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '帮我建一个站点级工单助手' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as MeHubStewardPlanResult
    expect(body.reply).toContain('工单')
    expect(body.actions[0]).toMatchObject({ tier: 'safe' })
    // The planning userId is the OPERATOR's session user, never a client value.
    expect(b.steward.planCalls).toEqual([
      { userId: b.operatorUserId, instruction: '帮我建一个站点级工单助手' },
    ])
  })

  it('POST forwards a shape-coerced history (role/content kept, garbage dropped)', async () => {
    await fetch(`${b.server.url}/api/admin/steward/plan`, {
      method: 'POST',
      headers: { cookie: b.operatorCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        instruction: '再加一个能力',
        history: [
          { role: 'user', content: '建一个工单助手' },
          { role: 'assistant', content: '已经建好了。' },
          { role: 'system', content: '应被丢弃' }, // bad role → dropped
          { role: 'user', content: 42 }, // non-string content → dropped
          'garbage', // non-object → dropped
          null,
        ],
      }),
    })
    expect(b.steward.planCalls[0]?.history).toEqual([
      { role: 'user', content: '建一个工单助手' },
      { role: 'assistant', content: '已经建好了。' },
    ])
  })

  it('POST forwards a turn `result` shape-coerced (operator route shares the helper)', async () => {
    await fetch(`${b.server.url}/api/admin/steward/plan`, {
      method: 'POST',
      headers: { cookie: b.operatorCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        instruction: '接着改工作流',
        history: [
          { role: 'user', content: '把工单助手建起来' },
          {
            role: 'assistant',
            content: '',
            result: {
              kind: 'create_agent',
              status: 'done',
              subject: 'support-bot',
              secret: 'sk-should-never-appear', // forged → dropped by the shared coercer
            },
          },
        ],
      }),
    })
    expect(b.steward.planCalls[0]?.history).toEqual([
      { role: 'user', content: '把工单助手建起来' },
      { role: 'assistant', content: '', result: { kind: 'create_agent', status: 'done', subject: 'support-bot' } },
    ])
  })

  it('POST without history omits the field entirely (no empty array)', async () => {
    await fetch(`${b.server.url}/api/admin/steward/plan`, {
      method: 'POST',
      headers: { cookie: b.operatorCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '建个助手' }),
    })
    expect(b.steward.planCalls[0]).not.toHaveProperty('history')
  })

  it('POST with a non-array history → 400 (never calls the surface)', async () => {
    const res = await fetch(`${b.server.url}/api/admin/steward/plan`, {
      method: 'POST',
      headers: { cookie: b.operatorCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '建个助手', history: 'not-an-array' }),
    })
    expect(res.status).toBe(400)
    expect(b.steward.planCalls).toHaveLength(0)
  })

  it('POST trims the instruction and rejects an empty one → 400 (never calls the surface)', async () => {
    const res = await fetch(`${b.server.url}/api/admin/steward/plan`, {
      method: 'POST',
      headers: { cookie: b.operatorCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '   ' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { code?: string }).toMatchObject({ code: 'bad_request' })
    expect(b.steward.planCalls).toHaveLength(0)
  })

  it('POST → 500 (steward_failed) when the surface throws (dispatch non-ok)', async () => {
    b.steward.planThrows = new Error('steward dispatch failed')
    const res = await fetch(`${b.server.url}/api/admin/steward/plan`, {
      method: 'POST',
      headers: { cookie: b.operatorCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '建个助手' }),
    })
    expect(res.status).toBe(500)
    expect((await res.json()) as { code?: string }).toMatchObject({ code: 'steward_failed' })
  })

  it('POST → 503 not_wired when no operator steward is wired (even for an owner)', async () => {
    const b2 = await boot({ withSteward: false })
    try {
      const res = await fetch(`${b2.server.url}/api/admin/steward/plan`, {
        method: 'POST',
        headers: { cookie: b2.operatorCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: '建个助手' }),
      })
      expect(res.status).toBe(503)
      expect((await res.json()) as { code?: string }).toMatchObject({ code: 'not_wired' })
      expect(b2.steward.planCalls).toHaveLength(0)
    } finally {
      await teardown(b2)
    }
  })

  it('POST → 503 no_operator_identity for a v3-only Space admin (no v4 user, no inbox) — R2', async () => {
    // A v3 admin token (Bearer, no `aipk_`/`adm_` prefix) passes requireAdmin via
    // space.verifyAdminToken, but resolveResourceActor finds no v4 session → userId
    // null → the operator steward is unavailable (no person's inbox to park into).
    const res = await fetch(`${b.server.url}/api/admin/steward/plan`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '建个助手' }),
    })
    expect(res.status).toBe(503)
    expect((await res.json()) as { code?: string }).toMatchObject({ code: 'no_operator_identity' })
    expect(b.steward.planCalls).toHaveLength(0)
  })

  it('GET on the plan path (wrong method) falls through to 404', async () => {
    const res = await fetch(`${b.server.url}/api/admin/steward/plan`, {
      headers: { cookie: b.operatorCookie },
    })
    expect(res.status).toBe(404)
  })
})

describe('/api/admin/steward/apply', () => {
  let b: Boot
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(() => teardown(b))

  it('401 without any admin auth', async () => {
    const res = await fetch(`${b.server.url}/api/admin/steward/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: { kind: 'inspect', answer: 'hi' } }),
    })
    expect(res.status).toBe(401)
    expect(b.steward.applyCalls).toHaveLength(0)
  })

  it('POST forwards the action VERBATIM + forced operator userId, returns 200', async () => {
    const action = {
      kind: 'create_agent',
      handle: 'support-bot',
      label: '工单助手',
      provider: 'anthropic',
      system: 'triage',
      capabilities: ['triage'],
    }
    const res = await fetch(`${b.server.url}/api/admin/steward/apply`, {
      method: 'POST',
      headers: { cookie: b.operatorCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as MeHubStewardApplyResult).toMatchObject({ status: 'done', tier: 'safe' })
    // userId is the OPERATOR's session user; the action rides through untouched (the
    // host is the validation + re-classification authority).
    expect(b.steward.applyCalls).toEqual([{ userId: b.operatorUserId, action }])
  })

  it('POST with no action → 400 (never calls the surface)', async () => {
    const res = await fetch(`${b.server.url}/api/admin/steward/apply`, {
      method: 'POST',
      headers: { cookie: b.operatorCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'no action here' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { code?: string }).toMatchObject({ code: 'bad_request' })
    expect(b.steward.applyCalls).toHaveLength(0)
  })

  it('POST maps a host status:"invalid" verdict to HTTP 400 (and echoes the body)', async () => {
    b.steward.applyResult = { status: 'invalid', reason: '这个动作的格式不对,没有执行。' }
    const res = await fetch(`${b.server.url}/api/admin/steward/apply`, {
      method: 'POST',
      headers: { cookie: b.operatorCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: { kind: 'nonsense' } }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as MeHubStewardApplyResult).toMatchObject({
      status: 'invalid',
      reason: '这个动作的格式不对,没有执行。',
    })
    // It still reached the host — the host, not the web layer, is the validator.
    expect(b.steward.applyCalls).toHaveLength(1)
  })

  it('POST returns 200 for every non-invalid status (refused / pending_approval / needs_approval)', async () => {
    const cases: MeHubStewardApplyResult[] = [
      { status: 'refused', reason: '凭证设置请到「我的 API 密钥」面板自己改。' },
      { status: 'pending_approval', tier: 'dangerous', inboxItemId: 'inbox-1' },
      { status: 'needs_approval', tier: 'cross_hub' },
    ]
    for (const result of cases) {
      b.steward.applyResult = result
      const res = await fetch(`${b.server.url}/api/admin/steward/apply`, {
        method: 'POST',
        headers: { cookie: b.operatorCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ action: { kind: 'delete_agent', agentId: 'support-bot' } }),
      })
      expect(res.status, result.status).toBe(200)
      expect((await res.json()) as MeHubStewardApplyResult).toMatchObject({ status: result.status })
    }
  })

  it('POST maps an operator-service status error to its HTTP code (403 / 404)', async () => {
    for (const [status, code] of [
      [403, 403],
      [404, 404],
    ] as Array<[number, number]>) {
      b.steward.applyThrows = statusError(status, `boom ${status}`)
      const res = await fetch(`${b.server.url}/api/admin/steward/apply`, {
        method: 'POST',
        headers: { cookie: b.operatorCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ action: { kind: 'delete_agent', agentId: 'support-bot' } }),
      })
      expect(res.status, String(status)).toBe(code)
    }
  })

  it('POST maps a plain surface throw (no status) to 500', async () => {
    b.steward.applyThrows = new Error('unexpected')
    const res = await fetch(`${b.server.url}/api/admin/steward/apply`, {
      method: 'POST',
      headers: { cookie: b.operatorCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: { kind: 'inspect', answer: 'hi' } }),
    })
    expect(res.status).toBe(500)
  })

  it('POST → 503 not_wired when no operator steward is wired', async () => {
    const b2 = await boot({ withSteward: false })
    try {
      const res = await fetch(`${b2.server.url}/api/admin/steward/apply`, {
        method: 'POST',
        headers: { cookie: b2.operatorCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ action: { kind: 'inspect', answer: 'hi' } }),
      })
      expect(res.status).toBe(503)
      expect((await res.json()) as { code?: string }).toMatchObject({ code: 'not_wired' })
      expect(b2.steward.applyCalls).toHaveLength(0)
    } finally {
      await teardown(b2)
    }
  })

  it('POST → 503 no_operator_identity for a v3-only Space admin (R2)', async () => {
    const res = await fetch(`${b.server.url}/api/admin/steward/apply`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: { kind: 'inspect', answer: 'hi' } }),
    })
    expect(res.status).toBe(503)
    expect((await res.json()) as { code?: string }).toMatchObject({ code: 'no_operator_identity' })
    expect(b.steward.applyCalls).toHaveLength(0)
  })
})
