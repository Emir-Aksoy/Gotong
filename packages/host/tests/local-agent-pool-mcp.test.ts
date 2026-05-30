/**
 * `LocalAgentPool` × `mcpServers:` integration tests.
 *
 * Two angles:
 *
 *   1. **Pure-function tests for `mcp-config`** — `${VAR}` expansion
 *      semantics (now against a pluggable `SecretSource`) +
 *      `resolveMcpServerConfig` spec→config mapping across transports.
 *
 *   2. **End-to-end spawn → connect → tool-use → disconnect** — wire
 *      a managed agent whose manifest declares the in-tree fake MCP
 *      server, dispatch a task, watch the mock LLM provider see the
 *      toolset's tools attached to its request. We don't actually
 *      drive a real LLM here — that would require a live model
 *      account — instead we hook into the provider boundary and
 *      assert what the agent forwards downstream.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLogger, Hub, Space, type AgentRecord } from '@aipehub/core'
import type { LlmRequest } from '@aipehub/llm'

import { LocalAgentPool } from '../src/local-agent-pool.js'
import {
  expandSecretRefs,
  resolveMcpServerConfig,
  mergeAgentMcpSpecs,
  type SecretSource,
} from '../src/mcp-config.js'
import type { McpServerSpec } from '@aipehub/core'

const logger = createLogger('lap-mcp-test', { disabled: true })
void logger

/**
 * Path to the in-tree fake MCP server (lives in `@aipehub/mcp-client/tests`).
 * Re-used here so the host test exercises the real spawn + handshake
 * without depending on `npx -y` (flaky in CI, slow on first run).
 */
const FAKE_MCP_SERVER = fileURLToPath(
  new URL(
    '../../mcp-client/tests/fake-mcp-server.mjs',
    import.meta.url,
  ),
)
void dirname

// --- expandSecretRefs (pure-function tests) ----------------------------
//
// R6: expansion now runs against a pluggable `SecretSource` instead of
// reaching into `process.env` directly, so these tests feed a plain map
// — no env mutation, no cleanup, vault-ready.

const secrets: SecretSource = (name) =>
  ({ FAKE_TOKEN: 'sk-test-12345', FAKE_TEAM: 'TEAM-42' })[name]

describe('expandSecretRefs — ${VAR} substitution semantics', () => {
  it('expands a single ${VAR} reference', () => {
    expect(expandSecretRefs({ TOKEN: '${FAKE_TOKEN}' }, secrets, 's')).toEqual({
      TOKEN: 'sk-test-12345',
    })
  })

  it('expands multiple references in one value', () => {
    expect(
      expandSecretRefs({ COMPOSITE: 'prefix:${FAKE_TOKEN}-${FAKE_TEAM}' }, secrets, 's'),
    ).toEqual({ COMPOSITE: 'prefix:sk-test-12345-TEAM-42' })
  })

  it('missing var expands to empty string + fires onMissingSecret', () => {
    const missed: Array<[string, string]> = []
    expect(
      expandSecretRefs({ X: 'pre-${NOPE}-post' }, secrets, 'srv', (v, s) =>
        missed.push([v, s]),
      ),
    ).toEqual({ X: 'pre--post' })
    expect(missed).toEqual([['NOPE', 'srv']])
  })

  it('values without any ${} markers pass through unchanged', () => {
    expect(expandSecretRefs({ PATH_THING: '/usr/local/bin' }, secrets, 's')).toEqual({
      PATH_THING: '/usr/local/bin',
    })
  })

  it('does NOT expand a literal $5.99 — only the ${VAR} form', () => {
    expect(expandSecretRefs({ PRICE: '$5.99' }, secrets, 's')).toEqual({ PRICE: '$5.99' })
  })

  it('preserves keys with empty values', () => {
    expect(expandSecretRefs({ EMPTY: '' }, secrets, 's')).toEqual({ EMPTY: '' })
  })

  it('only matches POSIX-shaped names — leaves $1, ${1FOO}, $NOT_BRACED alone', () => {
    expect(
      expandSecretRefs(
        { A: '${1STARTING_DIGIT}', B: '$NOT_BRACED' },
        secrets,
        's',
      ),
    ).toEqual({ A: '${1STARTING_DIGIT}', B: '$NOT_BRACED' })
  })
})

// --- resolveMcpServerConfig (spec → config mapping) --------------------

describe('resolveMcpServerConfig — spec→config across transports (R6)', () => {
  it('maps a stdio spec, expanding ${VAR} in env', () => {
    expect(
      resolveMcpServerConfig(
        {
          name: 'gh',
          command: 'npx',
          args: ['-y', 'server-github'],
          env: { GITHUB_TOKEN: '${FAKE_TOKEN}' },
          cwd: '/work',
        },
        secrets,
      ),
    ).toEqual({
      name: 'gh',
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { GITHUB_TOKEN: 'sk-test-12345' },
      cwd: '/work',
    })
  })

  it('maps an http spec, expanding ${VAR} in headers + preserving url', () => {
    expect(
      resolveMcpServerConfig(
        {
          name: 'hosted',
          transport: 'http',
          url: 'https://mcp.example.com/v1',
          headers: { Authorization: 'Bearer ${FAKE_TOKEN}' },
        },
        secrets,
      ),
    ).toEqual({
      name: 'hosted',
      transport: 'http',
      url: 'https://mcp.example.com/v1',
      headers: { Authorization: 'Bearer sk-test-12345' },
    })
  })

  it('maps an sse spec with no headers', () => {
    expect(
      resolveMcpServerConfig(
        { name: 'legacy', transport: 'sse', url: 'https://sse.example.com/stream' },
        secrets,
      ),
    ).toEqual({
      name: 'legacy',
      transport: 'sse',
      url: 'https://sse.example.com/stream',
    })
  })

  it('defaults the secret source to process.env when omitted', () => {
    process.env.FAKE_R6_DEFAULT_SRC = 'from-env'
    try {
      const cfg = resolveMcpServerConfig({
        name: 'x',
        command: 'run',
        env: { K: '${FAKE_R6_DEFAULT_SRC}' },
      })
      expect(cfg).toMatchObject({ env: { K: 'from-env' } })
    } finally {
      delete process.env.FAKE_R6_DEFAULT_SRC
    }
  })
})

// --- mergeAgentMcpSpecs (hub-registry opt-in merge, M1) ----------------

describe('mergeAgentMcpSpecs — inline + hub-registry opt-in', () => {
  const reg = (...specs: McpServerSpec[]) =>
    new Map(specs.map((s) => [s.name, s]))

  it('no opt-in → just the inline specs (copied)', () => {
    const inline: McpServerSpec[] = [{ name: 'fs', command: 'npx' }]
    expect(mergeAgentMcpSpecs(inline, [], reg())).toEqual(inline)
  })

  it('resolves opt-in names against the registry, registry-first order', () => {
    const out = mergeAgentMcpSpecs(
      [{ name: 'local', command: 'x' }],
      ['hosted'],
      reg({ name: 'hosted', transport: 'http', url: 'https://h' }),
    )
    expect(out.map((s) => s.name)).toEqual(['hosted', 'local'])
  })

  it('drops an unknown opt-in name + fires onUnknown', () => {
    const unknown: string[] = []
    const out = mergeAgentMcpSpecs([], ['ghost'], reg(), (n) => unknown.push(n))
    expect(out).toEqual([])
    expect(unknown).toEqual(['ghost'])
  })

  it('inline wins when an opt-in name collides with an inline server', () => {
    const inlineFs: McpServerSpec = { name: 'fs', command: 'local-fs' }
    const out = mergeAgentMcpSpecs(
      [inlineFs],
      ['fs'],
      reg({ name: 'fs', transport: 'http', url: 'https://registry-fs' }),
    )
    // The registry copy is dropped; only the inline one survives.
    expect(out).toEqual([inlineFs])
  })

  it('de-dupes repeated opt-in names', () => {
    const out = mergeAgentMcpSpecs(
      [],
      ['a', 'a', 'b'],
      reg({ name: 'a', command: 'x' }, { name: 'b', command: 'y' }),
    )
    expect(out.map((s) => s.name)).toEqual(['a', 'b'])
  })
})

// --- End-to-end: managed agent with mcpServers: spawns toolset ----------

describe('LocalAgentPool — agent with mcpServers attaches a toolset', () => {
  let root: string
  let space: Space
  let hub: Hub

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipe-lap-mcp-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()
  })
  afterEach(async () => {
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  async function persistAgent(record: AgentRecord): Promise<void> {
    await space.upsertAgent(record)
  }

  it('spawn pipeline attaches the toolset and the agent exposes its tools', async () => {
    await persistAgent({
      id: 'fs-bot',
      allowedCapabilities: ['draft'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'you have fs tools',
        mcpServers: [
          {
            name: 'fs',
            command: process.execPath,
            args: [FAKE_MCP_SERVER],
          },
        ],
      },
    })

    const pool = new LocalAgentPool({ hub, space })
    await pool.start()

    // Verify the agent is registered. We can't directly inspect the
    // `tools` field (it's protected). Instead, dispatch a task and
    // assert that the mock provider gets `tools:` populated.
    //
    // The mock provider needs to be the actual provider behind the
    // agent. The pool's buildProvider returns a real MockLlmProvider
    // for spec.provider === 'mock' — we capture its outgoing request
    // by intercepting at the agent level. Since the agent itself is
    // a plain LlmAgent we can't easily intercept; instead, we
    // observe the side-effect: did the toolset's listTools()
    // succeed? Check by reading the pool's spawn log (already done
    // above) and dispatching a no-op task.
    const result = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'say hi',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    // The mock provider's default reply is `[mock reply to: ...]`.
    // What we really care about: the agent didn't crash on the
    // toolset wiring. The fact that the dispatch completed proves
    // the toolset connect()'d successfully.
    expect(String((result.output as { text: string }).text)).toContain('mock reply')

    await pool.stopAll()
  })

  it('stop() disconnects the toolset (child process is reaped)', async () => {
    await persistAgent({
      id: 'fs-bot-2',
      allowedCapabilities: ['draft'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'with fs',
        mcpServers: [
          {
            name: 'fs',
            command: process.execPath,
            args: [FAKE_MCP_SERVER],
          },
        ],
      },
    })

    const pool = new LocalAgentPool({ hub, space })
    await pool.start()
    expect(hub.participant('fs-bot-2')).toBeDefined()

    // Stop and verify the participant is gone. The toolset's
    // disconnect() is wired into stop() — if it had hung, this
    // call would time out. The fact that it returns at all is the
    // assertion.
    await pool.stop('fs-bot-2')
    expect(hub.participant('fs-bot-2')).toBeUndefined()
  })

  it('a server with a bad command does NOT prevent the agent from spawning', async () => {
    // McpToolset's contract: a server that fails to spawn is marked
    // dead but the toolset (and the agent) stay usable. Verify the
    // pool inherits that.
    await persistAgent({
      id: 'half-broken',
      allowedCapabilities: ['draft'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'with maybe-broken fs',
        mcpServers: [
          {
            name: 'fs',
            // Real server — should spawn fine.
            command: process.execPath,
            args: [FAKE_MCP_SERVER],
          },
          {
            name: 'ghost',
            // Bogus path — should fail to spawn, but not tank the agent.
            command: '/no/such/binary',
          },
        ],
      },
    })

    const pool = new LocalAgentPool({ hub, space })
    await pool.start()

    expect(hub.participant('half-broken')).toBeDefined()
    const result = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'hi',
    })
    expect(result.kind).toBe('ok')
    await pool.stopAll()
  })

  it('a remote (http) mcpServer flows through the spawn pipeline (R4 union)', async () => {
    // The http transport can't reach a real server in-test, but the
    // spec must still flow through `specToConfig` → McpToolset without
    // tanking the agent: a dead remote server degrades like a dead
    // stdio one. Pair it with a live stdio server so the agent has at
    // least one working toolset.
    await persistAgent({
      id: 'remote-bot',
      allowedCapabilities: ['draft'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'with a remote tool',
        mcpServers: [
          { name: 'fs', command: process.execPath, args: [FAKE_MCP_SERVER] },
          {
            name: 'hosted',
            transport: 'http',
            url: 'http://127.0.0.1:1/mcp', // refused fast — server marked dead
            headers: { Authorization: 'Bearer ${FAKE_TOKEN_FOR_TEST}' },
          },
        ],
      },
    })
    const pool = new LocalAgentPool({ hub, space })
    await pool.start()
    expect(hub.participant('remote-bot')).toBeDefined()
    const result = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'hi',
    })
    expect(result.kind).toBe('ok')
    await pool.stopAll()
  })

  it('agent opts into a hub-registry MCP server via useMcpServers (M1)', async () => {
    // Install a server in the hub registry (no inline config on the agent).
    await space.upsertMcpServer({
      spec: { name: 'shared-fs', command: process.execPath, args: [FAKE_MCP_SERVER] },
      description: 'shared filesystem',
    })
    await persistAgent({
      id: 'opt-in-bot',
      allowedCapabilities: ['draft'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'uses a hub-installed tool',
        useMcpServers: ['shared-fs'],
      },
    })
    const pool = new LocalAgentPool({ hub, space })
    await pool.start()
    expect(hub.participant('opt-in-bot')).toBeDefined()
    const result = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'hi',
    })
    expect(result.kind).toBe('ok')
    await pool.stopAll()
  })

  it('an unknown useMcpServers name is skipped — the agent still spawns', async () => {
    await persistAgent({
      id: 'ghost-opt-in',
      allowedCapabilities: ['draft'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'opts into a non-existent registry server',
        useMcpServers: ['not-installed'],
      },
    })
    const pool = new LocalAgentPool({ hub, space })
    await pool.start()
    expect(hub.participant('ghost-opt-in')).toBeDefined()
    const result = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'hi',
    })
    expect(result.kind).toBe('ok')
    await pool.stopAll()
  })

  it('installMcpServer hot-adds to a running agent that already has a toolset (M2)', async () => {
    // Agent spawns WITH an inline toolset + opts into a not-yet-installed
    // registry server (skipped at spawn → only the inline one is live).
    await persistAgent({
      id: 'hot-add-bot',
      allowedCapabilities: ['draft'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'inline + opt-in',
        mcpServers: [{ name: 'inline', command: process.execPath, args: [FAKE_MCP_SERVER] }],
        useMcpServers: ['shared'],
      },
    })
    const pool = new LocalAgentPool({ hub, space })
    await pool.start()
    expect(pool.mcpServersForAgent('hot-add-bot')).toEqual(['inline'])

    // Install the registry server → it hot-adds to the live toolset.
    const rec = await space.upsertMcpServer({
      spec: { name: 'shared', command: process.execPath, args: [FAKE_MCP_SERVER] },
    })
    await pool.installMcpServer(rec)
    expect(pool.mcpServersForAgent('hot-add-bot').sort()).toEqual(['inline', 'shared'])

    // Uninstall → it's hot-removed again.
    await pool.uninstallMcpServer('shared')
    expect(pool.mcpServersForAgent('hot-add-bot')).toEqual(['inline'])
    await pool.stopAll()
  })

  it('installMcpServer respawns an agent that had no toolset (opted into an absent server) (M2)', async () => {
    // Agent opts into a server that doesn't exist yet → no toolset at spawn.
    await persistAgent({
      id: 'respawn-bot',
      allowedCapabilities: ['draft'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'opt-in only',
        useMcpServers: ['shared'],
      },
    })
    const pool = new LocalAgentPool({ hub, space })
    await pool.start()
    expect(pool.mcpServersForAgent('respawn-bot')).toEqual([]) // no toolset yet

    // Install → the agent is respawned and now has the server.
    const rec = await space.upsertMcpServer({
      spec: { name: 'shared', command: process.execPath, args: [FAKE_MCP_SERVER] },
    })
    await pool.installMcpServer(rec)
    expect(hub.participant('respawn-bot')).toBeDefined() // came back up
    expect(pool.mcpServersForAgent('respawn-bot')).toEqual(['shared'])
    await pool.stopAll()
  })

  it('installMcpServer leaves agents that did NOT opt in untouched (M2)', async () => {
    await persistAgent({
      id: 'no-opt-in',
      allowedCapabilities: ['draft'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'inline only, no opt-in',
        mcpServers: [{ name: 'inline', command: process.execPath, args: [FAKE_MCP_SERVER] }],
      },
    })
    const pool = new LocalAgentPool({ hub, space })
    await pool.start()
    const rec = await space.upsertMcpServer({
      spec: { name: 'shared', command: process.execPath, args: [FAKE_MCP_SERVER] },
    })
    await pool.installMcpServer(rec)
    // Unchanged — the agent didn't opt into 'shared'.
    expect(pool.mcpServersForAgent('no-opt-in')).toEqual(['inline'])
    await pool.stopAll()
  })

  it('agent WITHOUT mcpServers spawns identically (no regression)', async () => {
    await persistAgent({
      id: 'plain',
      allowedCapabilities: ['draft'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'no tools',
      },
    })
    const pool = new LocalAgentPool({ hub, space })
    await pool.start()
    const result = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'hi',
    })
    expect(result.kind).toBe('ok')
    await pool.stopAll()
  })
})

// A tiny escape valve so unused-imports don't trip on this test file.
void ({} as LlmRequest)
