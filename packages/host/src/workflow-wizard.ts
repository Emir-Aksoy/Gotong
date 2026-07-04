/**
 * workflow-wizard.ts — WIZ-M3. 六段建流向导的编排核 + 校验闭环。
 *
 *   ① 确认任务（可跳过）— prepare()：任务复述 + 组件目录概要，零 LLM 即时返回；
 *     接了可选 clarify 依赖才附带 LLM 生成的澄清问题（best-effort）
 *   ② 盘点组件 — 目录来自注入的 catalog()（WIZ-M1 五源聚合），prompt / 缺口
 *     分析 / 用户展示三处共享同一份
 *   ③ 选型组装 — compose()：把目录整体喂给既有 workflow:assist 面（author 模式）
 *   ④ 衡量资源 — analyzeWorkflowGaps（WIZ-M2，零 LLM）
 *   ⑤ 提议 — yaml + 讲解 + DAG 图 + 缺口清单 + 三补法，用户调整（带 history 重来）
 *     或同意（入口层负责落盘，WIZ-M4）
 *   ⑥ 校验闭环 — R1 有界自修复：机器能改的错不再丢回给用户，渲染成修复指令
 *     （R2）喂回模型重来，默认最多 2 轮；修不完如实交还
 *
 * 修复 vs 缺口的分界（向导的核心判断）：
 *   - 修复（机器能改，R1 回路）：解析错误、四种 HARD 结构违规（bad_ref /
 *     forward_ref / self_trigger_cycle / id_collision——这些在 saveDraft 的
 *     硬闸也过不去）、以及「近失」命名——目录里有个几乎同名的能力 / 参与者，
 *     疑似模型拼错或自造，直接喂回去改名。
 *   - 缺口（人来决定，不修复）：能力 / id 在目录里真不存在 → WIZ-M2 的三补法
 *     （装模板 / 新建 agent / 派成员）交给用户批准。缺口不挡草稿落盘
 *     （unknown_capability 全程 advisory，unknown_agent 只挡上线），装完再发布。
 *   把「用了还没装的预置模板能力」当缺口而非错误，是向导和裸 assist 的本质差
 *   别——目录里的预置节就是让模型在已装覆盖不了时可以提议的，修复它反而错。
 *
 * 无状态纪律（WFEDIT 前例）：service 不存任何会话——调整走客户端携带的
 * history 重新 compose；R1 修复史只活在单次 compose 内部。三入口（admin /
 * /me / 管家）都能压在同一个核上（WIZ-M4）。
 */

import { parseWorkflow } from '@gotong/workflow'
import type { WorkflowDefinition, WorkflowGraphView } from '@gotong/workflow'

import {
  installedCapabilities,
  renderCatalogForPrompt,
  type ComponentEntry,
} from './component-catalog.js'
import {
  analyzeWorkflowGaps,
  renderGapAnalysis,
  type GapAnalysis,
  type WorkflowNeed,
} from './workflow-gap-analysis.js'

// ── 鸭子类型依赖 ────────────────────────────────────────────────────────────

/**
 * 深检结果的结构投影（真 `WorkflowStructureCheckResult` 满足它）。kind 保持
 * 开放 string——检查器的违规注册表本就开放，向导只认 HARD 四种的字面值。
 */
export interface WizardDeepCheckView {
  ok: boolean
  violations: ReadonlyArray<{ kind: string; message: string; path: string }>
}

/** assist 输出的结构投影（真 `WorkflowAssistantOutput` 满足它；light fake 可单测）。 */
export interface WizardAssistOutput {
  draftStatus: 'valid' | 'no_yaml' | 'invalid'
  yaml: string
  explanation: string
  validationError?: string
  deepCheck?: WizardDeepCheckView
  graph?: WorkflowGraphView
}

/** Phase 13 assist 面的投影（真 `WorkflowAssistSurface` 满足）。 */
export interface WizardAssistView {
  assist(input: {
    description: string
    mode?: 'author'
    detail?: 'oneliner' | 'brief' | 'detailed'
    contextHints?: {
      agents?: ReadonlyArray<{ id: string; capabilities: ReadonlyArray<string>; description?: string }>
      mcpServers?: ReadonlyArray<string>
      existingWorkflowIds?: ReadonlyArray<string>
    }
    by: string
    onChunk?: (chunk: string) => void
  }): Promise<WizardAssistOutput>
}

export interface WorkflowWizardDeps {
  assist: WizardAssistView
  /** WIZ-M1 目录（入口层每次调用时从活源现聚合——目录必须反映当下事实）。 */
  catalog: () => Promise<ReadonlyArray<ComponentEntry>> | ReadonlyArray<ComponentEntry>
  /** 已有工作流 id——喂给 assist 防 id 撞车。best-effort，缺省为空。 */
  existingWorkflowIds?: () => Promise<ReadonlyArray<string>> | ReadonlyArray<string>
  /**
   * 可选的澄清问题生成（LLM）。不接 = ① 段退化成确定性的确认卡（任务复述 +
   * 目录概要 + 「可补充可跳过」）——对弱模型这往往更稳，所以默认就不接。
   */
  clarify?: (input: { task: string; catalogText: string; by: string }) => Promise<{ questions: string[] }>
  /** R1 修复重问的上限（不含首轮组装）。默认 2——超过就交还给人，不无限烧。 */
  maxRepairRounds?: number
}

// ── ①+② prepare ─────────────────────────────────────────────────────────────

export interface WizardPrepareResult {
  task: string
  catalog: ReadonlyArray<ComponentEntry>
  /** 已装 + 预置分节的目录文本（和 compose 喂给模型的是同一份渲染）。 */
  catalogText: string
  /** clarify 依赖给出的澄清问题；没接 / 失败 = 空数组（① 可跳过，不因它失败）。 */
  questions: string[]
  /** 给用户看的确认卡。 */
  confirmText: string
}

// ── ③–⑥ compose ─────────────────────────────────────────────────────────────

/** 一轮用户来回（客户端携带，无状态）。failed=true 表示那次提议被用户否了。 */
export interface WizardTurn {
  role: 'user' | 'assistant'
  text: string
  failed?: boolean
}

export interface WizardComposeRequest {
  task: string
  /** 服务端解析的调用者身份（配额/审计记账用），永不信客户端。 */
  by: string
  /** ① 段用户的补充说明；空 / 缺省 = 用户跳过了确认。 */
  clarifications?: string
  /** 往轮对话（用户调整提议后重来）。服务端截断 + 清洗，只作提示上下文。 */
  history?: ReadonlyArray<WizardTurn>
  detail?: 'oneliner' | 'brief' | 'detailed'
  onChunk?: (chunk: string) => void
}

export type WizardComposeResult =
  | {
      ok: true
      yaml: string
      explanation: string
      graph?: WorkflowGraphView
      /** ④ 段结论：逐需求「谁能接 / 怎么补」。ok=false 的需求就是待用户批准的缺口。 */
      gapAnalysis: GapAnalysis
      gapText: string
      /** 缺口补法里去重后的模板 ref——入口层直接渲染「装这几个模板」的批准按钮。 */
      installTemplateRefs: string[]
      /** R1 实际用掉的修复轮数（0 = 一把过）。 */
      repairRounds: number
      /** advisory 深检透传（unknown_* 对草稿不挡路，但界面要能展示）。 */
      deepCheck?: WizardDeepCheckView
    }
  | {
      ok: false
      /**
       * needs_user — 模型没出 YAML（在反问 / 拒绝），explanation 是它想问的话；
       * exhausted — 修满上限仍有机器级错误，errorsText 是最后一轮的错误渲染；
       * assistant_unavailable — assist 面抛了（没 key / 派发失败）。
       */
      reason: 'needs_user' | 'exhausted' | 'assistant_unavailable'
      explanation?: string
      errorsText?: string
      lastYaml?: string
      repairRounds: number
      detail?: string
    }

// ── service ─────────────────────────────────────────────────────────────────

/** saveDraft 硬闸同款四种——机器必须修掉，任何写路径都过不去。 */
const HARD_VIOLATION_KINDS: ReadonlySet<string> = new Set([
  'bad_ref',
  'forward_ref',
  'self_trigger_cycle',
  'id_collision',
])

const MAX_HISTORY_TURNS = 6
const MAX_TURN_CHARS = 2000

export class WorkflowWizardService {
  constructor(private readonly deps: WorkflowWizardDeps) {}

  /** ①+②：零 LLM 即时返回（clarify 接了才多一问，失败静默降级）。 */
  async prepare(req: { task: string; by: string }): Promise<WizardPrepareResult> {
    const catalog = await this.deps.catalog()
    const catalogText = renderCatalogForPrompt(catalog)
    let questions: string[] = []
    if (this.deps.clarify) {
      try {
        questions = (await this.deps.clarify({ task: req.task, catalogText, by: req.by })).questions
      } catch {
        questions = [] // ① 可跳过——澄清失败绝不挡流程
      }
    }
    const confirmText = [
      `准备为你搭工作流：「${req.task}」`,
      '',
      catalogText,
      '',
      ...(questions.length > 0 ? ['先确认几个问题（也可以不答直接开始）：', ...questions.map((q, i) => `  ${i + 1}. ${q}`), ''] : []),
      '（有补充说明请回复；直接开始可跳过这一步）',
    ].join('\n')
    return { task: req.task, catalog, catalogText, questions, confirmText }
  }

  /** ③–⑥：组装 → 缺口衡量 → R1 有界修复 → 提议或如实交还。 */
  async compose(req: WizardComposeRequest): Promise<WizardComposeResult> {
    const catalog = await this.deps.catalog()
    const catalogText = renderCatalogForPrompt(catalog)
    const existingIds = this.deps.existingWorkflowIds ? await this.deps.existingWorkflowIds() : []
    const maxRounds = this.deps.maxRepairRounds ?? 2
    const basePrompt = composeWizardPrompt(req.task, req.clarifications, catalogText, req.history)
    const contextHints = contextHintsFromCatalog(catalog, existingIds)

    let repairRounds = 0
    // 每轮把上一版 YAML + 渲染好的修复指令拼在 base prompt 后重问；轮间不共享
    // LLM 会话（assist 面本就是单任务无状态），所以指令必须自足。
    let repairSuffix = ''
    let lastYaml = ''
    let lastErrorsText = ''

    for (;;) {
      let out: WizardAssistOutput
      try {
        out = await this.deps.assist.assist({
          description: basePrompt + repairSuffix,
          mode: 'author',
          ...(req.detail ? { detail: req.detail } : {}),
          contextHints,
          by: req.by,
          ...(req.onChunk ? { onChunk: req.onChunk } : {}),
        })
      } catch (err) {
        return {
          ok: false,
          reason: 'assistant_unavailable',
          repairRounds,
          detail: err instanceof Error ? err.message : String(err),
        }
      }

      // no_yaml = 模型在反问 / 拒绝——这不是机器错误，是对话，交还给用户。
      if (out.draftStatus === 'no_yaml') {
        return { ok: false, reason: 'needs_user', explanation: out.explanation, repairRounds }
      }

      const verdict = triageDraft(out, catalog)
      if (verdict.kind === 'green') {
        const gapAnalysis = verdict.gapAnalysis
        return {
          ok: true,
          yaml: out.yaml,
          explanation: out.explanation,
          ...(out.graph ? { graph: out.graph } : {}),
          gapAnalysis,
          gapText: renderGapAnalysis(gapAnalysis),
          installTemplateRefs: distillInstallRefs(gapAnalysis),
          repairRounds,
          ...(out.deepCheck ? { deepCheck: out.deepCheck } : {}),
        }
      }

      lastYaml = out.yaml
      lastErrorsText = verdict.instruction
      if (repairRounds >= maxRounds) {
        return {
          ok: false,
          reason: 'exhausted',
          errorsText: lastErrorsText,
          ...(lastYaml ? { lastYaml } : {}),
          repairRounds,
        }
      }
      repairRounds += 1
      repairSuffix = [
        '',
        '',
        '── 你上一版的输出没通过校验 ──',
        ...(out.yaml ? ['上一版 YAML：', '```yaml', out.yaml, '```'] : []),
        verdict.instruction,
        '逐条修复以上问题，然后输出修正后的**完整** YAML（不要只贴差异）。',
      ].join('\n')
    }
  }
}

// ── 判定（修复 vs 缺口的分诊） ──────────────────────────────────────────────

type Triage =
  | { kind: 'green'; gapAnalysis: GapAnalysis }
  | { kind: 'repair'; instruction: string }

function triageDraft(out: WizardAssistOutput, catalog: ReadonlyArray<ComponentEntry>): Triage {
  // 解析失败：解析器的报错本身就是最精准的修复指令，原文引用。
  if (out.draftStatus === 'invalid') {
    return {
      kind: 'repair',
      instruction: `解析器拒绝了这版 YAML：${out.validationError ?? '(无详细信息)'}`,
    }
  }

  const problems: string[] = []

  // HARD 结构违规：saveDraft 硬闸同款，机器必须修。深检由 assist 面按
  // contextHints 现算；缺席时跳过（落盘硬闸仍会兜底，不在这重造检查器）。
  for (const v of out.deepCheck?.violations ?? []) {
    if (HARD_VIOLATION_KINDS.has(v.kind)) problems.push(renderHardViolation(v))
  }

  // 近失命名：能力 / 参与者在目录里几乎同名 → 疑似拼错 / 自造，改名而非报缺。
  let def: WorkflowDefinition | undefined
  try {
    def = parseWorkflow(out.yaml)
  } catch {
    def = undefined // draftStatus==='valid' 理应能解析；防御性兜底交给 HARD 检查
  }
  let gapAnalysis: GapAnalysis = { ok: true, needs: [] }
  if (def) {
    gapAnalysis = analyzeWorkflowGaps(def, catalog)
    problems.push(...nearMissProblems(gapAnalysis, catalog))
  }

  if (problems.length > 0) {
    return { kind: 'repair', instruction: problems.map((p, i) => `${i + 1}. ${p}`).join('\n') }
  }
  // 剩下的不满足需求都是真缺口（目录里真没有）——不修复，随提议交用户决定。
  return { kind: 'green', gapAnalysis }
}

function renderHardViolation(v: { kind: string; message: string; path: string }): string {
  const fix: Record<string, string> = {
    bad_ref: '引用了不存在的步骤输出——$ref 只能指向已声明的步骤 id',
    forward_ref: '引用了排在后面的步骤——只能引用更早步骤的输出，必要时调整步骤顺序',
    self_trigger_cycle: '有步骤派回了本工作流自己的触发能力，会无限自触发——换一个能力或删掉这步',
    id_collision: '步骤 / 分支 id 重复——每个 id 必须唯一',
  }
  return `${v.message}（${v.path}）。${fix[v.kind] ?? ''}`
}

/**
 * 把「近失」需求渲染成改名指令。近失 = 所缺的名字和目录里某个已装名几乎一样
 * （编辑距离 ≤ 2 / 大小写差 / 包含）；真缺（目录里连近似都没有）不进这里。
 */
function nearMissProblems(analysis: GapAnalysis, catalog: ReadonlyArray<ComponentEntry>): string[] {
  const installedCaps = [...installedCapabilities(catalog)].sort()
  const doerIds = catalog
    .filter((e) => e.status === 'installed' && (e.kind === 'human' || e.kind === 'agent'))
    .map((e) => e.id)
  const out: string[] = []
  for (const n of analysis.needs) {
    if (n.satisfied) continue
    if (n.need.kind === 'explicit') {
      const near = nearestNames(n.need.to!, doerIds)
      if (near.length > 0) {
        out.push(
          `步骤 ${n.need.at} 点名的参与者「${n.need.to}」不存在——最接近的已注册参与者是 ${near.map((s) => `「${s}」`).join(' / ')}，用目录里的原名`,
        )
      }
      continue
    }
    for (const cap of capsMissingEverywhere(n.need, catalog)) {
      const near = nearestNames(cap, installedCaps)
      if (near.length > 0) {
        out.push(
          `步骤 ${n.need.at} 用的能力「${cap}」不存在——目录里最接近的是 ${near.map((s) => `「${s}」`).join(' / ')}，能力名必须逐字来自目录，不要自造`,
        )
      }
    }
  }
  return out
}

/** 这个需求里「目录任何地方（含预置模板）都没有」的能力——只有这种才可能是近失。 */
function capsMissingEverywhere(need: WorkflowNeed, catalog: ReadonlyArray<ComponentEntry>): string[] {
  const anywhere = installedCapabilities(catalog)
  for (const e of catalog) {
    if (e.kind !== 'template') continue
    for (const a of e.providesAgents ?? []) for (const c of a.capabilities) anywhere.add(c)
  }
  return (need.capabilities ?? []).filter((c) => !anywhere.has(c))
}

/**
 * 近失判定 + 建议：大小写差 / 编辑距离 ≤ 2 / 一方包含另一方（≥3 字符）。
 * 返回按接近程度排序的至多 3 个候选；空数组 = 不是近失（是真缺口）。
 */
export function nearestNames(target: string, candidates: ReadonlyArray<string>, max = 3): string[] {
  const t = target.toLowerCase()
  const scored: Array<{ name: string; score: number }> = []
  for (const c of candidates) {
    const cl = c.toLowerCase()
    if (cl === t) {
      scored.push({ name: c, score: 0 }) // 只差大小写
      continue
    }
    const containment = (cl.includes(t) || t.includes(cl)) && Math.min(cl.length, t.length) >= 3
    const dist = levenshteinCapped(t, cl, 2)
    if (dist !== null) scored.push({ name: c, score: dist })
    else if (containment) scored.push({ name: c, score: 3 })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((s) => s.name)
}

/** 编辑距离，超过 cap 提前返回 null（候选集小、串短，O(n·m) 足够）。 */
function levenshteinCapped(a: string, b: string, cap: number): number | null {
  if (Math.abs(a.length - b.length) > cap) return null
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
      if (cur[j]! < rowMin) rowMin = cur[j]!
    }
    if (rowMin > cap) return null
    prev = cur
  }
  return prev[b.length]! <= cap ? prev[b.length]! : null
}

// ── prompt 组装 ─────────────────────────────────────────────────────────────

/**
 * ③ 段的组装 prompt：任务 + 补充 + 完整目录 + 组装规则 + 往轮对话。规则把
 * 「优先已装、预置要说明、人也是组件」写死在 prompt 里——这是向导对弱模型的
 * 主要扶手：词表就在眼前，不需要模型脑补 hub 里有什么。
 */
export function composeWizardPrompt(
  task: string,
  clarifications: string | undefined,
  catalogText: string,
  history: ReadonlyArray<WizardTurn> | undefined,
): string {
  const lines: string[] = [
    '你要为用户组装一个工作流。',
    '',
    '【任务】',
    task,
  ]
  if (clarifications && clarifications.trim().length > 0) {
    lines.push('', '【用户补充】', clarifications.trim())
  }
  lines.push(
    '',
    '【组件目录 —— 只能用这里列出的东西】',
    catalogText,
    '',
    '【组装规则】',
    '1. 能力名 / 参与者 id 必须逐字来自目录，不要自造。',
    '2. 优先用「已有组件」；确实覆盖不了时才用「预置组件」节里的能力，并在讲解里说明那需要用户批准安装。',
    '3. 人也是组件：需要审批 / 拍板的环节用 human 步派给成员。',
    '4. 步骤 id 全部唯一；只引用更早步骤的输出。',
  )
  const turns = sanitizeTurns(history)
  if (turns.length > 0) {
    lines.push('', '【之前的来回】')
    for (const t of turns) {
      const tag = t.role === 'user' ? '用户' : '助手'
      lines.push(`${tag}${t.failed ? '（这版被用户否了，不要原样重来）' : ''}：${t.text}`)
    }
  }
  return lines.join('\n')
}

/** 截断 + 清洗客户端携带的对话（advisory 上下文，防 prompt 无界膨胀）。 */
function sanitizeTurns(history: ReadonlyArray<WizardTurn> | undefined): WizardTurn[] {
  if (!history) return []
  return history
    .filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.trim().length > 0)
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({
      role: t.role,
      text: t.text.length > MAX_TURN_CHARS ? `${t.text.slice(0, MAX_TURN_CHARS)}…（截断）` : t.text,
      ...(t.failed ? { failed: true as const } : {}),
    }))
}

/** 目录 → assist contextHints（人和 agent 同列——人也是可派活的参与者）。 */
function contextHintsFromCatalog(
  catalog: ReadonlyArray<ComponentEntry>,
  existingWorkflowIds: ReadonlyArray<string>,
): NonNullable<Parameters<WizardAssistView['assist']>[0]['contextHints']> {
  const agents = catalog
    .filter((e) => e.status === 'installed' && (e.kind === 'human' || e.kind === 'agent'))
    .map((e) => ({
      id: e.id,
      capabilities: [...(e.capabilities ?? [])],
      ...(e.description ? { description: e.description } : {}),
    }))
  const mcpServers = catalog.filter((e) => e.kind === 'mcp').map((e) => e.id)
  return {
    agents,
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(existingWorkflowIds.length > 0 ? { existingWorkflowIds: [...existingWorkflowIds] } : {}),
  }
}

/** 缺口补法里的模板 ref 去重（入口层的「装这几个模板」批准按钮直接用）。 */
function distillInstallRefs(analysis: GapAnalysis): string[] {
  const refs = new Set<string>()
  for (const n of analysis.needs) {
    for (const p of n.proposals ?? []) {
      if (p.kind === 'install_template') refs.add(p.ref)
    }
  }
  return [...refs].sort()
}
