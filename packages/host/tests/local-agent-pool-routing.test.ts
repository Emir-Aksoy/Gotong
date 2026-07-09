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
})
