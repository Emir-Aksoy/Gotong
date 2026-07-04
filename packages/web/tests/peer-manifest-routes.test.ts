/**
 * Phase 18 A-M2 — /api/admin/peer-manifests routes (cross-hub capability
 * manifest browse + refresh).
 *
 * Coverage:
 *   - 503 when the host didn't wire ctx.peerManifests (peers off)
 *   - 401 when unauthenticated
 *   - GET lists the surface's peer rows
 *   - POST /refresh calls refresh() then returns the list
 *   - POST /refresh threads an optional peerId through to the surface
 *   - POST 400 on a non-string peerId
 *   - 405 on an unsupported method
 *   - 500 when the surface throws
 *
 * The federation surface is a stub so web tests don't drag in the host's
 * peer registry (the host-side createPeerManifestFederation test covers the
 * cache + stale logic). The route's job here is auth gating + dispatch.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import {
  serveWeb,
  type PeerManifestFederationSurface,
  type PeerManifestRow,
  type WebServerHandle,
} from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  rows: PeerManifestRow[]
  refreshCalls: Array<string | undefined>
  listThrows: boolean
}

async function boot(opts: { withFederation?: boolean } = {}): Promise<Boot> {
  const withFederation = opts.withFederation ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-peer-'))
  const init = await Space.init(tmp, { name: 'peer-manifest-route-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { token: adminToken } = await init.space.createAdmin('TestAdmin')

  const out: Boot = {
    tmp, hub,
    server: undefined as unknown as WebServerHandle,
    baseUrl: '',
    adminToken,
    rows: [],
    refreshCalls: [],
    listThrows: false,
  }

  const fedStub: PeerManifestFederationSurface = {
    async list() {
      if (out.listThrows) throw new Error('boom')
      return out.rows
    },
    async refresh(peerId) {
      out.refreshCalls.push(peerId)
    },
  }

  out.server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(withFederation ? { peerManifests: fedStub } : {}),
  })
  out.baseUrl = out.server.url
  return out
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

const auth = (b: Boot) => ({ authorization: `Bearer ${b.adminToken}` })

describe('/api/admin/peer-manifests (Phase 18 A-M2)', () => {
  let b: Boot
  afterEach(async () => { await teardown(b) })

  it('503 when the federation surface is not wired (peers off)', async () => {
    b = await boot({ withFederation: false })
    const r = await fetch(`${b.baseUrl}/api/admin/peer-manifests`, { headers: auth(b) })
    expect(r.status).toBe(503)
  })

  it('401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/peer-manifests`)
    expect(r.status).toBe(401)
  })

  it('GET returns the peer manifest rows', async () => {
    b = await boot()
    b.rows = [
      { peer: 'hub_a', label: 'Partner A', online: true, stale: false, capabilities: ['draft', 'review'], lastFetchedAt: 1000 },
      { peer: 'hub_b', label: null, online: false, stale: true, capabilities: ['quote'], lastFetchedAt: 900 },
    ]
    const r = await fetch(`${b.baseUrl}/api/admin/peer-manifests`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.peers).toHaveLength(2)
    expect(j.peers[0].capabilities).toEqual(['draft', 'review'])
    expect(j.peers[1].stale).toBe(true)
  })

  it('POST /refresh calls refresh() then returns the list', async () => {
    b = await boot()
    b.rows = [{ peer: 'hub_a', label: null, online: true, stale: false, capabilities: ['x'], lastFetchedAt: 1 }]
    const r = await fetch(`${b.baseUrl}/api/admin/peer-manifests/refresh`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.ok).toBe(true)
    expect(j.peers).toHaveLength(1)
    expect(b.refreshCalls).toEqual([undefined]) // refresh-all
  })

  it('POST /refresh threads an optional peerId through to the surface', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/peer-manifests/refresh`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'hub_a' }),
    })
    expect(r.status).toBe(200)
    expect(b.refreshCalls).toEqual(['hub_a'])
  })

  it('POST /refresh 400 on a non-string peerId', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/peer-manifests/refresh`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 42 }),
    })
    expect(r.status).toBe(400)
    expect(b.refreshCalls).toHaveLength(0)
  })

  it('405 on a non-GET method to the list path', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/peer-manifests`, { method: 'PUT', headers: auth(b) })
    expect(r.status).toBe(405)
  })

  it('500 when the surface throws', async () => {
    b = await boot()
    b.listThrows = true
    const r = await fetch(`${b.baseUrl}/api/admin/peer-manifests`, { headers: auth(b) })
    expect(r.status).toBe(500)
  })
})
