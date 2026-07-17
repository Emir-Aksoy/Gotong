/**
 * MR-M2 — the pool's `buildRoutedProvider` seam wires an agent's optional
 * `fallbacks:` chain into a deterministic RoutingProvider, covering every
 * managed agent (butler + plain LLM rows) through the SAME providerFactory.
 *
 * Two contracts pinned here, end-to-end through a real dispatch:
 *
 *   1. **opt-in byte-stable** — an agent with NO fallbacks builds its provider
 *      via exactly one providerFactory call (today's single-provider path); the
 *      RoutingProvider is never interposed.
 *   2. **failover** — an agent WHOSE primary hard-fails before the first chunk
 *      still answers, served by the next candidate. The factory is called once
 *      per candidate, primary-first (ordered chain).
 *
 * Both candidates stay `provider: 'mock'` and are told apart by `spec.model`,
 * so no API keys / budget ledger path is involved — the failover logic is
 * isolated from unrelated machinery.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLogger, Hub, Space, type AgentRecord } from '@gotong/core'
import { MockLlmProvider, type LlmProvider } from '@gotong/llm'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@gotong/identity'

import { LocalAgentPool } from '../src/local-agent-pool.js'
import { OrgApiPool } from '../src/org-api-pool.js'
import { RoutingHealthTracker } from '../src/routing-health.js'
import { bootstrapServices, type HubServices } from '../src/services/index.js'

const logger = createLogger('lap-routing-test', { disabled: true })

describe('LocalAgentPool — buildRoutedProvider (MR-M2 model routing)', () => {
  let root: string
  let space: Space
  let hub: Hub
  let services: HubServices
  let identity: IdentityStore
  // Records the `spec.model` of every providerFactory call, in order.
  let factoryModels: (string | undefined)[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-lap-routing-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()
    await writeFile(
      join(space.paths.services, 'plugins.json'),
      JSON.stringify({ plugins: [] }, null, 2) + '\n',
      'utf8',
    )
    const boot = await bootstrapServices({ space, hub, logger })
    services = boot.services
    identity = openIdentityStore({
      dbPath: join(root, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    factoryModels = []
  })

  afterEach(async () => {
    identity.close()
    await services.shutdownAll()
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  // A providerFactory that keys behaviour on `spec.model`:
  //   'boom-*'  → throws synchronously from .stream() (pre-first-chunk hard fail)
  //   otherwise → yields a single text chunk `served:<model>`
  function makePool(routingHealth?: RoutingHealthTracker): LocalAgentPool {
    const orgApiPool = new OrgApiPool({ identity })
    return new LocalAgentPool({
      hub,
      space,
      services,
      identity,
      orgApiPool,
      ...(routingHealth ? { routingHealth } : {}),
      providerFactory: (spec): LlmProvider => {
        factoryModels.push(spec.model)
        if (spec.model && spec.model.startsWith('boom-')) {
          return new MockLlmProvider({ throwError: `${spec.model} unavailable` })
        }
        return new MockLlmProvider({
          chunks: [
            { type: 'text', text: `served:${spec.model}` },
            { type: 'end', stopReason: 'end_turn' },
          ],
        })
      },
    })
  }

  async function dispatchEcho(): Promise<{ kind: string; output?: unknown }> {
    const user = identity.createUser({
      email: 'routing@test.local',
      displayName: 'U',
      role: 'member',
    })
    const res = await hub.dispatch({
      from: user.id,
      strategy: { kind: 'capability', capabilities: ['echo'] },
      payload: { user: 'hi' },
      origin: { orgId: 'local', userId: user.id },
    })
    return res as { kind: string; output?: unknown }
  }

  it('no fallbacks → one providerFactory call, single-provider path (byte-stable)', async () => {
    await space.upsertAgent({
      id: 'solo',
      allowedCapabilities: ['echo'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'mock', system: 'hi', model: 'solo-model' },
    } satisfies AgentRecord)
    const pool = makePool()
    await pool.start()

    const res = await dispatchEcho()
    expect(res.kind).toBe('ok')
    expect((res.output as { text?: string }).text).toBe('served:solo-model')
    // The RoutingProvider was never interposed — exactly one build, no extra
    // candidate construction.
    expect(factoryModels).toEqual(['solo-model'])
  })

  it('primary hard-fails before first chunk → next candidate serves (failover)', async () => {
    await space.upsertAgent({
      id: 'routed',
      allowedCapabilities: ['echo'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'hi',
        model: 'boom-primary',
        fallbacks: [{ provider: 'mock', model: 'backup-model' }],
      },
    } satisfies AgentRecord)
    const pool = makePool()
    await pool.start()

    const res = await dispatchEcho()
    // The primary threw before yielding; only the fallback can produce `ok`.
    expect(res.kind).toBe('ok')
    expect((res.output as { text?: string }).text).toBe('served:backup-model')
    // Ordered chain: primary built first, fallback second — both via the seam.
    expect(factoryModels).toEqual(['boom-primary', 'backup-model'])
  })

  it('MR-M3 — a failover feeds the injected routing-health sink (candidate degraded)', async () => {
    await space.upsertAgent({
      id: 'watched',
      allowedCapabilities: ['echo'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'hi',
        model: 'boom-primary',
        fallbacks: [{ provider: 'mock', model: 'backup-model' }],
      },
    } satisfies AgentRecord)
    const tracker = new RoutingHealthTracker()
    const pool = makePool(tracker)
    await pool.start()

    expect(tracker.snapshot()).toEqual([]) // nothing has failed yet
    const res = await dispatchEcho()
    expect(res.kind).toBe('ok') // served by the fallback

    // The primary's pre-first-chunk failure reached the sink → a degraded row
    // for candidate index 0 (one failure < breaker threshold, so not yet open).
    const rows = tracker.snapshot()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agentId: 'watched', index: 0, state: 'degraded' })
  })

  // MR-M5 — the manual "test routing" diagnostic. Unlike a dispatch (which stops
  // at the first healthy candidate), this probes EVERY candidate independently,
  // so an operator learns whether each declared fallback actually works. Uses
  // `openai-compatible` candidates (not `mock`, which short-circuits to ok) so
  // the boom-model factory can produce a genuinely-failing candidate.
  it('MR-M5 — probeRoutingCandidates verifies EACH candidate independently', async () => {
    await space.upsertAgent({
      id: 'probed',
      allowedCapabilities: ['echo'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'openai-compatible',
        system: 'hi',
        model: 'boom-primary',
        baseURL: 'https://primary.test/v1',
        fallbacks: [
          { provider: 'openai-compatible', model: 'backup-model', baseURL: 'https://backup.test/v1' },
        ],
      },
    } satisfies AgentRecord)
    const pool = makePool()

    const probes = await pool.probeRoutingCandidates('probed')
    expect(probes).toHaveLength(2)
    // Primary (index 0) threw before the first chunk → an honest not-ok verdict.
    expect(probes[0]).toMatchObject({ index: 0, ok: false })
    // Fallback (index 1) streamed → ok, with the model it tested echoed back.
    expect(probes[1]).toMatchObject({ index: 1, ok: true, model: 'backup-model' })
    // Both candidates built through the SAME providerFactory, primary-first —
    // the exact spawn chain, so a pass proves the real call path.
    expect(factoryModels).toEqual(['boom-primary', 'backup-model'])
  })

  it('MR-M5 — a mock candidate reports ok without calling the provider factory', async () => {
    await space.upsertAgent({
      id: 'mockprobe',
      allowedCapabilities: ['echo'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'mock', system: 'hi' },
    } satisfies AgentRecord)
    const pool = makePool()

    const probes = await pool.probeRoutingCandidates('mockprobe')
    expect(probes).toHaveLength(1)
    expect(probes[0]).toMatchObject({ index: 0, provider: 'mock', ok: true })
    expect(factoryModels).toEqual([]) // mock short-circuits — no provider call, no cost
  })

  it('MR-M5 — unknown agent id yields an empty probe list (never throws)', async () => {
    const pool = makePool()
    expect(await pool.probeRoutingCandidates('does-not-exist')).toEqual([])
  })

  // ————————————————————————————————————————————————————————————————————
  // MR-M6 — per-candidate env-name credentials (`apiKeyEnv`). The MR-M2 chain
  // hands ONE per-agent key to every candidate; two openai-compatible vendors
  // with different keys therefore couldn't share a chain. `apiKeyEnv` points a
  // spec / candidate at its OWN env var — and it is exclusive: a named-but-
  // missing variable must mean "no key", never a silent fall-through to a
  // different vendor's stored key.
  // ————————————————————————————————————————————————————————————————————
  describe('MR-M6 — apiKeyEnv per-candidate credentials', () => {
    // Captures (model, apiKey) per factory call; throws for an
    // openai-compatible spec without a key — the REAL factory's contract,
    // which is exactly what turns "missing env var" into a skipped fallback.
    let factoryCalls: Array<{ model?: string; key?: string }>
    function makeKeyAwarePool(): LocalAgentPool {
      factoryCalls = []
      const orgApiPool = new OrgApiPool({ identity })
      return new LocalAgentPool({
        hub,
        space,
        services,
        identity,
        orgApiPool,
        providerFactory: (spec, apiKey): LlmProvider => {
          factoryCalls.push({ model: spec.model, ...(apiKey ? { key: apiKey } : {}) })
          if (spec.provider === 'openai-compatible' && !apiKey) {
            throw new Error(`${spec.model ?? spec.provider}: openai-compatible needs a key`)
          }
          return new MockLlmProvider({
            chunks: [
              { type: 'text', text: `served:${spec.model}` },
              { type: 'end', stopReason: 'end_turn' },
            ],
          })
        },
      })
    }

    const ENV_FB = 'MRM6_TEST_FB_KEY'
    const ENV_PRIMARY = 'MRM6_TEST_PRIMARY_KEY'
    afterEach(() => {
      delete process.env[ENV_FB]
      delete process.env[ENV_PRIMARY]
    })

    it('a fallback with apiKeyEnv gets ITS OWN key while the primary keeps the per-agent key', async () => {
      process.env[ENV_FB] = 'longcat-key'
      await space.upsertAgent({
        id: 'two-vendors',
        allowedCapabilities: ['echo'],
        createdAt: new Date().toISOString(),
        managed: {
          kind: 'llm',
          provider: 'openai-compatible',
          system: 'hi',
          model: 'primary-model',
          baseURL: 'https://primary.test/v1',
          fallbacks: [
            {
              provider: 'openai-compatible',
              model: 'backup-model',
              baseURL: 'https://backup.test/v1',
              apiKeyEnv: ENV_FB,
            },
          ],
        },
      } satisfies AgentRecord)
      await space.setAgentApiKey('two-vendors', 'mimo-key')
      const pool = makeKeyAwarePool()
      await pool.start()

      const res = await dispatchEcho()
      expect(res.kind).toBe('ok')
      expect((res.output as { text?: string }).text).toBe('served:primary-model')
      // Primary built with the stored per-agent key; the fallback with its env
      // key — two vendors, two credentials, one chain.
      expect(factoryCalls).toEqual([
        { model: 'primary-model', key: 'mimo-key' },
        { model: 'backup-model', key: 'longcat-key' },
      ])
    })

    it('apiKeyEnv naming a MISSING variable skips that fallback — never borrows the per-agent key', async () => {
      await space.upsertAgent({
        id: 'dead-fb',
        allowedCapabilities: ['echo'],
        createdAt: new Date().toISOString(),
        managed: {
          kind: 'llm',
          provider: 'openai-compatible',
          system: 'hi',
          model: 'primary-model',
          baseURL: 'https://primary.test/v1',
          fallbacks: [
            {
              provider: 'openai-compatible',
              model: 'backup-model',
              baseURL: 'https://backup.test/v1',
              apiKeyEnv: ENV_FB, // deliberately unset
            },
          ],
        },
      } satisfies AgentRecord)
      await space.setAgentApiKey('dead-fb', 'mimo-key')
      const pool = makeKeyAwarePool()
      await pool.start()

      const res = await dispatchEcho()
      expect(res.kind).toBe('ok') // primary serves; the dead fallback never sinks the agent
      // The fallback build was attempted WITHOUT a key (exclusive env-name
      // semantics) and threw → skipped. Had it borrowed 'mimo-key', a real
      // deployment would Bearer the wrong vendor and 401 at failover time.
      expect(factoryCalls).toEqual([
        { model: 'primary-model', key: 'mimo-key' },
        { model: 'backup-model' },
      ])
    })

    it('a PRIMARY apiKeyEnv is exclusive: env value wins over a stored per-agent key', async () => {
      process.env[ENV_PRIMARY] = 'env-key'
      await space.upsertAgent({
        id: 'env-primary',
        allowedCapabilities: ['echo'],
        createdAt: new Date().toISOString(),
        managed: {
          kind: 'llm',
          provider: 'openai-compatible',
          system: 'hi',
          model: 'primary-model',
          baseURL: 'https://primary.test/v1',
          apiKeyEnv: ENV_PRIMARY,
        },
      } satisfies AgentRecord)
      await space.setAgentApiKey('env-primary', 'stored-key')
      const pool = makeKeyAwarePool()
      await pool.start()

      const res = await dispatchEcho()
      expect(res.kind).toBe('ok')
      expect(factoryCalls).toEqual([{ model: 'primary-model', key: 'env-key' }])
    })

    it('MR-M5 probe honors apiKeyEnv per candidate (tests the key the router would use)', async () => {
      process.env[ENV_FB] = 'longcat-key'
      await space.upsertAgent({
        id: 'probe-env',
        allowedCapabilities: ['echo'],
        createdAt: new Date().toISOString(),
        managed: {
          kind: 'llm',
          provider: 'openai-compatible',
          system: 'hi',
          model: 'primary-model',
          baseURL: 'https://primary.test/v1',
          fallbacks: [
            {
              provider: 'openai-compatible',
              model: 'backup-model',
              baseURL: 'https://backup.test/v1',
              apiKeyEnv: ENV_FB,
            },
          ],
        },
      } satisfies AgentRecord)
      await space.setAgentApiKey('probe-env', 'mimo-key')
      const pool = makeKeyAwarePool()

      const probes = await pool.probeRoutingCandidates('probe-env')
      expect(probes).toHaveLength(2)
      expect(probes[0]).toMatchObject({ index: 0, ok: true })
      expect(probes[1]).toMatchObject({ index: 1, ok: true, model: 'backup-model' })
      expect(factoryCalls).toEqual([
        { model: 'primary-model', key: 'mimo-key' },
        { model: 'backup-model', key: 'longcat-key' },
      ])
    })

    it('CARE liveness target resolves the apiKeyEnv key (probes the ACTIVE brain, not a stale slot)', async () => {
      process.env[ENV_PRIMARY] = 'env-key'
      await space.upsertAgent({
        id: 'care-env',
        allowedCapabilities: ['echo'],
        createdAt: new Date().toISOString(),
        managed: {
          kind: 'llm',
          provider: 'openai-compatible',
          system: 'hi',
          model: 'primary-model',
          baseURL: 'https://primary.test/v1',
          apiKeyEnv: ENV_PRIMARY,
        },
      } satisfies AgentRecord)
      await space.setAgentApiKey('care-env', 'stale-stored-key')
      const pool = makeKeyAwarePool()

      const target = await pool.resolveLlmProbeTarget('care-env')
      expect(target).toMatchObject({ status: 'ok', apiKey: 'env-key', baseURL: 'https://primary.test/v1' })
    })
  })
})
