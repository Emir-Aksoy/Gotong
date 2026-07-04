/**
 * RES-M4 — the load-bearing end-to-end acceptance for the whole RES series'
 * one non-negotiable invariant: **probing and proposing are read-only; a
 * resource adaptation only ever changes an agent on an EXPLICIT per-item human
 * apply — nothing is ever silently modified.**
 *
 * The unit tests cover the pieces in isolation: the pure RES-M2 engine
 * (host/tests/resource-adaptation.test.ts) and the RES-M3 apply route against a
 * stubbed proposal (web/tests/resource-adapt-route.test.ts). This closes the one
 * seam those can't: the REAL host adaptation service (createResourceAdaptationService)
 * running over the hub's ACTUAL agents, surfaced through the always-on
 * GET /api/admin/resources/adaptations, then a human approving ONE proposal
 * through POST /api/admin/resources/adapt — with the write really landing on disk.
 *
 * It boots a real Hub + Space + serveWeb wired exactly like production
 * (`serveWeb({ resourceAdaptation })`) and injects a DETERMINISTIC inventory (a
 * keyless anthropic provider + a reachable local Ollama) so the proposals are
 * stable — the real network probe is non-hermetic and is not what we're proving.
 *
 * Three claims, end to end:
 *   1. the always-on route runs the real engine over the current agents and
 *      surfaces an APPLICABLE `use_local_endpoint` fix for the keyless agent
 *   2. approving THAT proposal really rewires the agent to the local endpoint
 *   3. an ADVISORY proposal (applicable:false) is REFUSED and the agent is left
 *      byte-identical — "never silent, never half-applied", proven end to end
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space } from '@gotong/core'
import { serveWeb, type WebServerHandle } from '@gotong/web'

import { createResourceAdaptationService } from '../src/resource-adaptation.js'
import type { ResourceInventory } from '../src/resource-inventory.js'

// Keyless anthropic + a reachable local Ollama. Injecting the inventory keeps
// this hermetic — the real probe would depend on whether Ollama is actually up.
const FAKE_INVENTORY: ResourceInventory = {
  llmKeys: [
    { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY', envSet: false, vaultConfigured: false },
  ],
  localEndpoints: [
    { label: 'Ollama', url: 'http://127.0.0.1:11434/api/tags', reachable: true },
  ],
  cliAgents: [],
  mcpServers: [],
  checkedAt: '2026-07-02T00:00:00.000Z',
}

interface Rig {
  root: string
  hub: Hub
  space: Space
  web: WebServerHandle
  baseUrl: string
  token: string
}

async function boot(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'gotong-res-e2e-'))
  const { space, adminToken } = await Space.init(root, { name: 'res-e2e', adminDisplayName: 'Owner' })
  if (!adminToken) throw new Error('expected admin token from Space.init')
  const hub = new Hub({ space })
  await hub.start()
  // The REAL adaptation service, fed a deterministic inventory (production wires
  // the same service over the live RES-M1 probe).
  const resourceAdaptation = createResourceAdaptationService({ inventory: async () => FAKE_INVENTORY })
  const web = await serveWeb(hub, { host: '127.0.0.1', port: 0, resourceAdaptation })
  return { root, hub, space, web, baseUrl: web.url, token: adminToken }
}

async function teardown(r: Rig): Promise<void> {
  await r.web.close()
  await r.hub.stop()
  await rm(r.root, { recursive: true, force: true })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' })

const managedOf = async (r: Rig, id: string) => (await r.space.agents()).find((a) => a.id === id)?.managed

describe('RES-M4 e2e — read-only propose → human-approved apply → never silent', () => {
  let r: Rig
  beforeEach(async () => { r = await boot() })
  afterEach(async () => { await teardown(r) })

  it('proposes a local-endpoint fix, applies it on approval, and refuses the advisory one', async () => {
    // A keyless anthropic agent — can't run as-is (no key resolves).
    const create = await fetch(`${r.baseUrl}/api/admin/agents`, {
      method: 'POST',
      headers: auth(r.token),
      body: JSON.stringify({ id: 'mentor', provider: 'anthropic', system: 'you mentor', capabilities: ['chat'] }),
    })
    expect(create.status).toBe(200)

    // ── Claim 1: the always-on route runs the REAL engine over current agents ──
    const listed = await fetch(`${r.baseUrl}/api/admin/resources/adaptations`, { headers: auth(r.token) })
    expect(listed.status).toBe(200)
    const proposals: Array<Record<string, unknown>> = (await listed.json()).proposals
    const local = proposals.find((p) => p.kind === 'use_local_endpoint' && p.agentId === 'mentor')
    const advisory = proposals.find((p) => p.kind === 'set_env_key' && p.agentId === 'mentor')
    // Applicable local-endpoint fix (Ollama is up) + advisory set-env (anthropic
    // has a conventional env var but it's unset). Both are read-only suggestions.
    expect(local).toBeTruthy()
    expect(local!.applicable).toBe(true)
    expect(local!.suggestedBaseURL).toBe('http://127.0.0.1:11434/v1')
    expect(advisory).toBeTruthy()
    expect(advisory!.applicable).toBe(false)
    // Merely proposing changed NOTHING — the agent is still keyless anthropic.
    expect((await managedOf(r, 'mentor'))?.provider).toBe('anthropic')

    // ── Claim 2: approving the applicable proposal really rewires the agent ────
    const applied = await fetch(`${r.baseUrl}/api/admin/resources/adapt`, {
      method: 'POST',
      headers: auth(r.token),
      body: JSON.stringify({ proposal: local }),
    })
    expect(applied.status).toBe(200)
    expect((await applied.json()).applied).toEqual({ kind: 'use_local_endpoint', agentId: 'mentor' })
    const rewired = await managedOf(r, 'mentor')
    expect(rewired?.provider).toBe('openai-compatible')
    expect(rewired?.baseURL).toBe('http://127.0.0.1:11434/v1')
    expect(rewired?.providerLabel).toBe('Ollama')
    expect(rewired?.system).toBe('you mentor') // untouched fields preserved

    // ── Claim 3: an advisory proposal is refused; the agent is byte-identical ──
    const before = JSON.stringify(await managedOf(r, 'mentor'))
    const refused = await fetch(`${r.baseUrl}/api/admin/resources/adapt`, {
      method: 'POST',
      headers: auth(r.token),
      body: JSON.stringify({ proposal: advisory }),
    })
    expect(refused.status).toBe(400)
    expect((await refused.json()).code).toBe('not_applicable')
    expect(JSON.stringify(await managedOf(r, 'mentor'))).toBe(before)
  })
})
