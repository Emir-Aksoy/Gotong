/**
 * Audit M8 — an unpriced model must fail closed against a configured cost cap.
 *
 * estimateCostMicros returns $0 for a model with no pricing entry, so the
 * post-call cost sink records nothing and a `llm_cost_micros` cap could never
 * enforce — fail-OPEN. The pool classifies the agent's model at spawn and the
 * gate refuses up front when a cost cap is set and the model is unpriced.
 *
 * This pins the POOL wiring (model classification → ctx threading → cost peek
 * marked `denyIfModelUnpriced`); the gate logic itself is pinned in
 * usage-budget-gate.test.ts. We drive a NON-`mock` provider via the
 * `providerFactory` seam so the gate is installed; the provider is never
 * actually called because the gate denies before the call.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLogger, Hub, Space, type AgentRecord } from '@gotong/core'
import { MockLlmProvider } from '@gotong/llm'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@gotong/identity'

import { LocalAgentPool } from '../src/local-agent-pool.js'
import { OrgApiPool } from '../src/org-api-pool.js'
import { bootstrapServices, type HubServices } from '../src/services/index.js'

const logger = createLogger('lap-unpriced-test', { disabled: true })

describe('LocalAgentPool — unpriced model fails closed on a cost cap (audit M8)', () => {
  let root: string
  let space: Space
  let hub: Hub
  let services: HubServices
  let identity: IdentityStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-lap-unpriced-'))
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
  })

  afterEach(async () => {
    identity.close()
    await services.shutdownAll()
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  async function spawnAgentWithModel(model: string): Promise<void> {
    await space.upsertAgent({
      id: 'echo-anthropic',
      allowedCapabilities: ['echo'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'anthropic', system: 'hi', model },
    } satisfies AgentRecord)
    const pool = new LocalAgentPool({
      hub,
      space,
      services,
      identity,
      orgApiPool: new OrgApiPool({ identity }),
      providerFactory: () => new MockLlmProvider({ reply: () => 'ok' }),
    })
    await pool.start()
  }

  function dispatch(userId: string): Promise<{ kind: string; error?: string }> {
    return hub.dispatch({
      from: userId,
      strategy: { kind: 'capability', capabilities: ['echo'] },
      payload: 'go',
      origin: { orgId: 'local', userId },
    }) as Promise<{ kind: string; error?: string }>
  }

  it('an UNPRICED model + a cost cap → the dispatch fails closed', async () => {
    await spawnAgentWithModel('totally-unknown-model-xyz') // not in the pricing table
    const user = identity.createUser({
      email: 'u@test.local',
      displayName: 'U',
      role: 'member',
    })
    identity.setQuota({ userId: user.id, metric: 'llm_cost_micros', period: 'daily', quota: 5000 })

    const r = await dispatch(user.id)
    expect(r.kind).toBe('failed')
    expect(r.error).toContain('unpriced_model_denied')
  })

  it('a PRICED model + the same cost cap → the dispatch succeeds', async () => {
    await spawnAgentWithModel('claude-opus-4') // present in the pricing table
    const user = identity.createUser({
      email: 'u2@test.local',
      displayName: 'U2',
      role: 'member',
    })
    identity.setQuota({ userId: user.id, metric: 'llm_cost_micros', period: 'daily', quota: 5000 })

    const r = await dispatch(user.id)
    expect(r.kind).toBe('ok')
  })

  it('an UNPRICED model but NO cost cap → the dispatch succeeds (cost is moot)', async () => {
    await spawnAgentWithModel('totally-unknown-model-xyz')
    const user = identity.createUser({
      email: 'u3@test.local',
      displayName: 'U3',
      role: 'member',
    })
    // No llm_cost_micros quota set.
    const r = await dispatch(user.id)
    expect(r.kind).toBe('ok')
  })
})
