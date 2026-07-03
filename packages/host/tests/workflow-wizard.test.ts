/**
 * WIZ-M3 — 六段建流向导编排核的单测。
 *
 * 钉死的承诺：
 *   1. prepare 零 LLM 即时返回确认卡 + 目录；clarify 是可选增强，失败静默降级
 *   2. compose 的修复 vs 缺口分诊：解析错误 / HARD 违规 / 近失命名 → R1 自动
 *      修复回路；「用了预置模板才有的能力」是缺口不是错误——不浪费修复轮，
 *      直接出提议 + 装模板补法
 *   3. R1 有界：默认最多 2 轮修复，超了如实 exhausted 交还（带最后错误渲染 +
 *      最后一版 YAML）；no_yaml 是对话不是错误，立刻 needs_user
 *   4. R2 渲染进下一轮 prompt：解析器报错原文 / 近失建议名 / HARD 修法都要
 *      真的出现在重问的 description 里（弱模型全靠这个改对）
 *   5. prompt 组装：任务 / 用户补充 / 目录 / 组装规则 / 往轮对话（含否决标记）
 *
 * assist 用脚本化 fake（顺序出队 + 记录每轮入参）——回路行为全部可断言。
 */

import { describe, expect, it } from 'vitest'

import { buildComponentCatalog } from '../src/component-catalog.js'
import {
  nearestNames,
  WorkflowWizardService,
  type WizardAssistOutput,
} from '../src/workflow-wizard.js'

// ── fixtures ────────────────────────────────────────────────────────────────

const CATALOG = buildComponentCatalog({
  participants: [
    { id: 'writer', kind: 'agent', capabilities: ['draft', 'revise'], description: '中文写手' },
    { id: 'alice', kind: 'human', capabilities: ['approve', 'aipehub.human/v1'] },
  ],
  installedMcpServers: [{ name: 'filesystem' }],
  resources: { llmKeys: [{ provider: 'deepseek', envSet: true, vaultConfigured: false }] },
  presetTemplates: [
    { id: 'legal-pack', name: '法务包', agents: [{ name: '律师', capabilities: ['law-review'] }] },
  ],
})

const GOOD_YAML = `
schema: aipehub.workflow/v1
workflow:
  id: demo
  trigger:
    capability: run-demo
  steps:
    - id: d1
      dispatch:
        strategy: { kind: capability, capabilities: [draft] }
        payload: { brief: hi }
`

function yamlWithCap(cap: string): string {
  return GOOD_YAML.replace('capabilities: [draft]', `capabilities: [${cap}]`)
}

function valid(yaml: string, extra?: Partial<WizardAssistOutput>): WizardAssistOutput {
  return { draftStatus: 'valid', yaml, explanation: '搭好了', deepCheck: { ok: true, violations: [] }, ...extra }
}

function fakeAssist(outputs: WizardAssistOutput[]) {
  const calls: Array<{ description: string; contextHints?: { agents?: readonly unknown[]; mcpServers?: readonly string[] } }> = []
  return {
    calls,
    view: {
      assist: async (input: { description: string; contextHints?: never }) => {
        calls.push(input as (typeof calls)[number])
        const next = outputs.shift()
        if (!next) throw new Error('fake assist exhausted')
        return next
      },
    },
  }
}

function service(outputs: WizardAssistOutput[], opts?: { maxRepairRounds?: number; clarify?: never | ((i: { task: string }) => Promise<{ questions: string[] }>) }) {
  const fake = fakeAssist(outputs)
  const svc = new WorkflowWizardService({
    assist: fake.view,
    catalog: () => CATALOG,
    existingWorkflowIds: () => ['old-flow'],
    ...(opts?.maxRepairRounds !== undefined ? { maxRepairRounds: opts.maxRepairRounds } : {}),
    ...(opts?.clarify ? { clarify: opts.clarify as never } : {}),
  })
  return { svc, calls: fake.calls }
}

// ── ①+② prepare ─────────────────────────────────────────────────────────────

describe('prepare（确认卡，零 LLM）', () => {
  it('返回任务复述 + 目录分节 + 可跳过措辞；没接 clarify 就没有问题', async () => {
    const { svc } = service([])
    const r = await svc.prepare({ task: '每天整理待办发给我', by: 'u1' })
    expect(r.questions).toEqual([])
    expect(r.confirmText).toContain('「每天整理待办发给我」')
    expect(r.confirmText).toContain('=== 本 hub 已有组件（现在就能用）===')
    expect(r.confirmText).toContain('直接开始可跳过')
    expect(r.catalogText).toContain('legal-pack')
  })

  it('clarify 接了就附问题；clarify 抛错静默降级为空（① 绝不因它失败）', async () => {
    const ok = service([], { clarify: async () => ({ questions: ['谁来审批？'] }) })
    const r1 = await ok.svc.prepare({ task: 't', by: 'u1' })
    expect(r1.questions).toEqual(['谁来审批？'])
    expect(r1.confirmText).toContain('谁来审批？')

    const bad = service([], { clarify: async () => { throw new Error('no key') } })
    const r2 = await bad.svc.prepare({ task: 't', by: 'u1' })
    expect(r2.questions).toEqual([])
  })
})

// ── ③–⑤ compose：组装 + 缺口 ────────────────────────────────────────────────

describe('compose — 组装与缺口（不该修的不修）', () => {
  it('一把过：已装能力覆盖 → ok，0 修复轮，无缺口', async () => {
    const { svc, calls } = service([valid(GOOD_YAML)])
    const r = await svc.compose({ task: '起草一篇稿', by: 'u1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.repairRounds).toBe(0)
    expect(r.gapAnalysis.ok).toBe(true)
    expect(r.installTemplateRefs).toEqual([])
    expect(calls).toHaveLength(1)
    // prompt 组装：任务 + 目录 + 规则都在
    expect(calls[0]!.description).toContain('【任务】')
    expect(calls[0]!.description).toContain('起草一篇稿')
    expect(calls[0]!.description).toContain('=== 本 hub 已有组件（现在就能用）===')
    expect(calls[0]!.description).toContain('【组装规则】')
    // contextHints：人和 agent 同列，MCP 名单 + 既有 id 防撞
    expect(calls[0]!.contextHints?.agents).toHaveLength(2)
    expect(calls[0]!.contextHints?.mcpServers).toEqual(['filesystem'])
  })

  it('用了预置模板才有的能力 = 缺口不是错误：不烧修复轮，出装模板补法', async () => {
    const { svc, calls } = service([valid(yamlWithCap('law-review'))])
    const r = await svc.compose({ task: '合同审一遍', by: 'u1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(calls).toHaveLength(1) // 关键：没有把它当错误重问
    expect(r.repairRounds).toBe(0)
    expect(r.gapAnalysis.ok).toBe(false)
    expect(r.installTemplateRefs).toEqual(['legal-pack'])
    expect(r.gapText).toContain('补法1 装模板「legal-pack」')
  })

  it('真缺但不近失（如 summarize）也是缺口：给新建 agent / 派成员补法', async () => {
    const { svc, calls } = service([valid(yamlWithCap('summarize'))])
    const r = await svc.compose({ task: '总结', by: 'u1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(calls).toHaveLength(1)
    const kinds = r.gapAnalysis.needs[0]!.proposals!.map((p) => p.kind)
    expect(kinds).toEqual(['create_agent', 'assign_member'])
  })

  it('用户补充与往轮对话折进 prompt（含被否标记）', async () => {
    const { svc, calls } = service([valid(GOOD_YAML)])
    await svc.compose({
      task: '起草',
      by: 'u1',
      clarifications: '每天早上跑',
      history: [
        { role: 'assistant', text: '第一版方案', failed: true },
        { role: 'user', text: '加一步审批' },
      ],
    })
    const d = calls[0]!.description
    expect(d).toContain('【用户补充】\n每天早上跑')
    expect(d).toContain('【之前的来回】')
    expect(d).toContain('助手（这版被用户否了，不要原样重来）：第一版方案')
    expect(d).toContain('用户：加一步审批')
  })
})

// ── ⑥ 校验闭环：R1 有界修复 + R2 渲染 ───────────────────────────────────────

describe('compose — R1 修复回路', () => {
  it('解析失败 → 报错原文喂回重问 → 第二轮通过', async () => {
    const { svc, calls } = service([
      { draftStatus: 'invalid', yaml: 'bad: yaml', explanation: '', validationError: "workflow.steps[0].id is required" },
      valid(GOOD_YAML),
    ])
    const r = await svc.compose({ task: '起草', by: 'u1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.repairRounds).toBe(1)
    expect(calls).toHaveLength(2)
    const d2 = calls[1]!.description
    expect(d2).toContain('没通过校验')
    expect(d2).toContain('解析器拒绝了这版 YAML：workflow.steps[0].id is required')
    expect(d2).toContain('bad: yaml') // 上一版原文在场，模型改而不是重猜
    expect(d2).toContain('完整')
  })

  it('近失命名（drafts ≈ draft）→ 建议改名喂回 → 第二轮通过', async () => {
    const { svc, calls } = service([valid(yamlWithCap('drafts')), valid(GOOD_YAML)])
    const r = await svc.compose({ task: '起草', by: 'u1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.repairRounds).toBe(1)
    const d2 = calls[1]!.description
    expect(d2).toContain('「drafts」不存在')
    expect(d2).toContain('「draft」')
    expect(d2).toContain('不要自造')
  })

  it('HARD 结构违规（forward_ref）→ 修法喂回 → 第二轮通过', async () => {
    const { svc, calls } = service([
      valid(GOOD_YAML, {
        deepCheck: {
          ok: false,
          violations: [{ kind: 'forward_ref', message: "step 'd1' references later step 'd2'", path: 'workflow.steps[0].dispatch.payload' }],
        },
      }),
      valid(GOOD_YAML),
    ])
    const r = await svc.compose({ task: '起草', by: 'u1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.repairRounds).toBe(1)
    expect(calls[1]!.description).toContain('只能引用更早步骤的输出')
  })

  it('修满上限仍红 → exhausted，如实带回最后错误 + 最后一版 YAML', async () => {
    const bad: WizardAssistOutput = { draftStatus: 'invalid', yaml: 'still: bad', explanation: '', validationError: 'nope' }
    const { svc, calls } = service([bad, bad, bad])
    const r = await svc.compose({ task: '起草', by: 'u1' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('exhausted')
    expect(r.repairRounds).toBe(2) // 默认上限 2 轮修复 = 共 3 次调用
    expect(calls).toHaveLength(3)
    expect(r.errorsText).toContain('解析器拒绝了这版 YAML：nope')
    expect(r.lastYaml).toBe('still: bad')
  })

  it('maxRepairRounds=0 → 首轮红就交还，不重问', async () => {
    const bad: WizardAssistOutput = { draftStatus: 'invalid', yaml: '', explanation: '', validationError: 'x' }
    const { svc, calls } = service([bad], { maxRepairRounds: 0 })
    const r = await svc.compose({ task: 't', by: 'u1' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('exhausted')
    expect(r.repairRounds).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('no_yaml 是对话不是错误：立刻 needs_user，不烧修复轮', async () => {
    const { svc, calls } = service([{ draftStatus: 'no_yaml', yaml: '', explanation: '请问审批人是谁？' }])
    const r = await svc.compose({ task: '起草并审批', by: 'u1' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('needs_user')
    expect(r.explanation).toBe('请问审批人是谁？')
    expect(calls).toHaveLength(1)
  })

  it('assist 面抛错 → assistant_unavailable 带 detail', async () => {
    const svc = new WorkflowWizardService({
      assist: { assist: async () => { throw new Error('no api key') } },
      catalog: () => CATALOG,
    })
    const r = await svc.compose({ task: 't', by: 'u1' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('assistant_unavailable')
    expect(r.detail).toContain('no api key')
  })
})

// ── 近失判定 ────────────────────────────────────────────────────────────────

describe('nearestNames', () => {
  it('编辑距离 ≤2 / 大小写差 / 包含算近失；远的不算', () => {
    expect(nearestNames('drafts', ['draft', 'revise'])).toEqual(['draft'])
    expect(nearestNames('Draft', ['draft'])).toEqual(['draft'])
    expect(nearestNames('review', ['law-review'])).toEqual(['law-review']) // 包含
    expect(nearestNames('summarize', ['draft', 'revise'])).toEqual([]) // 真缺口
  })

  it('按接近程度排序并截到 3 个', () => {
    const got = nearestNames('draft', ['draft2', 'adraft', 'draf', 'drafty', 'x'])
    expect(got).toHaveLength(3)
    expect(got).not.toContain('x')
  })
})
