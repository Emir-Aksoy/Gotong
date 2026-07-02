/**
 * RES-M1 — unit tests for `createResourceInventoryService`, the deterministic
 * read-only snapshot of adaptable local resources. All deps are injected fakes
 * (no real fs / network / PATH), so these pin the aggregation contract:
 *   - llmKeys: env existence ∪ vault existence, EXISTENCE ONLY — never a value;
 *   - vault providers not in the well-known map still surface (MiMo/DeepSeek);
 *   - localEndpoints: reachable = fetch resolved; error/timeout → unreachable;
 *   - cliAgents: found = existsSync on a PATH dir; apiKeyEnvSet is existence-only;
 *   - mcpServers: name-only listing;
 *   - best-effort: a fault in one family degrades that family, never throws;
 *   - NO SECRET VALUE ever appears in the serialized snapshot.
 */

import { describe, expect, it } from 'vitest'

import {
  createResourceInventoryService,
  type ResourceInventoryDeps,
} from '../src/resource-inventory.js'

/** Build the service with hermetic defaults; every family is fake by default. */
function svc(over: Partial<ResourceInventoryDeps> = {}) {
  return createResourceInventoryService({
    env: {},
    listVaultProviders: () => [],
    listMcpServers: async () => [],
    // default: no endpoints probed unless a test opts in (keeps tests offline).
    localEndpoints: [],
    pathDirs: [],
    exists: () => false,
    fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    ...over,
  })
}

describe('createResourceInventoryService — llmKeys (RES-M1)', () => {
  it('reports env EXISTENCE only, never the value', async () => {
    const inv = await svc({
      env: { ANTHROPIC_API_KEY: 'sk-super-secret-should-never-surface' },
    }).inventory()
    const anthropic = inv.llmKeys.find((r) => r.provider === 'anthropic')
    expect(anthropic).toMatchObject({ envVar: 'ANTHROPIC_API_KEY', envSet: true })
    // the secret value must not appear ANYWHERE in the serialized snapshot
    expect(JSON.stringify(inv)).not.toContain('sk-super-secret-should-never-surface')
  })

  it('blank / whitespace env var counts as unset', async () => {
    const inv = await svc({ env: { OPENAI_API_KEY: '   ' } }).inventory()
    expect(inv.llmKeys.find((r) => r.provider === 'openai')?.envSet).toBe(false)
  })

  it('vault providers not in the well-known map still surface (no env guess)', async () => {
    const inv = await svc({ listVaultProviders: () => ['deepseek', 'mimo'] }).inventory()
    const mimo = inv.llmKeys.find((r) => r.provider === 'mimo')
    expect(mimo).toMatchObject({ vaultConfigured: true, envSet: false })
    expect(mimo?.envVar).toBeUndefined()
    // deepseek IS in the well-known map → carries its env var guess
    expect(inv.llmKeys.find((r) => r.provider === 'deepseek')?.envVar).toBe('DEEPSEEK_API_KEY')
  })

  it('rows are sorted by provider and dedupe env∪vault union', async () => {
    const inv = await svc({
      env: { ANTHROPIC_API_KEY: 'x' },
      listVaultProviders: () => ['anthropic', 'zzz-vendor'],
    }).inventory()
    const providers = inv.llmKeys.map((r) => r.provider)
    expect(providers).toEqual([...providers].sort())
    // anthropic appears exactly once despite being in both env-known and vault
    expect(providers.filter((p) => p === 'anthropic')).toHaveLength(1)
    expect(inv.llmKeys.find((r) => r.provider === 'anthropic')).toMatchObject({
      envSet: true,
      vaultConfigured: true,
    })
  })

  it('vault probe fault degrades to "none configured", never throws', async () => {
    const inv = await svc({
      listVaultProviders: () => {
        throw new Error('vault boom')
      },
    }).inventory()
    // still returns the well-known providers, all vaultConfigured=false
    expect(inv.llmKeys.every((r) => r.vaultConfigured === false)).toBe(true)
    expect(inv.llmKeys.length).toBeGreaterThan(0)
  })
})

describe('createResourceInventoryService — localEndpoints (RES-M1)', () => {
  it('reachable when fetch resolves (any HTTP response = something listening)', async () => {
    const inv = await svc({
      localEndpoints: [{ label: 'Ollama', url: 'http://127.0.0.1:11434/api/tags' }],
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    }).inventory()
    expect(inv.localEndpoints).toEqual([
      { label: 'Ollama', url: 'http://127.0.0.1:11434/api/tags', reachable: true },
    ])
  })

  it('a 404 still counts as reachable (server is up, wrong path)', async () => {
    const inv = await svc({
      localEndpoints: [{ label: 'Ollama', url: 'http://127.0.0.1:11434/nope' }],
      fetchImpl: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
    }).inventory()
    expect(inv.localEndpoints[0]?.reachable).toBe(true)
  })

  it('unreachable when fetch throws (refused / DNS / timeout), fail-open', async () => {
    const inv = await svc({
      localEndpoints: [{ label: 'Ollama', url: 'http://127.0.0.1:11434/api/tags' }],
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    }).inventory()
    expect(inv.localEndpoints[0]?.reachable).toBe(false)
  })

  it('empty endpoint list → no network family, no probe', async () => {
    let called = false
    const inv = await svc({
      localEndpoints: [],
      fetchImpl: (async () => {
        called = true
        return new Response(null)
      }) as unknown as typeof fetch,
    }).inventory()
    expect(inv.localEndpoints).toEqual([])
    expect(called).toBe(false)
  })

  it('AIPE_RES_ENDPOINTS env extends the default probe list', async () => {
    const inv = await svc({
      env: { AIPE_RES_ENDPOINTS: 'LM Studio=http://127.0.0.1:1234/v1/models,bad-no-url' },
      // localEndpoints undefined → falls back to Ollama default ∪ env list
      localEndpoints: undefined,
      fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    }).inventory()
    const labels = inv.localEndpoints.map((e) => e.label)
    expect(labels).toContain('Ollama') // default
    expect(labels).toContain('LM Studio') // env-added
    expect(labels).not.toContain('bad-no-url') // malformed (no `=url`) skipped
  })
})

describe('createResourceInventoryService — cliAgents (RES-M1)', () => {
  it('found when the command exists in a PATH dir (existsSync, no subprocess)', async () => {
    const inv = await svc({
      pathDirs: ['/usr/local/bin', '/opt/homebrew/bin'],
      exists: (p) => p === '/opt/homebrew/bin/claude',
    }).inventory()
    const claude = inv.cliAgents.find((c) => c.command === 'claude')
    expect(claude).toMatchObject({ label: 'Claude Code', found: true })
    // a CLI not on PATH is present in the roster but found=false
    expect(inv.cliAgents.find((c) => c.command === 'codex')?.found).toBe(false)
  })

  it('surfaces the CLI apiKeyEnv existence (existence only)', async () => {
    const inv = await svc({
      env: { ANTHROPIC_API_KEY: 'x' },
      pathDirs: ['/bin'],
      exists: () => false,
    }).inventory()
    expect(inv.cliAgents.find((c) => c.command === 'claude')).toMatchObject({
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      apiKeyEnvSet: true,
    })
    // a CLI with no key env carries neither field
    const opencode = inv.cliAgents.find((c) => c.command === 'opencode')
    expect(opencode?.apiKeyEnv).toBeUndefined()
    expect(opencode?.apiKeyEnvSet).toBeUndefined()
  })
})

describe('createResourceInventoryService — mcpServers (RES-M1)', () => {
  it('lists installed hub MCP servers by name', async () => {
    const inv = await svc({
      listMcpServers: async () => [{ spec: { name: 'chroma' } }, { spec: { name: 'obsidian' } }],
    }).inventory()
    expect(inv.mcpServers).toEqual([{ name: 'chroma' }, { name: 'obsidian' }])
  })

  it('mcp probe fault degrades to empty, never throws', async () => {
    const inv = await svc({
      listMcpServers: async () => {
        throw new Error('registry boom')
      },
    }).inventory()
    expect(inv.mcpServers).toEqual([])
  })
})

describe('createResourceInventoryService — shape (RES-M1)', () => {
  it('always returns all four families + a timestamp', async () => {
    const inv = await svc().inventory()
    expect(inv).toHaveProperty('llmKeys')
    expect(inv).toHaveProperty('localEndpoints')
    expect(inv).toHaveProperty('cliAgents')
    expect(inv).toHaveProperty('mcpServers')
    expect(typeof inv.checkedAt).toBe('string')
  })
})
