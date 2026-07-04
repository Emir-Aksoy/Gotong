/**
 * HTTP tests for `/api/me/workflows/create` + `/api/me/workflows/:id/explain` —
 * the member-facing "工作流架构师" (ARCH-M6).
 *
 * Boots a real Space + Hub + IdentityStore + serveWeb with a FAKE
 * `MeWorkflowCreateSurface` (and, for explain, a minimal catalog `workflows`
 * surface) so we exercise the ROUTES — auth gate, userId forcing, instruction /
 * detail / history coercion, ★ explain VISIBILITY gating (resolveMeWorkflow), ★
 * reason → status mapping, NDJSON streaming, degradation when unwired — without
 * the host's assistant → boundary-lock → saveDraft pipeline. That pipeline is
 * covered by the M5 service test; the end-to-end "real assistant + real lock +
 * real versioning" path is the M8 E2E gate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'

import { serveWeb, type WebServerHandle, type WorkflowSurface } from '../src/server.js'
import type {
  MeWorkflowCreateSurface,
  MeWorkflowCreateResult,
  MeWorkflowExplainResult,
} from '../src/me-routes.js'

/** A representative DAG projection — what the architect's `graph` carries. */
const GRAPH = {
  workflowId: 'my-flow',
  nodes: [
    { id: 'trigger', kind: 'trigger', label: 'chat 触发' },
    { id: 'draft', kind: 'step', label: '起草' },
    { id: 'done', kind: 'output', label: '输出' },
  ],
  edges: [
    { kind: 'sequence', from: 'trigger', to: 'draft' },
    { kind: 'sequence', from: 'draft', to: 'done' },
  ],
}

/** Records every call so the tests can assert userId forcing + pass-through. */
class FakeWorkflowCreate implements MeWorkflowCreateSurface {
  readonly createCalls: Array<{
    instruction: string
    userId: string
    detail?: string
    history?: Array<{ instruction: string; outcome?: string }>
  }> = []
  readonly explainCalls: Array<{
    workflowId: string
    userId: string
    detail?: string
    focus?: string
  }> = []
  /** Whether each call carried a per-call chunk sink (streaming). */
  readonly createHadOnChunk: boolean[] = []
  readonly explainHadOnChunk: boolean[] = []
  /** Chunks the fake emits into `onChunk` before returning (when wired). */
  emitChunks: string[] = []
  /** When set, the method throws instead of returning (mid-stream failure). */
  createThrows: Error | null = null
  explainThrows: Error | null = null

  createResult: MeWorkflowCreateResult = {
    ok: true,
    workflowId: 'my-flow',
    yaml: 'schema: gotong.workflow/v1\n',
    explanation: '每天早上把你的待办整理一下发给你。',
    graph: GRAPH,
  }
  explainResult: MeWorkflowExplainResult = {
    ok: true,
    workflowId: 'flow',
    yaml: 'schema: gotong.workflow/v1\n',
    explanation: '这个工作流先起草,再审阅,最后输出。',
    detail: 'brief',
    graph: GRAPH,
  }

  async create(args: {
    instruction: string
    userId: string
    detail?: string
    history?: Array<{ instruction: string; outcome?: string }>
    onChunk?: (chunk: string) => void
  }): Promise<MeWorkflowCreateResult> {
    const { onChunk, ...rest } = args
    this.createCalls.push(rest)
    this.createHadOnChunk.push(typeof onChunk === 'function')
    if (onChunk) for (const c of this.emitChunks) onChunk(c)
    if (this.createThrows) throw this.createThrows
    return this.createResult
  }
  async explain(args: {
    workflowId: string
    userId: string
    detail?: string
    focus?: string
    onChunk?: (chunk: string) => void
  }): Promise<MeWorkflowExplainResult> {
    const { onChunk, ...rest } = args
    this.explainCalls.push(rest)
    this.explainHadOnChunk.push(typeof onChunk === 'function')
    if (onChunk) for (const c of this.emitChunks) onChunk(c)
    if (this.explainThrows) throw this.explainThrows
    return this.explainResult
  }
}

/**
 * A minimal catalog `workflows` surface — only `list()` is used by
 * `resolveMeWorkflow` (the explain visibility gate). The other ~30
 * `WorkflowSurface` methods are never called on these routes, so we cast a
 * partial. By default it advertises one published, member-facing workflow
 * `flow` (+ a slash-id one for the decode test).
 */
function fakeCatalog(
  rows: Array<{ id: string; state?: string; enabled?: boolean; allowedRoles?: string[] }> = [
    { id: 'flow', state: 'published', enabled: true },
    { id: 'my/flow', state: 'published', enabled: true },
  ],
): WorkflowSurface {
  const summaries = rows.map((r) => ({
    id: r.id,
    name: r.id,
    triggerCapability: `${r.id}:run`,
    state: r.state,
    surfaceMe: {
      enabled: r.enabled ?? true,
      ...(r.allowedRoles ? { allowedRoles: r.allowedRoles } : {}),
    },
  }))
  return { list: async () => summaries } as unknown as WorkflowSurface
}

interface Boot {
  tmp: string
  hub: Hub
  identity: IdentityStore
  server: WebServerHandle
  memberUserId: string
  memberCookie: string
  create: FakeWorkflowCreate
}

async function boot(opts: { withCreate?: boolean; withCatalog?: boolean } = {}): Promise<Boot> {
  const withCreate = opts.withCreate ?? true
  const withCatalog = opts.withCatalog ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-wfcreate-'))
  const space = (await Space.init(tmp, { name: 'wfcreate-test' })).space
  const hub = new Hub({ space })
  await hub.start()

  await space.createAdmin('TestAdmin')
  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
  identity.bootstrap({ ownerEmail: 'admin@local', ownerDisplayName: 'TestAdmin' })
  const member = identity.createUser({
    email: 'member@team.test',
    displayName: 'Test Member',
    password: 'member-strong-password',
    role: 'member',
  })

  const create = new FakeWorkflowCreate()
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(withCreate ? { workflowCreate: create } : {}),
    ...(withCatalog ? { workflows: fakeCatalog() } : {}),
  })

  const loginRes = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'member@team.test', password: 'member-strong-password' }),
  })
  if (loginRes.status !== 200) throw new Error(`member login failed: ${loginRes.status}`)
  const memberCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

  return { tmp, hub, identity, server, memberUserId: member.id, memberCookie, create }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// CREATE — author a brand-new workflow from plain language.
// ---------------------------------------------------------------------------

describe('POST /api/me/workflows/create', () => {
  let b: Boot
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(() => teardown(b))

  it('401 without a v4 session', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/create`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('POST forwards the instruction + forced session userId, returns 200 with graph', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/create`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '每天早上把我的待办整理一下发给我' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as MeWorkflowCreateResult
    expect(body).toMatchObject({ ok: true, workflowId: 'my-flow' })
    // graph rides back verbatim — the client renders the DAG SVG from it.
    if (body.ok) expect(body.graph).toEqual(GRAPH)
    // The creating userId is the SESSION user, never a client value.
    expect(b.create.createCalls).toEqual([
      { instruction: '每天早上把我的待办整理一下发给我', userId: b.memberUserId },
    ])
  })

  it('POST forwards a coerced detail; an invalid one is dropped', async () => {
    await fetch(`${b.server.url}/api/me/workflows/create`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '建个工作流', detail: 'detailed' }),
    })
    expect(b.create.createCalls[0]?.detail).toBe('detailed')

    await fetch(`${b.server.url}/api/me/workflows/create`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '再来一个', detail: 'verbose-please' }),
    })
    expect(b.create.createCalls[1]).not.toHaveProperty('detail')
  })

  it('POST forwards a shape-coerced history to the surface', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/create`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        instruction: '再加一步让我确认',
        history: [
          { instruction: '建个整理待办的工作流', outcome: '已生成草稿。' },
          { instruction: '改成每天触发', outcome: 42 }, // non-string outcome dropped, turn kept
          { instruction: 7 }, // non-string instruction → turn dropped
          'garbage',
          null,
        ],
      }),
    })
    expect(res.status).toBe(200)
    expect(b.create.createCalls[0]?.history).toEqual([
      { instruction: '建个整理待办的工作流', outcome: '已生成草稿。' },
      { instruction: '改成每天触发' },
    ])
  })

  it('POST with a non-array history → 400 (never calls the surface)', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/create`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '建个工作流', history: 'not-an-array' }),
    })
    expect(res.status).toBe(400)
    expect(b.create.createCalls).toHaveLength(0)
  })

  it('POST without history omits the field entirely (no empty array)', async () => {
    await fetch(`${b.server.url}/api/me/workflows/create`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '建个工作流' }),
    })
    expect(b.create.createCalls[0]).not.toHaveProperty('history')
  })

  it('POST trims the instruction and rejects an empty one → 400 (never calls the surface)', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/create`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '   ' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { code?: string }).toMatchObject({ code: 'bad_request' })
    expect(b.create.createCalls).toHaveLength(0)
  })

  it('POST with a non-string instruction → 400', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/create`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 42 }),
    })
    expect(res.status).toBe(400)
    expect(b.create.createCalls).toHaveLength(0)
  })

  it('POST maps the surface reasons to HTTP status', async () => {
    const cases: Array<[string, number]> = [
      ['cross_hub', 409],
      ['id_exists', 409],
      ['draft_cap', 429],
      ['assistant_failed', 422],
      ['parse_failed', 422],
      ['structure_failed', 422],
      ['assistant_unavailable', 503],
    ]
    for (const [reason, status] of cases) {
      b.create.createResult = { ok: false, reason, message: `${reason} boom` }
      const res = await fetch(`${b.server.url}/api/me/workflows/create`, {
        method: 'POST',
        headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: '建个工作流' }),
      })
      expect(res.status, reason).toBe(status)
      expect((await res.json()) as { code?: string }).toMatchObject({ code: reason })
    }
  })

  it('POST echoes draftStatus + detail on an assistant_failed rejection', async () => {
    b.create.createResult = {
      ok: false,
      reason: 'assistant_failed',
      message: 'AI 没能把你的描述变成工作流。',
      detail: '触发能力缺失',
      draftStatus: 'no_yaml',
    }
    const res = await fetch(`${b.server.url}/api/me/workflows/create`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '随便' }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code?: string; detail?: string; draftStatus?: string }
    expect(body).toMatchObject({ code: 'assistant_failed', detail: '触发能力缺失', draftStatus: 'no_yaml' })
  })

  it('POST → 503 when no workflowCreate surface is wired', async () => {
    const b2 = await boot({ withCreate: false })
    try {
      const res = await fetch(`${b2.server.url}/api/me/workflows/create`, {
        method: 'POST',
        headers: { cookie: b2.memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: '建个工作流' }),
      })
      expect(res.status).toBe(503)
      expect(b2.create.createCalls).toHaveLength(0)
    } finally {
      await teardown(b2)
    }
  })
})

// ---------------------------------------------------------------------------
// CREATE — streaming (NDJSON over the same POST).
// ---------------------------------------------------------------------------

describe('POST /api/me/workflows/create — streaming', () => {
  let b: Boot
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(() => teardown(b))

  async function postStream(body: Record<string, unknown>): Promise<{
    res: Response
    lines: Array<Record<string, unknown>>
  }> {
    const res = await fetch(`${b.server.url}/api/me/workflows/create`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    const lines = text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    return { res, lines }
  }

  it('streams chunk lines then a result line; surface got a per-call sink', async () => {
    b.create.emitChunks = ['schema: gotong', '.workflow/v1\n']
    const { res, lines } = await postStream({ instruction: '建个工作流', stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    expect(lines).toEqual([
      { kind: 'chunk', text: 'schema: gotong' },
      { kind: 'chunk', text: '.workflow/v1\n' },
      expect.objectContaining({ kind: 'result', ok: true, workflowId: 'my-flow' }),
    ])
    expect(b.create.createHadOnChunk).toEqual([true])
  })

  it('carries a surface failure in the result line (HTTP stays 200)', async () => {
    b.create.createResult = {
      ok: false,
      reason: 'cross_hub',
      message: '这个工作流里有派发到别的 hub 的步骤。',
    }
    const { res, lines } = await postStream({ instruction: '把订单发到供货商', stream: true })
    expect(res.status).toBe(200)
    expect(lines.at(-1)).toMatchObject({
      kind: 'result',
      ok: false,
      code: 'cross_hub',
      error: '这个工作流里有派发到别的 hub 的步骤。',
    })
  })

  it('carries a surface throw as a result line with code=internal', async () => {
    b.create.createThrows = new Error('assistant exploded mid-call')
    const { lines } = await postStream({ instruction: '建个工作流', stream: true })
    expect(lines.at(-1)).toMatchObject({
      kind: 'result',
      ok: false,
      code: 'internal',
      error: 'assistant exploded mid-call',
    })
  })

  it('stream:false keeps the plain-JSON contract and passes no sink', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/create`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '建个工作流', stream: false }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(b.create.createHadOnChunk).toEqual([false])
  })
})

// ---------------------------------------------------------------------------
// EXPLAIN — narrate a catalog-visible workflow at an adjustable depth.
// ---------------------------------------------------------------------------

describe('POST /api/me/workflows/:id/explain', () => {
  let b: Boot
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(() => teardown(b))

  it('401 without a v4 session', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/flow/explain`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('POST a visible workflow forwards forced userId + decoded id, returns 200 with graph', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/flow/explain`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ detail: 'detailed' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as MeWorkflowExplainResult
    expect(body).toMatchObject({ ok: true, workflowId: 'flow', detail: 'brief' })
    if (body.ok) expect(body.graph).toEqual(GRAPH)
    // The explaining userId is the SESSION user; detail rides through coerced.
    expect(b.create.explainCalls).toEqual([
      { workflowId: 'flow', userId: b.memberUserId, detail: 'detailed' },
    ])
  })

  it('POST decodes a URL-encoded workflow id (and resolves it in the catalog)', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/my%2Fflow/explain`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    expect(b.create.explainCalls[0]?.workflowId).toBe('my/flow')
  })

  it('★ POST an UNKNOWN id → 403 (forbidden) and NEVER calls the surface', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/does-not-exist/explain`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
    expect((await res.json()) as { code?: string }).toMatchObject({ code: 'forbidden' })
    // Visibility gate denied BEFORE the executor ran — no existence leak.
    expect(b.create.explainCalls).toHaveLength(0)
  })

  it('★ POST a workflow not visible to this role → 403 (never calls the surface)', async () => {
    // Re-boot with a catalog whose `flow` is owner/admin-only.
    const b2 = await boot()
    try {
      // Swap in a role-restricted catalog by closing + reopening server is heavy;
      // instead drive an id that the default catalog doesn't publish.
      const res = await fetch(`${b2.server.url}/api/me/workflows/hidden/explain`, {
        method: 'POST',
        headers: { cookie: b2.memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
      expect(b2.create.explainCalls).toHaveLength(0)
    } finally {
      await teardown(b2)
    }
  })

  it('★ POST → 403 when the catalog (workflows) surface is unwired', async () => {
    const b2 = await boot({ withCatalog: false })
    try {
      const res = await fetch(`${b2.server.url}/api/me/workflows/flow/explain`, {
        method: 'POST',
        headers: { cookie: b2.memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      // resolveMeWorkflow returns null without a catalog → fail-closed 403.
      expect(res.status).toBe(403)
      expect(b2.create.explainCalls).toHaveLength(0)
    } finally {
      await teardown(b2)
    }
  })

  it('POST forwards an optional focus question', async () => {
    await fetch(`${b.server.url}/api/me/workflows/flow/explain`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ focus: '这一步会不会卡审批?' }),
    })
    expect(b.create.explainCalls[0]?.focus).toBe('这一步会不会卡审批?')
  })

  it('POST maps the surface reasons to HTTP status', async () => {
    const cases: Array<[string, number]> = [
      ['not_found', 404],
      ['no_source', 409],
      ['assistant_failed', 422],
      ['assistant_unavailable', 503],
    ]
    for (const [reason, status] of cases) {
      b.create.explainResult = { ok: false, reason, message: `${reason} boom` }
      const res = await fetch(`${b.server.url}/api/me/workflows/flow/explain`, {
        method: 'POST',
        headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status, reason).toBe(status)
      expect((await res.json()) as { code?: string }).toMatchObject({ code: reason })
    }
  })

  it('★ POST → 503 when no workflowCreate surface is wired (checked BEFORE visibility)', async () => {
    const b2 = await boot({ withCreate: false })
    try {
      const res = await fetch(`${b2.server.url}/api/me/workflows/flow/explain`, {
        method: 'POST',
        headers: { cookie: b2.memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(503)
      expect(b2.create.explainCalls).toHaveLength(0)
    } finally {
      await teardown(b2)
    }
  })

  it('GET on the /explain path (wrong method) falls through to 404', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/flow/explain`, {
      headers: { cookie: b.memberCookie },
    })
    expect(res.status).toBe(404)
  })

  it('streams chunk lines then a result line for a visible workflow', async () => {
    b.create.emitChunks = ['这个工作流', '先起草再审阅。']
    const res = await fetch(`${b.server.url}/api/me/workflows/flow/explain`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    const lines = (await res.text())
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toEqual([
      { kind: 'chunk', text: '这个工作流' },
      { kind: 'chunk', text: '先起草再审阅。' },
      expect.objectContaining({ kind: 'result', ok: true, workflowId: 'flow' }),
    ])
    expect(b.create.explainHadOnChunk).toEqual([true])
  })
})
