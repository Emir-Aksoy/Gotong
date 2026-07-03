/**
 * WIZ-M5 — live eval baseline for the 六段建流向导, driven by a REAL LLM.
 *
 * Skipped unless a real key is exported (ANTHROPIC_API_KEY or OPENAI_API_KEY) —
 * same discipline as live-workflow.test.ts: nightly/release supplies the key,
 * normal `pnpm -r test` and key-less shells skip.
 *
 * The mock-provider gates (workflow-wizard.test.ts / workflow-wizard-e2e.test.ts)
 * pin the ORCHESTRATION: repair loops, gap analysis, persist gates. What they
 * can't measure is whether a real model, fed the wizard's catalog-grounded
 * prompt, actually lands valid drafts — the quality the wizard exists for. This
 * eval runs a FIXED set of zh tasks through the real stack and prints a
 * scorecard:
 *
 *   green     — ok on the first try (repairRounds 0)
 *   repaired  — ok after the bounded R1 loop caught a machine-level error
 *   needs_user— the model asked back instead of emitting YAML
 *   exhausted — still hard-broken after the repair budget
 *   error     — the assist path itself failed
 *
 * The assertion is a FLOOR, not a target: every task classifies cleanly (no
 * crash) and at least half land ok (green+repaired). Raising the floor is a
 * conscious decision once a baseline is recorded — the printed scorecard is the
 * deliverable to compare runs against.
 *
 * Cost discipline: 4 tasks × (1 + ≤1 repair) calls, 1024-token cap, cheap
 * models by default (Claude Haiku / gpt-4o-mini; DeepSeek via OPENAI_BASE_URL).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Hub, HumanParticipant, InMemoryStorage } from '@aipehub/core'
import { type LlmProvider } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { OpenAIProvider } from '@aipehub/llm-openai'
import {
  WorkflowAssistantAgent,
  WORKFLOW_ASSISTANT_CAPABILITY,
  type WorkflowAssistantOutput,
} from '@aipehub/workflow-assistant'

import { createWorkflowWizard } from '../src/wizard-wiring.js'
import type { WorkflowWizardService, WizardAssistView } from '../src/workflow-wizard.js'

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)

function liveProvider(): { provider: LlmProvider; label: string } {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      label: 'anthropic',
      provider: new AnthropicProvider({
        defaultModel: process.env.AIPE_LIVE_ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest',
        defaultMaxTokens: 1024,
      }),
    }
  }
  return {
    label: 'openai',
    provider: new OpenAIProvider({
      defaultModel: process.env.AIPE_LIVE_OPENAI_MODEL ?? 'gpt-4o-mini',
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    }),
  }
}

/**
 * The FIXED eval set — plain-language zh tasks a member would actually type,
 * spanning the wizard's terrain: pure-sequential, human-in-the-loop, a preset
 * gap, and a parallel fan-out. Editing this set invalidates baseline
 * comparisons — add, don't rewrite.
 */
const EVAL_TASKS: ReadonlyArray<{ id: string; task: string }> = [
  { id: 'seq', task: '每天早上收集笔记,总结成三句话发给我' },
  { id: 'hitl', task: '写一份周报草稿,让 boss 审批通过后再定稿' },
  { id: 'gap', task: '合同先法务初审,再总结要点给我' },
  { id: 'fan', task: '同一篇稿子同时做摘要和排版,两个都完成后合并输出' },
]

type Outcome = 'green' | 'repaired' | 'needs_user' | 'exhausted' | 'error'

describe.skipIf(!HAS_KEY)('live wizard eval — fixed zh tasks, real model', () => {
  let hub: Hub
  let wizard: WorkflowWizardService

  beforeAll(async () => {
    hub = new Hub({ storage: new InMemoryStorage() })
    await hub.start()
    // A small but realistic catalog: a human approver + a worker covering the
    // common verbs; legal-review only exists as a PRESET template (the gap task).
    hub.register(new HumanParticipant({ id: 'boss', capabilities: ['approve'] }))
    hub.register(
      new HumanParticipant({
        id: 'worker',
        capabilities: ['collect-notes', 'summarize', 'draft', 'layout'],
      }),
    )
    const { provider, label } = liveProvider()
    // eslint-disable-next-line no-console
    console.log(`live wizard eval provider: ${label}`)
    hub.register(new WorkflowAssistantAgent({ provider, maxTokens: 1024 }))

    const assist: WizardAssistView = {
      async assist(input) {
        const result = await hub.dispatch({
          from: input.by,
          strategy: { kind: 'capability', capabilities: [WORKFLOW_ASSISTANT_CAPABILITY] },
          payload: {
            description: input.description,
            ...(input.mode ? { mode: input.mode } : {}),
            ...(input.contextHints ? { contextHints: input.contextHints } : {}),
          },
          title: 'workflow:assist',
        })
        if (result.kind !== 'ok') throw new Error(`assist dispatch failed: ${result.kind}`)
        return result.output as WorkflowAssistantOutput
      },
    }

    wizard = createWorkflowWizard({
      assist,
      sources: {
        participants: () =>
          hub.participants().map((p) => ({ id: p.id, kind: p.kind, capabilities: p.capabilities })),
        mcpServers: async () => [],
        inventory: async () => ({ llmKeys: [], localEndpoints: [], cliAgents: [] }),
        templateCards: () => [
          {
            id: 'legal-pack',
            name: '法务包',
            agents: [{ id: 'lawyer', displayName: '法务审查官', capabilities: ['legal-review'] }],
          },
        ],
        connectors: () => [],
      },
      // Cost bound: one repair round per task in the eval (the default 2 stays
      // for production; the eval measures first-shot + one-fix quality).
      maxRepairRounds: 1,
    })
  }, 60_000)

  afterAll(async () => {
    await hub.stop()
  })

  it('scorecard: every task classifies; at least half land ok', async () => {
    const rows: Array<{ id: string; outcome: Outcome; note: string }> = []
    for (const t of EVAL_TASKS) {
      let outcome: Outcome
      let note = ''
      try {
        const res = await wizard.compose({ task: t.task, by: 'eval' })
        if (res.ok) {
          outcome = res.repairRounds === 0 ? 'green' : 'repaired'
          note = `gaps=${res.gapAnalysis.needs.filter((n) => !n.satisfied).length} templates=${res.installTemplateRefs.join('/') || '-'}`
        } else {
          outcome = res.reason === 'assistant_unavailable' ? 'error' : res.reason
          note = (res.explanation ?? res.errorsText ?? res.detail ?? '').slice(0, 80)
        }
      } catch (err) {
        outcome = 'error'
        note = String(err).slice(0, 80)
      }
      rows.push({ id: t.id, outcome, note })
    }

    const count = (o: Outcome) => rows.filter((r) => r.outcome === o).length
    // The scorecard IS the deliverable — one line per task + the totals row.
    // eslint-disable-next-line no-console
    console.log(
      ['live wizard eval scorecard:']
        .concat(rows.map((r) => `  ${r.id.padEnd(5)} ${r.outcome.padEnd(10)} ${r.note}`))
        .concat(
          `  TOTAL green=${count('green')} repaired=${count('repaired')} needs_user=${count('needs_user')} exhausted=${count('exhausted')} error=${count('error')} / ${rows.length}`,
        )
        .join('\n'),
    )

    // Floor, not target: nothing crashed, and ≥ half landed a valid draft.
    expect(rows).toHaveLength(EVAL_TASKS.length)
    expect(count('error')).toBe(0)
    expect(count('green') + count('repaired')).toBeGreaterThanOrEqual(EVAL_TASKS.length / 2)
  }, 300_000)
})
