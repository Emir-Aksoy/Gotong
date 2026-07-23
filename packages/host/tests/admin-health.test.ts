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
import type { HealthRoutingRow } from '../src/routing-health.js'

function svc(opts: {
  agents: HealthAgentLike[]
  live?: string[]
  resolvesKey?: (id: string, provider: string) => Promise<boolean>
  mcp?: HealthMcpLike[]
  writable?: boolean
  spacePath?: string
  // EH-M1 — config-progress deps are OPTIONAL by design; absent → snapshot
  // omits the counts entirely (honest "unknown", not a defaulted 0).
  countWorkflows?: () => Promise<{ total: number; published: number }>
  countRuns?: () => Promise<number>
  // DEPLOY-B3 — live IM bridge rows; same optional-dep contract.
  imStatus?: () => { platform: string; source?: string }[]
  // FDE-M1b — declared connector slots; same optional-dep contract.
  listConnectorSlots?: () => Promise<
    { pack: string; id: string; optional: boolean; hint?: string }[]
  >
  // CARE-M7 — 断供读取;same optional-dep contract (absent → snapshot 无 llmOutage).
  readLlmOutage?: () => Promise<{ kind: string; since: number } | null>
  // MR-M3 — routing-health projection; same optional-dep contract.
  routingHealth?: () => HealthRoutingRow[]
  // B② — new-version notice; same optional-dep contract.
  readUpdateAvailable?: () => { current: string; latest: string } | null | undefined
}) {
  return createAdminHealthService({
    listAgents: async () => opts.agents,
    liveIds: () => new Set(opts.live ?? []),
    resolvesKey: opts.resolvesKey ?? (async () => true),
    listMcpServers: async () => opts.mcp ?? [],
    spacePath: opts.spacePath ?? '/tmp/space',
    probeWritable: async () => opts.writable ?? true,
    ...(opts.countWorkflows ? { countWorkflows: opts.countWorkflows } : {}),
    ...(opts.countRuns ? { countRuns: opts.countRuns } : {}),
    ...(opts.imStatus ? { imStatus: opts.imStatus } : {}),
    ...(opts.listConnectorSlots ? { listConnectorSlots: opts.listConnectorSlots } : {}),
    ...(opts.readLlmOutage ? { readLlmOutage: opts.readLlmOutage } : {}),
    ...(opts.routingHealth ? { routingHealth: opts.routingHealth } : {}),
    ...(opts.readUpdateAvailable ? { readUpdateAvailable: opts.readUpdateAvailable } : {}),
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
    const ok = await svc({ agents: [], writable: true, spacePath: '/data/.gotong' }).snapshot()
    expect(ok.spaceWritable).toBe(true)
    expect(ok.spacePath).toBe('/data/.gotong')
    const bad = await svc({ agents: [], writable: false }).snapshot()
    expect(bad.spaceWritable).toBe(false)
  })

  // EH-M1 — config-progress counts feed the panel's "next step" guidance. The
  // optional shape is load-bearing: an absent count must stay absent (not 0), so
  // the frontend can tell "host didn't wire workflows" from "truly 0 workflows"
  // and not wrongly suggest "go build one".
  it('omits config-progress counts entirely when those deps are not injected', async () => {
    const s = await svc({ agents: [managed('a1', 'openai')] }).snapshot()
    expect('workflowCount' in s).toBe(false)
    expect('publishedWorkflowCount' in s).toBe(false)
    expect('runCount' in s).toBe(false)
  })

  it('includes workflow + run counts when those deps are injected', async () => {
    const s = await svc({
      agents: [managed('a1', 'openai')],
      countWorkflows: async () => ({ total: 3, published: 2 }),
      countRuns: async () => 7,
    }).snapshot()
    expect(s.workflowCount).toBe(3)
    expect(s.publishedWorkflowCount).toBe(2)
    expect(s.runCount).toBe(7)
  })

  it('best-effort: a counting dep that throws degrades to 0, never breaks the snapshot', async () => {
    const s = await svc({
      agents: [managed('a1', 'openai')],
      countWorkflows: async () => {
        throw new Error('controller offline')
      },
      countRuns: async () => {
        throw new Error('run store offline')
      },
    }).snapshot()
    // dep present but faulted → count as 0 (advisory), and the rest of the
    // snapshot still resolves (agent row intact).
    expect(s.workflowCount).toBe(0)
    expect(s.publishedWorkflowCount).toBe(0)
    expect(s.runCount).toBe(0)
    expect(s.managedCount).toBe(1)
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

  // DEPLOY-B3 — IM bridge rows share the optional-dep honesty ladder: absent
  // dep → field absent ("host didn't wire IM" ≠ "no channels"); dep present →
  // rows verbatim ([] means genuinely none); dep fault → [] (advisory, never
  // breaks the snapshot).
  describe('imBridges (DEPLOY-B3)', () => {
    it('omits the field entirely when the dep is not injected', async () => {
      const s = await svc({ agents: [] }).snapshot()
      expect('imBridges' in s).toBe(false)
    })

    it('echoes live rows with platform + credential source', async () => {
      const s = await svc({
        agents: [],
        imStatus: () => [
          { platform: 'telegram', source: 'vault' },
          { platform: 'slack', source: 'env' },
        ],
      }).snapshot()
      expect(s.imBridges).toEqual([
        { platform: 'telegram', source: 'vault' },
        { platform: 'slack', source: 'env' },
      ])
    })

    it('reports [] when the dep is wired but no bridge is live', async () => {
      const s = await svc({ agents: [], imStatus: () => [] }).snapshot()
      expect(s.imBridges).toEqual([])
    })

    it('degrades a dep fault to [] without breaking the snapshot', async () => {
      const s = await svc({
        agents: [managed('a1', 'openai')],
        imStatus: () => {
          throw new Error('bridges not up yet')
        },
      }).snapshot()
      expect(s.imBridges).toEqual([])
      expect(s.managedCount).toBe(1)
    })
  })

  // FDE-M1b — declared connector slots with LIVE fulfilment. The file only
  // stores intent ("pack X wants a server named Y"); `filled` is computed here
  // against actual MCP wiring (hub registry OR any agent's inline servers), so
  // the verdict can never go stale. Same optional-dep honesty ladder as above.
  describe('connectorSlots (FDE-M1b)', () => {
    const slot = (pack: string, id: string, extra?: { optional?: boolean; hint?: string }) => ({
      pack,
      id,
      optional: extra?.optional ?? false,
      ...(extra?.hint !== undefined ? { hint: extra.hint } : {}),
    })

    it('omits the field entirely when the dep is not injected', async () => {
      const s = await svc({ agents: [] }).snapshot()
      expect('connectorSlots' in s).toBe(false)
    })

    it('marks a slot filled when a hub-registry MCP server bears its name', async () => {
      const s = await svc({
        agents: [],
        mcp: [{ spec: { name: 'calendar' } }],
        listConnectorSlots: async () => [slot('morning-brief-hub', 'calendar', { optional: true })],
      }).snapshot()
      expect(s.connectorSlots).toEqual([
        { pack: 'morning-brief-hub', id: 'calendar', optional: true, filled: true },
      ])
    })

    it('marks a slot filled from an agent INLINE mcpServers name too', async () => {
      const s = await svc({
        agents: [
          {
            id: 'a1',
            managed: { kind: 'llm', provider: 'openai', mcpServers: [{ name: 'notes' }] },
          },
        ],
        listConnectorSlots: async () => [slot('pack-a', 'notes')],
      }).snapshot()
      expect(s.connectorSlots?.[0]).toMatchObject({ id: 'notes', filled: true })
    })

    it('reports unfilled slots with hint passthrough when nothing matches', async () => {
      const s = await svc({
        agents: [],
        mcp: [{ spec: { name: 'other' } }],
        listConnectorSlots: async () => [
          slot('pack-a', 'calendar', { optional: true, hint: '连接器目录「日历」组任选后端' }),
        ],
      }).snapshot()
      expect(s.connectorSlots).toEqual([
        {
          pack: 'pack-a',
          id: 'calendar',
          optional: true,
          hint: '连接器目录「日历」组任选后端',
          filled: false,
        },
      ])
    })

    it('degrades a dep fault to [] without breaking the snapshot', async () => {
      const s = await svc({
        agents: [managed('a1', 'openai')],
        listConnectorSlots: async () => {
          throw new Error('registry unreadable')
        },
      }).snapshot()
      expect(s.connectorSlots).toEqual([])
      expect(s.managedCount).toBe(1)
    })
  })

  describe('llmOutage (CARE-M7)', () => {
    it('omits the field entirely when the dep is not injected (honest unknown)', async () => {
      const s = await svc({ agents: [managed('a1', 'openai')] }).snapshot()
      expect('llmOutage' in s).toBe(false)
    })

    it('null when wired but there is no outage (checked, healthy)', async () => {
      const s = await svc({
        agents: [managed('a1', 'openai')],
        readLlmOutage: async () => null,
      }).snapshot()
      expect(s.llmOutage).toBe(null)
    })

    it('passes through the outage fact (kind + since) when down', async () => {
      const s = await svc({
        agents: [managed('a1', 'anthropic')],
        readLlmOutage: async () => ({ kind: 'auth', since: 1_700_000_000_000 }),
      }).snapshot()
      expect(s.llmOutage).toEqual({ kind: 'auth', since: 1_700_000_000_000 })
    })

    it('degrades a dep fault to null — a read fault must never show a false red', async () => {
      const s = await svc({
        agents: [managed('a1', 'anthropic')],
        readLlmOutage: async () => {
          throw new Error('disk hiccup')
        },
      }).snapshot()
      expect(s.llmOutage).toBe(null) // fail-open:体检读盘出错 ≠ 断供
      expect(s.managedCount).toBe(1)
    })
  })

  describe('routing (MR-M3)', () => {
    const row: HealthRoutingRow = {
      agentId: 'a1',
      candidate: 'anthropic',
      index: 0,
      state: 'open',
      errorKind: 'network',
      since: 1_700_000_000_000,
      openUntil: 1_700_000_030_000,
    }

    it('omits the field entirely when the dep is not injected (honest unknown)', async () => {
      const s = await svc({ agents: [managed('a1', 'anthropic')] }).snapshot()
      expect('routing' in s).toBe(false)
    })

    it('empty array when wired but every candidate is healthy', async () => {
      const s = await svc({
        agents: [managed('a1', 'anthropic')],
        routingHealth: () => [],
      }).snapshot()
      expect(s.routing).toEqual([])
    })

    it('passes through the degraded candidate rows verbatim', async () => {
      const s = await svc({
        agents: [managed('a1', 'anthropic')],
        routingHealth: () => [row],
      }).snapshot()
      expect(s.routing).toEqual([row])
    })

    it('degrades a sink fault to [] — a projection fault must never sink the panel', async () => {
      const s = await svc({
        agents: [managed('a1', 'anthropic')],
        routingHealth: () => {
          throw new Error('sink boom')
        },
      }).snapshot()
      expect(s.routing).toEqual([])
      expect(s.managedCount).toBe(1)
    })
  })

  describe('updateAvailable (perf audit B②)', () => {
    it('omits the field when the dep is not injected OR the probe has no answer yet', async () => {
      const unwired = await svc({ agents: [managed('a1', 'openai')] }).snapshot()
      expect('updateAvailable' in unwired).toBe(false)

      // knob on but no successful probe yet → still absent (unknown ≠ current)
      const unprobed = await svc({
        agents: [managed('a1', 'openai')],
        readUpdateAvailable: () => undefined,
      }).snapshot()
      expect('updateAvailable' in unprobed).toBe(false)
    })

    it('null when probed and current; the row when a newer release exists', async () => {
      const current = await svc({
        agents: [managed('a1', 'openai')],
        readUpdateAvailable: () => null,
      }).snapshot()
      expect(current.updateAvailable).toBe(null)

      const behind = await svc({
        agents: [managed('a1', 'openai')],
        readUpdateAvailable: () => ({ current: '4.0.0', latest: '4.1.0' }),
      }).snapshot()
      expect(behind.updateAvailable).toEqual({ current: '4.0.0', latest: '4.1.0' })
    })

    it('degrades a dep fault to ABSENT — never a false "up to date" null', async () => {
      const s = await svc({
        agents: [managed('a1', 'openai')],
        readUpdateAvailable: () => {
          throw new Error('boom')
        },
      }).snapshot()
      expect('updateAvailable' in s).toBe(false)
      expect(s.managedCount).toBe(1)
    })
  })
})
