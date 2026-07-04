/**
 * Phase 6 #1 — peer reputation read-only dashboard HTTP route.
 *
 * Coverage:
 *   GET /api/admin/identity/reputation
 *     - owner-gated (member → 403)
 *     - 503 when host did not wire the reputation adapter
 *     - empty snapshot → {reputation: []}
 *     - data → sorted desc by score, then sampleCount, then peerHubId
 *     - label join: peer with row in identity.peers shows label, others null
 *
 * The adapter under test is a closure injected into `serveWeb({ reputation })`.
 * The route is purely a sort + pass-through, so we inject a stub snapshot
 * function rather than wiring a real hub.reputation. That keeps the test
 * focused on the route's contract: gating + sort + JSON shape.
 *
 * Mirrors identity-routes-org-quotas.test.ts boot/teardown structure.
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

import {
  serveWeb,
  type WebServerHandle,
  type IdentityPeerReputationDTO,
} from '../src/server.js'

interface BootResult {
  tmp: string
  hub: Hub
  space: Space
  identity: IdentityStore
  server: WebServerHandle
  baseUrl: string
  ownerCookie: string
  memberCookie: string
  /** Mutable reference the stub adapter reads each call — tests rewrite. */
  snapshotData: IdentityPeerReputationDTO[]
}

async function boot(opts: { withAdapter: boolean } = { withAdapter: true }): Promise<BootResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-reputation-'))
  const init = await Space.init(tmp, { name: 'reputation-test' })
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
    ownerEmail: 'owner@rep.local',
    ownerDisplayName: 'Test Owner',
  })

  const ownerUser = identity.listUsers().find((u) => u.email === 'owner@rep.local')!
  identity.setPassword(ownerUser.id, 'owner-strong-password-12')
  identity.createUser({
    email: 'm@rep.local',
    displayName: 'Member',
    password: 'member-strong-password',
    role: 'member',
  })

  // Mutable holder so individual tests can rewrite the snapshot without
  // bouncing the server. Snapshot adapter just returns whatever's here.
  const snapshotData: IdentityPeerReputationDTO[] = []

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(opts.withAdapter
      ? { reputation: { snapshot: () => snapshotData.slice() } }
      : {}),
  })

  const ownerLogin = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'owner@rep.local',
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
      email: 'm@rep.local',
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
    snapshotData,
  }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('GET /api/admin/identity/reputation', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('member role → 403', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/reputation`, {
      headers: { cookie: b.memberCookie },
    })
    expect(r.status).toBe(403)
  })

  it('owner empty snapshot → {reputation: []}', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/reputation`, {
      headers: { cookie: b.ownerCookie },
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j).toEqual({ reputation: [] })
  })

  it('sorts desc by score, then sampleCount, then peerHubId', async () => {
    // Intentionally insert in wrong order — the route must sort.
    b.snapshotData.push(
      { peerHubId: 'hub_bottom', score: -0.5, sampleCount: 1, lastUpdatedAt: 1, label: null },
      { peerHubId: 'hub_top',    score:  0.9, sampleCount: 8, lastUpdatedAt: 2, label: 'A' },
      // Tie on score → sampleCount tie-break wins for hub_b_more.
      { peerHubId: 'hub_b_more', score:  0.5, sampleCount: 10, lastUpdatedAt: 3, label: null },
      { peerHubId: 'hub_b_less', score:  0.5, sampleCount: 2,  lastUpdatedAt: 4, label: null },
      // Same score + same sampleCount → peerHubId localeCompare wins.
      { peerHubId: 'hub_z_tie',  score: 0.1, sampleCount: 5, lastUpdatedAt: 5, label: null },
      { peerHubId: 'hub_a_tie',  score: 0.1, sampleCount: 5, lastUpdatedAt: 6, label: null },
    )

    const r = await fetch(`${b.baseUrl}/api/admin/identity/reputation`, {
      headers: { cookie: b.ownerCookie },
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { reputation: IdentityPeerReputationDTO[] }
    expect(j.reputation.map((p) => p.peerHubId)).toEqual([
      'hub_top',     // 0.9
      'hub_b_more',  // 0.5 / 10
      'hub_b_less',  // 0.5 / 2
      'hub_a_tie',   // 0.1 / 5, "a" < "z"
      'hub_z_tie',   // 0.1 / 5
      'hub_bottom',  // -0.5
    ])
  })

  it('non-finite scores sort to the end stably (Audit #152)', async () => {
    // Defensive: snapshot rows with NaN / Infinity score (sampleCount=0
    // EWMA corner) used to shuffle around because the comparator's
    // (a.score - b.score) is NaN, making sort order implementation-
    // defined. Pin them to the end with a stable peerHubId tie-break.
    b.snapshotData.push(
      { peerHubId: 'hub_nan_a', score: Number.NaN,     sampleCount: 0, lastUpdatedAt: 1, label: null },
      { peerHubId: 'hub_inf',   score: Number.POSITIVE_INFINITY, sampleCount: 0, lastUpdatedAt: 2, label: null },
      { peerHubId: 'hub_real',  score: 0.4, sampleCount: 5, lastUpdatedAt: 3, label: null },
      { peerHubId: 'hub_nan_b', score: Number.NaN,     sampleCount: 0, lastUpdatedAt: 4, label: null },
    )
    const r = await fetch(`${b.baseUrl}/api/admin/identity/reputation`, {
      headers: { cookie: b.ownerCookie },
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { reputation: IdentityPeerReputationDTO[] }
    // Real finite score first; then non-finite block, alphabetical.
    // Note: JSON.stringify(NaN) → "null", so when the row crosses the
    // wire the score becomes null on the client. The sort still must
    // happen server-side BEFORE serialization, which is what this test
    // pins.
    expect(j.reputation.map((p) => p.peerHubId)).toEqual([
      'hub_real',
      'hub_inf',     // Infinity is also non-finite per Number.isFinite
      'hub_nan_a',
      'hub_nan_b',
    ])
  })

  it('preserves label join from snapshot adapter', async () => {
    b.snapshotData.push(
      { peerHubId: 'hub_with_label', score: 0.7, sampleCount: 3, lastUpdatedAt: 100, label: 'Supplier' },
      { peerHubId: 'hub_anon',       score: 0.3, sampleCount: 1, lastUpdatedAt: 200, label: null },
    )
    const r = await fetch(`${b.baseUrl}/api/admin/identity/reputation`, {
      headers: { cookie: b.ownerCookie },
    })
    const j = (await r.json()) as { reputation: IdentityPeerReputationDTO[] }
    expect(j.reputation).toHaveLength(2)
    expect(j.reputation[0]!.label).toBe('Supplier')
    expect(j.reputation[0]!.peerHubId).toBe('hub_with_label')
    expect(j.reputation[1]!.label).toBeNull()
  })

  it('snapshot adapter exception bubbles as 500', async () => {
    // Inject an adapter that throws — make sure the route surfaces a
    // clean 500 rather than crashing the request. We rebuild the server
    // for this case so the snapshot fn is the throwing one.
    await b.server.close()
    const throwingHandle = await serveWeb(b.hub, {
      host: '127.0.0.1',
      port: 0,
      identity: b.identity,
      reputation: {
        snapshot: () => {
          throw new Error('disk read failed')
        },
      },
    })
    const r = await fetch(`${throwingHandle.url}/api/admin/identity/reputation`, {
      headers: { cookie: b.ownerCookie },
    })
    expect(r.status).toBe(500)
    await throwingHandle.close()
    // Re-open a working server so afterEach's teardown still has
    // something to close cleanly (it closes b.server).
    b.server = await serveWeb(b.hub, {
      host: '127.0.0.1',
      port: 0,
      identity: b.identity,
      reputation: { snapshot: () => [] },
    })
    b.baseUrl = b.server.url
  })
})

describe('GET /api/admin/identity/reputation (no adapter wired)', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot({ withAdapter: false }) })
  afterEach(async () => { await teardown(b) })

  it('owner → 503 (host opt-out, UI surfaces inline)', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/reputation`, {
      headers: { cookie: b.ownerCookie },
    })
    expect(r.status).toBe(503)
    const j = (await r.json()) as { error: string }
    expect(j.error).toMatch(/reputation/i)
  })

  it('member → 403 (owner gate still wins over 503)', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/reputation`, {
      headers: { cookie: b.memberCookie },
    })
    expect(r.status).toBe(403)
  })
})
