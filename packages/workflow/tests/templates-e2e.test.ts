/**
 * Phase 19 P5 — industry-template end-to-end acceptance.
 *
 * Each shipped industry template (M5-M7) must run through a real
 * `WorkflowRunner` with a *mock provider* and produce the expected output.
 * The "mock provider" is a stub hub: it answers each capability dispatch with
 * a canned result keyed on the capability, standing in for the LlmAgents a
 * real host would register. A `human:` step desugars (at parse time) to a
 * dispatch to `aipehub.human/v1`, so the mock simply returns the resolved
 * decision — the suspend/resume machinery itself is covered by Phase 16's
 * inbox-e2e; here we prove the TEMPLATE's step graph threads end to end.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { ParticipantId, Task, TaskResult } from '@aipehub/core'

import { WorkflowRunner, parseWorkflow, type HubLike } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const wfDir = join(here, '..', '..', '..', 'templates', 'workflows')

const HUMAN_CAP = 'aipehub.human/v1'

type CapHandler = (payload: Record<string, unknown>) => unknown

interface MockCall {
  cap: string
  payload: Record<string, unknown>
}

/** A stub hub that answers each capability dispatch from `handlers`. */
function mockProviderHub(handlers: Record<string, CapHandler>): {
  hub: HubLike
  calls: MockCall[]
} {
  const calls: MockCall[] = []
  let n = 0
  const hub: HubLike = {
    async dispatch(opts): Promise<TaskResult> {
      const cap =
        opts.strategy.kind === 'capability' ? (opts.strategy.capabilities[0] ?? '') : '(explicit)'
      const payload = (opts.payload ?? {}) as Record<string, unknown>
      calls.push({ cap, payload })
      const handler = handlers[cap]
      const taskId = `mock-${++n}`
      const by = `mock:${cap}` as ParticipantId
      if (!handler) {
        return { kind: 'failed', taskId, by, error: `no mock provider for capability '${cap}'`, ts: 1 }
      }
      return { kind: 'ok', taskId, by, output: handler(payload), ts: 1 }
    },
  }
  return { hub, calls }
}

/** Parse a shipped template, run it through the runner with the mock hub. */
async function runTemplate(
  file: string,
  triggerCap: string,
  payload: Record<string, unknown>,
  handlers: Record<string, CapHandler>,
): Promise<{ result: TaskResult; calls: MockCall[] }> {
  const def = parseWorkflow(readFileSync(join(wfDir, file), 'utf8'))
  const { hub, calls } = mockProviderHub(handlers)
  const runner = new WorkflowRunner({ definition: def, hub })
  const task: Task = {
    id: 'trigger-1',
    from: 'admin',
    strategy: { kind: 'capability', capabilities: [triggerCap] },
    payload,
    createdAt: 1,
  }
  const result = await runner.onTask(task)
  return { result, calls }
}

describe('industry template E2E — contract-review-flow (P5-M5)', () => {
  it('threads extract → assess → human sign-off → memo with a mock provider', async () => {
    const { result, calls } = await runTemplate(
      'contract-review-flow.yaml',
      'review-contract',
      {
        contract_text: 'The party agrees to auto-renew for unlimited terms...',
        counterparty: 'Acme Corp',
        reviewer_id: 'legal-user-1',
      },
      {
        'contract-extract': (p) => {
          // saw the trigger's contract text
          expect(p.contract_text).toMatch(/auto-renew/)
          return { clauses: ['auto-renewal', 'unlimited liability'], term: '12mo' }
        },
        'contract-assess': (p) => {
          // saw the previous step's extracted clauses
          expect(p.clauses).toEqual({ clauses: ['auto-renewal', 'unlimited liability'], term: '12mo' })
          return { riskScore: 7, flags: ['auto-renewal', 'unlimited liability'] }
        },
        // the human: step — mock returns the resolved legal decision
        [HUMAN_CAP]: (p) => {
          expect(p.kind).toBe('approval')
          expect(p.assignee).toBe('legal-user-1') // $ref was resolved to the userId
          return { approved: true, note: 'OK once liability is capped' }
        },
        'contract-memo': (p) => {
          expect((p.legal_decision as { approved: boolean }).approved).toBe(true)
          return { memo: 'Reviewed; proceed with liability carve-out.' }
        },
      },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('expected ok')
    const out = result.output as {
      counterparty: string
      legal_decision: { approved: boolean }
      memo: { memo: string }
    }
    expect(out.counterparty).toBe('Acme Corp')
    expect(out.legal_decision.approved).toBe(true)
    expect(out.memo.memo).toMatch(/carve-out/)

    // the human step dispatched to the inbox capability, not to a fake tool
    expect(calls.map((c) => c.cap)).toEqual([
      'contract-extract',
      'contract-assess',
      HUMAN_CAP,
      'contract-memo',
    ])
  })
})

describe('industry template E2E — lead-qualification-flow (P5-M6)', () => {
  const handlers = (qualified: boolean): Record<string, CapHandler> => ({
    'lead-enrich': (p) => {
      expect((p.lead as { company: string }).company).toBe('Kopitiam Co')
      return { company: 'Kopitiam Co', size: 'SMB', industry: 'F&B' }
    },
    'lead-score': () => ({ score: qualified ? 85 : 30, qualified, segment: qualified ? 'enterprise' : 'low' }),
    'lead-outreach': (p) => {
      expect((p.score as { qualified: boolean }).qualified).toBe(true)
      return { subject: 'Hello from us', body: '...' }
    },
    'crm-upsert': () => ({ crmId: 'crm-123', synced: true }),
  })

  it('qualified lead → drafts outreach, then syncs CRM (when: true branch)', async () => {
    const { result, calls } = await runTemplate(
      'lead-qualification-flow.yaml',
      'qualify-lead',
      { name: 'Mei', email: 'mei@example.com', company: 'Kopitiam Co' },
      handlers(true),
    )
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('expected ok')
    const out = result.output as { outreach?: { subject: string }; crm: { synced: boolean } }
    expect(out.outreach?.subject).toBe('Hello from us')
    expect(out.crm.synced).toBe(true)
    // outreach DID run; crm-sync saw it
    expect(calls.map((c) => c.cap)).toEqual(['lead-enrich', 'lead-score', 'lead-outreach', 'crm-upsert'])
    const crmCall = calls.find((c) => c.cap === 'crm-upsert')!
    expect((crmCall.payload.outreach as { subject: string }).subject).toBe('Hello from us')
  })

  it('unqualified lead → skips outreach, still syncs CRM (when: false branch)', async () => {
    const { result, calls } = await runTemplate(
      'lead-qualification-flow.yaml',
      'qualify-lead',
      { name: 'Mei', email: 'mei@example.com', company: 'Kopitiam Co' },
      handlers(false),
    )
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('expected ok')
    const out = result.output as { outreach?: unknown; crm: { synced: boolean } }
    // the conditional step was skipped — its $ref resolves to undefined
    expect(out.outreach).toBeUndefined()
    expect(out.crm.synced).toBe(true)
    // lead-outreach was NEVER dispatched
    expect(calls.map((c) => c.cap)).toEqual(['lead-enrich', 'lead-score', 'crm-upsert'])
    const crmCall = calls.find((c) => c.cap === 'crm-upsert')!
    expect(crmCall.payload.outreach).toBeUndefined()
  })
})
