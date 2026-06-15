/**
 * Route B P1-M11c — /api/admin/a2a-agents CRUD.
 *
 * An admin registers the external A2A agents this hub forwards capability
 * dispatches to (replacing Phase 18's `AIPE_A2A_AGENTS` env blob). Driven
 * through a real serveWeb with a STUB A2aAgentAdminSurface — the store is
 * covered in identity/tests/a2a-agent-store.test.ts and the hub-sync in
 * host/tests/a2a-outbound.test.ts; here we pin auth gating, body validation
 * (mandatory fields + non-empty capabilities), and the create/update/delete
 * dispatch.
 *
 * Like SAML there is NO secret to hide: `tokenEnv` is the NAME of the env var
 * the bearer is read from, so the view carries it in full. It also carries
 * host-joined runtime liveness (`active` / `inactiveReason`), so the UI can
 * tell "saved but inactive: token env unset" from "running".
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'

import {
  serveWeb,
  type A2aAgentAdminSurface,
  type A2aAgentView,
  type WebServerHandle,
} from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  rows: A2aAgentView[]
  addCalls: unknown[]
  updateCalls: Array<{ id: string; patch: unknown }>
  removeCalls: string[]
  addThrows: { code: string } | null
  removeReturns: boolean
}

function view(over: Partial<A2aAgentView> = {}): A2aAgentView {
  return {
    id: 'remote-writer',
    capabilities: ['draft', 'review'],
    url: 'https://agent-a.example.com/a2a',
    tokenEnv: 'WRITER_A2A_TOKEN',
    peerId: null,
    targetSkill: null,
    lifecycle: null,
    allowedDataClasses: null,
    outboundQuotaBudget: null,
    requireApprovalOutbound: false,
    enabled: true,
    label: null,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    ...over,
  }
}

async function boot(opts: { wired?: boolean } = {}): Promise<Boot> {
  const wired = opts.wired ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-a2a-admin-'))
  const init = await Space.init(tmp, { name: 'a2a-admin-route-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { token: adminToken } = await init.space.createAdmin('TestAdmin')

  const out: Boot = {
    tmp,
    hub,
    server: undefined as unknown as WebServerHandle,
    baseUrl: '',
    adminToken,
    rows: [],
    addCalls: [],
    updateCalls: [],
    removeCalls: [],
    addThrows: null,
    removeReturns: true,
  }

  const surface: A2aAgentAdminSurface = {
    list() {
      return out.rows
    },
    add(input) {
      out.addCalls.push(input)
      if (out.addThrows) throw out.addThrows
      return view({ id: (input as { id: string }).id })
    },
    update(id, patch) {
      out.updateCalls.push({ id, patch })
      return view({ id })
    },
    remove(id) {
      out.removeCalls.push(id)
      return out.removeReturns
    },
  }

  out.server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(wired ? { a2aAgents: surface } : {}),
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
const jsonAuth = (b: Boot) => ({ ...auth(b), 'content-type': 'application/json' })
const AGENTS = '/api/admin/a2a-agents'

describe('/api/admin/a2a-agents (Route B P1-M11c)', () => {
  let b: Boot
  afterEach(async () => {
    await teardown(b)
  })

  it('503 when the surface is not wired (no identity store)', async () => {
    b = await boot({ wired: false })
    const r = await fetch(`${b.baseUrl}${AGENTS}`, { headers: auth(b) })
    expect(r.status).toBe(503)
  })

  it('401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`)
    expect(r.status).toBe(401)
  })

  it('GET lists agents; tokenEnv + runtime liveness are carried', async () => {
    b = await boot()
    b.rows = [
      view({ id: 'live', active: true }),
      view({ id: 'pending', active: false, inactiveReason: 'token_env_unset' }),
    ]
    const r = await fetch(`${b.baseUrl}${AGENTS}`, { headers: auth(b) })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.agents).toHaveLength(2)
    // tokenEnv is the env-var NAME (non-secret) — carried so admins know what to set.
    expect(j.agents[0].tokenEnv).toBe('WRITER_A2A_TOKEN')
    // honest liveness: a token-less row reads inactive with a reason, not "running".
    expect(j.agents[1].active).toBe(false)
    expect(j.agents[1].inactiveReason).toBe('token_env_unset')
  })

  it('POST registers an agent (201) and forwards all fields to the store', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({
        id: 'partner-a',
        capabilities: ['compose'],
        url: 'https://new.test/a2a',
        tokenEnv: 'PARTNER_A_TOKEN',
        peerId: 'hub-a',
        targetSkill: 'compose',
        label: 'Partner A',
      }),
    })
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.agent.id).toBe('partner-a')
    const sent = b.addCalls[0] as {
      id: string
      capabilities: string[]
      url: string
      tokenEnv: string
      peerId: string
      targetSkill: string
      label: string
    }
    expect(sent.id).toBe('partner-a')
    expect(sent.capabilities).toEqual(['compose'])
    expect(sent.url).toBe('https://new.test/a2a')
    expect(sent.tokenEnv).toBe('PARTNER_A_TOKEN')
    expect(sent.peerId).toBe('hub-a')
    expect(sent.targetSkill).toBe('compose')
    expect(sent.label).toBe('Partner A')
  })

  it('POST 400 on a missing mandatory field (tokenEnv)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({ id: 'x', capabilities: ['a'], url: 'https://x.test/a2a' }),
    })
    expect(r.status).toBe(400)
    expect(b.addCalls).toHaveLength(0)
  })

  it('POST 400 on empty capabilities (a no-capability agent can never be dispatched)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({ id: 'x', capabilities: [], url: 'https://x.test/a2a', tokenEnv: 'T' }),
    })
    expect(r.status).toBe(400)
    expect(b.addCalls).toHaveLength(0)
  })

  it('POST maps a duplicate id to 409', async () => {
    b = await boot()
    b.addThrows = { code: 'a2a_agent_exists' }
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({ id: 'dup', capabilities: ['a'], url: 'https://dup.test/a2a', tokenEnv: 'T' }),
    })
    expect(r.status).toBe(409)
    expect((await r.json()).error).toBe('a2a_agent_exists')
  })

  it('PATCH updates an agent by id (id not in the patch)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}/remote-writer`, {
      method: 'PATCH',
      headers: jsonAuth(b),
      body: JSON.stringify({ enabled: false, url: 'https://moved.test/a2a' }),
    })
    expect(r.status).toBe(200)
    expect(b.updateCalls).toEqual([
      { id: 'remote-writer', patch: { url: 'https://moved.test/a2a', enabled: false } },
    ])
  })

  it('PATCH 400 on an empty url', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}/remote-writer`, {
      method: 'PATCH',
      headers: jsonAuth(b),
      body: JSON.stringify({ url: '   ' }),
    })
    expect(r.status).toBe(400)
    expect(b.updateCalls).toHaveLength(0)
  })

  it('DELETE removes an agent', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}/remote-writer`, { method: 'DELETE', headers: auth(b) })
    expect(r.status).toBe(200)
    expect((await r.json()).ok).toBe(true)
    expect(b.removeCalls).toEqual(['remote-writer'])
  })

  it('DELETE 404 on an unknown id', async () => {
    b = await boot()
    b.removeReturns = false
    const r = await fetch(`${b.baseUrl}${AGENTS}/ghost`, { method: 'DELETE', headers: auth(b) })
    expect(r.status).toBe(404)
    expect(b.removeCalls).toEqual(['ghost'])
  })

  it('405 on an unsupported method to the collection', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, { method: 'PUT', headers: auth(b) })
    expect(r.status).toBe(405)
  })

  // --- Stream H2-OUT: long-running lifecycle (the v32 column reaches the store) ---

  it('GET carries lifecycle in the view (null = blocking, object = long-running)', async () => {
    b = await boot()
    b.rows = [
      view({ id: 'blocking' }), // lifecycle: null by default
      view({ id: 'long', lifecycle: { pollIntervalMs: 5000, maxAttempts: 40 } }),
    ]
    const j = await (await fetch(`${b.baseUrl}${AGENTS}`, { headers: auth(b) })).json()
    expect(j.agents[0].lifecycle).toBeNull()
    expect(j.agents[1].lifecycle).toEqual({ pollIntervalMs: 5000, maxAttempts: 40 })
  })

  it('POST forwards a tuned lifecycle object to the store', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({
        id: 'long',
        capabilities: ['review'],
        url: 'https://r.test/a2a',
        tokenEnv: 'T',
        lifecycle: { pollIntervalMs: 5000, maxAttempts: 40 },
      }),
    })
    expect(r.status).toBe(201)
    const sent = b.addCalls[0] as { lifecycle?: unknown }
    expect(sent.lifecycle).toEqual({ pollIntervalMs: 5000, maxAttempts: 40 })
  })

  it('POST forwards a {} lifecycle (opts in with defaults) but omits it when absent', async () => {
    b = await boot()
    // `{}` is meaningful (lifecycle ON, defaults) — it must reach the store.
    await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({ id: 'd', capabilities: ['a'], url: 'https://d.test/a2a', tokenEnv: 'T', lifecycle: {} }),
    })
    expect((b.addCalls[0] as { lifecycle?: unknown }).lifecycle).toEqual({})
    // No lifecycle key → omitted entirely, so the store keeps its NULL default (blocking).
    await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({ id: 'b', capabilities: ['a'], url: 'https://b.test/a2a', tokenEnv: 'T' }),
    })
    expect('lifecycle' in (b.addCalls[1] as object)).toBe(false)
  })

  it('POST 400 on a non-positive lifecycle field (web shape gate, never reaches the store)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({
        id: 'bad',
        capabilities: ['a'],
        url: 'https://x.test/a2a',
        tokenEnv: 'T',
        lifecycle: { pollIntervalMs: -1 },
      }),
    })
    expect(r.status).toBe(400)
    expect(b.addCalls).toHaveLength(0)
  })

  it('PATCH forwards lifecycle: null (turn OFF) to the store', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}/remote-writer`, {
      method: 'PATCH',
      headers: jsonAuth(b),
      body: JSON.stringify({ lifecycle: null }),
    })
    expect(r.status).toBe(200)
    expect(b.updateCalls).toEqual([{ id: 'remote-writer', patch: { lifecycle: null } }])
  })

  // --- Item 2 (Z-M1): outbound-edge gate fields (data-class / quota / approval) ---
  // These reach the v34 columns. The participant-level gates are covered in
  // a2a/tests + host/tests/a2a-outbound*.test.ts; here we pin the verbatim
  // round-trip through the duck-typed route and the web shape gate (400).

  it('GET carries the gate fields in the view (null = allow-all / unlimited, false = no approval)', async () => {
    b = await boot()
    b.rows = [
      view({ id: 'open' }), // defaults: null / null / false
      view({
        id: 'clamped',
        allowedDataClasses: ['public', 'internal'],
        outboundQuotaBudget: 50,
        requireApprovalOutbound: true,
      }),
    ]
    const j = await (await fetch(`${b.baseUrl}${AGENTS}`, { headers: auth(b) })).json()
    expect(j.agents[0].allowedDataClasses).toBeNull()
    expect(j.agents[0].outboundQuotaBudget).toBeNull()
    expect(j.agents[0].requireApprovalOutbound).toBe(false)
    expect(j.agents[1].allowedDataClasses).toEqual(['public', 'internal'])
    expect(j.agents[1].outboundQuotaBudget).toBe(50)
    expect(j.agents[1].requireApprovalOutbound).toBe(true)
  })

  it('POST forwards the gate fields verbatim to the store', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({
        id: 'gated',
        capabilities: ['review'],
        url: 'https://g.test/a2a',
        tokenEnv: 'T',
        allowedDataClasses: ['public'],
        outboundQuotaBudget: 10,
        requireApprovalOutbound: true,
      }),
    })
    expect(r.status).toBe(201)
    const sent = b.addCalls[0] as {
      allowedDataClasses?: unknown
      outboundQuotaBudget?: unknown
      requireApprovalOutbound?: unknown
    }
    expect(sent.allowedDataClasses).toEqual(['public'])
    expect(sent.outboundQuotaBudget).toBe(10)
    expect(sent.requireApprovalOutbound).toBe(true)
  })

  it('POST forwards an empty allowedDataClasses [] (lock shut) — it is meaningful, not omitted', async () => {
    b = await boot()
    await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({
        id: 'locked',
        capabilities: ['a'],
        url: 'https://l.test/a2a',
        tokenEnv: 'T',
        allowedDataClasses: [],
      }),
    })
    expect((b.addCalls[0] as { allowedDataClasses?: unknown }).allowedDataClasses).toEqual([])
  })

  it('POST omits the gate fields entirely when absent (store keeps its NULL/false defaults)', async () => {
    b = await boot()
    await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({ id: 'plain', capabilities: ['a'], url: 'https://p.test/a2a', tokenEnv: 'T' }),
    })
    const sent = b.addCalls[0] as object
    expect('allowedDataClasses' in sent).toBe(false)
    expect('outboundQuotaBudget' in sent).toBe(false)
    expect('requireApprovalOutbound' in sent).toBe(false)
  })

  it('POST 400 on a non-array allowedDataClasses (web shape gate, never reaches the store)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({
        id: 'bad',
        capabilities: ['a'],
        url: 'https://x.test/a2a',
        tokenEnv: 'T',
        allowedDataClasses: 'public',
      }),
    })
    expect(r.status).toBe(400)
    expect(b.addCalls).toHaveLength(0)
  })

  it('POST 400 on a negative outboundQuotaBudget', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({
        id: 'bad',
        capabilities: ['a'],
        url: 'https://x.test/a2a',
        tokenEnv: 'T',
        outboundQuotaBudget: -5,
      }),
    })
    expect(r.status).toBe(400)
    expect(b.addCalls).toHaveLength(0)
  })

  it('POST 400 on a non-boolean requireApprovalOutbound', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}`, {
      method: 'POST',
      headers: jsonAuth(b),
      body: JSON.stringify({
        id: 'bad',
        capabilities: ['a'],
        url: 'https://x.test/a2a',
        tokenEnv: 'T',
        requireApprovalOutbound: 'yes',
      }),
    })
    expect(r.status).toBe(400)
    expect(b.addCalls).toHaveLength(0)
  })

  it('PATCH forwards allowedDataClasses: null (clear) + outboundQuotaBudget: null (unlimited)', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}${AGENTS}/remote-writer`, {
      method: 'PATCH',
      headers: jsonAuth(b),
      body: JSON.stringify({ allowedDataClasses: null, outboundQuotaBudget: null }),
    })
    expect(r.status).toBe(200)
    expect(b.updateCalls).toEqual([
      { id: 'remote-writer', patch: { allowedDataClasses: null, outboundQuotaBudget: null } },
    ])
  })
})
