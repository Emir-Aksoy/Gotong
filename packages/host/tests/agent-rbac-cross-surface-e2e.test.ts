/**
 * v5 E4-M3 — agent RBAC cross-surface acceptance gate.
 *
 * Two surfaces enforce the SAME agent ownership:
 *   1. the admin routes  (`/api/admin/agents/*`, web layer, E4-M1)
 *   2. the member self-service grants service (`HostMeAgentGrantsService`,
 *      Route B P1-M1)
 *
 * Each is unit-tested in isolation. What neither covers — and what would
 * silently split-brain if someone changed the grant key shape on one side —
 * is that they operate on ONE `resource_grants` source of truth: a grant made
 * on either surface must be visible AND enforced on the other.
 *
 * This boots a REAL Space + Hub + IdentityStore + serveWeb (the admin route)
 * and constructs HostMeAgentGrantsService against the SAME store (the /me
 * surface), then drives a grant across the seam in both directions. `mock`
 * agents persist without an API key (no lifecycle wired), so it needs no LLM.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import { serveWeb, type WebServerHandle } from '@gotong/web'

import { HostMeAgentGrantsService } from '../src/me-agent-grants-service.js'

const base = { provider: 'mock', system: 'you are a test agent', capabilities: ['chat'] }

interface Boot {
  tmp: string
  hub: Hub
  space: Space
  identity: IdentityStore
  server: WebServerHandle
  baseUrl: string
  meGrants: HostMeAgentGrantsService
  /** v4 admin (role='admin', NOT owner) — the RBAC-restricted principal. */
  adminACookie: string
  adminAUserId: string
  adminBCookie: string
  adminBUserId: string
}

async function boot(): Promise<Boot> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-agent-xsurface-'))
  const space = (await Space.init(tmp, { name: 'xsurface-test' })).space
  const hub = new Hub({ space })
  await hub.start()

  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
  identity.bootstrap({ ownerEmail: 'owner@local', ownerDisplayName: 'Owner' })

  const a = identity.createUser({ email: 'admin-a@local', displayName: 'AdminA', role: 'admin', password: 'admin-a-password-123' })
  const adminACookie = `gotong_identity=${identity.authenticatePassword({ email: 'admin-a@local', password: 'admin-a-password-123' }).token}`
  const bUser = identity.createUser({ email: 'admin-b@local', displayName: 'AdminB', role: 'admin', password: 'admin-b-password-123' })
  const adminBCookie = `gotong_identity=${identity.authenticatePassword({ email: 'admin-b@local', password: 'admin-b-password-123' }).token}`

  const server = await serveWeb(hub, { host: '127.0.0.1', port: 0, identity })
  // The /me grants surface, against the very same identity store the routes use.
  const meGrants = new HostMeAgentGrantsService({ identity })

  return {
    tmp, hub, space, identity, server, baseUrl: server.url, meGrants,
    adminACookie, adminAUserId: a.id, adminBCookie, adminBUserId: bUser.id,
  }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

function asCookie(b: Boot, cookie: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { cookie }
  let payload: string | undefined
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  return fetch(`${b.baseUrl}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) })
}

const editBody = (id: string) => ({ ...base, id, system: 'edited prompt' })

describe('agent RBAC — admin route ⇄ /me grants share one source of truth (v5 E4-M3)', () => {
  let b: Boot
  beforeEach(async () => {
    b = await boot()
    // AdminA creates an agent through the ADMIN route → seeds AdminA as owner.
    const r = await asCookie(b, b.adminACookie, 'POST', '/api/admin/agents', { ...base, id: 'shared1' })
    expect(r.status).toBe(200)
  })
  afterEach(async () => { await teardown(b) })

  it('admin-route create seeds an owner the /me surface sees', async () => {
    // The owner grant written by the admin route is visible to the same user
    // through the /me grants service — same resource_grants row, no split-brain.
    const grants = await b.meGrants.list(b.adminAUserId, 'shared1')
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ principalKind: 'user', principalId: b.adminAUserId, perm: 'owner', isSelf: true })
  })

  it('a grant made on the /me surface is ENFORCED by the admin route', async () => {
    // Before any grant, AdminB is a non-owner admin → admin route refuses edit.
    const before = await asCookie(b, b.adminBCookie, 'PUT', '/api/admin/agents/shared1', editBody('shared1'))
    expect(before.status).toBe(403)
    expect((await before.json()).code).toBe('agent_forbidden')

    // AdminA grants AdminB 'editor' via the /me self-service surface…
    await b.meGrants.set(b.adminAUserId, 'shared1', { principalKind: 'user', principalId: b.adminBUserId, perm: 'editor' })

    // …and the ADMIN route now honors it: editor may PUT, but DELETE is owner-gated.
    const put = await asCookie(b, b.adminBCookie, 'PUT', '/api/admin/agents/shared1', editBody('shared1'))
    expect(put.status).toBe(200)
    const del = await asCookie(b, b.adminBCookie, 'DELETE', '/api/admin/agents/shared1')
    expect(del.status).toBe(403)
    expect((await del.json()).code).toBe('agent_forbidden')
  })

  it('a grant made on the admin route is visible + manageable on the /me surface', async () => {
    // AdminA promotes AdminB to co-owner through the ADMIN grant route…
    const grant = await asCookie(b, b.adminACookie, 'POST', '/api/admin/agents/shared1/grants', { userId: b.adminBUserId, perm: 'owner' })
    expect(grant.status).toBe(200)

    // …and AdminB, now a co-owner, can read the access list via /me (the admin
    // grant landed in the same row the /me surface authorizes against).
    const grants = await b.meGrants.list(b.adminBUserId, 'shared1')
    expect(grants.map((g) => g.principalId).sort()).toEqual([b.adminAUserId, b.adminBUserId].sort())
    expect(grants.every((g) => g.perm === 'owner')).toBe(true)
  })

  it('deleting the agent on the admin route clears the grants the /me surface relied on', async () => {
    // The agent's owner deletes it through the admin route…
    const del = await asCookie(b, b.adminACookie, 'DELETE', '/api/admin/agents/shared1')
    expect(del.status).toBe(200)

    // …and the /me surface no longer sees AdminA as an owner — anti-enumeration
    // 404 (removeAllAgentGrants ran, so a same-id re-create starts clean).
    await expect(b.meGrants.list(b.adminAUserId, 'shared1')).rejects.toMatchObject({ status: 404 })
  })
})
