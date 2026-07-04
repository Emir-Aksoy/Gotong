/**
 * C2 — org-quota HTTP routes.
 *
 * Coverage:
 *   GET    /api/admin/identity/org-quotas
 *     - owner-gated (member → 403)
 *     - empty initially
 *     - listed after add; decorated with usage/pct/state from sumUsage
 *
 *   POST   /api/admin/identity/org-quotas
 *     - owner-gated
 *     - happy path returns row
 *     - validates metric/period/quota
 *     - upsert preserves warnPct when omitted
 *
 *   DELETE /api/admin/identity/org-quotas/:metric/:period
 *     - removes row + 404 on miss
 *     - invalid period segment → 400
 *
 * Mirrors identity-routes-peers.test.ts structure.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@gotong/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'

interface BootResult {
  tmp: string
  hub: Hub
  space: Space
  identity: IdentityStore
  server: WebServerHandle
  baseUrl: string
  ownerCookie: string
  memberCookie: string
  ownerUserId: string
  memberUserId: string
}

async function boot(): Promise<BootResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-quotas-'))
  const init = await Space.init(tmp, { name: 'quotas-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')
  void admin
  const identity = openIdentityStore({
    dbPath: join(tmp, 'identity.sqlite'),
    masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
  })
  identity.bootstrap({
    adminToken,
    ownerEmail: 'owner@quotas.local',
    ownerDisplayName: 'Test Owner',
  })

  const ownerUser = identity.listUsers().find((u) => u.email === 'owner@quotas.local')!
  identity.setPassword(ownerUser.id, 'owner-strong-password-12')
  const member = identity.createUser({
    email: 'm@quotas.local',
    displayName: 'Member',
    password: 'member-strong-password',
    role: 'member',
  })

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
  })

  const ownerLogin = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'owner@quotas.local',
      password: 'owner-strong-password-12',
    }),
  })
  if (ownerLogin.status !== 200) {
    throw new Error(`boot: owner login failed status=${ownerLogin.status}`)
  }
  const ownerCookie = ownerLogin.headers.get('set-cookie')!.split(';')[0]!

  const memberLogin = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'm@quotas.local',
      password: 'member-strong-password',
    }),
  })
  const memberCookie = memberLogin.headers.get('set-cookie')!.split(';')[0]!

  return {
    tmp,
    hub,
    space,
    identity,
    server,
    baseUrl: server.url,
    ownerCookie,
    memberCookie,
    ownerUserId: ownerUser.id,
    memberUserId: member.id,
  }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('GET /api/admin/identity/org-quotas', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('member role → 403', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/org-quotas`, {
      headers: { cookie: b.memberCookie },
    })
    expect(r.status).toBe(403)
  })

  it('owner empty list → {quotas: []}', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/org-quotas`, {
      headers: { cookie: b.ownerCookie },
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j).toEqual({ quotas: [] })
  })

  it('lists after add, decorates with usage/pct/state', async () => {
    b.identity.setOrgQuota({
      metric: 'llm_requests',
      period: 'daily',
      quota: 100,
    })
    // Seed some usage for the owner.
    b.identity.checkAndIncrement({
      userId: b.ownerUserId,
      metric: 'llm_requests',
      period: 'daily',
      amount: 30,
    })

    const r = await fetch(`${b.baseUrl}/api/admin/identity/org-quotas`, {
      headers: { cookie: b.ownerCookie },
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as {
      quotas: Array<{
        metric: string
        period: string
        quota: number
        warnPct: number
        usage: number
        pct: number
        state: string
      }>
    }
    expect(j.quotas).toHaveLength(1)
    const q = j.quotas[0]!
    expect(q.metric).toBe('llm_requests')
    expect(q.quota).toBe(100)
    expect(q.usage).toBe(30)
    expect(q.pct).toBe(30)
    expect(q.state).toBe('ok')
  })

  it('marks state="warn" when usage crosses warnPct', async () => {
    b.identity.setOrgQuota({
      metric: 'mcp_calls',
      period: 'hourly',
      quota: 100,
      warnPct: 50,
    })
    b.identity.checkAndIncrement({
      userId: b.ownerUserId,
      metric: 'mcp_calls',
      period: 'hourly',
      amount: 55,
    })
    const r = await fetch(`${b.baseUrl}/api/admin/identity/org-quotas`, {
      headers: { cookie: b.ownerCookie },
    })
    const j = (await r.json()) as { quotas: Array<{ state: string; pct: number }> }
    expect(j.quotas[0]!.state).toBe('warn')
    expect(j.quotas[0]!.pct).toBe(55)
  })
})

describe('POST /api/admin/identity/org-quotas', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('happy path: row created', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/org-quotas`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        metric: 'llm_tokens_in',
        period: 'monthly',
        quota: 1000000,
        warnPct: 70,
      }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { quota: { metric: string; warnPct: number } }
    expect(j.quota.metric).toBe('llm_tokens_in')
    expect(j.quota.warnPct).toBe(70)
  })

  it('member → 403', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/org-quotas`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ metric: 'x', period: 'daily', quota: 10 }),
    })
    expect(r.status).toBe(403)
  })

  it('missing metric → 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/org-quotas`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ period: 'daily', quota: 10 }),
    })
    expect(r.status).toBe(400)
  })

  it('invalid period → 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/org-quotas`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ metric: 'x', period: 'fortnightly', quota: 10 }),
    })
    expect(r.status).toBe(400)
  })

  it('negative quota → 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/org-quotas`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ metric: 'x', period: 'daily', quota: -1 }),
    })
    expect(r.status).toBe(400)
  })

  it('upsert preserves warnPct when omitted', async () => {
    // First save with custom warnPct.
    await fetch(`${b.baseUrl}/api/admin/identity/org-quotas`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        metric: 'm', period: 'daily', quota: 100, warnPct: 33,
      }),
    })
    // Second save without warnPct should keep 33.
    const r = await fetch(`${b.baseUrl}/api/admin/identity/org-quotas`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ metric: 'm', period: 'daily', quota: 200 }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { quota: { quota: number; warnPct: number } }
    expect(j.quota.quota).toBe(200)
    expect(j.quota.warnPct).toBe(33)
  })
})

describe('DELETE /api/admin/identity/org-quotas/:metric/:period', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('removes existing row', async () => {
    b.identity.setOrgQuota({
      metric: 'dropme',
      period: 'hourly',
      quota: 10,
    })
    const r = await fetch(
      `${b.baseUrl}/api/admin/identity/org-quotas/dropme/hourly`,
      { method: 'DELETE', headers: { cookie: b.ownerCookie } },
    )
    expect(r.status).toBe(200)
    expect(b.identity.getOrgQuota('dropme', 'hourly')).toBeNull()
  })

  it('unknown tuple → 404', async () => {
    const r = await fetch(
      `${b.baseUrl}/api/admin/identity/org-quotas/nope/daily`,
      { method: 'DELETE', headers: { cookie: b.ownerCookie } },
    )
    expect(r.status).toBe(404)
  })

  it('invalid period segment → 400', async () => {
    const r = await fetch(
      `${b.baseUrl}/api/admin/identity/org-quotas/m/bogus`,
      { method: 'DELETE', headers: { cookie: b.ownerCookie } },
    )
    expect(r.status).toBe(400)
  })

  it('member → 403', async () => {
    b.identity.setOrgQuota({ metric: 'x', period: 'daily', quota: 10 })
    const r = await fetch(
      `${b.baseUrl}/api/admin/identity/org-quotas/x/daily`,
      { method: 'DELETE', headers: { cookie: b.memberCookie } },
    )
    expect(r.status).toBe(403)
  })

  it('metric segment is URL-encoded round-trip', async () => {
    b.identity.setOrgQuota({
      metric: 'with spaces',
      period: 'daily',
      quota: 1,
    })
    const r = await fetch(
      `${b.baseUrl}/api/admin/identity/org-quotas/${encodeURIComponent('with spaces')}/daily`,
      { method: 'DELETE', headers: { cookie: b.ownerCookie } },
    )
    expect(r.status).toBe(200)
    expect(b.identity.getOrgQuota('with spaces', 'daily')).toBeNull()
  })
})
