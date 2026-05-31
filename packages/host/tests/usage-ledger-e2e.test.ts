/**
 * Phase 17 (Sprint 4) — usage/cost ledger END-TO-END acceptance gate.
 *
 * This is THE test the sprint exists to pass: it wires M1–M6 together on
 * one real stack and proves the whole chain holds.
 *
 * Everything here is real, not stubbed:
 *   - a real `Hub` + `Space` (tmp dir),
 *   - a real `IdentityStore` (tmp sqlite) carrying the v=11 `usage_ledger`
 *     table + the quota counters,
 *   - the real `LocalAgentPool` wiring the post-call `usageSink`,
 *   - the real `WorkflowController` driving an attributed LLM call so the
 *     ledger row gets user / org / workflow / agent / model attribution,
 *   - the real `estimateCostMicros` pricing the recorded tokens,
 *   - the real `@aipehub/web` export columns + CSV/JSONL formatters.
 *
 * Two gates:
 *   1. An attributed workflow → LLM call writes ONE priced ledger row;
 *      `aggregateLedger` rolls it up correctly; the row exports to CSV +
 *      JSONL and parses back byte-for-byte.
 *   2. Fail-closed: once a token budget is spent, the NEXT call is refused
 *      pre-call and an `api_quota_denied` audit row is written. (The pool
 *      installs the gate on non-mock agents only, so — like
 *      `usage-budget-gate.test.ts` — we drive a plain LlmAgent + the same
 *      gate + the real sink-style debit the gate is built to enforce.)
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space, type AgentRecord, type Task } from '@aipehub/core'
import {
  LlmAgent,
  MockLlmProvider,
  type LlmUsage,
  type LlmUsageSinkMeta,
} from '@aipehub/llm'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@aipehub/identity'
import {
  LEDGER_COLUMNS,
  toCsv,
  toJsonl,
  type UsageLedgerEntryDTO,
} from '@aipehub/web'

import { LocalAgentPool } from '../src/local-agent-pool.js'
import { WorkflowController } from '../src/workflow-controller.js'
import { DEFAULT_PRICING, estimateCostMicros } from '../src/pricing.js'
import { OrgApiPool } from '../src/org-api-pool.js'

// A workflow whose single step dispatches to the managed mock agent's
// capability (`echo`). The runner re-stamps the trigger's origin and
// appends `{ by: 'workflow:usage-e2e-wf' }` to the step's ancestry, so the
// LLM call lands fully attributed.
const WORKFLOW_YAML = `
schema: aipehub.workflow/v1
workflow:
  id: usage-e2e-wf
  name: usage e2e
  trigger: { capability: usage:start }
  steps:
    - id: call
      dispatch:
        strategy: { kind: capability, capabilities: [echo] }
        payload: $trigger.payload
`

describe('Phase 17 — usage/cost ledger end-to-end acceptance gate', () => {
  let root: string
  let space: Space
  let hub: Hub
  let identity: IdentityStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipe-usage-e2e-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()
    identity = openIdentityStore({
      dbPath: join(root, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
  })

  afterEach(async () => {
    identity.close()
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('an attributed workflow LLM call writes a priced row that aggregates + exports cleanly', async () => {
    // --- spawn the managed mock agent (priced model) through the real pool,
    //     so its post-call usageSink is wired exactly as in production.
    await space.upsertAgent({
      id: 'echo-mock',
      allowedCapabilities: ['echo'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'mock', system: 'hi', model: 'claude-opus-4' },
    } satisfies AgentRecord)
    const pool = new LocalAgentPool({ hub, space, identity })
    await pool.start()

    // --- register the workflow runner (Model-B import → published rev1).
    const controller = new WorkflowController({
      hub,
      definitionsDir: join(root, 'workflows', 'definitions'),
      spaceRoot: root,
    })
    const sum = await controller.importFromText(WORKFLOW_YAML)
    expect(sum.state).toBe('published')

    const user = identity.createUser({
      email: 'e2e@test.local',
      displayName: 'E2E Caller',
      role: 'member',
    })

    // --- fire the trigger with the consumer's origin. The runner re-stamps
    //     it onto the inner `echo` dispatch → the LLM call is attributed.
    const fired = await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['usage:start'] },
      payload: { q: 'hello there' },
      origin: { orgId: 'local', userId: user.id },
    })
    expect(fired.kind).toBe('ok')

    // === GATE 1a: exactly one ledger row, fully attributed + priced. ===
    const rows = identity.queryLedger({})
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.agentId).toBe('echo-mock')
    expect(row.userId).toBe(user.id)
    expect(row.orgId).toBe('local')
    expect(row.workflowId).toBe('usage-e2e-wf') // closest workflow ancestor
    expect(row.model).toBe('claude-opus-4')
    expect(row.provider).toBe('mock')
    expect(row.inputTokens).toBeGreaterThan(0)
    expect(row.outputTokens).toBeGreaterThan(0)
    expect(row.unpriced).toBe(false)
    // cost computed off THIS row's tokens at the claude-opus-4 rate.
    expect(row.costMicros).toBe(row.inputTokens * 15 + row.outputTokens * 75)
    expect(row.costMicros).toBeGreaterThan(0)

    // === GATE 1b: the summary aggregate rolls the row up per dimension. ===
    const byUser = identity.aggregateLedger({ groupBy: 'user' })
    expect(byUser).toHaveLength(1)
    expect(byUser[0]).toMatchObject({ key: user.id, calls: 1, costMicros: row.costMicros })

    const byWorkflow = identity.aggregateLedger({ groupBy: 'workflow' })
    expect(byWorkflow.find((r) => r.key === 'usage-e2e-wf')).toMatchObject({
      calls: 1,
      costMicros: row.costMicros,
    })

    const byModel = identity.aggregateLedger({ groupBy: 'model' })
    expect(byModel.find((r) => r.key === 'claude-opus-4')).toMatchObject({
      calls: 1,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    })

    // === GATE 1c: the row exports to CSV + JSONL and parses back. ===
    const dto = identity.queryLedger({}) as unknown as UsageLedgerEntryDTO[]

    // JSONL — deep round-trip (one object per line).
    const jsonl = toJsonl(dto)
    const parsedJsonl = jsonl
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as UsageLedgerEntryDTO)
    expect(parsedJsonl).toHaveLength(1)
    expect(parsedJsonl[0]).toEqual(dto[0])

    // CSV — header + one data line; index by header and check key fields.
    // (None of our values contain commas, so a plain split is sound here;
    // RFC-4180 escaping is covered by web/export-format.test.ts.)
    const csv = toCsv(LEDGER_COLUMNS, dto)
    const lines = csv.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    const header = lines[0].split(',')
    const cells = lines[1].split(',')
    const rec = Object.fromEntries(header.map((h, i) => [h, cells[i]]))
    expect(Number(rec.cost_micros)).toBe(row.costMicros)
    expect(rec.user_id).toBe(user.id)
    expect(rec.workflow_id).toBe('usage-e2e-wf')
    expect(rec.agent_id).toBe('echo-mock')
    expect(rec.model).toBe('claude-opus-4')
    // derived USD column == micros / 1e6, fixed(6).
    expect(rec.cost_usd).toBe((row.costMicros / 1_000_000).toFixed(6))

    await pool.stopAll()
  })

  it('fail-closed: a spent token budget refuses the NEXT call and audits the denial', async () => {
    const user = identity.createUser({
      email: 'budget-e2e@test.local',
      displayName: 'Budget E2E',
      role: 'member',
    })

    // The exact gate config the pool builds: call-count debit + token /
    // cost budget peeks.
    const gate = new OrgApiPool({ identity }).makeLlmQuotaGate({
      metric: 'llm_requests',
      period: 'daily',
      budgetPeeks: [
        { metric: 'llm_tokens', period: 'daily' },
        { metric: 'llm_cost_micros', period: 'daily' },
      ],
    })

    // The real post-call sink path (mirrors LocalAgentPool): record actual
    // consumption UNGATED via recordUsage so the NEXT pre-call peek sees the
    // budget spent. Using the gated checkAndIncrement here would freeze
    // `used` below the cap and the peek would never fire (the fail-open bug
    // this gate exists to catch). The pool skips this debit for mock by
    // design; the gate it builds enforces the non-mock path exercised here.
    const sink = (task: Task, usage: LlmUsage, meta: LlmUsageSinkMeta): void => {
      const userId = task.origin?.userId
      if (!userId) return
      const { costMicros } = estimateCostMicros(usage, meta.model, DEFAULT_PRICING)
      identity.recordUsage({
        userId,
        metric: 'llm_tokens',
        period: 'daily',
        amount: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      })
      identity.recordUsage({
        userId,
        metric: 'llm_cost_micros',
        period: 'daily',
        amount: costMicros,
      })
    }

    hub.register(
      new LlmAgent({
        id: 'echo',
        capabilities: ['echo'],
        model: 'claude-opus-4',
        provider: new MockLlmProvider({ reply: () => 'ok' }),
        preCallHook: (task) => gate(task.origin),
        usageSink: sink,
      }),
    )

    // A 1-token/day cap — the first call alone blows past it.
    identity.setQuota({ userId: user.id, metric: 'llm_tokens', period: 'daily', quota: 1 })

    const dispatch = (payload: string) =>
      hub.dispatch({
        from: user.id,
        strategy: { kind: 'capability', capabilities: ['echo'] },
        payload,
        origin: { orgId: 'local', userId: user.id },
      }) as Promise<{ kind: string; error?: string }>

    // First call: peek sees used=0 < 1 → allowed; the sink then records the
    // real token count (> 1), spending the budget.
    const first = await dispatch('go')
    expect(first.kind).toBe('ok')
    const spent = identity.listUsage({ userId: user.id, metric: 'llm_tokens', period: 'daily' })
    expect(spent[0]?.used ?? 0).toBeGreaterThan(1)

    // === GATE 2: the next call is refused pre-call (fail-closed). ===
    const second = await dispatch('go again')
    expect(second.kind).toBe('failed')
    expect(second.error).toContain('quota_exceeded')

    // …and the denial is on the audit trail (the series ops size a raise from).
    const denied = identity.listAuditLog({
      action: 'api_quota_denied',
      targetUserId: user.id,
    })
    expect(denied.length).toBeGreaterThanOrEqual(1)
    expect(denied[0].success).toBe(false)
    expect(denied[0].metadata).toMatchObject({ metric: 'llm_tokens', period: 'daily' })
  })
})
