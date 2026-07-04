/**
 * B2.2.2 — host wiring tests for the per-call LLM quota gate.
 *
 * Two layers under test:
 *
 *   1. `LocalAgentPool` constructor / spawn wiring — does it build a
 *      `QuotaGate` when `orgApiPool` is present? Does it skip the
 *      hook for `provider: 'mock'`? (Mock LLM calls don't cost money;
 *      debiting them would surprise demo / test users.)
 *
 *   2. End-to-end through `hub.dispatch` → `LlmAgent.preCallHook` →
 *      `identity.checkAndIncrement`. We bypass `LocalAgentPool` for
 *      this slice (its `buildProvider` is hardcoded; injecting a fake
 *      provider isn't possible without invasive surgery). Instead we
 *      construct a plain `LlmAgent` with a `MockLlmProvider` and the
 *      same `preCallHook` shape the pool would have installed. That
 *      gives us:
 *        - a real `OrgApiPool.makeLlmQuotaGate({...})` closure,
 *        - real `LlmAgent.handleTask` flow including preCallHook,
 *        - real `Hub.dispatch` carrying `origin`,
 *        - real `IdentityStore.checkAndIncrement` writing rows.
 *      The pool's spawn wiring is covered by tier (1); putting them
 *      together is what tier (2) is for.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLogger, Hub, Space, type AgentRecord } from '@gotong/core'
import { LlmAgent, MockLlmProvider } from '@gotong/llm'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@gotong/identity'

import { LocalAgentPool } from '../src/local-agent-pool.js'
import { OrgApiPool, QuotaExceededError, type QuotaGate } from '../src/org-api-pool.js'
import { bootstrapServices, type HubServices } from '../src/services/index.js'

const logger = createLogger('lap-quota-test', { disabled: true })

// =========================================================================
// Tier 1 — LocalAgentPool wiring
// =========================================================================

describe('LocalAgentPool — quota gate wiring (B2.2.2)', () => {
  let root: string
  let space: Space
  let hub: Hub
  let services: HubServices
  let identity: IdentityStore
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-lap-quota-wiring-'))
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

  it('does not build a quota gate when orgApiPool is absent', () => {
    const pool = new LocalAgentPool({ hub, space, services })
    // No public surface for this — peek the private. Absence here is
    // the contract: hosts that failed to open the identity store
    // (and therefore have no orgApiPool) get the v3 fallback chain
    // with no per-call quota enforcement.
    expect((pool as unknown as { llmQuotaGate?: QuotaGate }).llmQuotaGate).toBeUndefined()
  })

  it('builds a quota gate at ctor time when orgApiPool is present', () => {
    const orgApiPool = new OrgApiPool({ identity })
    const pool = new LocalAgentPool({ hub, space, services, orgApiPool })
    const gate = (pool as unknown as { llmQuotaGate?: QuotaGate }).llmQuotaGate
    expect(typeof gate).toBe('function')
  })

  it('spawn of a mock-provider agent does not debit the user (mock free-rides)', async () => {
    const orgApiPool = new OrgApiPool({ identity })
    const user = identity.createUser({
      email: 'lap-mock@test.local',
      displayName: 'Mock Caller',
      role: 'member',
    })
    await space.upsertAgent({
      id: 'echo-mock',
      allowedCapabilities: ['echo'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'mock', system: 'hi' },
    } satisfies AgentRecord)
    const pool = new LocalAgentPool({ hub, space, services, orgApiPool })
    await pool.start()
    // Dispatch a task *with* origin — the gate would debit if it had
    // been wired, but because provider==='mock' the pool skipped the
    // preCallHook. Counter must stay at 0.
    const r = await hub.dispatch({
      from: user.id,
      strategy: { kind: 'capability', capabilities: ['echo'] },
      payload: 'hello',
      origin: { orgId: 'local', userId: user.id },
    })
    expect(r.kind).toBe('ok')
    expect(identity.listUsage({ userId: user.id })).toEqual([])
  })
})

// =========================================================================
// Tier 2 — End-to-end through hub.dispatch → preCallHook
// =========================================================================

describe('OrgApiPool gate × LlmAgent — end-to-end (B2.2.2)', () => {
  let root: string
  let space: Space
  let hub: Hub
  let identity: IdentityStore
  let userId: string
  let gate: QuotaGate

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-orgpool-e2e-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()
    identity = openIdentityStore({
      dbPath: join(root, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    const u = identity.createUser({
      email: 'e2e@test.local',
      displayName: 'E2E Caller',
      role: 'member',
    })
    userId = u.id
    const orgApiPool = new OrgApiPool({ identity })
    gate = orgApiPool.makeLlmQuotaGate({
      metric: 'llm_requests',
      period: 'daily',
    })
  })

  afterEach(async () => {
    identity.close()
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  function registerLlmAgent(reply: string): void {
    const agent = new LlmAgent({
      id: 'echo',
      capabilities: ['echo'],
      provider: new MockLlmProvider({ reply: () => reply }),
      preCallHook: (task) => {
        gate(task.origin)
      },
    })
    hub.register(agent)
  }

  it('debits one unit per dispatch when origin.userId is present', async () => {
    registerLlmAgent('ok')
    for (let i = 0; i < 3; i++) {
      const r = await hub.dispatch({
        from: userId,
        strategy: { kind: 'capability', capabilities: ['echo'] },
        payload: { user: 'hi' },
        origin: { orgId: 'local', userId },
      })
      expect(r.kind).toBe('ok')
    }
    // Three preCallHook invocations against the same (user, metric,
    // period) tuple → single counter row with used=3.
    const [row] = identity.listUsage({
      userId,
      metric: 'llm_requests',
      period: 'daily',
    })
    expect(row?.used).toBe(3)
  })

  it('fails the task with quota_exceeded once the cap is hit, leaving counter at the cap', async () => {
    registerLlmAgent('ok')
    identity.setQuota({
      userId,
      metric: 'llm_requests',
      period: 'daily',
      quota: 2,
    })

    // First two succeed.
    for (let i = 0; i < 2; i++) {
      const r = await hub.dispatch({
        from: userId,
        strategy: { kind: 'capability', capabilities: ['echo'] },
        payload: 'go',
        origin: { orgId: 'local', userId },
      })
      expect(r.kind).toBe('ok')
    }
    // Third fails. The LlmAgent surfaces the thrown QuotaExceededError
    // as a normal `failed` TaskResult — the message includes the
    // characteristic prefix so we can substring-match.
    const r = await hub.dispatch({
      from: userId,
      strategy: { kind: 'capability', capabilities: ['echo'] },
      payload: 'over',
      origin: { orgId: 'local', userId },
    })
    expect(r.kind).toBe('failed')
    if (r.kind === 'failed') {
      expect(r.error).toContain('quota_exceeded')
      // Sanity: thrown error type carries the structured fields the
      // gate factory promised callers (HTTP 429, task fail metadata).
      // We can only assert on the message here — Hub stringifies the
      // error when serialising to TaskResult — so test the class via a
      // direct gate call separately.
    }

    const [row] = identity.listUsage({
      userId,
      metric: 'llm_requests',
      period: 'daily',
    })
    expect(row?.used).toBe(2) // 3rd call's debit was rolled back
    expect(row?.quota).toBe(2)
  })

  it('directly thrown QuotaExceededError carries structured fields', () => {
    identity.setQuota({
      userId,
      metric: 'llm_requests',
      period: 'daily',
      quota: 0, // 0-budget — first call throws
    })
    try {
      gate({ orgId: 'local', userId })
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError)
      const qe = err as QuotaExceededError
      expect(qe.code).toBe('quota_exceeded')
      expect(qe.userId).toBe(userId)
      expect(qe.metric).toBe('llm_requests')
      expect(qe.period).toBe('daily')
      expect(qe.quota).toBe(0)
      // exceededBy is >=1 (we asked for 1 over a 0 budget).
      expect(qe.exceededBy).toBeGreaterThanOrEqual(1)
    }
  })

  it('dispatch without origin → preCallHook no-ops, no row written', async () => {
    registerLlmAgent('ok')
    const r = await hub.dispatch({
      from: userId,
      strategy: { kind: 'capability', capabilities: ['echo'] },
      payload: 'go',
      // origin intentionally omitted — admin-style task, free-rides.
    })
    expect(r.kind).toBe('ok')
    expect(identity.listUsage({ userId })).toEqual([])
  })

  it('dispatch with origin missing userId → preCallHook no-ops', async () => {
    registerLlmAgent('ok')
    // Hub.dispatch's `origin` is typed `TaskOrigin = {orgId, userId}`
    // — both required at the type level. To exercise the runtime
    // tolerance the gate provides (subject.userId absent → free-ride),
    // we cast through unknown. A future federation refactor that adds
    // a "userId-less peer hub" origin shape would land here.
    const r = await hub.dispatch({
      from: userId,
      strategy: { kind: 'capability', capabilities: ['echo'] },
      payload: 'go',
      origin: { orgId: 'local' } as unknown as { orgId: string; userId: string },
    })
    expect(r.kind).toBe('ok')
    expect(identity.listUsage({ userId })).toEqual([])
  })
})
