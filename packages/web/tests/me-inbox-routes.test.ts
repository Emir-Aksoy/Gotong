/**
 * HTTP tests for `/api/me/inbox` — member task inbox (Phase 16 M4).
 *
 * Boots a real Space + Hub + IdentityStore + serveWeb with a FAKE
 * `InboxSurface` so we exercise the routes (auth gate, userId forcing, error
 * → status mapping, degradation when unwired) without the host's two-step
 * resume. The real resume orchestration is covered by the M5 service test and
 * the M7 E2E gate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type { InboxItemView, InboxSurface } from '../src/me-routes.js'

/** Records every call so the tests can assert userId forcing + pass-through. */
class FakeInbox implements InboxSurface {
  pending: InboxItemView[] = []
  readonly listPendingCalls: string[] = []
  readonly resolveCalls: Array<{ itemId: string; userId: string; decision: unknown }> = []
  /** When set, `resolve` throws an error carrying this `.code`. */
  resolveError: { code: string; message: string } | null = null

  async listPending(userId: string): Promise<InboxItemView[]> {
    this.listPendingCalls.push(userId)
    return this.pending
  }
  async resolve(args: { itemId: string; userId: string; decision: unknown }): Promise<void> {
    this.resolveCalls.push(args)
    if (this.resolveError) {
      const e = new Error(this.resolveError.message) as Error & { code?: string }
      e.code = this.resolveError.code
      throw e
    }
  }
}

interface Boot {
  tmp: string
  hub: Hub
  identity: IdentityStore
  server: WebServerHandle
  memberUserId: string
  memberCookie: string
  inbox: FakeInbox
}

async function boot(opts: { withInbox?: boolean } = {}): Promise<Boot> {
  const withInbox = opts.withInbox ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-inbox-'))
  const space = (await Space.init(tmp, { name: 'inbox-test' })).space
  const hub = new Hub({ space })
  await hub.start()

  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')
  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
  identity.bootstrap({ adminToken, ownerEmail: 'admin@local', ownerDisplayName: 'TestAdmin' })
  const member = identity.createUser({
    email: 'member@team.test',
    displayName: 'Test Member',
    password: 'member-strong-password',
    role: 'member',
  })

  const inbox = new FakeInbox()
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(withInbox ? { inbox } : {}),
  })

  const loginRes = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'member@team.test', password: 'member-strong-password' }),
  })
  if (loginRes.status !== 200) throw new Error(`member login failed: ${loginRes.status}`)
  const memberCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

  return { tmp, hub, identity, server, memberUserId: member.id, memberCookie, inbox }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

const APPROVAL = { kind: 'approval', approved: true }

describe('/api/me/inbox', () => {
  let b: Boot
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(() => teardown(b))

  it('401 without a v4 session', async () => {
    const res = await fetch(`${b.server.url}/api/me/inbox`)
    expect(res.status).toBe(401)
  })

  it('GET lists pending items scoped to the caller (userId forced server-side)', async () => {
    b.inbox.pending = [
      { itemId: 'i1', kind: 'approval', prompt: 'Approve?', createdAt: 2 },
      { itemId: 'i2', kind: 'choice', prompt: 'Pick', options: [{ value: 'a' }], createdAt: 1 },
    ]
    const res = await fetch(`${b.server.url}/api/me/inbox`, {
      headers: { cookie: b.memberCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: InboxItemView[] }
    expect(body.items.map((i) => i.itemId)).toEqual(['i1', 'i2'])
    // The route passed the SESSION userId to the surface — a member can't list
    // another user's items by tampering with the request.
    expect(b.inbox.listPendingCalls).toEqual([b.memberUserId])
  })

  it('GET degrades to an empty list when no inbox is wired', async () => {
    const b2 = await boot({ withInbox: false })
    try {
      const res = await fetch(`${b2.server.url}/api/me/inbox`, {
        headers: { cookie: b2.memberCookie },
      })
      expect(res.status).toBe(200)
      expect((await res.json()) as { items: unknown[] }).toEqual({ items: [] })
    } finally {
      await teardown(b2)
    }
  })

  it('POST resolve forwards itemId + forced userId + decision, returns 200', async () => {
    const res = await fetch(`${b.server.url}/api/me/inbox/i1/resolve`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: APPROVAL }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true, itemId: 'i1' })
    expect(b.inbox.resolveCalls).toEqual([
      { itemId: 'i1', userId: b.memberUserId, decision: APPROVAL },
    ])
  })

  it('POST resolve maps surface error codes to HTTP status', async () => {
    const cases: Array<[string, number]> = [
      ['not_found', 404],
      ['forbidden', 403],
      ['already_resolved', 409],
      ['invalid_decision', 400],
    ]
    for (const [code, status] of cases) {
      b.inbox.resolveError = { code, message: `${code} boom` }
      const res = await fetch(`${b.server.url}/api/me/inbox/ix/resolve`, {
        method: 'POST',
        headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: APPROVAL }),
      })
      expect(res.status, code).toBe(status)
      expect((await res.json()) as { code?: string }).toMatchObject({ code })
    }
  })

  it('POST resolve with a missing decision → 400', async () => {
    const res = await fetch(`${b.server.url}/api/me/inbox/i1/resolve`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(b.inbox.resolveCalls).toHaveLength(0)
  })

  it('POST resolve with no inbox wired → 503', async () => {
    const b2 = await boot({ withInbox: false })
    try {
      const res = await fetch(`${b2.server.url}/api/me/inbox/i1/resolve`, {
        method: 'POST',
        headers: { cookie: b2.memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: APPROVAL }),
      })
      expect(res.status).toBe(503)
    } finally {
      await teardown(b2)
    }
  })

  it('unknown /me/inbox sub-path falls through to 404', async () => {
    // GET on the resolve path matches neither the exact GET nor the POST regex.
    const res = await fetch(`${b.server.url}/api/me/inbox/i1/resolve`, {
      headers: { cookie: b.memberCookie },
    })
    expect(res.status).toBe(404)
  })
})
