/**
 * Phase 17 (Sprint 4) — usage/cost ledger + audit export HTTP routes.
 *
 * Full-server integration (real IdentityStore seeded via appendLedger /
 * writeAuditLog + serveWeb + fetch). Verifies owner-gating, filtering,
 * aggregation, and CSV / JSONL export shape for:
 *
 *   GET /api/admin/identity/usage/ledger
 *   GET /api/admin/identity/usage/ledger/export
 *   GET /api/admin/identity/usage/summary
 *   GET /api/admin/identity/audit/export
 *
 * Boot mirrors identity-routes-org-quotas.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@aipehub/identity'

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
}

const D15 = Date.UTC(2026, 3, 15, 10, 0, 0)
const D16 = Date.UTC(2026, 3, 16, 9, 0, 0)

async function boot(): Promise<BootResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-usage-'))
  const init = await Space.init(tmp, { name: 'usage-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { token: adminToken } = await space.createAdmin('TestAdmin')
  const identity = openIdentityStore({
    dbPath: join(tmp, 'identity.sqlite'),
    masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
  })
  identity.bootstrap({
    adminToken,
    ownerEmail: 'owner@usage.local',
    ownerDisplayName: 'Owner',
  })
  const ownerUser = identity.listUsers().find((u) => u.email === 'owner@usage.local')!
  identity.setPassword(ownerUser.id, 'owner-strong-password-12')
  identity.createUser({
    email: 'm@usage.local',
    displayName: 'Member',
    password: 'member-strong-password',
    role: 'member',
  })

  // Seed ledger rows.
  identity.appendLedger({ ts: D15, userId: 'u1', agentId: 'a1', model: 'claude-opus-4', provider: 'anthropic', inputTokens: 1000, outputTokens: 200, costMicros: 30_000 })
  identity.appendLedger({ ts: D15, userId: 'u2', agentId: 'a1', model: 'gpt-4o', provider: 'openai', inputTokens: 500, outputTokens: 100, costMicros: 2_250 })
  identity.appendLedger({ ts: D16, userId: 'u1', agentId: 'a2', model: 'claude-opus-4', provider: 'anthropic', inputTokens: 2000, outputTokens: 400, costMicros: 60_000 })

  const server = await serveWeb(hub, { host: '127.0.0.1', port: 0, identity })

  const ownerCookie = await login(server.url, 'owner@usage.local', 'owner-strong-password-12')
  const memberCookie = await login(server.url, 'm@usage.local', 'member-strong-password')

  return { tmp, hub, space, identity, server, baseUrl: server.url, ownerCookie, memberCookie }
}

async function login(base: string, email: string, password: string): Promise<string> {
  const r = await fetch(`${base}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`)
  return r.headers.get('set-cookie')!.split(';')[0]!
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('usage ledger routes (Phase 17)', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  function get(path: string, cookie: string): Promise<Response> {
    return fetch(`${b.baseUrl}${path}`, { headers: { cookie } })
  }

  it('member role → 403 on every usage route', async () => {
    for (const p of [
      '/api/admin/identity/usage/ledger',
      '/api/admin/identity/usage/summary',
      '/api/admin/identity/usage/ledger/export',
      '/api/admin/identity/audit/export',
    ]) {
      expect((await get(p, b.memberCookie)).status).toBe(403)
    }
  })

  it('GET /usage/ledger lists newest-first', async () => {
    const r = await get('/api/admin/identity/usage/ledger', b.ownerCookie)
    expect(r.status).toBe(200)
    const j = (await r.json()) as { entries: Array<{ ts: number }> }
    expect(j.entries).toHaveLength(3)
    expect(j.entries[0].ts).toBe(D16) // most recent first
  })

  it('GET /usage/ledger?userId= filters', async () => {
    const r = await get('/api/admin/identity/usage/ledger?userId=u1', b.ownerCookie)
    const j = (await r.json()) as { entries: unknown[] }
    expect(j.entries).toHaveLength(2)
  })

  it('GET /usage/summary?groupBy=user aggregates cost', async () => {
    const r = await get('/api/admin/identity/usage/summary?groupBy=user', b.ownerCookie)
    expect(r.status).toBe(200)
    const j = (await r.json()) as {
      groupBy: string
      rows: Array<{ key: string; calls: number; costMicros: number }>
    }
    expect(j.groupBy).toBe('user')
    const byKey = Object.fromEntries(j.rows.map((x) => [x.key, x]))
    expect(byKey['u1'].calls).toBe(2)
    expect(byKey['u1'].costMicros).toBe(90_000)
    expect(byKey['u2'].costMicros).toBe(2_250)
    // Ordered cost DESC → u1 first.
    expect(j.rows[0].key).toBe('u1')
  })

  it('GET /usage/summary?groupBy=bad → 400', async () => {
    const r = await get('/api/admin/identity/usage/summary?groupBy=nope', b.ownerCookie)
    expect(r.status).toBe(400)
  })

  it('GET /usage/ledger/export?format=csv → CSV attachment', async () => {
    const r = await get('/api/admin/identity/usage/ledger/export?format=csv', b.ownerCookie)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/csv')
    expect(r.headers.get('content-disposition')).toContain('attachment')
    expect(r.headers.get('content-disposition')).toContain('usage-ledger.csv')
    const text = await r.text()
    const lines = text.trim().split('\n')
    expect(lines[0]).toContain('id,ts,iso_ts')
    expect(lines[0]).toContain('cost_micros')
    expect(lines).toHaveLength(4) // header + 3 rows
  })

  it('GET /usage/ledger/export?format=jsonl → NDJSON', async () => {
    const r = await get('/api/admin/identity/usage/ledger/export?format=jsonl', b.ownerCookie)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('application/x-ndjson')
    const text = await r.text()
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(3)
    const first = JSON.parse(lines[0]) as { model: string }
    expect(first.model).toBe('claude-opus-4')
  })

  it('GET /audit/export?format=csv → audit CSV (owner-only)', async () => {
    b.identity.writeAuditLog({
      action: 'test_event',
      actorSource: 'system',
      success: true,
    })
    const r = await get('/api/admin/identity/audit/export?format=csv', b.ownerCookie)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/csv')
    expect(r.headers.get('content-disposition')).toContain('audit-log.csv')
    const text = await r.text()
    expect(text.split('\n')[0]).toContain('action')
    expect(text).toContain('test_event')
  })
})
