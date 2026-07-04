/**
 * WIZ-M2 — 缺口分析纯函数的单测。
 *
 * 钉死的承诺：
 *   1. 判定语义逐字镜像深检的 hasAgentWithAllCapabilities：**单个** participant
 *      同时具备全部能力才算满足——「各会一半」的并集不算
 *   2. explicit 按 id 精确命中；broadcast 不带能力过滤 = 零承接者也满足
 *   3. parallel 分支逐个展开成 `stepId.branchId` 需求；human: 糖走普通
 *      capability 判定（gotong.human/v1），成员即承接者
 *   4. 三条补法各有门槛：装模板要求模板里**单个 agent** 全覆盖；新建 agent 要求
 *      有燃料（provider / 端点）；派成员要求 hub 里真有人。都提不出=如实空
 *   5. 渲染：结论行 + 缩进补法行；空补法如实说「暂无现成补法」
 *
 * 定义全部经真 parseWorkflow 搭出（不是手捏对象）——schema 漂移会在这里先红。
 */

import { describe, expect, it } from 'vitest'

import { parseWorkflow } from '@gotong/workflow'

import { buildComponentCatalog } from '../src/component-catalog.js'
import { analyzeWorkflowGaps, renderGapAnalysis } from '../src/workflow-gap-analysis.js'

// ── 公共 fixture ────────────────────────────────────────────────────────────

// writer 会 draft+revise；alice 是真人（带 inbox broker 能力）。燃料：deepseek key
// + ollama 端点。模板：legal-pack 单 agent 全覆盖 law-review；half-pack 两个 agent
// 各会一半（approve / publish）；ghost-pack 带一个叫 ghost 的 agent。
const CATALOG = buildComponentCatalog({
  participants: [
    { id: 'writer', kind: 'agent', capabilities: ['draft', 'revise'] },
    { id: 'alice', kind: 'human', capabilities: ['approve', 'gotong.human/v1'] },
  ],
  resources: {
    llmKeys: [{ provider: 'deepseek', envSet: true, vaultConfigured: false }],
    localEndpoints: [{ label: 'ollama', url: 'http://127.0.0.1:11434', reachable: true }],
  },
  presetTemplates: [
    { id: 'legal-pack', name: '法务包', agents: [{ name: '律师', capabilities: ['law-review', 'contract-draft'] }] },
    { id: 'half-pack', agents: [{ name: 'h1', capabilities: ['approve'] }, { name: 'h2', capabilities: ['publish'] }] },
    { id: 'ghost-pack', agents: [{ name: 'ghost', capabilities: ['haunt'] }] },
  ],
})

function wf(stepsYaml: string) {
  return parseWorkflow(`
schema: gotong.workflow/v1
workflow:
  id: gap-demo
  trigger:
    capability: run-gap-demo
  steps:
${stepsYaml}
`)
}

describe('analyzeWorkflowGaps — 满足判定（镜像深检语义）', () => {
  it('capability：单个 agent 覆盖全部 → 满足并列出承接者', () => {
    const def = wf(`
    - id: draft
      dispatch:
        strategy: { kind: capability, capabilities: [draft, revise] }
        payload: { brief: hi }
`)
    const a = analyzeWorkflowGaps(def, CATALOG)
    expect(a.ok).toBe(true)
    expect(a.needs).toHaveLength(1)
    expect(a.needs[0]!.need).toEqual({ at: 'draft', kind: 'capability', capabilities: ['draft', 'revise'] })
    expect(a.needs[0]!.satisfiedBy).toEqual([{ id: 'writer', kind: 'agent' }])
  })

  it('capability：各会一半的并集不算满足（all-caps 语义的锁）', () => {
    // writer 会 draft、alice 会 approve —— 没有单个参与者两样都会
    const def = wf(`
    - id: signoff
      dispatch:
        strategy: { kind: capability, capabilities: [draft, approve] }
        payload: {}
`)
    const a = analyzeWorkflowGaps(def, CATALOG)
    expect(a.ok).toBe(false)
    expect(a.needs[0]!.satisfied).toBe(false)
  })

  it('explicit：id 命中（含人）/ 未命中', () => {
    const def = wf(`
    - id: ask
      dispatch:
        strategy: { kind: explicit, to: alice }
        payload: {}
    - id: haunt
      dispatch:
        strategy: { kind: explicit, to: ghost }
        payload: {}
`)
    const a = analyzeWorkflowGaps(def, CATALOG)
    expect(a.needs[0]!.satisfied).toBe(true)
    expect(a.needs[0]!.satisfiedBy).toEqual([{ id: 'alice', kind: 'human' }])
    expect(a.needs[1]!.satisfied).toBe(false)
    expect(a.ok).toBe(false)
  })

  it('broadcast：不带能力过滤零承接者也满足；带了就按 all-caps 查', () => {
    const def = wf(`
    - id: notify
      dispatch:
        strategy: { kind: broadcast }
        payload: { done: true }
    - id: recall
      dispatch:
        strategy: { kind: broadcast, capabilities: [law-review] }
        payload: {}
`)
    const a = analyzeWorkflowGaps(def, [])
    expect(a.needs[0]!.satisfied).toBe(true)
    expect(a.needs[0]!.satisfiedBy).toBeUndefined()
    expect(a.needs[1]!.satisfied).toBe(false)
  })

  it('parallel 分支逐个展开成 stepId.branchId', () => {
    const def = wf(`
    - id: fan
      parallel: true
      branches:
        - id: legal
          dispatch:
            strategy: { kind: capability, capabilities: [law-review] }
            payload: {}
        - id: write
          dispatch:
            strategy: { kind: capability, capabilities: [draft] }
            payload: {}
`)
    const a = analyzeWorkflowGaps(def, CATALOG)
    expect(a.needs.map((n) => n.need.at)).toEqual(['fan.legal', 'fan.write'])
    expect(a.needs[0]!.satisfied).toBe(false) // 没人会 law-review
    expect(a.needs[1]!.satisfied).toBe(true)
  })

  it('human: 糖走普通 capability 判定 —— 成员即承接者', () => {
    const def = wf(`
    - id: ok
      human:
        assignee: alice
        kind: approval
        prompt: 请审批
`)
    const a = analyzeWorkflowGaps(def, CATALOG)
    expect(a.needs[0]!.need.capabilities).toEqual(['gotong.human/v1'])
    expect(a.needs[0]!.satisfied).toBe(true)
    expect(a.needs[0]!.satisfiedBy).toEqual([{ id: 'alice', kind: 'human' }])
  })
})

describe('analyzeWorkflowGaps — 三条补法与门槛', () => {
  const LAW_GAP = wf(`
    - id: legal
      dispatch:
        strategy: { kind: capability, capabilities: [law-review] }
        payload: {}
`)

  it('capability 缺口：装模板（单 agent 全覆盖）> 新建 agent（有燃料）> 派成员（有人）', () => {
    const a = analyzeWorkflowGaps(LAW_GAP, CATALOG)
    const props = a.needs[0]!.proposals!
    expect(props.map((p) => p.kind)).toEqual(['install_template', 'create_agent', 'assign_member'])
    expect(props[0]).toMatchObject({ ref: 'legal-pack', agentName: '律师' })
    expect(props[0]!.message).toContain('需你批准')
    expect(props[1]).toMatchObject({ capabilities: ['law-review'], providers: ['deepseek', 'ollama'] })
    expect(props[1]!.message).toContain('提示词质量')
    expect(props[2]).toMatchObject({ memberIds: ['alice'], capabilities: ['law-review'] })
  })

  it('装模板要求单 agent 全覆盖：half-pack 的两半救不了 [approve, publish]', () => {
    const def = wf(`
    - id: pub
      dispatch:
        strategy: { kind: capability, capabilities: [approve, publish] }
        payload: {}
`)
    const a = analyzeWorkflowGaps(def, CATALOG)
    const props = a.needs[0]!.proposals!
    expect(props.find((p) => p.kind === 'install_template')).toBeUndefined()
    expect(props.map((p) => p.kind)).toEqual(['create_agent', 'assign_member'])
  })

  it('没燃料不提新建 agent；没人不提派成员；全没有 = 如实空', () => {
    const bareCatalog = buildComponentCatalog({
      participants: [{ id: 'writer', kind: 'agent', capabilities: ['draft'] }],
    })
    const a = analyzeWorkflowGaps(LAW_GAP, bareCatalog)
    expect(a.needs[0]!.proposals).toEqual([])
  })

  it('explicit 缺口：同名模板 agent 给台阶（措辞诚实）+ 可按 id 新建；不提派成员', () => {
    const def = wf(`
    - id: haunt
      dispatch:
        strategy: { kind: explicit, to: ghost }
        payload: {}
`)
    const a = analyzeWorkflowGaps(def, CATALOG)
    const props = a.needs[0]!.proposals!
    expect(props.map((p) => p.kind)).toEqual(['install_template', 'create_agent'])
    expect(props[0]).toMatchObject({ ref: 'ghost-pack', agentName: 'ghost' })
    expect(props[0]!.message).toContain('以实际注册为准')
    expect(props[1]).toMatchObject({ forId: 'ghost', capabilities: [] })
    expect(props.find((p) => p.kind === 'assign_member')).toBeUndefined()
  })
})

describe('renderGapAnalysis', () => {
  it('全满足：头行报数，逐行 ✓', () => {
    const def = wf(`
    - id: draft
      dispatch:
        strategy: { kind: capability, capabilities: [draft] }
        payload: {}
`)
    const text = renderGapAnalysis(analyzeWorkflowGaps(def, CATALOG))
    expect(text).toContain('1 个派发需求全部有人能接')
    expect(text).toContain('✓ draft 需要 [draft] —— writer 可承接')
  })

  it('有缺口：头行报缺口数，✗ 行 + 缩进补法行', () => {
    const def = wf(`
    - id: legal
      dispatch:
        strategy: { kind: capability, capabilities: [law-review] }
        payload: {}
`)
    const text = renderGapAnalysis(analyzeWorkflowGaps(def, CATALOG))
    expect(text).toContain('1 个派发需求，1 个有缺口')
    expect(text).toContain('✗ legal 需要 [law-review] —— 没有单个成员/agent 同时具备全部能力')
    expect(text).toContain('    补法1 装模板「legal-pack」')
    expect(text).toContain('    补法2 用已就绪的 deepseek / ollama 新建')
    expect(text).toContain('    补法3 交给成员承接（alice）')
  })

  it('空补法如实说「暂无现成补法」；explicit 缺口有专属措辞', () => {
    const def = wf(`
    - id: haunt
      dispatch:
        strategy: { kind: explicit, to: ghost }
        payload: {}
`)
    const empty = renderGapAnalysis(analyzeWorkflowGaps(def, []))
    expect(empty).toContain('✗ haunt 点名「ghost」—— 本 hub 没有这个参与者')
    expect(empty).toContain('暂无现成补法')
    // broadcast 无过滤的专属行
    const bcast = wf(`
    - id: notify
      dispatch:
        strategy: { kind: broadcast }
        payload: {}
`)
    expect(renderGapAnalysis(analyzeWorkflowGaps(bcast, []))).toContain(
      '✓ notify 广播（无能力过滤）—— 不需要特定承接者',
    )
  })
})
