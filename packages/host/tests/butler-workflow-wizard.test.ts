/**
 * butler-workflow-wizard — WIZ-M4c. The resident butler's BENIGN `plan_workflow`
 * verb: run the six-phase wizard's compose and hand back a PROPOSAL (explanation
 * + gap checklist + validated YAML), persisting nothing.
 *
 * This isolates the thin toolset from the real wizard (a fake `ButlerWizardSource`
 * hands back crafted results):
 *
 *   1. Proposal-only — the tool never touches any create/save surface; the reply
 *      explicitly routes saving through the governed `create_workflow` (with the
 *      proposal's YAML carried verbatim by the model).
 *   2. Each ok:false reason maps to an honest zh reply (needs_user relays the
 *      assistant's question as a NON-error; exhausted/unavailable are errors).
 *   3. NO-LEAK — compose is always attributed to ITS OWN member (`by`).
 *   4. Degradation — no wizard surface ⇒ the tool isn't offered at all (mirrors
 *      the /me wizard routes' 503).
 *
 * The wizard pipeline itself (catalog → assist → gap → bounded repair) is proven
 * in workflow-wizard.test.ts; the wiring in wizard-wiring.test.ts.
 */

import { describe, expect, it } from 'vitest'

import {
  buildButlerWorkflowWizardToolset,
  type ButlerWizardSource,
} from '../src/personal-butler-workflow-wizard.js'
import type { WizardComposeResult } from '../src/workflow-wizard.js'

function fakeWizard(result: WizardComposeResult | Error): {
  surface: ButlerWizardSource
  reqs: Array<{ task: string; by: string; clarifications?: string }>
} {
  const reqs: Array<{ task: string; by: string; clarifications?: string }> = []
  return {
    reqs,
    surface: {
      async compose(req) {
        reqs.push(req)
        if (result instanceof Error) throw result
        return result
      },
    },
  }
}

const GREEN: WizardComposeResult = {
  ok: true,
  yaml: 'schema: aipehub.workflow/v1\nworkflow:\n  id: weekly-report\n',
  explanation: '每周五整理周报,你确认后发出。',
  gapAnalysis: { ok: true, needs: [] },
  gapText: '✓ 起草 — 主笔手能接\n✓ 审批 — 你自己',
  installTemplateRefs: [],
  repairRounds: 0,
}

const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? '').join('')

describe('butler-workflow-wizard — shape + degradation', () => {
  it('offers exactly plan_workflow when the wizard is wired; nothing when absent', () => {
    const wired = buildButlerWorkflowWizardToolset({ userId: 'alice', wizard: fakeWizard(GREEN).surface })
    expect(wired.listTools().map((t) => t.name)).toEqual(['plan_workflow'])
    const unwired = buildButlerWorkflowWizardToolset({ userId: 'alice' })
    expect(unwired.listTools()).toEqual([])
  })

  it('refuses an empty task without calling the wizard', async () => {
    const f = fakeWizard(GREEN)
    const tool = buildButlerWorkflowWizardToolset({ userId: 'alice', wizard: f.surface })
    const res = await tool.callTool('plan_workflow', { task: '   ' })
    expect(res.isError).toBe(true)
    expect(f.reqs).toHaveLength(0)
  })
})

describe('butler-workflow-wizard — proposal rendering', () => {
  it('a green compose renders explanation + gap checklist + fenced YAML + the create_workflow hand-off', async () => {
    const f = fakeWizard(GREEN)
    const tool = buildButlerWorkflowWizardToolset({ userId: 'alice', wizard: f.surface })
    const res = await tool.callTool('plan_workflow', {
      task: '每周五发周报',
      clarifications: '发给我自己确认',
    })
    expect(res.isError).toBeFalsy()
    const t = text(res)
    expect(t).toContain('还没保存')
    expect(t).toContain('每周五整理周报')
    expect(t).toContain('主笔手能接')
    expect(t).toContain('```yaml')
    expect(t).toContain('id: weekly-report')
    expect(t).toContain('create_workflow') // the save half routes through the governed gate
    // compose is attributed to THIS member, clarifications ride through.
    expect(f.reqs).toEqual([
      { task: '每周五发周报', by: 'alice', clarifications: '发给我自己确认' },
    ])
  })

  it('names the templates to install (and that installing needs admin approval)', async () => {
    const f = fakeWizard({ ...GREEN, installTemplateRefs: ['legal-pack', 'ops-pack'] })
    const tool = buildButlerWorkflowWizardToolset({ userId: 'alice', wizard: f.surface })
    const t = text(await tool.callTool('plan_workflow', { task: '合同初审' }))
    expect(t).toContain('legal-pack')
    expect(t).toContain('ops-pack')
    expect(t).toContain('批准')
  })
})

describe('butler-workflow-wizard — ok:false relays', () => {
  it('needs_user relays the assistant question as a NON-error (a dialogue state)', async () => {
    const f = fakeWizard({
      ok: false,
      reason: 'needs_user',
      explanation: '这个流程谁来审批?你自己还是别的同事?',
      repairRounds: 0,
    })
    const tool = buildButlerWorkflowWizardToolset({ userId: 'alice', wizard: f.surface })
    const res = await tool.callTool('plan_workflow', { task: '发周报' })
    expect(res.isError).toBeFalsy()
    expect(text(res)).toContain('谁来审批')
  })

  it('exhausted is an error carrying the last error rendering', async () => {
    const f = fakeWizard({
      ok: false,
      reason: 'exhausted',
      errorsText: '1. 步骤 review 引用了不存在的步骤输出',
      repairRounds: 2,
    })
    const tool = buildButlerWorkflowWizardToolset({ userId: 'alice', wizard: f.surface })
    const res = await tool.callTool('plan_workflow', { task: '发周报' })
    expect(res.isError).toBe(true)
    const t = text(res)
    expect(t).toContain('2 轮')
    expect(t).toContain('不存在的步骤输出')
  })

  it('assistant_unavailable is an error', async () => {
    const f = fakeWizard({ ok: false, reason: 'assistant_unavailable', repairRounds: 0 })
    const tool = buildButlerWorkflowWizardToolset({ userId: 'alice', wizard: f.surface })
    const res = await tool.callTool('plan_workflow', { task: '发周报' })
    expect(res.isError).toBe(true)
  })

  it('a wizard throw fails closed with a friendly message', async () => {
    const tool = buildButlerWorkflowWizardToolset({
      userId: 'alice',
      wizard: fakeWizard(new Error('boom')).surface,
    })
    const res = await tool.callTool('plan_workflow', { task: '发周报' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('出错')
  })
})

describe('butler-workflow-wizard — no-leak', () => {
  it("compose is always attributed to the tool's OWN member", async () => {
    const f = fakeWizard(GREEN)
    const tool = buildButlerWorkflowWizardToolset({ userId: 'alice', wizard: f.surface })
    await tool.callTool('plan_workflow', { task: 'a' })
    await tool.callTool('plan_workflow', { task: 'b', clarifications: 'c' })
    expect(f.reqs.every((r) => r.by === 'alice')).toBe(true)
  })
})
