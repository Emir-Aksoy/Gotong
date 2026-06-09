/**
 * HTTP tests for `/api/me/workflows/:id/{editable,edit}` — member natural-
 * language workflow editing (WFEDIT-M3).
 *
 * Boots a real Space + Hub + IdentityStore + serveWeb with a FAKE
 * `MeWorkflowEditSurface` so we exercise the ROUTES (auth gate, userId forcing,
 * instruction validation, reason → status mapping, violation echo, degradation
 * when unwired) without the host's RBAC → assistant → boundary-lock → persist
 * pipeline. That pipeline is covered by the M2 service test; the end-to-end
 * "real assistant + real lock + real versioning" path is the M5 E2E gate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type {
  MeWorkflowEditSurface,
  MeWorkflowEditableResult,
  MeWorkflowEditResult,
} from '../src/me-routes.js'

const BOUNDARY = {
  trigger: 'run-flow',
  egress: [{ stepId: 'place', capability: 'supplier.confirm-order', dataClasses: ['public'] }],
}

/** Records every call so the tests can assert userId forcing + pass-through. */
class FakeWorkflowEdit implements MeWorkflowEditSurface {
  readonly editableCalls: Array<{ workflowId: string; userId: string }> = []
  readonly editCalls: Array<{ workflowId: string; instruction: string; userId: string }> = []
  /** What `editableView` returns (default: a happy cross-hub view). */
  editableResult: MeWorkflowEditableResult = {
    ok: true,
    workflowId: 'flow',
    state: 'published',
    editable: true,
    yaml: 'schema: aipehub.workflow/v1\n',
    boundary: BOUNDARY,
    crossHub: true,
  }
  /** What `edit` returns (default: a happy published edit). */
  editResult: MeWorkflowEditResult = {
    ok: true,
    state: 'published',
    applied: 'published',
    yaml: 'schema: aipehub.workflow/v1\n',
    explanation: '把第一步的提示语改了。',
    boundary: BOUNDARY,
  }

  async editableView(workflowId: string, userId: string): Promise<MeWorkflowEditableResult> {
    this.editableCalls.push({ workflowId, userId })
    return this.editableResult
  }
  async edit(args: {
    workflowId: string
    instruction: string
    userId: string
  }): Promise<MeWorkflowEditResult> {
    this.editCalls.push(args)
    return this.editResult
  }
}

interface Boot {
  tmp: string
  hub: Hub
  identity: IdentityStore
  server: WebServerHandle
  memberUserId: string
  memberCookie: string
  edit: FakeWorkflowEdit
}

async function boot(opts: { withEdit?: boolean } = {}): Promise<Boot> {
  const withEdit = opts.withEdit ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-wfedit-'))
  const space = (await Space.init(tmp, { name: 'wfedit-test' })).space
  const hub = new Hub({ space })
  await hub.start()

  const { token: adminToken } = await space.createAdmin('TestAdmin')
  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
  identity.bootstrap({ adminToken, ownerEmail: 'admin@local', ownerDisplayName: 'TestAdmin' })
  const member = identity.createUser({
    email: 'member@team.test',
    displayName: 'Test Member',
    password: 'member-strong-password',
    role: 'member',
  })

  const edit = new FakeWorkflowEdit()
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(withEdit ? { workflowEdit: edit } : {}),
  })

  const loginRes = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'member@team.test', password: 'member-strong-password' }),
  })
  if (loginRes.status !== 200) throw new Error(`member login failed: ${loginRes.status}`)
  const memberCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

  return { tmp, hub, identity, server, memberUserId: member.id, memberCookie, edit }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('/api/me/workflows/:id/editable', () => {
  let b: Boot
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(() => teardown(b))

  it('401 without a v4 session', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/flow/editable`)
    expect(res.status).toBe(401)
  })

  it('GET forwards the decoded workflowId + forced session userId, returns 200', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/flow/editable`, {
      headers: { cookie: b.memberCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as MeWorkflowEditableResult
    expect(body).toMatchObject({ ok: true, workflowId: 'flow', crossHub: true })
    // The route passed the SESSION userId to the surface — a member can't view
    // another user's editor by tampering with the request.
    expect(b.edit.editableCalls).toEqual([{ workflowId: 'flow', userId: b.memberUserId }])
  })

  it('GET decodes a URL-encoded workflow id', async () => {
    await fetch(`${b.server.url}/api/me/workflows/my%2Fflow/editable`, {
      headers: { cookie: b.memberCookie },
    })
    expect(b.edit.editableCalls[0]?.workflowId).toBe('my/flow')
  })

  it('GET maps surface reasons to HTTP status', async () => {
    const cases: Array<[string, number]> = [
      ['forbidden', 403],
      ['not_found', 404],
      ['archived', 409],
      ['under_review', 409],
    ]
    for (const [reason, status] of cases) {
      b.edit.editableResult = { ok: false, reason, message: `${reason} boom` }
      const res = await fetch(`${b.server.url}/api/me/workflows/flow/editable`, {
        headers: { cookie: b.memberCookie },
      })
      expect(res.status, reason).toBe(status)
      expect((await res.json()) as { code?: string }).toMatchObject({ code: reason })
    }
  })

  it('GET → 503 when no workflowEdit surface is wired', async () => {
    const b2 = await boot({ withEdit: false })
    try {
      const res = await fetch(`${b2.server.url}/api/me/workflows/flow/editable`, {
        headers: { cookie: b2.memberCookie },
      })
      expect(res.status).toBe(503)
    } finally {
      await teardown(b2)
    }
  })
})

describe('/api/me/workflows/:id/edit', () => {
  let b: Boot
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(() => teardown(b))

  it('401 without a v4 session', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/flow/edit`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('POST forwards workflowId + instruction + forced userId, returns 200', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/flow/edit`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '把第一步的提示语改得更礼貌一点' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as MeWorkflowEditResult).toMatchObject({
      ok: true,
      applied: 'published',
    })
    // The editing userId is the SESSION user, never a client value.
    expect(b.edit.editCalls).toEqual([
      { workflowId: 'flow', instruction: '把第一步的提示语改得更礼貌一点', userId: b.memberUserId },
    ])
  })

  it('POST trims the instruction and rejects an empty one → 400 (never calls the surface)', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/flow/edit`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '   ' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { code?: string }).toMatchObject({ code: 'bad_request' })
    expect(b.edit.editCalls).toHaveLength(0)
  })

  it('POST with a non-string instruction → 400', async () => {
    const res = await fetch(`${b.server.url}/api/me/workflows/flow/edit`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 42 }),
    })
    expect(res.status).toBe(400)
    expect(b.edit.editCalls).toHaveLength(0)
  })

  it('POST echoes boundary violations + detail on a boundary_locked rejection → 409', async () => {
    b.edit.editResult = {
      ok: false,
      reason: 'boundary_locked',
      message: '这次修改动到了跨 hub 的出入口。',
      violations: [
        { kind: 'egress_retargeted', stepId: 'place', detail: '出口去哪个 hub 不可改。' },
      ],
      detail: '出口去哪个 hub 不可改。',
    }
    const res = await fetch(`${b.server.url}/api/me/workflows/flow/edit`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '把订单发到另一个供货商' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code?: string
      violations?: Array<{ kind: string }>
      detail?: string
    }
    expect(body.code).toBe('boundary_locked')
    expect(body.violations?.[0]?.kind).toBe('egress_retargeted')
    expect(body.detail).toBe('出口去哪个 hub 不可改。')
  })

  it('POST maps the other surface reasons to HTTP status', async () => {
    const cases: Array<[string, number]> = [
      ['forbidden', 403],
      ['not_found', 404],
      ['no_source', 409],
      ['assistant_failed', 422],
      ['parse_failed', 422],
      ['id_changed', 422],
      ['structure_failed', 422],
      ['assistant_unavailable', 503],
    ]
    for (const [reason, status] of cases) {
      b.edit.editResult = { ok: false, reason, message: `${reason} boom` }
      const res = await fetch(`${b.server.url}/api/me/workflows/flow/edit`, {
        method: 'POST',
        headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: 'change something' }),
      })
      expect(res.status, reason).toBe(status)
      expect((await res.json()) as { code?: string }).toMatchObject({ code: reason })
    }
  })

  it('POST → 503 when no workflowEdit surface is wired', async () => {
    const b2 = await boot({ withEdit: false })
    try {
      const res = await fetch(`${b2.server.url}/api/me/workflows/flow/edit`, {
        method: 'POST',
        headers: { cookie: b2.memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: 'change something' }),
      })
      expect(res.status).toBe(503)
      expect(b2.edit.editCalls).toHaveLength(0)
    } finally {
      await teardown(b2)
    }
  })

  it('GET on the /edit path (wrong method) falls through to 404', async () => {
    // The edit path only matches POST; a GET matches neither it nor the
    // editable regex, so it falls through to the catch-all 404.
    const res = await fetch(`${b.server.url}/api/me/workflows/flow/edit`, {
      headers: { cookie: b.memberCookie },
    })
    expect(res.status).toBe(404)
  })
})
