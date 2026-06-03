/**
 * v5 E5-M3 — /api/admin/peer-summaries routes (cross-hub control plane:
 * local footprint + peer summaries browse + refresh).
 *
 * Coverage:
 *   - 503 when the host didn't wire ctx.peerSummaries (peers off)
 *   - 401 when unauthenticated
 *   - GET returns { local, peers } from the surface
 *   - POST /refresh calls refresh() then returns { ok, local, peers }
 *   - POST /refresh threads an optional peerId through to the surface
 *   - POST 400 on a non-string peerId
 *   - 405 on an unsupported method
 *   - 500 when the surface throws
 *
 * The federation surface is a stub so web tests don't drag in the host's peer
 * registry (the host-side createPeerSummaryFederation test covers cache + the
 * lastError logic). The route's job here is auth gating + dispatch + the
 * local+peers join.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'

import {
  serveWeb,
  type PeerSummary,
  type PeerSummaryFederationSurface,
  type PeerSummaryRow,
  type WebServerHandle,
} from '../src/server.js'

const LOCAL: PeerSummary = {
  hubId: 'local',
  protocolVersion: '1',
  generatedAt: 5,
  assets: { agents: 2, workflows: 1, publishedWorkflows: 1, peers: 1 },
  runs: { total: 0, byStatus: {} },
  llm: { windowDays: 30, calls: 0, tokens: 0, costMicros: 0 },
  health: { suspendedTasks: 0 },
}

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  rows: PeerSummaryRow[]
  refreshCalls: Array<string | undefined>
  listThrows: boolean
}

async function boot(opts: { withFederation?: boolean } = {}): Promise<Boot> {
  const withFederation = opts.withFederation ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-peer-summary-'))
  const init = await Space.init(tmp, { name: 'peer-summary-route-test' })
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

  const fedStub: PeerSummaryFederationSurface = {
    async local() {
      return LOCAL
    },
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
    ...(withFederation ? { peerSummaries: fedStub } : {}),
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

const peerRow = (over: Partial<PeerSummaryRow>): PeerSummaryRow => ({
  peer: 'hub_a',
  label: 'Partner A',
  online: true,
  stale: false,
  summary: null,
  lastFetchedAt: null,
  lastError: null,
  ...over,
})

describe('/api/admin/peer-summaries (v5 E5-M3)', () => {
  let b: Boot
  afterEach(async () => { await teardown(b) })

  it('503 when the federation surface is not wired (peers off)', async () => {
    b = await boot({ withFederation: false })
    const r = await fetch(`${b.baseUrl}/api/admin/peer-summaries`, { headers: auth(b) })
    expect(r.status).toBe(503)
  })

  it('401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/peer-summaries`)
    expect(r.status).toBe(401)
  })

  it('GET returns local footprint + peer summary rows', async () => {
    b = await boot()
    b.rows = [
      peerRow({ peer: 'hub_a', summary: { ...LOCAL, hubId: 'hub_a' }, lastFetchedAt: 1000 }),
      peerRow({ peer: 'hub_b', label: null, online: false, stale: false, lastError: 'not shared by this peer' }),
    ]
    const r = await fetch(`${b.baseUrl}/api/admin/peer-summaries`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.local.assets.agents).toBe(2)
    expect(j.peers).toHaveLength(2)
    expect(j.peers[0].summary.hubId).toBe('hub_a')
    // the opt-out peer carries no summary but an honest lastError
    expect(j.peers[1].summary).toBeNull()
    expect(j.peers[1].lastError).toBe('not shared by this peer')
  })

  it('POST /refresh calls refresh() then returns { ok, local, peers }', async () => {
    b = await boot()
    b.rows = [peerRow({ summary: { ...LOCAL, hubId: 'hub_a' }, lastFetchedAt: 1 })]
    const r = await fetch(`${b.baseUrl}/api/admin/peer-summaries/refresh`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.ok).toBe(true)
    expect(j.local.hubId).toBe('local')
    expect(j.peers).toHaveLength(1)
    expect(b.refreshCalls).toEqual([undefined]) // refresh-all
  })

  it('POST /refresh threads an optional peerId through to the surface', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/peer-summaries/refresh`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'hub_a' }),
    })
    expect(r.status).toBe(200)
    expect(b.refreshCalls).toEqual(['hub_a'])
  })

  it('POST /refresh 400 on a non-string peerId', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/peer-summaries/refresh`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 42 }),
    })
    expect(r.status).toBe(400)
    expect(b.refreshCalls).toHaveLength(0)
  })

  it('405 on a non-GET method to the list path', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/peer-summaries`, { method: 'PUT', headers: auth(b) })
    expect(r.status).toBe(405)
  })

  it('500 when the surface throws', async () => {
    b = await boot()
    b.listThrows = true
    const r = await fetch(`${b.baseUrl}/api/admin/peer-summaries`, { headers: auth(b) })
    expect(r.status).toBe(500)
  })
})
