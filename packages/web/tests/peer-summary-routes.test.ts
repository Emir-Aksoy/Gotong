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
  type PeerSummaryAlertBreach,
  type PeerSummaryAlertChannel,
  type PeerSummaryAlertChannelAddInput,
  type PeerSummaryAlertChannelUpdateInput,
  type PeerSummaryAlertDeliveryResult,
  type PeerSummaryAlertFiring,
  type PeerSummaryAlertFiringQuery,
  type PeerSummaryAlertRule,
  type PeerSummaryAlertRuleAddInput,
  type PeerSummaryAlertRuleUpdateInput,
  type PeerSummaryFederationSurface,
  type PeerSummaryHistoryQuery,
  type PeerSummaryRow,
  type PeerSummaryTrendPoint,
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
  historyCalls: PeerSummaryHistoryQuery[]
  historyResult: PeerSummaryTrendPoint[]
  // F-M5 alert surface
  alertRules: PeerSummaryAlertRule[]
  breaches: PeerSummaryAlertBreach[]
  addCalls: PeerSummaryAlertRuleAddInput[]
  updateCalls: Array<{ id: string; patch: PeerSummaryAlertRuleUpdateInput }>
  removeCalls: string[]
  removeResult: boolean
  addThrowsCode: string | null
  evaluateThrows: boolean
  // F day-3 firing history + channels
  firings: PeerSummaryAlertFiring[]
  firingQueries: Array<PeerSummaryAlertFiringQuery | undefined>
  channels: PeerSummaryAlertChannel[]
  channelAddCalls: PeerSummaryAlertChannelAddInput[]
  channelUpdateCalls: Array<{ id: string; patch: PeerSummaryAlertChannelUpdateInput }>
  channelRemoveCalls: string[]
  channelRemoveResult: boolean
  channelAddThrowsCode: string | null
  testCalls: string[]
  testThrowsCode: string | null
  testResult: PeerSummaryAlertDeliveryResult
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
    historyCalls: [],
    historyResult: [],
    alertRules: [],
    breaches: [],
    addCalls: [],
    updateCalls: [],
    removeCalls: [],
    removeResult: true,
    addThrowsCode: null,
    evaluateThrows: false,
    firings: [],
    firingQueries: [],
    channels: [],
    channelAddCalls: [],
    channelUpdateCalls: [],
    channelRemoveCalls: [],
    channelRemoveResult: true,
    channelAddThrowsCode: null,
    testCalls: [],
    testThrowsCode: null,
    testResult: { channelId: 'psac_1', ok: true, status: 200 },
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
    async history(query) {
      out.historyCalls.push(query)
      return out.historyResult
    },
    metricKeys() {
      return ['assets.agents', 'health.suspendedTasks']
    },
    listAlertRules() {
      return out.alertRules
    },
    addAlertRule(input) {
      out.addCalls.push(input)
      if (out.addThrowsCode) {
        throw Object.assign(new Error('store'), { code: out.addThrowsCode })
      }
      return {
        id: 'asr_new',
        source: input.source,
        metric: input.metric,
        comparator: input.comparator,
        threshold: input.threshold,
        label: input.label ?? null,
        enabled: input.enabled ?? true,
        createdAt: 0,
        updatedAt: 0,
      }
    },
    updateAlertRule(id, patch) {
      out.updateCalls.push({ id, patch })
      return {
        id,
        source: 'local',
        metric: 'assets.agents',
        comparator: 'gt',
        threshold: 1,
        label: null,
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        ...patch,
      }
    },
    removeAlertRule(id) {
      out.removeCalls.push(id)
      return out.removeResult
    },
    async evaluateAlerts() {
      if (out.evaluateThrows) throw new Error('boom')
      return out.breaches
    },
    listAlertFirings(query) {
      out.firingQueries.push(query)
      return out.firings
    },
    listAlertChannels() {
      return out.channels
    },
    addAlertChannel(input) {
      out.channelAddCalls.push(input)
      if (out.channelAddThrowsCode) {
        throw Object.assign(new Error('store'), { code: out.channelAddThrowsCode })
      }
      return {
        id: 'psac_new',
        kind: input.kind,
        url: input.url,
        headerEnv: input.headerEnv ?? null,
        platform: input.platform ?? null,
        target: input.target ?? null,
        enabled: input.enabled ?? true,
        label: input.label ?? null,
        createdAt: 0,
        updatedAt: 0,
      }
    },
    updateAlertChannel(id, patch) {
      out.channelUpdateCalls.push({ id, patch })
      return {
        id,
        kind: 'webhook',
        url: 'https://hooks.example.com/x',
        headerEnv: null,
        platform: null,
        target: null,
        enabled: true,
        label: null,
        createdAt: 0,
        updatedAt: 0,
        ...patch,
      }
    },
    removeAlertChannel(id) {
      out.channelRemoveCalls.push(id)
      return out.channelRemoveResult
    },
    async testAlertChannel(id) {
      out.testCalls.push(id)
      if (out.testThrowsCode) {
        throw Object.assign(new Error('store'), { code: out.testThrowsCode })
      }
      return out.testResult
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

  // ── v5 Stream F — GET /history (metric trend from snapshots) ──────────────

  it('GET /history returns trend points + the metric-key list', async () => {
    b = await boot()
    b.historyResult = [
      { capturedAt: 1000, value: 1 },
      { capturedAt: 2000, value: 3 },
    ]
    const r = await fetch(
      `${b.baseUrl}/api/admin/peer-summaries/history?source=local&metric=assets.agents`,
      { headers: auth(b) },
    )
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.source).toBe('local')
    expect(j.metric).toBe('assets.agents')
    expect(j.points).toEqual([
      { capturedAt: 1000, value: 1 },
      { capturedAt: 2000, value: 3 },
    ])
    expect(j.metrics).toContain('assets.agents')
    // the surface saw the parsed query (no window params this time)
    expect(b.historyCalls).toEqual([
      { source: 'local', metric: 'assets.agents', since: undefined, until: undefined, limit: undefined },
    ])
  })

  it('GET /history threads since/until/limit through as integers', async () => {
    b = await boot()
    const r = await fetch(
      `${b.baseUrl}/api/admin/peer-summaries/history?source=hub_a&metric=runs.total&since=100&until=900&limit=50`,
      { headers: auth(b) },
    )
    expect(r.status).toBe(200)
    expect(b.historyCalls).toEqual([
      { source: 'hub_a', metric: 'runs.total', since: 100, until: 900, limit: 50 },
    ])
  })

  it('GET /history 400 when source or metric is missing', async () => {
    b = await boot()
    const noMetric = await fetch(
      `${b.baseUrl}/api/admin/peer-summaries/history?source=local`,
      { headers: auth(b) },
    )
    expect(noMetric.status).toBe(400)
    const noSource = await fetch(
      `${b.baseUrl}/api/admin/peer-summaries/history?metric=assets.agents`,
      { headers: auth(b) },
    )
    expect(noSource.status).toBe(400)
    expect(b.historyCalls).toHaveLength(0)
  })

  it('GET /history 400 on a non-integer window param', async () => {
    b = await boot()
    const r = await fetch(
      `${b.baseUrl}/api/admin/peer-summaries/history?source=local&metric=assets.agents&since=abc`,
      { headers: auth(b) },
    )
    expect(r.status).toBe(400)
    expect(b.historyCalls).toHaveLength(0)
  })

  it('GET /history 503 when the federation surface is not wired', async () => {
    b = await boot({ withFederation: false })
    const r = await fetch(
      `${b.baseUrl}/api/admin/peer-summaries/history?source=local&metric=assets.agents`,
      { headers: auth(b) },
    )
    expect(r.status).toBe(503)
  })
})

// ── v5 Stream F-M5 — /api/admin/peer-summary-alerts (rules CRUD + live eval) ──

const ALERTS = '/api/admin/peer-summary-alerts'
const RULES = '/api/admin/peer-summary-alerts/rules'

const breach = (over: Partial<PeerSummaryAlertBreach> = {}): PeerSummaryAlertBreach => ({
  ruleId: 'asr_1',
  source: 'local',
  metric: 'health.suspendedTasks',
  comparator: 'gt',
  threshold: 5,
  value: 9,
  label: null,
  ...over,
})

const alertRule = (over: Partial<PeerSummaryAlertRule> = {}): PeerSummaryAlertRule => ({
  id: 'asr_1',
  source: 'local',
  metric: 'health.suspendedTasks',
  comparator: 'gt',
  threshold: 5,
  label: null,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

describe('/api/admin/peer-summary-alerts (v5 Stream F-M5)', () => {
  let b: Boot
  afterEach(async () => { await teardown(b) })

  it('503 when the federation surface is not wired', async () => {
    b = await boot({ withFederation: false })
    const r = await fetch(`${b.baseUrl}${ALERTS}`, { headers: auth(b) })
    expect(r.status).toBe(503)
  })

  it('401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${ALERTS}`)
    expect(r.status).toBe(401)
  })

  it('GET returns live breaches + the rule list + metric keys', async () => {
    b = await boot()
    b.breaches = [breach({ value: 9 })]
    b.alertRules = [alertRule()]
    const r = await fetch(`${b.baseUrl}${ALERTS}`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.alerts).toHaveLength(1)
    expect(j.alerts[0].value).toBe(9)
    expect(j.rules).toHaveLength(1)
    expect(j.rules[0].id).toBe('asr_1')
    expect(j.metrics).toContain('assets.agents')
  })

  it('GET 500 when evaluation throws', async () => {
    b = await boot()
    b.evaluateThrows = true
    const r = await fetch(`${b.baseUrl}${ALERTS}`, { headers: auth(b) })
    expect(r.status).toBe(500)
  })

  it('POST /rules adds a rule and threads the body to the surface', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${RULES}`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'local',
        metric: 'health.suspendedTasks',
        comparator: 'gte',
        threshold: 3,
        label: 'watch',
      }),
    })
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.rule.id).toBe('asr_new')
    expect(j.rule.comparator).toBe('gte')
    expect(b.addCalls).toEqual([
      { source: 'local', metric: 'health.suspendedTasks', comparator: 'gte', threshold: 3, label: 'watch' },
    ])
  })

  it('POST /rules 400 on a bad comparator / non-numeric threshold / missing field', async () => {
    b = await boot()
    const base = { source: 'local', metric: 'm', comparator: 'gt', threshold: 1 }
    const post = (body: unknown) =>
      fetch(`${b.baseUrl}${RULES}`, {
        method: 'POST',
        headers: { ...auth(b), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await post({ ...base, comparator: 'between' })).status).toBe(400)
    expect((await post({ ...base, threshold: 'x' })).status).toBe(400)
    expect((await post({ ...base, source: '' })).status).toBe(400)
    expect(b.addCalls).toHaveLength(0) // never reached the surface
  })

  it('POST /rules 409 when the store rejects a duplicate id', async () => {
    b = await boot()
    b.addThrowsCode = 'alert_rule_exists'
    const r = await fetch(`${b.baseUrl}${RULES}`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'local', metric: 'm', comparator: 'gt', threshold: 1 }),
    })
    expect(r.status).toBe(409)
  })

  it('PATCH /rules/:id updates and threads the id + patch', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${RULES}/asr_1`, {
      method: 'PATCH',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ threshold: 12, enabled: false }),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.rule.threshold).toBe(12)
    expect(j.rule.enabled).toBe(false)
    expect(b.updateCalls).toEqual([{ id: 'asr_1', patch: { threshold: 12, enabled: false } }])
  })

  it('DELETE /rules/:id removes; 404 when the rule is gone', async () => {
    b = await boot()
    const ok = await fetch(`${b.baseUrl}${RULES}/asr_1`, { method: 'DELETE', headers: auth(b) })
    expect(ok.status).toBe(200)
    expect(b.removeCalls).toEqual(['asr_1'])
    b.removeResult = false
    const gone = await fetch(`${b.baseUrl}${RULES}/asr_x`, { method: 'DELETE', headers: auth(b) })
    expect(gone.status).toBe(404)
  })

  it('405 on an unsupported method to the rules collection', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${RULES}`, { method: 'GET', headers: auth(b) })
    expect(r.status).toBe(405)
  })
})

// ── v5 Stream F day-3 — firing history + notification channels ────────────────

const FIRINGS = '/api/admin/peer-summary-alerts/firings'
const CHANNELS = '/api/admin/peer-summary-alerts/channels'

const firing = (over: Partial<PeerSummaryAlertFiring> = {}): PeerSummaryAlertFiring => ({
  id: 1,
  ruleId: 'asr_1',
  source: 'local',
  metric: 'health.suspendedTasks',
  comparator: 'gt',
  threshold: 5,
  value: 9,
  label: null,
  openedAt: 1000,
  resolvedAt: null,
  ...over,
})

const channel = (over: Partial<PeerSummaryAlertChannel> = {}): PeerSummaryAlertChannel => ({
  id: 'psac_1',
  kind: 'webhook',
  url: 'https://hooks.example.com/x',
  headerEnv: null,
  platform: null,
  target: null,
  enabled: true,
  label: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

describe('/api/admin/peer-summary-alerts/firings (v5 Stream F day-3)', () => {
  let b: Boot
  afterEach(async () => { await teardown(b) })

  it('503 when the federation surface is not wired', async () => {
    b = await boot({ withFederation: false })
    const r = await fetch(`${b.baseUrl}${FIRINGS}`, { headers: auth(b) })
    expect(r.status).toBe(503)
  })

  it('GET returns firing rows + passes an empty query when no filters', async () => {
    b = await boot()
    b.firings = [firing({ id: 7, resolvedAt: 2000 }), firing({ id: 8 })]
    const r = await fetch(`${b.baseUrl}${FIRINGS}`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.firings).toHaveLength(2)
    expect(j.firings[0].id).toBe(7)
    expect(b.firingQueries).toEqual([{}])
  })

  it('GET threads source / ruleId / state / since / until / limit as a query', async () => {
    b = await boot()
    const r = await fetch(
      `${b.baseUrl}${FIRINGS}?source=hub_a&ruleId=asr_3&state=resolved&since=100&until=900&limit=20`,
      { headers: auth(b) },
    )
    expect(r.status).toBe(200)
    expect(b.firingQueries).toEqual([
      { source: 'hub_a', ruleId: 'asr_3', state: 'resolved', since: 100, until: 900, limit: 20 },
    ])
  })

  it('GET 400 on an invalid state', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${FIRINGS}?state=weird`, { headers: auth(b) })
    expect(r.status).toBe(400)
    expect(b.firingQueries).toHaveLength(0)
  })

  it('GET 400 on a non-integer window param', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${FIRINGS}?since=abc`, { headers: auth(b) })
    expect(r.status).toBe(400)
    expect(b.firingQueries).toHaveLength(0)
  })

  it('405 on a non-GET method', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${FIRINGS}`, { method: 'POST', headers: auth(b) })
    expect(r.status).toBe(405)
  })
})

describe('/api/admin/peer-summary-alerts/channels (v5 Stream F day-3)', () => {
  let b: Boot
  afterEach(async () => { await teardown(b) })

  it('GET lists channels (no secret in the row — headerEnv is an env name)', async () => {
    b = await boot()
    b.channels = [channel({ headerEnv: 'OPS_WEBHOOK_TOKEN' }), channel({ id: 'psac_2', enabled: false })]
    const r = await fetch(`${b.baseUrl}${CHANNELS}`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.channels).toHaveLength(2)
    expect(j.channels[0].headerEnv).toBe('OPS_WEBHOOK_TOKEN')
    // the row never carries a bearer — only the env-var NAME
    expect(Object.keys(j.channels[0])).not.toContain('header')
  })

  it('POST adds a webhook channel and threads the body', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${CHANNELS}`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'webhook',
        url: 'https://hooks.example.com/ops',
        headerEnv: 'OPS_WEBHOOK_TOKEN',
        label: 'ops',
      }),
    })
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.channel.id).toBe('psac_new')
    expect(j.channel.url).toBe('https://hooks.example.com/ops')
    expect(b.channelAddCalls).toEqual([
      { kind: 'webhook', url: 'https://hooks.example.com/ops', headerEnv: 'OPS_WEBHOOK_TOKEN', label: 'ops' },
    ])
  })

  it('POST adds an im channel (telegram) and threads platform + target', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${CHANNELS}`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'im',
        url: 'https://api.telegram.org',
        platform: 'telegram',
        target: '-1001234567890',
        headerEnv: 'TG_BOT_TOKEN',
      }),
    })
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.channel.platform).toBe('telegram')
    expect(j.channel.target).toBe('-1001234567890')
    expect(b.channelAddCalls).toEqual([
      {
        kind: 'im',
        url: 'https://api.telegram.org',
        platform: 'telegram',
        target: '-1001234567890',
        headerEnv: 'TG_BOT_TOKEN',
      },
    ])
  })

  it('POST adds an im channel (slack incoming-webhook) without a target', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${CHANNELS}`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'im', url: 'https://hooks.slack.com/services/T/B/x', platform: 'slack' }),
    })
    expect(r.status).toBe(201)
    expect(b.channelAddCalls).toEqual([
      { kind: 'im', url: 'https://hooks.slack.com/services/T/B/x', platform: 'slack' },
    ])
  })

  it('POST adds an email channel and threads target', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${CHANNELS}`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'email', url: 'https://api.mailer.example/send', target: 'ops@example.com' }),
    })
    expect(r.status).toBe(201)
    expect(b.channelAddCalls).toEqual([
      { kind: 'email', url: 'https://api.mailer.example/send', target: 'ops@example.com' },
    ])
  })

  it('POST 400 on an unknown kind / empty url / out-of-set im platform', async () => {
    b = await boot()
    const post = (body: unknown) =>
      fetch(`${b.baseUrl}${CHANNELS}`, {
        method: 'POST',
        headers: { ...auth(b), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await post({ kind: 'carrier-pigeon', url: 'x' })).status).toBe(400)
    expect((await post({ kind: 'webhook', url: '' })).status).toBe(400)
    // an out-of-set platform fails fast at the web layer (enum mirror) — no store call
    expect((await post({ kind: 'im', url: 'https://x.example/h', platform: 'myspace' })).status).toBe(400)
    expect(b.channelAddCalls).toHaveLength(0)
  })

  it('POST 409 when the store rejects a duplicate id', async () => {
    b = await boot()
    b.channelAddThrowsCode = 'alert_channel_exists'
    const r = await fetch(`${b.baseUrl}${CHANNELS}`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'webhook', url: 'https://x.example/h' }),
    })
    expect(r.status).toBe(409)
  })

  it('POST 400 when the store rejects a pasted bearer in headerEnv (invalid_input)', async () => {
    b = await boot()
    b.channelAddThrowsCode = 'invalid_input'
    const r = await fetch(`${b.baseUrl}${CHANNELS}`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'webhook', url: 'https://x.example/h', headerEnv: 'Bearer leak' }),
    })
    expect(r.status).toBe(400)
  })

  it('PATCH /:id updates and threads the id + patch', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${CHANNELS}/psac_1`, {
      method: 'PATCH',
      headers: { ...auth(b), 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, url: 'https://new.example/h' }),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.channel.enabled).toBe(false)
    expect(j.channel.url).toBe('https://new.example/h')
    expect(b.channelUpdateCalls).toEqual([
      { id: 'psac_1', patch: { enabled: false, url: 'https://new.example/h' } },
    ])
  })

  it('DELETE /:id removes; 404 when the channel is gone', async () => {
    b = await boot()
    const ok = await fetch(`${b.baseUrl}${CHANNELS}/psac_1`, { method: 'DELETE', headers: auth(b) })
    expect(ok.status).toBe(200)
    expect(b.channelRemoveCalls).toEqual(['psac_1'])
    b.channelRemoveResult = false
    const gone = await fetch(`${b.baseUrl}${CHANNELS}/psac_x`, { method: 'DELETE', headers: auth(b) })
    expect(gone.status).toBe(404)
  })

  it('POST /:id/test sends a synthetic payload and returns the delivery result', async () => {
    b = await boot()
    b.testResult = { channelId: 'psac_1', ok: true, status: 204 }
    const r = await fetch(`${b.baseUrl}${CHANNELS}/psac_1/test`, { method: 'POST', headers: auth(b) })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.result).toEqual({ channelId: 'psac_1', ok: true, status: 204 })
    expect(b.testCalls).toEqual(['psac_1'])
  })

  it('POST /:id/test 404 when the channel is missing', async () => {
    b = await boot()
    b.testThrowsCode = 'alert_channel_not_found'
    const r = await fetch(`${b.baseUrl}${CHANNELS}/psac_x/test`, { method: 'POST', headers: auth(b) })
    expect(r.status).toBe(404)
  })

  it('405 on a non-POST method to /:id/test', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${CHANNELS}/psac_1/test`, { method: 'GET', headers: auth(b) })
    expect(r.status).toBe(405)
    expect(b.testCalls).toHaveLength(0)
  })
})
