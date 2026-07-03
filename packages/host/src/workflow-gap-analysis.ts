/**
 * workflow-gap-analysis.ts — WIZ-M2. 缺口分析纯函数：工作流定义 × 组件目录 →
 * 每个派发需求「谁能接？没人接的话有哪几条补法？」。
 *
 * 判定语义**逐字镜像**深检的 `hasAgentWithAllCapabilities`（packages/evals/src/
 * checkers/workflow-structure.ts）：一个 capability 派发被满足，当且仅当**单个**
 * participant 同时具备全部所列能力——不是「每个能力各有人会」。镜像不一致的后果
 * 是向导说缺口已补、深检仍然红（或反过来），用户两头懵；所以这里的满足判定必须
 * 与深检共同进退，改任何一边先改另一边。
 *
 * 与深检的分工：深检管结构错误（自触发环 / 引用超前 / 未知 id），本文件只回答
 * 资源问题——「这个 hub 现在的人和 agent 接不接得住每一步」。WIZ-M3 的向导两个
 * 都跑，各出各的结论。
 *
 * 补法的诚实边界（与目录同一纪律）：
 *   - install_template 只在**模板里某单个 agent** 能独自覆盖全部所缺能力时才提
 *     （装两个各会一半的 agent 救不了 all-caps 语义）；装模板需人批准。
 *   - create_agent 只在有可用燃料（key 可解析的 provider 或活着的本地端点）时才
 *     提，且明说新 agent 的效果取决于提示词质量——不假装「建了就等于会」。
 *   - assign_member 只在 hub 里真有成员时才提。
 *   - 三条都提不出来时如实说「暂无现成补法」，不编。
 *
 * 纯函数、零 LLM、零 I/O——与 RES-M2 提议引擎、WIZ-M1 目录同形态。
 */

import type { DispatchSpec, WorkflowDefinition } from '@aipehub/workflow'

import type { ComponentEntry } from './component-catalog.js'

// ── 需求与判定 ──────────────────────────────────────────────────────────────

export interface WorkflowNeed {
  /** 出处：simple 步是 step id，parallel 分支是 `stepId.branchId`。 */
  at: string
  kind: 'capability' | 'explicit' | 'broadcast'
  /** capability / broadcast 时：这一步要求的能力集（broadcast 可缺省）。 */
  capabilities?: readonly string[]
  /** explicit 时：点名的 participant id。 */
  to?: string
}

export type GapProposal =
  | {
      /** 装一个预置模板——其中某单个 agent 能独自覆盖全部所缺能力。 */
      kind: 'install_template'
      /** 目录里的模板 id（= install.ref）。 */
      ref: string
      /** 模板里承接缺口的那个 agent 名（有名字才填）。 */
      agentName?: string
      message: string
    }
  | {
      /** 用已就绪的 LLM 燃料新建一个 agent 来承接。 */
      kind: 'create_agent'
      /** 新 agent 需要具备的能力集（explicit 缺口时为空——那是按 id 点名）。 */
      capabilities: readonly string[]
      /** explicit 缺口时：被点名而不存在的那个 id。 */
      forId?: string
      /** 可用燃料（llm-provider / endpoint 的目录 id），provider 在前。 */
      providers: readonly string[]
      message: string
    }
  | {
      /** 把这一步交给 hub 里的真人成员。 */
      kind: 'assign_member'
      memberIds: readonly string[]
      capabilities: readonly string[]
      message: string
    }

export interface NeedVerdict {
  need: WorkflowNeed
  satisfied: boolean
  /** 满足时：能承接的人 / agent（可能多个，按目录序）。broadcast 无能力过滤时缺省。 */
  satisfiedBy?: ReadonlyArray<{ id: string; kind: 'human' | 'agent' }>
  /** 不满足时的补法，固定优先序：装模板 > 新建 agent > 派成员。可为空数组（如实没辙）。 */
  proposals?: readonly GapProposal[]
}

export interface GapAnalysis {
  /** 全部需求都有人能接。 */
  ok: boolean
  /** 按步骤声明顺序（parallel 分支按分支顺序展开）。 */
  needs: NeedVerdict[]
}

// ── 分析 ────────────────────────────────────────────────────────────────────

/**
 * 只需要 steps —— 其余定义字段（trigger / output / governance…）是深检的事。
 * 取 Pick 而非整个 WorkflowDefinition，让 WIZ-M3 也能对助手草稿的局部解析结果跑。
 */
export function analyzeWorkflowGaps(
  def: Pick<WorkflowDefinition, 'steps'>,
  catalog: ReadonlyArray<ComponentEntry>,
): GapAnalysis {
  const doers = catalog.filter(
    (e): e is ComponentEntry & { kind: 'human' | 'agent' } =>
      e.status === 'installed' && (e.kind === 'human' || e.kind === 'agent'),
  )
  const needs = extractNeeds(def).map((need) => judgeNeed(need, doers, catalog))
  return { ok: needs.every((n) => n.satisfied), needs }
}

function extractNeeds(def: Pick<WorkflowDefinition, 'steps'>): WorkflowNeed[] {
  const out: WorkflowNeed[] = []
  const push = (at: string, strategy: DispatchSpec['strategy']) => {
    if (strategy.kind === 'explicit') {
      out.push({ at, kind: 'explicit', to: strategy.to })
    } else if (strategy.kind === 'capability') {
      out.push({ at, kind: 'capability', capabilities: [...strategy.capabilities] })
    } else {
      out.push({
        at,
        kind: 'broadcast',
        ...(strategy.capabilities ? { capabilities: [...strategy.capabilities] } : {}),
      })
    }
  }
  for (const step of def.steps) {
    // SimpleStep.kind 可缺省（解析器会盖章，手搭的定义可能没有）——缺省即 simple，
    // 与 runner 的默认语义一致。
    if (step.kind === 'parallel') {
      for (const b of step.branches) push(`${step.id}.${b.id}`, b.dispatch.strategy)
    } else {
      push(step.id, step.dispatch.strategy)
    }
  }
  return out
}

function judgeNeed(
  need: WorkflowNeed,
  doers: ReadonlyArray<ComponentEntry & { kind: 'human' | 'agent' }>,
  catalog: ReadonlyArray<ComponentEntry>,
): NeedVerdict {
  if (need.kind === 'explicit') {
    const hit = doers.filter((d) => d.id === need.to)
    if (hit.length > 0) {
      return { need, satisfied: true, satisfiedBy: hit.map((d) => ({ id: d.id, kind: d.kind })) }
    }
    return { need, satisfied: false, proposals: proposeForExplicit(need.to!, catalog) }
  }

  // broadcast 不带能力过滤 = 广播给愿意听的任何人，零承接者也合法（镜像深检：
  // 只在列了能力时才查覆盖）。
  const caps = need.capabilities ?? []
  if (need.kind === 'broadcast' && caps.length === 0) {
    return { need, satisfied: true }
  }

  // 镜像 hasAgentWithAllCapabilities 的 some/every：单个承接者覆盖全部能力。
  const covering = doers.filter((d) => caps.every((c) => (d.capabilities ?? []).includes(c)))
  if (covering.length > 0) {
    return {
      need,
      satisfied: true,
      satisfiedBy: covering.map((d) => ({ id: d.id, kind: d.kind })),
    }
  }
  return { need, satisfied: false, proposals: proposeForCapabilities(caps, doers, catalog) }
}

// ── 三条补法 ────────────────────────────────────────────────────────────────

function proposeForCapabilities(
  caps: readonly string[],
  doers: ReadonlyArray<ComponentEntry & { kind: 'human' | 'agent' }>,
  catalog: ReadonlyArray<ComponentEntry>,
): GapProposal[] {
  const out: GapProposal[] = []

  // 1. 装模板：某单个模板 agent 独自覆盖全部能力（不是模板并集覆盖——并集救不了
  //    all-caps 语义）。每个命中的模板出一条。
  for (const t of catalog) {
    if (t.kind !== 'template' || !t.providesAgents) continue
    const agent = t.providesAgents.find((a) => caps.every((c) => a.capabilities.includes(c)))
    if (!agent) continue
    out.push({
      kind: 'install_template',
      ref: t.install?.ref ?? t.id,
      ...(agent.name ? { agentName: agent.name } : {}),
      message: `装模板「${t.id}」—— 其中 agent${agent.name ? `「${agent.name}」` : ''}具备 [${caps.join(', ')}]（安装需你批准）`,
    })
  }

  // 2. 新建 agent：有燃料才提。provider（key 可解析）在前，本地端点在后。
  const fuel = [
    ...catalog.filter((e) => e.kind === 'llm-provider').map((e) => e.id),
    ...catalog.filter((e) => e.kind === 'endpoint').map((e) => e.id),
  ]
  if (fuel.length > 0) {
    out.push({
      kind: 'create_agent',
      capabilities: [...caps],
      providers: fuel,
      message: `用已就绪的 ${fuel.join(' / ')} 新建一个具备 [${caps.join(', ')}] 的 agent —— 新 agent 的效果取决于提示词质量，建好先试跑再上正事`,
    })
  }

  // 3. 派成员：hub 里真有人才提。
  const humans = doers.filter((d) => d.kind === 'human')
  if (humans.length > 0) {
    const ids = humans.map((h) => h.id)
    out.push({
      kind: 'assign_member',
      memberIds: ids,
      capabilities: [...caps],
      message: `交给成员承接（${ids.join(', ')}）—— 把这步改成 human 步，或给成员配上 [${caps.join(', ')}] 能力`,
    })
  }

  return out
}

function proposeForExplicit(to: string, catalog: ReadonlyArray<ComponentEntry>): GapProposal[] {
  const out: GapProposal[] = []

  // 模板里恰好带同名 agent 时给个台阶——但装出来的 participant id 以实际注册为准，
  // 不承诺一定叫这个名。
  for (const t of catalog) {
    if (t.kind !== 'template' || !t.providesAgents) continue
    if (!t.providesAgents.some((a) => a.name === to)) continue
    out.push({
      kind: 'install_template',
      ref: t.install?.ref ?? t.id,
      agentName: to,
      message: `模板「${t.id}」带一个叫「${to}」的 agent（安装需你批准；装后 id 以实际注册为准，必要时把这步的 to 对准新 id）`,
    })
  }

  const fuel = [
    ...catalog.filter((e) => e.kind === 'llm-provider').map((e) => e.id),
    ...catalog.filter((e) => e.kind === 'endpoint').map((e) => e.id),
  ]
  if (fuel.length > 0) {
    out.push({
      kind: 'create_agent',
      capabilities: [],
      forId: to,
      providers: fuel,
      message: `新建一个 id 为「${to}」的 agent（用 ${fuel.join(' / ')}）—— 或把这步改成 capability 派发，别钉死 id`,
    })
  }

  // 不提 assign_member：成员 id 是既定事实，改不成别人点名的那个名字。
  return out
}

// ── 给用户 / LLM 看的紧凑渲染 ───────────────────────────────────────────────

/**
 * 渲染成中文核对单：每个需求一行结论，缺口的补法逐条缩进列出。文本同时喂
 * WIZ-M3 的提议界面和（缺口存在时）组装 LLM 的修复指令，所以措辞保持事实性。
 */
export function renderGapAnalysis(analysis: GapAnalysis): string {
  const gaps = analysis.needs.filter((n) => !n.satisfied)
  const lines: string[] = [
    analysis.ok
      ? `工作流资源核对：${analysis.needs.length} 个派发需求全部有人能接`
      : `工作流资源核对：${analysis.needs.length} 个派发需求，${gaps.length} 个有缺口`,
  ]
  for (const v of analysis.needs) {
    lines.push(renderVerdictLine(v))
    if (!v.satisfied) {
      const props = v.proposals ?? []
      if (props.length === 0) {
        lines.push('    （目录里暂无现成补法 —— 可先邀请成员或配置 LLM provider / 本地端点，再重新核对）')
      } else {
        props.forEach((p, i) => lines.push(`    补法${i + 1} ${p.message}`))
      }
    }
  }
  return lines.join('\n')
}

function renderVerdictLine(v: NeedVerdict): string {
  const mark = v.satisfied ? '✓' : '✗'
  const who =
    v.satisfiedBy && v.satisfiedBy.length > 0
      ? v.satisfiedBy.map((s) => s.id).join(', ')
      : undefined
  if (v.need.kind === 'explicit') {
    return v.satisfied
      ? `${mark} ${v.need.at} 点名「${v.need.to}」—— 在`
      : `${mark} ${v.need.at} 点名「${v.need.to}」—— 本 hub 没有这个参与者`
  }
  const caps = v.need.capabilities ?? []
  if (v.need.kind === 'broadcast' && caps.length === 0) {
    return `${mark} ${v.need.at} 广播（无能力过滤）—— 不需要特定承接者`
  }
  const label = v.need.kind === 'broadcast' ? '广播需要' : '需要'
  return v.satisfied
    ? `${mark} ${v.need.at} ${label} [${caps.join(', ')}] —— ${who} 可承接`
    : `${mark} ${v.need.at} ${label} [${caps.join(', ')}] —— 没有单个成员/agent 同时具备全部能力`
}
