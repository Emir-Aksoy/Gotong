/**
 * Phase 17 (Sprint 4) — token / cost budget enforcement (fail-closed).
 *
 * The quota gate now also PEEKS budget metrics (`llm_tokens`,
 * `llm_cost_micros`) before each call and refuses when one is at/over its
 * cap. Actual consumption is recorded POST-call by the usage sink (tokens
 * aren't known until the provider responds), so enforcement is
 * "fail-closed on the NEXT call once the budget is spent". Here we
 * simulate the sink's recording with direct `checkAndIncrement` calls
 * (exactly what the sink does) and assert the gate's peek behaviour.
 *
 * Like the call-count quota test, the pool installs this gate only on
 * non-mock agents, so we exercise the gate through a plain LlmAgent +
 * MockLlmProvider with the SAME gate config the pool builds.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space } from '@aipehub/core'
import { LlmAgent, MockLlmProvider } from '@aipehub/llm'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@aipehub/identity'

import {
  OrgApiPool,
  QuotaExceededError,
  UnpricedModelDeniedError,
  type QuotaGate,
} from '../src/org-api-pool.js'

// The exact gate config LocalAgentPool builds (call-count debit + token /
// cost budget peeks).
function buildPoolGate(orgApiPool: OrgApiPool): QuotaGate {
  return orgApiPool.makeLlmQuotaGate({
    metric: 'llm_requests',
    period: 'daily',
    budgetPeeks: [
      { metric: 'llm_tokens', period: 'daily' },
      { metric: 'llm_cost_micros', period: 'daily' },
    ],
  })
}

describe('LLM budget gate — token/cost fail-closed (Phase 17)', () => {
  let root: string
  let space: Space
  let hub: Hub
  let identity: IdentityStore
  let userId: string
  let gate: QuotaGate

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipe-budget-gate-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()
    identity = openIdentityStore({
      dbPath: join(root, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    userId = identity.createUser({
      email: 'budget@test.local',
      displayName: 'Budget Caller',
      role: 'member',
    }).id
    gate = buildPoolGate(new OrgApiPool({ identity }))
  })

  afterEach(async () => {
    identity.close()
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  function registerLlmAgent(): void {
    hub.register(
      new LlmAgent({
        id: 'echo',
        capabilities: ['echo'],
        provider: new MockLlmProvider({ reply: () => 'ok' }),
        preCallHook: (task) => gate(task.origin),
      }),
    )
  }

  function dispatch(): Promise<{ kind: string; error?: string }> {
    return hub.dispatch({
      from: userId,
      strategy: { kind: 'capability', capabilities: ['echo'] },
      payload: 'go',
      origin: { orgId: 'local', userId },
    }) as Promise<{ kind: string; error?: string }>
  }

  it('passes when no budget quota is configured', () => {
    expect(() => gate({ orgId: 'local', userId })).not.toThrow()
  })

  it('allows while a token budget is under cap', () => {
    identity.setQuota({ userId, metric: 'llm_tokens', period: 'daily', quota: 1000 })
    identity.checkAndIncrement({ userId, metric: 'llm_tokens', period: 'daily', amount: 500 })
    expect(() => gate({ orgId: 'local', userId })).not.toThrow()
  })

  it('refuses once the token budget is spent (peek)', async () => {
    registerLlmAgent()
    identity.setQuota({ userId, metric: 'llm_tokens', period: 'daily', quota: 1000 })
    // Simulate the sink having recorded 1000 tokens (== cap).
    identity.checkAndIncrement({ userId, metric: 'llm_tokens', period: 'daily', amount: 1000 })

    try {
      gate({ orgId: 'local', userId })
      expect.fail('expected token-budget refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError)
      expect((err as QuotaExceededError).metric).toBe('llm_tokens')
    }
    // And the same refusal surfaces through a real dispatch.
    const r = await dispatch()
    expect(r.kind).toBe('failed')
    expect(r.error).toContain('quota_exceeded')
  })

  it('refuses once the cost budget is spent', () => {
    identity.setQuota({ userId, metric: 'llm_cost_micros', period: 'daily', quota: 5000 })
    identity.checkAndIncrement({ userId, metric: 'llm_cost_micros', period: 'daily', amount: 5000 })
    try {
      gate({ orgId: 'local', userId })
      expect.fail('expected cost-budget refusal')
    } catch (err) {
      expect((err as QuotaExceededError).metric).toBe('llm_cost_micros')
    }
  })

  it('a budget refusal does NOT debit the call-count (peek runs first)', () => {
    // 0-budget token cap → immediate refusal on peek.
    identity.setQuota({ userId, metric: 'llm_tokens', period: 'daily', quota: 0 })
    expect(() => gate({ orgId: 'local', userId })).toThrow(QuotaExceededError)
    // llm_requests must be untouched — a budget-refused call costs no
    // request unit because the peek runs before the call-count debit.
    expect(
      identity.listUsage({ userId, metric: 'llm_requests', period: 'daily' }),
    ).toEqual([])
  })

  it('the call-count gate still works alongside budget peeks', () => {
    identity.setQuota({ userId, metric: 'llm_requests', period: 'daily', quota: 1 })
    // No budget caps → budget peeks no-op; first call debits llm_requests.
    expect(() => gate({ orgId: 'local', userId })).not.toThrow()
    // Second call hits the call-count cap.
    expect(() => gate({ orgId: 'local', userId })).toThrow(QuotaExceededError)
  })

  // ── M8 — unpriced model + cost cap fails closed ────────────────────────────
  // An unpriced model records cost=$0 post-call, so a configured cost cap could
  // never enforce against it (fail-OPEN). The gate refuses up front when the
  // cost peek is marked `denyIfModelUnpriced` AND a cost cap is set AND the
  // call's model is unpriced — unless the operator allowed unpriced models.
  describe('M8 — unpriced model fail-closed', () => {
    function buildGate(allowUnpricedModels = false): QuotaGate {
      return new OrgApiPool({ identity }).makeLlmQuotaGate({
        metric: 'llm_requests',
        period: 'daily',
        budgetPeeks: [
          { metric: 'llm_tokens', period: 'daily' },
          { metric: 'llm_cost_micros', period: 'daily', denyIfModelUnpriced: true },
        ],
        allowUnpricedModels,
      })
    }

    it('refuses an unpriced model when a cost cap is set', () => {
      identity.setQuota({ userId, metric: 'llm_cost_micros', period: 'daily', quota: 5000 })
      const gate = buildGate()
      try {
        gate({ orgId: 'local', userId }, { modelUnpriced: true })
        expect.fail('expected unpriced-model refusal')
      } catch (err) {
        expect(err).toBeInstanceOf(UnpricedModelDeniedError)
        expect((err as UnpricedModelDeniedError).metric).toBe('llm_cost_micros')
      }
      // A budget-refused call must not have debited the call-count.
      expect(identity.listUsage({ userId, metric: 'llm_requests', period: 'daily' })).toEqual([])
    })

    it('allows an unpriced model when NO cost cap is set (cost is moot)', () => {
      const gate = buildGate()
      expect(() => gate({ orgId: 'local', userId }, { modelUnpriced: true })).not.toThrow()
    })

    it('allows a PRICED model even with a cost cap set', () => {
      identity.setQuota({ userId, metric: 'llm_cost_micros', period: 'daily', quota: 5000 })
      const gate = buildGate()
      expect(() => gate({ orgId: 'local', userId }, { modelUnpriced: false })).not.toThrow()
    })

    it('allows an unpriced model + cost cap when allowUnpricedModels is set', () => {
      identity.setQuota({ userId, metric: 'llm_cost_micros', period: 'daily', quota: 5000 })
      const gate = buildGate(true)
      expect(() => gate({ orgId: 'local', userId }, { modelUnpriced: true })).not.toThrow()
    })
  })
})
