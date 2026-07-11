/**
 * #2-M4a — the agent CRUD route accepts `useMcpServers`.
 *
 * The manifest path (parseManifest) already round-tripped useMcpServers,
 * but the direct POST/PUT /api/admin/agents body validator (validateAgentBody)
 * dropped it silently. That gap meant the M4 admin-UI opt-in checkboxes
 * would never persist. This pins the now-wired behavior:
 *
 *   - POST with useMcpServers → persisted into managed.useMcpServers
 *   - GET list echoes it back (publicAgent returns the whole managed spec)
 *   - PUT can rewrite it (incl. an empty array to clear a prior opt-in)
 *   - a malformed name (regex reject) → 400, nothing persisted
 *
 * No lifecycle is wired, so the provider-key gate is skipped and a `mock`
 * agent persists without a key (see agents-routes.ts: `if (ctx.lifecycle)`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'
import { loadOrCreateMasterKey, openIdentityStore, type IdentityStore } from '@gotong/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type { RoutingProbeSurface } from '../src/agents-routes.js'

interface Boot {
  tmp: string
  hub: Hub
  space: Space
  server: WebServerHandle
  baseUrl: string
  token: string
  identity?: IdentityStore
}

async function boot(): Promise<Boot> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-agents-route-'))
  const init = await Space.init(tmp, { name: 'agents-route-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const { token } = await space.createAdmin('TestAdmin')
  const server = await serveWeb(hub, { host: '127.0.0.1', port: 0 })
  return { tmp, hub, space, server, baseUrl: server.url, token }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity?.close()
  await rm(b.tmp, { recursive: true, force: true })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' })

const base = { provider: 'mock', system: 'you are a test agent', capabilities: ['chat'] }

describe('agents-route: useMcpServers (#2-M4a)', () => {
  let b: Boot
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('POST persists useMcpServers into managed', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'with-mcp', useMcpServers: ['fs', 'search'] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.agent.managed.useMcpServers).toEqual(['fs', 'search'])
    // Really landed on disk.
    const rec = (await b.space.agents()).find((a) => a.id === 'with-mcp')
    expect(rec?.managed.useMcpServers).toEqual(['fs', 'search'])
  })

  it('GET list echoes useMcpServers back', async () => {
    await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'listed', useMcpServers: ['fs'] }),
    })
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, { headers: auth(b.token) })
    expect(res.status).toBe(200)
    const { agents } = await res.json()
    const found = agents.find((a: { id: string }) => a.id === 'listed')
    expect(found.managed.useMcpServers).toEqual(['fs'])
  })

  it('PUT can clear a prior opt-in with an empty array', async () => {
    await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'clearable', useMcpServers: ['fs', 'search'] }),
    })
    const res = await fetch(`${b.baseUrl}/api/admin/agents/clearable`, {
      method: 'PUT',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'clearable', useMcpServers: [] }),
    })
    expect(res.status).toBe(200)
    const rec = (await b.space.agents()).find((a) => a.id === 'clearable')
    expect(rec?.managed.useMcpServers).toEqual([])
  })

  it('omitting useMcpServers leaves it undefined (not coerced to [])', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'no-mcp' }),
    })
    expect(res.status).toBe(200)
    const rec = (await b.space.agents()).find((a) => a.id === 'no-mcp')
    expect(rec?.managed.useMcpServers).toBeUndefined()
  })

  it('a malformed server name → 400, nothing persisted', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'bad-mcp', useMcpServers: ['has space'] }),
    })
    expect(res.status).toBe(400)
    expect((await b.space.agents()).some((a) => a.id === 'bad-mcp')).toBe(false)
  })
})

describe('agents-route: fallbacks (MR-M2 model routing)', () => {
  let b: Boot
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  const chain = [
    { provider: 'openai', model: 'gpt-5' },
    { provider: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  ]

  it('POST persists a fallback chain into managed', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'routed', fallbacks: chain }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.agent.managed.fallbacks).toEqual(chain)
    const rec = (await b.space.agents()).find((a) => a.id === 'routed')
    expect(rec?.managed.fallbacks).toEqual(chain)
  })

  it('omitting fallbacks leaves it undefined (opt-in byte-stable)', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'plain' }),
    })
    expect(res.status).toBe(200)
    const rec = (await b.space.agents()).find((a) => a.id === 'plain')
    expect(rec?.managed.fallbacks).toBeUndefined()
  })

  it('an openai-compatible fallback with no baseURL → 400, nothing persisted', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({
        ...base,
        id: 'bad-fb',
        fallbacks: [{ provider: 'openai-compatible', model: 'x' }],
      }),
    })
    expect(res.status).toBe(400)
    expect((await b.space.agents()).some((a) => a.id === 'bad-fb')).toBe(false)
  })

  it('PUT carrying the chain preserves it; omitting it drops it (wholesale replace)', async () => {
    await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'edited', fallbacks: chain }),
    })
    // A PUT that echoes the chain keeps it (mirrors the admin form's capture-echo).
    const keep = await fetch(`${b.baseUrl}/api/admin/agents/edited`, {
      method: 'PUT',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'edited', fallbacks: chain }),
    })
    expect(keep.status).toBe(200)
    expect((await b.space.agents()).find((a) => a.id === 'edited')?.managed.fallbacks).toEqual(chain)
    // A PUT that omits it drops it — documents the wholesale-replace contract the
    // admin form's echo defends against.
    const drop = await fetch(`${b.baseUrl}/api/admin/agents/edited`, {
      method: 'PUT',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'edited' }),
    })
    expect(drop.status).toBe(200)
    expect((await b.space.agents()).find((a) => a.id === 'edited')?.managed.fallbacks).toBeUndefined()
  })
})

describe('agents-route: maintenanceModel (NA-M5 maintenance model override)', () => {
  let b: Boot
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('POST persists a trimmed maintenanceModel; GET exposes it via managed', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'maint', maintenanceModel: '  cheap-distill-v1  ' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.agent.managed.maintenanceModel).toBe('cheap-distill-v1')
    const list = await fetch(`${b.baseUrl}/api/admin/agents`, { headers: auth(b.token) })
    const agents = (await list.json()).agents as Array<{ id: string; managed?: { maintenanceModel?: string } }>
    expect(agents.find((a) => a.id === 'maint')?.managed?.maintenanceModel).toBe('cheap-distill-v1')
  })

  it('omitting maintenanceModel leaves it undefined (opt-in byte-stable)', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'no-maint' }),
    })
    expect(res.status).toBe(200)
    expect((await b.space.agents()).find((a) => a.id === 'no-maint')?.managed.maintenanceModel).toBeUndefined()
  })

  it('an empty or non-string maintenanceModel → 400, nothing persisted', async () => {
    for (const bad of ['', '   ', 42]) {
      const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
        method: 'POST',
        headers: auth(b.token),
        body: JSON.stringify({ ...base, id: 'bad-maint', maintenanceModel: bad }),
      })
      expect(res.status).toBe(400)
    }
    expect((await b.space.agents()).some((a) => a.id === 'bad-maint')).toBe(false)
  })

  it('PUT echoing the value keeps it; omitting it drops it (wholesale replace)', async () => {
    await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'maint-edit', maintenanceModel: 'cheap-distill-v1' }),
    })
    const keep = await fetch(`${b.baseUrl}/api/admin/agents/maint-edit`, {
      method: 'PUT',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'maint-edit', maintenanceModel: 'cheap-distill-v1' }),
    })
    expect(keep.status).toBe(200)
    expect((await b.space.agents()).find((a) => a.id === 'maint-edit')?.managed.maintenanceModel).toBe('cheap-distill-v1')
    // Omission drops — the admin form's capture-echo (managed-agents.js) defends this.
    const drop = await fetch(`${b.baseUrl}/api/admin/agents/maint-edit`, {
      method: 'PUT',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'maint-edit' }),
    })
    expect(drop.status).toBe(200)
    expect((await b.space.agents()).find((a) => a.id === 'maint-edit')?.managed.maintenanceModel).toBeUndefined()
  })
})

describe('agents-route: probe-routing (MR-M5)', () => {
  // This route needs an injected `routingProbe` surface, so it boots its own
  // server per case (the shared `boot()` wires none). Pins the web-layer
  // contract of the manual 「测试路由」 diagnostic: admin-gated, opt-in (absent
  // surface → 503), guards run BEFORE the surface is touched (unknown → 404 with
  // zero probe calls), and the per-candidate rows pass through verbatim.
  let tmp: string
  let hub: Hub
  let space: Space
  let server: WebServerHandle
  let baseUrl: string
  let token: string
  // Records every id the fake surface is asked to probe — proves the route
  // reached it (and, for the 404 case, that it did NOT).
  let probed: string[]

  async function bootProbe(routingProbe?: RoutingProbeSurface): Promise<void> {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-probe-route-'))
    const init = await Space.init(tmp, { name: 'probe-route-test' })
    space = init.space
    hub = new Hub({ space })
    await hub.start()
    ;({ token } = await space.createAdmin('TestAdmin'))
    server = await serveWeb(hub, {
      host: '127.0.0.1',
      port: 0,
      ...(routingProbe ? { routingProbe } : {}),
    })
    baseUrl = server.url
  }

  afterEach(async () => {
    await server.close()
    await hub.stop()
    await rm(tmp, { recursive: true, force: true })
  })

  // A fake surface returning two candidate rows (one ok, one failing), recording
  // every id it probes.
  function fakeProbe(): RoutingProbeSurface {
    probed = []
    return {
      probeRoutingCandidates: async (id: string) => {
        probed.push(id)
        return [
          { index: 0, label: 'anthropic·claude', provider: 'anthropic', ok: true, model: 'claude', latencyMs: 12 },
          {
            index: 1,
            label: 'openai·gpt',
            provider: 'openai',
            ok: false,
            model: 'gpt',
            latencyMs: 8,
            code: 'invalid_key',
            message: 'nope',
          },
        ]
      },
    }
  }

  async function makeAgent(id: string): Promise<void> {
    await fetch(`${baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ ...base, id }),
    })
  }

  it('POST → 200 with the surface’s per-candidate rows (wired surface)', async () => {
    await bootProbe(fakeProbe())
    await makeAgent('routed')
    const res = await fetch(`${baseUrl}/api/admin/agents/routed/probe-routing`, {
      method: 'POST',
      headers: auth(token),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.agentId).toBe('routed')
    expect(body.candidates).toHaveLength(2)
    expect(body.candidates[0]).toMatchObject({ index: 0, ok: true, model: 'claude' })
    expect(body.candidates[1]).toMatchObject({ index: 1, ok: false, code: 'invalid_key' })
    // The route reached the surface with the decoded id.
    expect(probed).toEqual(['routed'])
  })

  it('absent surface → 503 (opt-in; panel hides the button)', async () => {
    await bootProbe() // no routingProbe wired
    await makeAgent('routed')
    const res = await fetch(`${baseUrl}/api/admin/agents/routed/probe-routing`, {
      method: 'POST',
      headers: auth(token),
    })
    expect(res.status).toBe(503)
  })

  it('unknown agent → 404, surface never probed (guard runs first)', async () => {
    await bootProbe(fakeProbe())
    const res = await fetch(`${baseUrl}/api/admin/agents/ghost/probe-routing`, {
      method: 'POST',
      headers: auth(token),
    })
    expect(res.status).toBe(404)
    expect(probed).toEqual([]) // no wasted probe on a nonexistent agent
  })

  it('requires admin auth → 401 without a token, surface never probed', async () => {
    await bootProbe(fakeProbe())
    await makeAgent('routed')
    const res = await fetch(`${baseUrl}/api/admin/agents/routed/probe-routing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(401)
    expect(probed).toEqual([]) // admin gate runs before the probe
  })
})

describe('agents-route: heartbeat (v5 D-M4)', () => {
  let b: Boot
  let reconcileCalls: number

  // Boots with a reconcileHeartbeats spy so we can assert a managed-agent
  // mutation re-seeds/prunes heartbeat rows (the host wires this to its
  // HeartbeatScheduler; here a counter stands in).
  beforeEach(async () => {
    reconcileCalls = 0
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-agents-route-hb-'))
    const init = await Space.init(tmp, { name: 'agents-route-hb-test' })
    const space = init.space
    const hub = new Hub({ space })
    await hub.start()
    const { token } = await space.createAdmin('TestAdmin')
    const server = await serveWeb(hub, {
      host: '127.0.0.1',
      port: 0,
      reconcileHeartbeats: async () => { reconcileCalls += 1 },
    })
    b = { tmp, hub, space, server, baseUrl: server.url, token }
  })
  afterEach(async () => { await teardown(b) })

  it('POST persists a heartbeat block and triggers a reconcile', async () => {
    const hb = { enabled: true, intervalMs: 1_800_000, checklist: 'check inbox' }
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'hb-agent', heartbeat: hb }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).agent.managed.heartbeat).toEqual(hb)
    const rec = (await b.space.agents()).find((a) => a.id === 'hb-agent')
    expect(rec?.managed.heartbeat).toEqual(hb)
    expect(reconcileCalls).toBeGreaterThanOrEqual(1)
  })

  it('PUT can toggle heartbeat off and reconciles again', async () => {
    await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST', headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'toggle', heartbeat: { enabled: true, intervalMs: 60_000 } }),
    })
    const before = reconcileCalls
    const res = await fetch(`${b.baseUrl}/api/admin/agents/toggle`, {
      method: 'PUT', headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'toggle', heartbeat: { enabled: false, intervalMs: 60_000 } }),
    })
    expect(res.status).toBe(200)
    const rec = (await b.space.agents()).find((a) => a.id === 'toggle')
    expect(rec?.managed.heartbeat?.enabled).toBe(false)
    expect(reconcileCalls).toBeGreaterThan(before)
  })

  it('a malformed heartbeat (intervalMs: 0) → 400, nothing persisted, no reconcile', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST', headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'bad-hb', heartbeat: { enabled: true, intervalMs: 0 } }),
    })
    expect(res.status).toBe(400)
    expect((await b.space.agents()).some((a) => a.id === 'bad-hb')).toBe(false)
    expect(reconcileCalls).toBe(0) // validation rejects before any side effect
  })

  it('omitting heartbeat leaves it undefined (not coerced)', async () => {
    await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST', headers: auth(b.token),
      body: JSON.stringify({ ...base, id: 'no-hb' }),
    })
    const rec = (await b.space.agents()).find((a) => a.id === 'no-hb')
    expect(rec?.managed.heartbeat).toBeUndefined()
  })
})

describe('agents-route: v4 identity admin auth', () => {
  let b: Boot
  beforeEach(async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-agents-v4-auth-'))
    const init = await Space.init(tmp, { name: 'agents-v4-auth-test' })
    const space = init.space
    const hub = new Hub({ space })
    await hub.start()
    const identity = openIdentityStore({
      dbPath: join(tmp, 'identity.sqlite'),
      masterKey: loadOrCreateMasterKey(join(tmp, 'identity-master.key')),
    })
    const booted = identity.bootstrap({
      ownerEmail: 'owner@example.test',
      ownerDisplayName: 'Owner',
    })
    identity.setPassword(booted.ownerUserId!, 'TestPass123!')
    identity.createUser({
      email: 'member@example.test',
      displayName: 'Member',
      password: 'TestPass123!',
      role: 'member',
    })
    const server = await serveWeb(hub, {
      host: '127.0.0.1',
      port: 0,
      identity,
    })
    b = { tmp, hub, space, server, baseUrl: server.url, token: '', identity }
  })
  afterEach(async () => { await teardown(b) })

  async function login(email: string): Promise<string> {
    const res = await fetch(`${b.baseUrl}/api/admin/identity/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'TestPass123!' }),
    })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toMatch(/^gotong_identity=/)
    return cookie!
  }

  it('accepts an owner v4 session cookie for legacy agent CRUD routes', async () => {
    const cookie = await login('owner@example.test')
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, id: 'v4-owned' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect((await b.space.agents()).some((a) => a.id === 'v4-owned')).toBe(true)
  })

  it('does not accept a non-admin v4 session cookie for legacy agent CRUD routes', async () => {
    const cookie = await login('member@example.test')
    const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, id: 'member-owned' }),
    })
    expect(res.status).toBe(401)
    expect((await b.space.agents()).some((a) => a.id === 'member-owned')).toBe(false)
  })
})
