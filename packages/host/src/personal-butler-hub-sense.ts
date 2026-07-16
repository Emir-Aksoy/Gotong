/**
 * personal-butler-hub-sense.ts — SEN-M1 hub 红灯感知。
 *
 * 阿同此前对 hub 状态的感知是**推送式**的(CARE-M3 巡检只在边沿播给开了
 * 播报的成员),自己开口前并不知道 hub 病着,被问「为什么怪怪的」只能猜。
 * 本模块补两张嘴,同一份数据源:
 *
 *   - **尾卡探针**(M1a):每轮纯读巡检落盘的牌面事实
 *     `<space>/butler/patrol-state.json`——零计算零 key 解析零网络,判定
 *     天然与巡检/面板同源(牌是 derivePatrolCards 折的,这里只转述)。
 *     无文件/损坏/空牌面/牌面陈旧 → null → prompt 字节不变(A1 同款)。
 *   - **benign `hub_health` 工具**(M1b):按需拉与管理面板同一份
 *     `AdminHealthSurface.snapshot()`(零成本静态检查,面板「每次打开都
 *     安全调」的同一契约),牌面判定复用 {@link derivePatrolCards} 绝不
 *     另写一份判据。目录层长尾(低频按需自省)。
 *
 * 披露边界:牌面细节(agent id / MCP 名 / spacePath)已由巡检推送给开了
 * 运行播报的成员——本模块的投影 ⊆ 既有披露面,零新披露。知识 ≠ 授权:
 * 两张嘴都只读,修复动作仍走 diagnose / governed 闸。
 *
 * 新鲜度诚实:探针对牌面文件设 3× 巡检节律的 mtime 门——巡检不在班时,
 * **不拿旧牌面当现状**(诚实的未知,与 imBridges 缺席≠空数组同一姿态)。
 */

import { stat } from 'node:fs/promises'

import type { Logger } from '@gotong/core'
import type { LlmAgentToolset, LlmErrorKind, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'

import type { AdminHealthSurface, HealthSnapshot } from './admin-health.js'
import { translateLlmFailureKind, type FailureLang } from './failure-translator.js'
import {
  BUTLER_PATROL_INTERVAL_MS,
  derivePatrolCards,
  loadPatrolState,
  type PatrolSeverity,
} from './personal-butler-patrol.js'

// ─── M1a 尾卡探针 ────────────────────────────────────────────────────────────

/**
 * 牌面文件的新鲜度门:mtime 落后超过 3 个巡检节律(30 分钟)= 巡检不在班,
 * 旧牌面不当现状。常量非旋钮(CARE-M3/M5 同惯例);重启后首 tick 前(≤10
 * 分钟)的短暂陈旧可接受——牌面是持续状态非事件,下一 tick 自然修正。
 */
export const PATROL_STATE_FRESH_MS = 3 * BUTLER_PATROL_INTERVAL_MS

/** 探针只需要的牌面切片(severity 排序 + label 点名)。 */
interface ProbeCard {
  severity: PatrolSeverity
  label: string
}

/**
 * 牌面 → 尾卡文本。红牌逐张点名(种类天然少:空间不可写 + 断供升级),
 * 黄牌汇总计数点前 2。**不点名任何目录工具**(指路指空原则——说人话
 * 「替他查一遍」,模型自会经 use_tool 取用)。导出给测试直打。
 */
export function buildHubSenseCard(cards: readonly ProbeCard[]): string {
  const red = cards.filter((c) => c.severity === 'red')
  const yellow = cards.filter((c) => c.severity === 'yellow')
  const lines: string[] = ['【hub 状态 · 系统注入】巡检当前牌面有问题:']
  for (const c of red) lines.push(`🔴 ${c.label}`)
  if (yellow.length > 0) {
    const named = yellow.slice(0, 2).map((c) => c.label).join('、')
    const suffix = yellow.length > 2 ? ' 等' : ''
    lines.push(`🟡 ${yellow.length} 项:${named}${suffix}`)
  }
  lines.push(
    '规则:这是 hub 级背景。成员报障或问「为什么怪怪的」时,先想想是不是这些在作怪;需要细节就替他查一遍 hub 体检(你有对应工具)。别把这卡说成用户说的话。',
  )
  return lines.join('\n')
}

export interface ButlerHubSenseProbeDeps {
  /** `<space>/butler/patrol-state.json` — 巡检落的牌面事实,探针只读。 */
  stateFile: string
  logger?: Pick<Logger, 'warn'>
  /** 注入时钟(测试新鲜度门);默认 Date.now。 */
  now?: () => number
}

/**
 * 每轮尾卡探针。一切失败路径(无文件 = 巡检没跑过或没接 / 损坏当空 /
 * 牌面陈旧 / 空牌面)→ null → 不注入 → prompt 字节不变。
 */
export function buildButlerHubSenseProbe(deps: ButlerHubSenseProbeDeps): () => Promise<string | null> {
  const now = deps.now ?? Date.now
  return async () => {
    let mtimeMs: number
    try {
      mtimeMs = (await stat(deps.stateFile)).mtimeMs
    } catch {
      return null // 没有牌面文件 = 巡检没跑过/没接——无声,不是错误
    }
    if (now() - mtimeMs > PATROL_STATE_FRESH_MS) return null // 巡检不在班,旧牌不当现状
    let cards: ProbeCard[]
    try {
      const state = await loadPatrolState(deps.stateFile)
      cards = Object.values(state.cards)
    } catch (err) {
      deps.logger?.warn('butler hub-sense: patrol state read failed — skipping injection', { err })
      return null
    }
    if (cards.length === 0) return null
    return buildHubSenseCard(cards)
  }
}

// ─── M1b benign hub_health ───────────────────────────────────────────────────

const HEALTH_TOOL: LlmToolDefinition = {
  name: 'hub_health',
  description:
    '看这台 hub 的当下体检(与管理面板同一份只读快照):问题牌面、agent 在线/缺 key、MCP 接线、IM 通道、LLM 断供与路由降级、空间可写。成员问「hub 现在正常吗」「为什么怪怪的」时用它。只读不修,修复动作走对应的诊断/管理路径。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

/** 病名安全翻译:未知 kind 如实印原码,绝不因面板 DTO 的宽 string 类型炸渲染。 */
function outageHeadline(kind: string, lang: FailureLang): string {
  try {
    return translateLlmFailureKind(kind as LlmErrorKind, lang).headline
  } catch {
    return kind
  }
}

/**
 * 纯投影渲染(零 LLM 决策):体检快照 → 中文体检卡。牌面判定复用
 * {@link derivePatrolCards}(与巡检/面板永不各说各话);断供走面板 CARE-M7
 * 的**无阈值**姿态(工具要当下真相,30 分钟阈值只属于巡检的「别刷 IM」);
 * 可选字段缺席 = 诚实的未知,整行跳过。导出给测试直打。
 */
export function renderHubHealth(s: HealthSnapshot, now: number): string {
  const cards = derivePatrolCards(s)
  const lines: string[] = ['hub 体检(与管理面板同一份快照):', '']
  if (cards.length === 0) {
    lines.push('✅ 没有问题牌。')
  } else {
    for (const c of cards) lines.push(`${c.severity === 'red' ? '🔴' : '🟡'} ${c.fact}`)
  }
  lines.push('', '总览:')
  lines.push(`- 托管 agent ${s.managedCount} 台:在线 ${s.onlineCount},缺 API key ${s.agentsMissingKey}`)
  lines.push(`- MCP 服务 ${s.mcpServers.length} 台(未接线 ${s.mcpUnwired})`)
  if (s.workflowCount !== undefined) {
    const runs = s.runCount !== undefined ? `,运行记录 ${s.runCount} 次` : ''
    lines.push(`- 工作流 ${s.workflowCount} 条(可跑 ${s.publishedWorkflowCount ?? 0})${runs}`)
  }
  if (s.imBridges !== undefined) {
    lines.push(
      s.imBridges.length === 0
        ? '- IM 通道:无(还没配)'
        : `- IM 通道:${s.imBridges.map((b) => b.platform).join('、')}`,
    )
  }
  if (s.llmOutage !== undefined) {
    if (s.llmOutage === null) {
      lines.push('- LLM 断供:无')
    } else {
      const mins = Math.max(1, Math.round((now - s.llmOutage.since) / 60_000))
      lines.push(`- LLM 断供:断供中约 ${mins} 分钟(${outageHeadline(s.llmOutage.kind, 'zh')})`)
    }
  }
  if (s.routing !== undefined) {
    lines.push(
      s.routing.length === 0
        ? '- 模型路由:全部候选健康'
        : `- 模型路由:${s.routing.length} 个候选降级/熔断中(哪台 agent 在用哪条链,可查 list_my_llms)`,
    )
  }
  lines.push(`- 空间目录:${s.spaceWritable ? '可写' : '写不进(红牌见上)'}`)
  return lines.join('\n')
}

export interface ButlerHubHealthDeps {
  /**
   * 惰性体检面(与巡检/onboarding 骑同一个 `patrolHealthRef` getter——
   * main.ts 在 factory 之后才建 adminHealth,首个 butler 任务时早已就位)。
   */
  health: () => AdminHealthSurface | undefined
  now?: () => number
  logger?: Pick<Logger, 'warn'>
}

class ButlerHubHealthToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerHubHealthDeps) {}

  listTools(): LlmToolDefinition[] {
    return [HEALTH_TOOL]
  }

  async callTool(name: string): Promise<LlmToolCallResult> {
    if (name !== HEALTH_TOOL.name) {
      return { content: [{ type: 'text', text: `未知工具:${name}` }], isError: true }
    }
    const surface = this.deps.health()
    if (!surface) {
      return {
        content: [{ type: 'text', text: 'hub 体检面还没就绪(host 启动早期),稍后再试。' }],
        isError: true,
      }
    }
    try {
      const snap = await surface.snapshot()
      return { content: [{ type: 'text', text: renderHubHealth(snap, (this.deps.now ?? Date.now)()) }] }
    } catch (err) {
      this.deps.logger?.warn('butler hub-sense: health snapshot failed', { err })
      return { content: [{ type: 'text', text: '暂时读不到 hub 体检,稍后再试。' }], isError: true }
    }
  }
}

/** benign 只读 hub 体检。hub 级事实同 backup_status:全员可读,读不出密。 */
export function buildButlerHubHealthToolset(deps: ButlerHubHealthDeps): LlmAgentToolset {
  return new ButlerHubHealthToolset(deps)
}
