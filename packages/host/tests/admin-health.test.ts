/**
 * ❷-M1 — unit tests for `createAdminHealthService`, the read-only "hub 体检"
 * aggregator. All deps are injected fakes (no real fs / hub), so these pin the
 * aggregation logic, not the host wiring (that's covered by the web route test +
 * main.ts):
 *   - only managed LLM agents are scanned (plain participants ignored);
 *   - missingKey is the fail-OPEN negation of resolvesKey (fault → quiet);
 *   - `mock` provider agents are never flagged (they need no key);
 *   - MCP "wired" = referenced by ≥1 managed agent's useMcpServers;
 *   - space writability flows from the injected probe.
 */

import { describe, expect, it } from 'vitest'

import {
  createAdminHealthService,
  type HealthAgentLike,
  type HealthMcpLike,
} from '../src/admin-health.js'

function svc(opts: {
  agents: HealthAgentLike[]
  live?: string[]
  resolvesKey?: (id: string, provider: string) => Promise<boolean>
  mcp?: HealthMcpLike[]
  writable?: boolean
  spacePath?: string
}) {
  return createAdminHealthService({
    listAgents: async () => opts.agents,
    liveIds: () => new Set(opts.live ?? []),
    resolvesKey: opts.resolvesKey ?? (async () => true),
    listMcpServers: async () => opts.mcp ?? [],
    spacePath: opts.spacePath ?? '/tmp/space',
    probeWritable: async () => opts.writable ?? true,
  })
}

const managed = (
  id: string,
  provider: string,
  useMcpServers?: string[],
): HealthAgentLike => ({
  id,
  managed: { kind: 'llm', provider, ...(useMcpServers ? { useMcpServers } : {}) },
})

describe('createAdminHealthService.snapshot', () => {
  it('flags a managed agent whose key does not resolve', async () => {
    const s = await svc({
      agents: [managed('a1', 'anthropic')],
      resolvesKey: async () => false,
    }).snapshot()
    expect(s.managedCount).toBe(1)
    expect(s.agentsMissingKey).toBe(1)
    expect(s.agents[0]).toMatchObject({ id: 'a1', provider: 'anthropic', missingKey: true })
  })

  it('does NOT flag an agent whose key resolves', async () => {
    const s = await svc({
      agents: [managed('a1', 'openai')],
      resolvesKey: async () => true,
    }).snapshot()
    expect(s.agentsMissingKey).toBe(0)
    expect(s.agents[0].missingKey).toBe(false)
  })

  it('treats a probe fault as fine (fail-open, never a false alarm)', async () => {
    const s = await svc({
      agents: [managed('a1', 'anthropic')],
      resolvesKey: async () => {
        throw new Error('vault locked')
      },
    }).snapshot()
    expect(s.agentsMissingKey).toBe(0)
    expect(s.agents[0].missingKey).toBe(false)
  })

  it('ignores plain (non-managed) participants', async () => {
    const s = await svc({
      agents: [{ id: 'sidecar' }, managed('a1', 'anthropic')],
      resolvesKey: async () => false,
    }).snapshot()
    expect(s.managedCount).toBe(1)
    expect(s.agents.map((a) => a.id)).toEqual(['a1'])
  })

  it('marks managed agents online from the live id set', async () => {
    const s = await svc({
      agents: [managed('a1', 'openai'), managed('a2', 'openai')],
      live: ['a1'],
    }).snapshot()
    expect(s.onlineCount).toBe(1)
    expect(s.agents.find((a) => a.id === 'a1')?.online).toBe(true)
    expect(s.agents.find((a) => a.id === 'a2')?.online).toBe(false)
  })

  it('flags MCP servers no agent references, and clears the wired ones', async () => {
    const s = await svc({
      agents: [managed('a1', 'openai', ['chroma'])],
      mcp: [{ spec: { name: 'chroma' } }, { spec: { name: 'obsidian' } }],
    }).snapshot()
    expect(s.mcpUnwired).toBe(1)
    expect(s.mcpServers.find((m) => m.name === 'chroma')?.wired).toBe(true)
    expect(s.mcpServers.find((m) => m.name === 'obsidian')?.wired).toBe(false)
  })

  it('reports space writability + path from the injected probe', async () => {
    const ok = await svc({ agents: [], writable: true, spacePath: '/data/.aipehub' }).snapshot()
    expect(ok.spaceWritable).toBe(true)
    expect(ok.spacePath).toBe('/data/.aipehub')
    const bad = await svc({ agents: [], writable: false }).snapshot()
    expect(bad.spaceWritable).toBe(false)
  })

  it('empty hub → all-green zero snapshot with a timestamp', async () => {
    const s = await svc({ agents: [] }).snapshot()
    expect(s).toMatchObject({
      agents: [],
      agentsMissingKey: 0,
      managedCount: 0,
      onlineCount: 0,
      mcpServers: [],
      mcpUnwired: 0,
    })
    expect(typeof s.checkedAt).toBe('string')
    expect(Number.isNaN(Date.parse(s.checkedAt))).toBe(false)
  })
})
