/**
 * D1.2 — peer registry HTTP routes.
 *
 * Coverage:
 *   GET    /api/admin/identity/peers
 *     - owner-gated (member → 403)
 *     - empty initially
 *     - listed after add; merges peerRegistry.status() when supplied
 *
 *   POST   /api/admin/identity/peers
 *     - owner-gated
 *     - happy path: returns row, vault entry created, invalidate() called
 *     - duplicate peerId → 409-ish via identity error
 *     - input validation: missing fields → 400
 *
 *   PATCH  /api/admin/identity/peers/:id
 *     - label-only / enabled / endpointUrl / peerToken rotation round-trip
 *
 *   DELETE /api/admin/identity/peers/:id
 *     - removes row, returns ok
 *     - missing id → 404
 *
 * Stub peerRegistry tracks .invalidate() calls so we assert each
 * mutation triggered a reload kick without spinning up real HubLinks.
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
  invalidateCount: { n: number }
  refreshPolicyCount: { n: number }
}

async function boot(): Promise<BootResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-peers-'))
  const init = await Space.init(tmp, { name: 'peers-test' })
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
    ownerEmail: 'owner@peers.local',
    ownerDisplayName: 'Test Owner',
  })

  // Owner needs a password to log in (bootstrap leaves it credential-less).
  const ownerUser = identity.listUsers().find((u) => u.email === 'owner@peers.local')!
  identity.setPassword(ownerUser.id, 'owner-strong-password-12')
  identity.createUser({
    email: 'm@peers.local',
    displayName: 'Member',
    password: 'member-strong-password',
    role: 'member',
  })

  const invalidateCount = { n: 0 }
  const refreshPolicyCount = { n: 0 }
  const peerRegistry = {
    invalidate: () => { invalidateCount.n++ },
    refreshPolicy: () => { refreshPolicyCount.n++ },
    status: () => [],
  }

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    peerRegistry,
  })

  const ownerLogin = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'owner@peers.local',
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
      email: 'm@peers.local',
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
    invalidateCount,
    refreshPolicyCount,
  }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity.close()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('GET /api/admin/identity/peers', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('member role → 403', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      headers: { cookie: b.memberCookie },
    })
    expect(r.status).toBe(403)
  })

  it('owner empty list → {peers: []}', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      headers: { cookie: b.ownerCookie },
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j).toEqual({ peers: [] })
  })

  it('lists after add, includes registry status fields', async () => {
    b.identity.addPeer({
      peerId: 'hub_remote',
      endpointUrl: 'wss://remote.example',
      label: 'Remote',
      peerToken: 'tok-xxxxxxxxxxxx',
    })
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      headers: { cookie: b.ownerCookie },
    })
    const j = (await r.json()) as { peers: Array<Record<string, unknown>> }
    expect(j.peers.length).toBe(1)
    expect(j.peers[0]!.peerId).toBe('hub_remote')
    // connected:false because the stub registry returns empty status.
    expect(j.peers[0]!.connected).toBe(false)
    expect(j.peers[0]!.backoffAttempts).toBe(0)
  })
})

describe('POST /api/admin/identity/peers', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('happy path: row created, invalidate called, vault entry exists', async () => {
    const before = b.invalidateCount.n
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_a',
        endpointUrl: 'wss://a.example',
        label: 'A',
        peerToken: 'tok-aaaaaaaaaaaaa',
      }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { peer: { id: string; peerId: string } }
    expect(j.peer.peerId).toBe('hub_a')
    expect(b.invalidateCount.n).toBe(before + 1)
    // Vault entry round-trips.
    expect(b.identity.getPeerToken(j.peer.id)).toBe('tok-aaaaaaaaaaaaa')
  })

  it('member → 403', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'h',
        endpointUrl: 'wss://x',
        peerToken: 't-12345678',
      }),
    })
    expect(r.status).toBe(403)
  })

  it('missing peerId → 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        endpointUrl: 'wss://x',
        peerToken: 't-12345678',
      }),
    })
    expect(r.status).toBe(400)
  })

  it('duplicate peerId → error', async () => {
    b.identity.addPeer({
      peerId: 'hub_dup',
      endpointUrl: 'wss://d.example',
      peerToken: 'tok-1234567890',
    })
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_dup',
        endpointUrl: 'wss://other.example',
        peerToken: 'tok-different-tok',
      }),
    })
    expect(r.status).toBeGreaterThanOrEqual(400)
  })
})

describe('PATCH /api/admin/identity/peers/:id', () => {
  let b: BootResult
  let peerId: string
  beforeEach(async () => {
    b = await boot()
    peerId = b.identity.addPeer({
      peerId: 'hub_patch',
      endpointUrl: 'wss://p.example',
      label: 'orig',
      peerToken: 'tok-original-123',
    }).id
  })
  afterEach(async () => { await teardown(b) })

  it('label + enabled round-trip + invalidate called', async () => {
    const before = b.invalidateCount.n
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers/${peerId}`, {
      method: 'PATCH',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'renamed', enabled: false }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { peer: { label: string; enabled: boolean } }
    expect(j.peer.label).toBe('renamed')
    expect(j.peer.enabled).toBe(false)
    expect(b.invalidateCount.n).toBe(before + 1)
  })

  it('peerToken rotation reflects in getPeerToken', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers/${peerId}`, {
      method: 'PATCH',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ peerToken: 'tok-rotated-7890' }),
    })
    expect(r.status).toBe(200)
    expect(b.identity.getPeerToken(peerId)).toBe('tok-rotated-7890')
  })

  // Audit #144 — PATCH on a missing peer used to fall through the
  // sendIdentityError switch to the default 500 branch. The store
  // throws IdentityError({code: 'peer_not_found'}); web now maps it
  // explicitly to 404 so the UI can render "row gone" vs "server bug".
  it('unknown id → 404 (was 500 before audit #144)', async () => {
    const r = await fetch(
      `${b.baseUrl}/api/admin/identity/peers/missing_row`,
      {
        method: 'PATCH',
        headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'whatever' }),
      },
    )
    expect(r.status).toBe(404)
    const j = (await r.json()) as { code?: string }
    expect(j.code).toBe('peer_not_found')
  })
})

describe('DELETE /api/admin/identity/peers/:id', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('removes existing row + invalidate called', async () => {
    const id = b.identity.addPeer({
      peerId: 'hub_rm',
      endpointUrl: 'wss://rm.example',
      peerToken: 'tok-rm-12345678',
    }).id
    const before = b.invalidateCount.n
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'DELETE',
      headers: { cookie: b.ownerCookie },
    })
    expect(r.status).toBe(200)
    expect(b.invalidateCount.n).toBe(before + 1)
    expect(b.identity.getPeer(id)).toBeNull()
  })

  it('unknown id → 404', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers/not_there`, {
      method: 'DELETE',
      headers: { cookie: b.ownerCookie },
    })
    expect(r.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Phase 18 B-M2 — per-peer trust-contract policy over the same CRUD routes.
//
// The host-side proof that a stored ACL actually gates inbound tasks lives in
// host/tests/peer-policy-acl.test.ts. What these pin is the WEB seam: the four
// policy fields (kind / acl / outboundCaps / requireApprovalOutbound) validate,
// persist, and round-trip; and a policy/endpoint edit kicks refreshPolicy()
// (full re-dial of a connected peer) rather than the plain invalidate() that a
// label/token edit gets — invalidate alone keeps the existing link, so a saved
// ACL would silently not take effect ("我保存了但没变").
// ---------------------------------------------------------------------------
describe('peer policy fields (Phase 18 B-M2)', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('POST persists all four policy fields + round-trips via getPeer', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_policy',
        endpointUrl: 'wss://policy.example',
        peerToken: 'tok-policy-12345',
        kind: 'organization',
        acl: { capabilities: ['probe'], requireOrigin: true },
        outboundCaps: ['chat'],
        requireApprovalOutbound: true,
      }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as {
      peer: {
        id: string
        kind: string
        acl: { capabilities?: string[]; requireOrigin?: boolean } | null
        outboundCaps: string[] | null
        requireApprovalOutbound: boolean
      }
    }
    expect(j.peer.kind).toBe('organization')
    expect(j.peer.acl).toEqual({ capabilities: ['probe'], requireOrigin: true })
    expect(j.peer.outboundCaps).toEqual(['chat'])
    expect(j.peer.requireApprovalOutbound).toBe(true)
    // Persisted, not just echoed.
    const stored = b.identity.getPeer(j.peer.id)!
    expect(stored.kind).toBe('organization')
    expect(stored.acl).toEqual({ capabilities: ['probe'], requireOrigin: true })
    expect(stored.outboundCaps).toEqual(['chat'])
    expect(stored.requireApprovalOutbound).toBe(true)
  })

  it('POST without policy fields → defaults (kind=service, acl null)', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_default',
        endpointUrl: 'wss://default.example',
        peerToken: 'tok-default-1234',
      }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as {
      peer: { kind: string; acl: unknown; requireApprovalOutbound: boolean }
    }
    expect(j.peer.kind).toBe('service')
    expect(j.peer.acl).toBeNull()
    expect(j.peer.requireApprovalOutbound).toBe(false)
  })

  it('POST invalid kind → 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_badkind',
        endpointUrl: 'wss://x.example',
        peerToken: 'tok-badkind-123',
        kind: 'bogus',
      }),
    })
    expect(r.status).toBe(400)
  })

  it('POST acl with non-array capabilities → 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_badacl',
        endpointUrl: 'wss://x.example',
        peerToken: 'tok-badacl-1234',
        acl: { capabilities: 'probe' },
      }),
    })
    expect(r.status).toBe(400)
  })

  it('POST outboundCaps not an array → 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_badout',
        endpointUrl: 'wss://x.example',
        peerToken: 'tok-badout-1234',
        outboundCaps: 'chat',
      }),
    })
    expect(r.status).toBe(400)
  })

  it('PATCH a policy field calls refreshPolicy (re-dial), not invalidate', async () => {
    const id = b.identity.addPeer({
      peerId: 'hub_relink',
      endpointUrl: 'wss://relink.example',
      peerToken: 'tok-relink-1234',
    }).id
    const inv = b.invalidateCount.n
    const rp = b.refreshPolicyCount.n
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ acl: { capabilities: ['probe'] } }),
    })
    expect(r.status).toBe(200)
    expect(b.refreshPolicyCount.n).toBe(rp + 1)
    expect(b.invalidateCount.n).toBe(inv) // NOT bumped — refreshPolicy supersedes
    const stored = b.identity.getPeer(id)!
    expect(stored.acl).toEqual({ capabilities: ['probe'] })
  })

  it('PATCH label-only stays on the plain invalidate path', async () => {
    const id = b.identity.addPeer({
      peerId: 'hub_labelonly',
      endpointUrl: 'wss://lo.example',
      peerToken: 'tok-labelonly-12',
    }).id
    const inv = b.invalidateCount.n
    const rp = b.refreshPolicyCount.n
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'renamed' }),
    })
    expect(r.status).toBe(200)
    expect(b.invalidateCount.n).toBe(inv + 1)
    expect(b.refreshPolicyCount.n).toBe(rp) // policy untouched → no re-dial
  })

  it('PATCH endpointUrl change also re-dials via refreshPolicy', async () => {
    const id = b.identity.addPeer({
      peerId: 'hub_endpoint',
      endpointUrl: 'wss://old.example',
      peerToken: 'tok-endpoint-123',
    }).id
    const rp = b.refreshPolicyCount.n
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ endpointUrl: 'wss://new.example' }),
    })
    expect(r.status).toBe(200)
    expect(b.refreshPolicyCount.n).toBe(rp + 1)
  })

  it('PATCH acl:null clears a previously set ACL', async () => {
    const id = b.identity.addPeer({
      peerId: 'hub_clear',
      endpointUrl: 'wss://clear.example',
      peerToken: 'tok-clear-12345',
      acl: { capabilities: ['probe'] },
    }).id
    expect(b.identity.getPeer(id)!.acl).toEqual({ capabilities: ['probe'] })
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ acl: null }),
    })
    expect(r.status).toBe(200)
    expect(b.identity.getPeer(id)!.acl).toBeNull()
  })
})

describe('peer pinned signing key (STD-M2b)', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  const KID = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM1234' // 43-char base64url

  it('POST persists pinnedKid + round-trips via getPeer AND the list DTO', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_pin', endpointUrl: 'wss://pin.example', peerToken: 'tok-pin-12345',
        pinnedKid: KID,
      }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { peer: { id: string; pinnedKid: string | null } }
    expect(j.peer.pinnedKid).toBe(KID)
    // Persisted, not just echoed.
    expect(b.identity.getPeer(j.peer.id)!.pinnedKid).toBe(KID)
    // Exposed in the list DTO so the admin panel can display the anchor.
    const lr = await fetch(`${b.baseUrl}/api/admin/identity/peers`, { headers: { cookie: b.ownerCookie } })
    const lj = (await lr.json()) as { peers: Array<{ peerId: string; pinnedKid: string | null }> }
    expect(lj.peers.find((p) => p.peerId === 'hub_pin')!.pinnedKid).toBe(KID)
  })

  it('POST without pinnedKid → null (no anchor by default; identity rests on the token)', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'hub_nopin', endpointUrl: 'wss://np.example', peerToken: 'tok-nopin-1234' }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { peer: { pinnedKid: string | null } }
    expect(j.peer.pinnedKid).toBeNull()
  })

  it('POST a malformed pinnedKid (not the 43-char thumbprint shape) → 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_badpin', endpointUrl: 'wss://bp.example', peerToken: 'tok-badpin-123',
        pinnedKid: 'too-short',
      }),
    })
    // A paste typo must be rejected up front — a bad pin would else become a
    // permanent phantom mismatch.
    expect(r.status).toBe(400)
  })

  it('PATCH sets then clears the pin (explicit null clears the anchor)', async () => {
    const id = b.identity.addPeer({
      peerId: 'hub_pinpatch', endpointUrl: 'wss://pp.example', peerToken: 'tok-pinpatch-1',
    }).id
    const set = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH', headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ pinnedKid: KID }),
    })
    expect(set.status).toBe(200)
    expect(b.identity.getPeer(id)!.pinnedKid).toBe(KID)
    const clear = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH', headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ pinnedKid: null }),
    })
    expect(clear.status).toBe(200)
    expect(b.identity.getPeer(id)!.pinnedKid).toBeNull()
  })

  it('PATCH pinnedKid-only stays on the plain invalidate path — advisory ≠ re-gate', async () => {
    const id = b.identity.addPeer({
      peerId: 'hub_pinonly', endpointUrl: 'wss://po.example', peerToken: 'tok-pinonly-12',
    }).id
    const inv = b.invalidateCount.n
    const rp = b.refreshPolicyCount.n
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH', headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ pinnedKid: KID }),
    })
    expect(r.status).toBe(200)
    expect(b.invalidateCount.n).toBe(inv + 1) // plain reconcile
    expect(b.refreshPolicyCount.n).toBe(rp) // the pin never re-dials a connected peer
  })
})

// GT-M3 — the graded trust tier (T0..T3) over the same CRUD routes. The DECISION
// matrix that consumes it lives in core (trust-tier.ts); what these pin is the
// WEB seam: the field validates, persists, round-trips via getPeer AND the list
// DTO, and — like pinnedKid — a tier-only edit stays on the plain invalidate
// path (it selects approval friction, it is NOT a mesh gating input, so it must
// never re-dial a connected peer).
describe('peer graded trust tier (GT-M3)', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('POST persists trustTier + round-trips via getPeer AND the list DTO', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_tier', endpointUrl: 'wss://tier.example', peerToken: 'tok-tier-12345',
        trustTier: 'T2',
      }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { peer: { id: string; trustTier: string | null } }
    expect(j.peer.trustTier).toBe('T2')
    // Persisted, not just echoed.
    expect(b.identity.getPeer(j.peer.id)!.trustTier).toBe('T2')
    // Exposed in the list DTO so the admin panel can pre-fill the selector.
    const lr = await fetch(`${b.baseUrl}/api/admin/identity/peers`, { headers: { cookie: b.ownerCookie } })
    const lj = (await lr.json()) as { peers: Array<{ peerId: string; trustTier: string | null }> }
    expect(lj.peers.find((p) => p.peerId === 'hub_tier')!.trustTier).toBe('T2')
  })

  it('POST without trustTier → null (un-graded by default; core resolves to the T1 floor)', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'hub_notier', endpointUrl: 'wss://nt.example', peerToken: 'tok-notier-123' }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { peer: { trustTier: string | null } }
    expect(j.peer.trustTier).toBeNull()
  })

  it('POST an invalid trustTier (outside T0..T3) → 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_badtier', endpointUrl: 'wss://bt.example', peerToken: 'tok-badtier-12',
        trustTier: 'T9',
      }),
    })
    // A tier the decision matrix will never recognise must be rejected up front,
    // not silently stored (it would else quietly fall through to the floor).
    expect(r.status).toBe(400)
  })

  it('PATCH sets then clears the tier (explicit null clears the grade)', async () => {
    const id = b.identity.addPeer({
      peerId: 'hub_tierpatch', endpointUrl: 'wss://tp.example', peerToken: 'tok-tierpatch',
    }).id
    const set = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH', headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ trustTier: 'T3' }),
    })
    expect(set.status).toBe(200)
    expect(b.identity.getPeer(id)!.trustTier).toBe('T3')
    const clear = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH', headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ trustTier: null }),
    })
    expect(clear.status).toBe(200)
    expect(b.identity.getPeer(id)!.trustTier).toBeNull()
  })

  it('PATCH trustTier-only stays on the plain invalidate path — advisory ≠ re-gate', async () => {
    const id = b.identity.addPeer({
      peerId: 'hub_tieronly', endpointUrl: 'wss://to.example', peerToken: 'tok-tieronly-1',
    }).id
    const inv = b.invalidateCount.n
    const rp = b.refreshPolicyCount.n
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH', headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ trustTier: 'T2' }),
    })
    expect(r.status).toBe(200)
    expect(b.invalidateCount.n).toBe(inv + 1) // plain reconcile
    expect(b.refreshPolicyCount.n).toBe(rp) // the tier never re-dials a connected peer
  })
})

// Phase 19 P4-M4 — the per-link trust-contract trio (revocationState /
// perLinkQuotaBudget / allowedDataClasses) over the same CRUD routes. The host
// ENFORCEMENT is pinned in host/tests/peer-isolation-e2e.test.ts +
// peer-token-resolver.test.ts; what these pin is the WEB seam: the three fields
// validate, persist, round-trip, and a revoke/quota/class edit kicks
// refreshPolicy() (a policy change must re-gate a CONNECTED peer).
describe('peer per-link trust contract (Phase 19 P4-M4)', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('POST persists the contract trio + round-trips via getPeer', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_contract',
        endpointUrl: 'wss://contract.example',
        peerToken: 'tok-contract-1234',
        revocationState: 'revoked',
        perLinkQuotaBudget: 42,
        allowedDataClasses: ['public', 'internal'],
      }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as {
      peer: {
        id: string
        revocationState: string
        perLinkQuotaBudget: number | null
        allowedDataClasses: string[] | null
      }
    }
    expect(j.peer.revocationState).toBe('revoked')
    expect(j.peer.perLinkQuotaBudget).toBe(42)
    expect(j.peer.allowedDataClasses).toEqual(['public', 'internal'])
    const stored = b.identity.getPeer(j.peer.id)!
    expect(stored.revocationState).toBe('revoked')
    expect(stored.perLinkQuotaBudget).toBe(42)
    expect(stored.allowedDataClasses).toEqual(['public', 'internal'])
  })

  it('POST without the trio → defaults (active / null / null)', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_contract_default',
        endpointUrl: 'wss://cd.example',
        peerToken: 'tok-cd-12345678',
      }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as {
      peer: {
        revocationState: string
        perLinkQuotaBudget: number | null
        allowedDataClasses: string[] | null
      }
    }
    expect(j.peer.revocationState).toBe('active')
    expect(j.peer.perLinkQuotaBudget).toBeNull()
    expect(j.peer.allowedDataClasses).toBeNull()
  })

  it('POST invalid revocationState → 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_badrev',
        endpointUrl: 'wss://x.example',
        peerToken: 'tok-badrev-1234',
        revocationState: 'paused',
      }),
    })
    expect(r.status).toBe(400)
  })

  it('POST negative perLinkQuotaBudget → 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_badbudget',
        endpointUrl: 'wss://x.example',
        peerToken: 'tok-badbudget-12',
        perLinkQuotaBudget: -1,
      }),
    })
    expect(r.status).toBe(400)
  })

  it('POST allowedDataClasses not an array → 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_badclass',
        endpointUrl: 'wss://x.example',
        peerToken: 'tok-badclass-123',
        allowedDataClasses: 'public',
      }),
    })
    expect(r.status).toBe(400)
  })

  it('PATCH revocationState=revoked re-gates via refreshPolicy (not invalidate)', async () => {
    const id = b.identity.addPeer({
      peerId: 'hub_revoke',
      endpointUrl: 'wss://revoke.example',
      peerToken: 'tok-revoke-1234',
    }).id
    const inv = b.invalidateCount.n
    const rp = b.refreshPolicyCount.n
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ revocationState: 'revoked' }),
    })
    expect(r.status).toBe(200)
    expect(b.refreshPolicyCount.n).toBe(rp + 1)
    expect(b.invalidateCount.n).toBe(inv) // policy edit supersedes plain reconcile
    expect(b.identity.getPeer(id)!.revocationState).toBe('revoked')
  })

  it('PATCH perLinkQuotaBudget:null clears a previously set budget', async () => {
    const id = b.identity.addPeer({
      peerId: 'hub_clearbudget',
      endpointUrl: 'wss://cb.example',
      peerToken: 'tok-cb-12345678',
      perLinkQuotaBudget: 10,
    }).id
    expect(b.identity.getPeer(id)!.perLinkQuotaBudget).toBe(10)
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ perLinkQuotaBudget: null }),
    })
    expect(r.status).toBe(200)
    expect(b.identity.getPeer(id)!.perLinkQuotaBudget).toBeNull()
  })
})

// v5 C-M1 — the callable-knowledge-base allowlist is a fourth per-link contract
// dimension. The host ENFORCEMENT (a peer only discovers + calls the named
// shared MCP servers) is pinned in host/tests/peer-kb-gate.test.ts +
// peer-kb-isolation-e2e.test.ts; what these pin is the WEB seam: the field
// validates, persists, round-trips, and a PATCH null clears it.
describe('peer callable-knowledge-base allowlist (v5 C-M1)', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('POST persists allowedKnowledgeBases + round-trips via getPeer', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_kb',
        endpointUrl: 'wss://kb.example',
        peerToken: 'tok-kb-12345678',
        allowedKnowledgeBases: ['company_kb', 'policies_kb'],
      }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { peer: { id: string; allowedKnowledgeBases: string[] | null } }
    expect(j.peer.allowedKnowledgeBases).toEqual(['company_kb', 'policies_kb'])
    expect(b.identity.getPeer(j.peer.id)!.allowedKnowledgeBases).toEqual(['company_kb', 'policies_kb'])
  })

  it('POST without the field → null default (all shared servers callable)', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_kb_default',
        endpointUrl: 'wss://kbd.example',
        peerToken: 'tok-kbd-1234567',
      }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { peer: { allowedKnowledgeBases: string[] | null } }
    expect(j.peer.allowedKnowledgeBases).toBeNull()
  })

  it('POST allowedKnowledgeBases:[] persists a hard lockdown (not coerced to null)', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_kb_lockdown',
        endpointUrl: 'wss://kbl.example',
        peerToken: 'tok-kbl-1234567',
        allowedKnowledgeBases: [],
      }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { peer: { id: string; allowedKnowledgeBases: string[] | null } }
    expect(j.peer.allowedKnowledgeBases).toEqual([])
    expect(b.identity.getPeer(j.peer.id)!.allowedKnowledgeBases).toEqual([])
  })

  it('POST allowedKnowledgeBases not an array → 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_kb_bad',
        endpointUrl: 'wss://x.example',
        peerToken: 'tok-kbbad-1234',
        allowedKnowledgeBases: 'company_kb',
      }),
    })
    expect(r.status).toBe(400)
  })

  it('PATCH allowedKnowledgeBases:null clears a previously set allowlist', async () => {
    const id = b.identity.addPeer({
      peerId: 'hub_kb_clear',
      endpointUrl: 'wss://kbc.example',
      peerToken: 'tok-kbc-1234567',
      allowedKnowledgeBases: ['company_kb'],
    }).id
    expect(b.identity.getPeer(id)!.allowedKnowledgeBases).toEqual(['company_kb'])
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ allowedKnowledgeBases: null }),
    })
    expect(r.status).toBe(200)
    expect(b.identity.getPeer(id)!.allowedKnowledgeBases).toBeNull()
  })
})

describe('peer transcript-sharing opt-in (v5 Stream G day-5)', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('POST shareTranscript:true persists + round-trips via getPeer', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_tx',
        endpointUrl: 'wss://tx.example',
        peerToken: 'tok-tx-12345678',
        shareTranscript: true,
      }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { peer: { id: string; shareTranscript: boolean } }
    expect(j.peer.shareTranscript).toBe(true)
    expect(b.identity.getPeer(j.peer.id)!.shareTranscript).toBe(true)
  })

  it('POST without the field → false default (fail-closed, leaks nothing)', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_tx_default',
        endpointUrl: 'wss://txd.example',
        peerToken: 'tok-txd-1234567',
      }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { peer: { shareTranscript: boolean } }
    expect(j.peer.shareTranscript).toBe(false)
  })

  it('PATCH flips shareTranscript on, then off (independent of shareSummary)', async () => {
    const id = b.identity.addPeer({
      peerId: 'hub_tx_patch',
      endpointUrl: 'wss://txp.example',
      peerToken: 'tok-txp-1234567',
    }).id
    expect(b.identity.getPeer(id)!.shareTranscript).toBe(false)
    let r = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ shareTranscript: true }),
    })
    expect(r.status).toBe(200)
    expect(b.identity.getPeer(id)!.shareTranscript).toBe(true)
    // shareSummary is a separate opt-in — flipping transcript never touched it.
    expect(b.identity.getPeer(id)!.shareSummary).toBe(false)
    r = await fetch(`${b.baseUrl}/api/admin/identity/peers/${id}`, {
      method: 'PATCH',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ shareTranscript: false }),
    })
    expect(r.status).toBe(200)
    expect(b.identity.getPeer(id)!.shareTranscript).toBe(false)
  })

  it('POST shareTranscript not a boolean → 400', async () => {
    const r = await fetch(`${b.baseUrl}/api/admin/identity/peers`, {
      method: 'POST',
      headers: { cookie: b.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'hub_tx_bad',
        endpointUrl: 'wss://x.example',
        peerToken: 'tok-txbad-1234',
        shareTranscript: 'yes',
      }),
    })
    expect(r.status).toBe(400)
  })
})
