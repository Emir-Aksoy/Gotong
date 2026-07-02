/**
 * RES-M2 — proposeAdaptations (the pure adaptation proposal engine).
 *
 * The engine turns a RES-M1 inventory + the hub's agents into a list of
 * PROPOSALS: pure data describing a change that would let a keyless agent run on
 * this machine (use the local Ollama, switch to a provider with a key, …). The
 * whole RES point is the human-approval invariant — so these tests pin that the
 * engine has ZERO side effects, is deterministic, and correctly splits
 * `applicable:true` (RES-M3 can enact via an agent update) from
 * `applicable:false` (advisory: the fix is a human action outside the hub).
 */

import { describe, expect, it } from 'vitest'

import {
  proposeAdaptations,
  createResourceAdaptationService,
  type AdaptationProposal,
} from '../src/resource-adaptation.js'
import type { ResourceInventory } from '../src/resource-inventory.js'

/** A canned inventory: anthropic has an env key, deepseek has no key at all. */
function inv(over: Partial<ResourceInventory> = {}): ResourceInventory {
  return {
    llmKeys: [
      { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY', envSet: true, vaultConfigured: false },
      { provider: 'deepseek', envVar: 'DEEPSEEK_API_KEY', envSet: false, vaultConfigured: false },
    ],
    localEndpoints: [{ label: 'Ollama', url: 'http://127.0.0.1:11434/api/tags', reachable: true }],
    cliAgents: [],
    mcpServers: [{ name: 'chroma' }],
    checkedAt: '2026-07-02T00:00:00.000Z',
    ...over,
  }
}

const byKind = (props: AdaptationProposal[], kind: AdaptationProposal['kind']) =>
  props.filter((p) => p.kind === kind)

describe('proposeAdaptations (RES-M2)', () => {
  it('emits nothing for an agent whose provider already resolves a key', () => {
    // anthropic has an env key → no adaptation needed.
    const props = proposeAdaptations({
      inventory: inv(),
      agents: [{ id: 'writer', provider: 'anthropic' }],
    })
    expect(props).toEqual([])
  })

  it('skips mock agents entirely (mock needs no key)', () => {
    const props = proposeAdaptations({
      inventory: inv(),
      agents: [{ id: 'demo', provider: 'mock' }],
    })
    expect(props).toEqual([])
  })

  it('a keyless agent gets use_local_endpoint (applicable) when a local endpoint is up', () => {
    const props = proposeAdaptations({
      inventory: inv(),
      agents: [{ id: 'mentor', provider: 'deepseek' }],
    })
    const local = byKind(props, 'use_local_endpoint')
    expect(local).toHaveLength(1)
    expect(local[0]).toMatchObject({
      kind: 'use_local_endpoint',
      agentId: 'mentor',
      fromProvider: 'deepseek',
      endpointLabel: 'Ollama',
      suggestedBaseURL: 'http://127.0.0.1:11434/v1',
      applicable: true,
    })
    // id is stable + deterministic
    expect(local[0]!.id).toBe('adapt:use_local_endpoint:mentor:Ollama')
  })

  it('a keyless agent gets switch_provider to a provider that DOES have a key (applicable)', () => {
    const props = proposeAdaptations({
      inventory: inv(),
      agents: [{ id: 'mentor', provider: 'deepseek' }],
    })
    const sw = byKind(props, 'switch_provider')
    expect(sw).toHaveLength(1)
    expect(sw[0]).toMatchObject({
      kind: 'switch_provider',
      agentId: 'mentor',
      fromProvider: 'deepseek',
      toProvider: 'anthropic',
      keySource: 'env',
      applicable: true,
    })
    expect(sw[0]!.id).toBe('adapt:switch_provider:mentor:anthropic')
  })

  it('keySource reflects vault when the alt provider is vault-configured only', () => {
    const props = proposeAdaptations({
      inventory: inv({
        llmKeys: [
          { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY', envSet: false, vaultConfigured: true },
          { provider: 'deepseek', envVar: 'DEEPSEEK_API_KEY', envSet: false, vaultConfigured: false },
        ],
      }),
      agents: [{ id: 'mentor', provider: 'deepseek' }],
    })
    expect(byKind(props, 'switch_provider')[0]).toMatchObject({ keySource: 'vault' })
  })

  it('a keyless agent with a conventional env var gets an advisory set_env_key (NOT applicable)', () => {
    const props = proposeAdaptations({
      inventory: inv(),
      agents: [{ id: 'mentor', provider: 'deepseek' }],
    })
    const setEnv = byKind(props, 'set_env_key')
    expect(setEnv).toHaveLength(1)
    expect(setEnv[0]).toMatchObject({
      kind: 'set_env_key',
      agentId: 'mentor',
      provider: 'deepseek',
      envVar: 'DEEPSEEK_API_KEY',
      applicable: false, // human action outside the hub — no apply button
    })
  })

  it('no local endpoint reachable → no use_local_endpoint, but switch/set-env still offered', () => {
    const props = proposeAdaptations({
      inventory: inv({
        localEndpoints: [{ label: 'Ollama', url: 'http://127.0.0.1:11434/api/tags', reachable: false }],
      }),
      agents: [{ id: 'mentor', provider: 'deepseek' }],
    })
    expect(byKind(props, 'use_local_endpoint')).toHaveLength(0)
    expect(byKind(props, 'switch_provider')).toHaveLength(1)
    expect(byKind(props, 'set_env_key')).toHaveLength(1)
  })

  it('no provider has a key → no switch_provider (but local endpoint + set-env still offered)', () => {
    const props = proposeAdaptations({
      inventory: inv({
        llmKeys: [
          { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY', envSet: false, vaultConfigured: false },
          { provider: 'deepseek', envVar: 'DEEPSEEK_API_KEY', envSet: false, vaultConfigured: false },
        ],
      }),
      agents: [{ id: 'mentor', provider: 'deepseek' }],
    })
    expect(byKind(props, 'switch_provider')).toHaveLength(0)
    expect(byKind(props, 'use_local_endpoint')).toHaveLength(1)
    expect(byKind(props, 'set_env_key')).toHaveLength(1)
  })

  it('an unknown provider with no env-var row gets no set_env_key advisory', () => {
    // A keyless agent whose provider is not in the inventory llmKeys at all →
    // there is no conventional env var to advise, so no set_env_key. It still
    // gets the local-endpoint + switch options that don't depend on its own row.
    const props = proposeAdaptations({
      inventory: inv(),
      agents: [{ id: 'weird', provider: 'some-exotic-provider' }],
    })
    expect(byKind(props, 'set_env_key')).toHaveLength(0)
    expect(byKind(props, 'use_local_endpoint')).toHaveLength(1)
    expect(byKind(props, 'switch_provider')).toHaveLength(1)
    // switching away from an exotic provider goes to the first keyed one
    expect(byKind(props, 'switch_provider')[0]).toMatchObject({ toProvider: 'anthropic' })
  })

  it('KB slot referencing an INSTALLED server → advisory wire_mcp_server (NOT applicable)', () => {
    const props = proposeAdaptations({
      inventory: inv(),
      agents: [],
      kbSlots: [{ name: 'coding_methodology', useMcpServer: 'chroma' }],
    })
    const wire = byKind(props, 'wire_mcp_server')
    expect(wire).toHaveLength(1)
    expect(wire[0]).toMatchObject({
      kind: 'wire_mcp_server',
      slotName: 'coding_methodology',
      candidateServer: 'chroma',
      applicable: false,
    })
    expect(wire[0]!.id).toBe('adapt:wire_mcp:coding_methodology:chroma')
  })

  it('KB slot referencing a server that is NOT installed → no proposal', () => {
    const props = proposeAdaptations({
      inventory: inv(),
      agents: [],
      kbSlots: [{ name: 'coding_methodology', useMcpServer: 'not-installed' }],
    })
    expect(byKind(props, 'wire_mcp_server')).toHaveLength(0)
  })

  it('KB slot with no useMcpServer reference → no proposal', () => {
    const props = proposeAdaptations({
      inventory: inv(),
      agents: [],
      kbSlots: [{ name: 'coding_methodology' }],
    })
    expect(byKind(props, 'wire_mcp_server')).toHaveLength(0)
  })

  it('is deterministic — same inputs produce byte-identical output twice', () => {
    const input = {
      inventory: inv(),
      agents: [
        { id: 'mentor', provider: 'deepseek' },
        { id: 'writer', provider: 'anthropic' },
      ],
      kbSlots: [{ name: 'kb', useMcpServer: 'chroma' }],
    }
    const a = proposeAdaptations(input)
    const b = proposeAdaptations(input)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('has zero side effects — it never mutates the inventory or agents it is handed', () => {
    const inventory = inv()
    const invSnapshot = JSON.stringify(inventory)
    const agents = [{ id: 'mentor', provider: 'deepseek' }]
    const agentsSnapshot = JSON.stringify(agents)
    proposeAdaptations({ inventory, agents })
    expect(JSON.stringify(inventory)).toBe(invSnapshot)
    expect(JSON.stringify(agents)).toBe(agentsSnapshot)
  })

  describe('createResourceAdaptationService', () => {
    it('fetches a fresh inventory then runs the pure engine over it', async () => {
      let fetched = 0
      const svc = createResourceAdaptationService({
        async inventory() {
          fetched++
          return inv()
        },
      })
      const props = await svc.propose({ agents: [{ id: 'mentor', provider: 'deepseek' }] })
      expect(fetched).toBe(1)
      expect(byKind(props, 'use_local_endpoint')).toHaveLength(1)
      expect(byKind(props, 'switch_provider')).toHaveLength(1)
    })

    it('carries KB slots through to the engine', async () => {
      const svc = createResourceAdaptationService({ async inventory() { return inv() } })
      const props = await svc.propose({
        agents: [],
        kbSlots: [{ name: 'kb', useMcpServer: 'chroma' }],
      })
      expect(byKind(props, 'wire_mcp_server')).toHaveLength(1)
    })
  })
})
