/**
 * Phase 17 (Sprint 4) — host wiring of the usage/cost ledger sink.
 *
 * Spawns a managed agent through `LocalAgentPool` and drives a real
 * `hub.dispatch` so the full path runs: LlmAgent.handleTask →
 * streamWithAuthHook → usageSink → identity.appendLedger. We use the
 * mock provider (the pool's `buildProvider` is hardcoded), and unlike the
 * quota gate the ledger sink does NOT skip mock — observability records
 * everything. Setting the agent's `model` to a priced id lets us assert a
 * real, non-zero cost computed off the recorded tokens.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLogger, Hub, Space, type AgentRecord } from '@gotong/core'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@gotong/identity'

import { LocalAgentPool } from '../src/local-agent-pool.js'
import { bootstrapServices, type HubServices } from '../src/services/index.js'

const logger = createLogger('lap-ledger-test', { disabled: true })

describe('LocalAgentPool — usage ledger sink (Phase 17)', () => {
  let root: string
  let space: Space
  let hub: Hub
  let services: HubServices
  let identity: IdentityStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-lap-ledger-'))
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

  async function spawnAgent(model?: string): Promise<void> {
    await space.upsertAgent({
      id: 'echo-mock',
      allowedCapabilities: ['echo'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'hi',
        ...(model ? { model } : {}),
      },
    } satisfies AgentRecord)
    const pool = new LocalAgentPool({ hub, space, services, identity })
    await pool.start()
  }

  it('records a ledger row with attribution + cost for an attributed call', async () => {
    await spawnAgent('claude-opus-4')
    const user = identity.createUser({
      email: 'ledger@test.local',
      displayName: 'Ledger Caller',
      role: 'member',
    })
    const r = await hub.dispatch({
      from: user.id,
      strategy: { kind: 'capability', capabilities: ['echo'] },
      payload: { user: 'hello there' },
      origin: { orgId: 'local', userId: user.id },
    })
    expect(r.kind).toBe('ok')

    const rows = identity.queryLedger({ userId: user.id })
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.agentId).toBe('echo-mock')
    expect(row.userId).toBe(user.id)
    expect(row.orgId).toBe('local')
    expect(row.model).toBe('claude-opus-4')
    expect(row.provider).toBe('mock')
    expect(row.inputTokens).toBeGreaterThan(0)
    expect(row.outputTokens).toBeGreaterThan(0)
    expect(row.unpriced).toBe(false)
    // Cost is computed off THIS row's tokens at the claude-opus-4 rate
    // (input 15 / output 75 per 1M == tokens * rate micros).
    expect(row.costMicros).toBe(row.inputTokens * 15 + row.outputTokens * 75)
    expect(row.workflowId).toBeNull() // direct dispatch, no workflow ancestor
  })

  it('records mock calls too (ledger != quota), flagged unpriced for an unknown model', async () => {
    await spawnAgent() // no model → 'unknown' → not in price table
    const user = identity.createUser({
      email: 'unpriced@test.local',
      displayName: 'Unpriced',
      role: 'member',
    })
    const r = await hub.dispatch({
      from: user.id,
      strategy: { kind: 'capability', capabilities: ['echo'] },
      payload: 'hi',
      origin: { orgId: 'local', userId: user.id },
    })
    expect(r.kind).toBe('ok')

    const rows = identity.queryLedger({ userId: user.id })
    expect(rows).toHaveLength(1)
    expect(rows[0].unpriced).toBe(true)
    expect(rows[0].costMicros).toBe(0)
    expect(rows[0].inputTokens).toBeGreaterThan(0) // tokens still recorded
  })

  it('records an unattributed call (no origin) with null user/org', async () => {
    await spawnAgent('claude-opus-4')
    const r = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['echo'] },
      payload: 'admin-triggered',
      // no origin → admin/system call
    })
    expect(r.kind).toBe('ok')

    const all = identity.queryLedger({})
    expect(all).toHaveLength(1)
    expect(all[0].userId).toBeNull()
    expect(all[0].orgId).toBeNull()
    expect(all[0].agentId).toBe('echo-mock')
    // Still priced (model is known) even though unattributed.
    expect(all[0].costMicros).toBeGreaterThan(0)
  })
})
