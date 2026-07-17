/**
 * RES-M3 — POST /api/admin/resources/adapt (human-approved adaptation apply).
 *
 * The whole RES point is the human-approval invariant: probing (RES-M1) and
 * proposing (RES-M2) are strictly read-only, and a proposal only becomes a WRITE
 * on an explicit per-item operator submit — nothing is ever changed silently.
 * This route is that one write, so these tests pin, against a REAL Space + Hub +
 * serveWeb (the write really lands on disk):
 *
 *   - an APPLICABLE switch_provider apply rewrites the agent's provider row
 *   - an APPLICABLE use_local_endpoint apply rewires the agent to the local URL
 *   - an ADVISORY proposal (applicable:false) is REJECTED and the agent is left
 *     byte-identical — the "never silent, never half-applied" guarantee
 *   - MR-M2 `fallbacks` and NA-M5 `maintenanceModel` SURVIVE both applies — the
 *     rebuilt edit body must echo the whole spec, or upsert wipes them silently
 *   - MR-M6 `apiKeyEnv` (exclusive semantics, old primary's vendor) is shed on
 *     a rewire and REPORTED via `applied.droppedApiKeyEnv` — dropped, not silent
 *   - a proposal for an unknown agent → 404; a missing proposal → 400
 *   - no admin token → 401 (the apply is admin-gated like every write)
 *
 * No lifecycle is wired, so the provider-key gate is skipped (see agents-routes:
 * `if (ctx.lifecycle)`); the apply itself is provider-agnostic here — we're
 * testing the adapt route's mapping + fail-closed rejection, not key resolution.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import { serveWeb, type WebServerHandle } from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  space: Space
  server: WebServerHandle
  baseUrl: string
  token: string
}

async function boot(): Promise<Boot> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-res-adapt-'))
  const init = await Space.init(tmp, { name: 'res-adapt-test' })
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
  await rm(b.tmp, { recursive: true, force: true })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' })

/** Create one managed agent through the real CRUD route (so it lands on disk). */
async function createAgent(b: Boot, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
    method: 'POST',
    headers: auth(b.token),
    body: JSON.stringify(body),
  })
  if (res.status !== 200) throw new Error(`create failed ${res.status}: ${await res.text()}`)
}

const adapt = (b: Boot, proposal: Record<string, unknown>) =>
  fetch(`${b.baseUrl}/api/admin/resources/adapt`, {
    method: 'POST',
    headers: auth(b.token),
    body: JSON.stringify({ proposal }),
  })

const managedOf = async (b: Boot, id: string) => (await b.space.agents()).find((a) => a.id === id)?.managed

describe('RES-M3 adapt route: applicable proposals mutate the agent row', () => {
  let b: Boot
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('switch_provider (applicable) rewrites provider + clears the compat baseURL', async () => {
    await createAgent(b, {
      id: 'mentor',
      provider: 'openai-compatible',
      baseURL: 'http://example.test/v1',
      providerLabel: 'Old',
      system: 'you are a mentor',
      capabilities: ['chat'],
    })
    const res = await adapt(b, {
      kind: 'switch_provider',
      id: 'adapt:switch_provider:mentor:anthropic',
      agentId: 'mentor',
      fromProvider: 'openai-compatible',
      toProvider: 'anthropic',
      keySource: 'env',
      applicable: true,
      title: 't',
      detail: 'd',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.applied).toEqual({ kind: 'switch_provider', agentId: 'mentor' })
    // Really landed: provider switched, compat-only fields shed, system preserved.
    const m = await managedOf(b, 'mentor')
    expect(m?.provider).toBe('anthropic')
    expect(m?.baseURL).toBeUndefined()
    expect(m?.providerLabel).toBeUndefined()
    expect(m?.system).toBe('you are a mentor')
  })

  it('use_local_endpoint (applicable) rewires the agent to the local URL', async () => {
    await createAgent(b, {
      id: 'writer',
      provider: 'anthropic',
      system: 'you write',
      capabilities: ['chat'],
      model: 'claude-sonnet-5',
    })
    const res = await adapt(b, {
      kind: 'use_local_endpoint',
      id: 'adapt:use_local_endpoint:writer:Ollama',
      agentId: 'writer',
      fromProvider: 'anthropic',
      endpointLabel: 'Ollama',
      suggestedBaseURL: 'http://127.0.0.1:11434/v1',
      applicable: true,
      title: 't',
      detail: 'd',
    })
    expect(res.status).toBe(200)
    // No stored key existed → the harmless 'local' placeholder is written (it
    // satisfies the compat per-agent-key rule; a local server ignores it) and
    // the response carries no keptStoredApiKey marker.
    expect((await res.json()).applied).toEqual({ kind: 'use_local_endpoint', agentId: 'writer' })
    expect(await b.space.getAgentApiKey('writer')).toBe('local')
    const m = await managedOf(b, 'writer')
    expect(m?.provider).toBe('openai-compatible')
    expect(m?.baseURL).toBe('http://127.0.0.1:11434/v1')
    expect(m?.providerLabel).toBe('Ollama')
    // The existing model is preserved (operator retargets to a local model as a
    // follow-up edit — the adapt only rewires the endpoint).
    expect(m?.model).toBe('claude-sonnet-5')
  })

  it('a stored per-agent key REFUSES the apply — stale keyless premise, key and spec both untouched', async () => {
    // A healthy compat agent whose real key lives in per-agent storage (the only
    // place a compat key can live). Every enactable proposal rests on "this
    // agent is keyless" (RES-M2 + the resolvesKey probe only propose for those),
    // so a stored key existing by apply time means the card is stale: the route
    // must refuse (NET-M2 re-resolve posture) rather than enact against it —
    // enacting would either clobber the key with 'local' or hand it to the new
    // endpoint.
    await createAgent(b, {
      id: 'mentor',
      provider: 'openai-compatible',
      baseURL: 'https://api.deepseek.example/v1',
      system: 'you mentor',
      capabilities: ['chat'],
    })
    await b.space.setAgentApiKey('mentor', 'sk-real-deepseek-key')
    const res = await adapt(b, {
      kind: 'use_local_endpoint',
      id: 'adapt:use_local_endpoint:mentor:Ollama',
      agentId: 'mentor',
      fromProvider: 'openai-compatible',
      endpointLabel: 'Ollama',
      suggestedBaseURL: 'http://127.0.0.1:11434/v1',
      applicable: true,
      title: 't',
      detail: 'd',
    })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('key_state_changed')
    // Nothing was enacted: endpoint unchanged…
    const m = await managedOf(b, 'mentor')
    expect(m?.provider).toBe('openai-compatible')
    expect(m?.baseURL).toBe('https://api.deepseek.example/v1')
    // …and the real key survived byte-identical.
    expect(await b.space.getAgentApiKey('mentor')).toBe('sk-real-deepseek-key')
  })

  it('inline mcpServers refuse one-click adapt — the PUT contract cannot echo them, so applying would silently wipe the wiring', async () => {
    await createAgent(b, {
      id: 'wired',
      provider: 'anthropic',
      system: 'you use tools',
      capabilities: ['chat'],
    })
    // Inline `mcpServers` only arrives via manifest import (the HTTP POST/PUT
    // contract doesn't carry the field) — seed it directly on the real Space.
    const rec = (await b.space.agents()).find((a) => a.id === 'wired')!
    await b.space.upsertAgent({
      id: 'wired',
      allowedCapabilities: rec.allowedCapabilities,
      managed: { ...rec.managed!, mcpServers: [{ name: 'files', command: 'mcp-files' }] },
    })
    const res = await adapt(b, {
      kind: 'switch_provider',
      id: 'adapt:switch_provider:wired:openai',
      agentId: 'wired',
      fromProvider: 'anthropic',
      toProvider: 'openai',
      applicable: true,
      title: 't',
      detail: 'd',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_applicable')
    const m = await managedOf(b, 'wired')
    expect(m?.provider).toBe('anthropic')
    expect(m?.mcpServers).toHaveLength(1)
  })
})

describe('RES-M3 adapt route: MR-M2/M6/NA-M5 spec fields survive the constrained edit', () => {
  let b: Boot
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  // The regression this pins: the rebuilt PUT body once echoed only a subset of
  // the spec, and since validateAgentBody treats an absent field as "unset" and
  // upsertAgent replaces the managed spec wholesale, applying ANY proposal
  // silently wiped fallbacks / apiKeyEnv / maintenanceModel.
  const FALLBACKS = [
    { provider: 'openai', model: 'gpt-4.1-mini', apiKeyEnv: 'OPENAI_BACKUP_KEY' },
    { provider: 'openai-compatible', baseURL: 'http://fallback.test/v1', providerLabel: 'DeepSeek' },
  ]

  it('use_local_endpoint keeps fallbacks + maintenanceModel; sheds and REPORTS the primary apiKeyEnv', async () => {
    await createAgent(b, {
      id: 'router',
      provider: 'anthropic',
      system: 'you route',
      capabilities: ['chat'],
      apiKeyEnv: 'OLD_ANTHROPIC_KEY',
      maintenanceModel: 'claude-haiku-4-5',
      fallbacks: FALLBACKS,
    })
    const res = await adapt(b, {
      kind: 'use_local_endpoint',
      id: 'adapt:use_local_endpoint:router:Ollama',
      agentId: 'router',
      fromProvider: 'anthropic',
      endpointLabel: 'Ollama',
      suggestedBaseURL: 'http://127.0.0.1:11434/v1',
      applicable: true,
      title: 't',
      detail: 'd',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    // The shed exclusive env credential is reported (name only), never silent.
    expect(body.applied).toEqual({
      kind: 'use_local_endpoint',
      agentId: 'router',
      droppedApiKeyEnv: 'OLD_ANTHROPIC_KEY',
    })
    const m = await managedOf(b, 'router')
    expect(m?.provider).toBe('openai-compatible')
    expect(m?.baseURL).toBe('http://127.0.0.1:11434/v1')
    // The whole chain survives byte-for-byte, INCLUDING per-candidate apiKeyEnv —
    // each candidate's credential belongs to that candidate, not the primary.
    expect(m?.fallbacks).toEqual(FALLBACKS)
    expect(m?.maintenanceModel).toBe('claude-haiku-4-5')
    // The primary's exclusive env name pointed at the OLD vendor — it must not
    // ride along onto the local endpoint (the placeholder per-agent key serves it).
    expect(m?.apiKeyEnv).toBeUndefined()
  })

  it('switch_provider keeps fallbacks + maintenanceModel while shedding compat fields + apiKeyEnv', async () => {
    await createAgent(b, {
      id: 'hopper',
      provider: 'openai-compatible',
      baseURL: 'http://old.test/v1',
      providerLabel: 'OldCompat',
      apiKeyEnv: 'OLD_COMPAT_KEY',
      system: 'you hop',
      capabilities: ['chat'],
      maintenanceModel: 'claude-haiku-4-5',
      fallbacks: FALLBACKS,
    })
    const res = await adapt(b, {
      kind: 'switch_provider',
      id: 'adapt:switch_provider:hopper:anthropic',
      agentId: 'hopper',
      fromProvider: 'openai-compatible',
      toProvider: 'anthropic',
      keySource: 'env',
      applicable: true,
      title: 't',
      detail: 'd',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.applied).toEqual({
      kind: 'switch_provider',
      agentId: 'hopper',
      droppedApiKeyEnv: 'OLD_COMPAT_KEY',
    })
    const m = await managedOf(b, 'hopper')
    expect(m?.provider).toBe('anthropic')
    // Compat-only fields shed with the old provider; routing/budget knobs stay.
    expect(m?.baseURL).toBeUndefined()
    expect(m?.providerLabel).toBeUndefined()
    expect(m?.apiKeyEnv).toBeUndefined()
    expect(m?.fallbacks).toEqual(FALLBACKS)
    expect(m?.maintenanceModel).toBe('claude-haiku-4-5')
  })
})

describe('RES-M3 adapt route: fail-closed (never silent, never half-applied)', () => {
  let b: Boot
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('an ADVISORY proposal (applicable:false) is rejected and the agent is unchanged', async () => {
    await createAgent(b, {
      id: 'keyless',
      provider: 'openai-compatible',
      baseURL: 'http://example.test/v1',
      system: 'you are keyless',
      capabilities: ['chat'],
    })
    const before = JSON.stringify(await managedOf(b, 'keyless'))
    const res = await adapt(b, {
      kind: 'set_env_key',
      id: 'adapt:set_env_key:keyless',
      agentId: 'keyless',
      provider: 'openai-compatible',
      envVar: 'SOME_KEY',
      applicable: false,
      title: 't',
      detail: 'd',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_applicable')
    // Byte-identical — the write never ran.
    expect(JSON.stringify(await managedOf(b, 'keyless'))).toBe(before)
  })

  it('a switch_provider to a NON-native target (applicable:false) is rejected, agent unchanged', async () => {
    await createAgent(b, {
      id: 'compat',
      provider: 'anthropic',
      system: 's',
      capabilities: ['chat'],
    })
    const before = JSON.stringify(await managedOf(b, 'compat'))
    const res = await adapt(b, {
      kind: 'switch_provider',
      id: 'adapt:switch_provider:compat:deepseek',
      agentId: 'compat',
      fromProvider: 'anthropic',
      toProvider: 'deepseek',
      keySource: 'env',
      applicable: false, // openai-compatible target → manual baseURL required
      title: 't',
      detail: 'd',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_applicable')
    expect(JSON.stringify(await managedOf(b, 'compat'))).toBe(before)
  })

  it('an applicable proposal for an unknown agent → 404', async () => {
    const res = await adapt(b, {
      kind: 'switch_provider',
      id: 'adapt:switch_provider:ghost:anthropic',
      agentId: 'ghost',
      fromProvider: 'openai-compatible',
      toProvider: 'anthropic',
      keySource: 'env',
      applicable: true,
      title: 't',
      detail: 'd',
    })
    expect(res.status).toBe(404)
  })

  it('a missing proposal → 400', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/resources/adapt`, {
      method: 'POST',
      headers: auth(b.token),
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('no admin token → 401 (the apply is admin-gated)', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/resources/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposal: { kind: 'switch_provider', agentId: 'x', applicable: true } }),
    })
    expect(res.status).toBe(401)
  })
})
