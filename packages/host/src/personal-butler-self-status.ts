/**
 * personal-butler-self-status.ts — SEN-M3. 阿同的自我状态一卡(benign 只读):
 * 「你现在怎么样 / 你还好吗」的答案。
 *
 * 成员今天要拼出这个答案得连问六个工具(模型链 / 体检 / 用量 / 记忆 /
 * 任务 / 备份),而阿同自己被问到时只能即兴。这张卡把六块**既有投影**
 * 折成一次只读调用——零新权威点,每块都是别处已交付面的再组合:
 *
 *   大脑     ← LSA-M1 `ButlerLlmSurface`(候选链 + 熔断健康,label 天然脱敏)
 *   断供     ← SEN-M1 同款惰性体检 getter,只读 `llmOutage` 一格(CARE-M7)
 *   累计用量 ← BE-M1 `ButlerUsageSurface`(账本聚合;**开台以来累计**,
 *              绝不冒充「今日」——账本聚合没有日界)
 *   记忆     ← S2-M1 同源 `read()` 快照,**只数条数**——记忆内容结构性
 *              不进渲染(拼图卡不是第二个隐私面)
 *   任务     ← TN-M1 本成员任务笔记本,只数 open
 *   备份     ← AFR-M7 `lastBackup()` 事实(hub 级,同 backup_status)
 *   手       ← HANDS-M2 `armButlerHands` 的结果(装了=监狱种类;没装=原因)
 *
 * ── 逐行降级,绝不整卡失效 ────────────────────────────────────────────────
 * 七块 dep 全部可选:缺席 = 该行「(未接)」;读失败 = 该行「(读取失败)」
 * + warn。一块碎片的死活永远不连累其余六行——自检卡的价值恰恰在
 * 「我看不到哪块」也是状态的一部分(honest-unknown,固定七行不跳行,
 * 与 hub_health 的问题导向跳行姿态刻意不同)。
 *
 * 复用纪律:病名翻译走 hub-sense 的 outageHeadline、成本格式走 observe 的
 * fmtCost、档位中文走 backup 的 tierLabel——判定/格式化永不两份。
 */

import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@gotong/llm'

import {
  MEMORY_FAILED_SWEEPS_THRESHOLD,
  MEMORY_STALE_MS,
  type ButlerMemoryHealth,
} from './butler-memory-health.js'
import { tierLabel, type ButlerBackupOps } from './personal-butler-backup.js'
import type { ButlerHandsStatus } from './personal-butler-hands.js'
import { outageHeadline } from './personal-butler-hub-sense.js'
import type { ButlerLlmSurface } from './personal-butler-llms.js'
import { fmtCost, type ButlerUsageSurface } from './personal-butler-observe.js'

/** 体检面的最小切片:这张卡只读 `llmOutage` 一格,别的字段结构性不声明。 */
export interface SelfStatusHealthSlice {
  snapshot(): Promise<{ llmOutage?: { kind: string; since: number } | null }>
}

/**
 * 记忆面的最小切片:只声明**计数所需**的字段——条目内容(text/摘要)不在
 * 类型里,渲染器想泄露也拿不到(与 list_peers 折 pinnedKid 同一条红线:
 * 最小投影)。
 */
export interface SelfStatusMemoryReader {
  read(userId: string): Promise<{
    profile: readonly unknown[]
    recent: readonly unknown[]
    lastDream?: { firedAt: number; promoted: number; pruned: number }
  }>
}

export interface ButlerSelfStatusDeps {
  userId: string
  /** LSA-M1 候选链投影(阿同自己的大脑)。 */
  llms?: ButlerLlmSurface
  /** SEN-M1 同款惰性 getter(host 启动早期可返回 undefined)。 */
  health?: () => SelfStatusHealthSlice | undefined
  /** BE-M1 用量账本聚合。 */
  usage?: ButlerUsageSurface
  /** S2-M1 同源记忆快照服务(HostButlerMemoryService 结构性满足)。 */
  memory?: SelfStatusMemoryReader
  /**
   * M-HEALTH — 记忆维护台账的读者(`() => readButlerMemoryHealth(file)`)。
   *
   * 为什么计数与 `lastDream` 不够:那两个数字**看起来永远是对的**——三百条
   * 长期记忆、上次蒸馏 5 天前,句子本身没撒谎,但我没有任何判据知道「5 天前」
   * 对一个 6 小时的活来说已经是坏了。判断要一个门槛,门槛住在台账里。
   * 缺席 = 不接这半句(pre-M-HEALTH 调用点逐字节不变)。
   */
  memoryHealth?: () => Promise<ButlerMemoryHealth | null>
  /** TN-M1 本成员任务笔记本(窄到只剩 list)。 */
  notebook?: { list(): Promise<ReadonlyArray<{ status: string }>> }
  /** AFR-M7 备份事实(hub 级)。 */
  backup?: Pick<ButlerBackupOps, 'lastBackup'>
  /** HANDS-M2 手装没装(hub 级事实,boot 时定)。 */
  hands?: ButlerHandsStatus
  now?: () => number
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
}

const NOT_WIRED = '(未接)'
const READ_FAILED = '(读取失败)'

const STATUS_TOOL: LlmToolDefinition = {
  name: 'my_status',
  description:
    '看你(阿同)自己当下的状态汇总:大脑模型链健不健康、有没有断供、累计用量、记忆规模与上次蒸馏、手上进行中的任务数、hub 上次备份、手(监狱工作区)装没装。成员问「你还好吗」「你现在什么状态」,或你自己怀疑状态不对劲时用它。只读自检,不改任何东西。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

/** 相对时长(向下取整):自检卡要的是量级,不是时间戳。 */
function fmtAgo(deltaMs: number): string {
  const d = Math.max(0, deltaMs)
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return `${Math.floor(d / 86_400_000)} 天前`
}

function healthWord(h: string): string {
  if (h === 'healthy') return '健康'
  if (h === 'degraded') return '降级'
  if (h === 'open') return '熔断中'
  if (h === 'half_open') return '试探恢复中'
  return h // 未知值如实印原码(与 outageHeadline 同姿态)
}

function warnRead(deps: ButlerSelfStatusDeps, part: string, err: unknown): void {
  deps.logger?.warn('butler self-status: fragment read failed', { part, err })
}

async function brainLine(deps: ButlerSelfStatusDeps): Promise<string> {
  if (!deps.llms) return NOT_WIRED
  try {
    const rows = await deps.llms.listForButler()
    if (rows.length === 0) return '还没有配置到我头上的模型'
    const primary = rows.find((r) => r.role === 'primary') ?? rows[0]!
    const name = primary.model ? `${primary.label}(${primary.model})` : primary.label
    const sick = rows.filter((r) => r.health !== 'healthy').length
    const chain =
      rows.length === 1
        ? '无备用候选'
        : sick > 0
          ? `候选链共 ${rows.length} 个,${sick} 个降级/熔断中(细节可查 list_my_llms)`
          : `候选链共 ${rows.length} 个,全部健康`
    return `主选 ${name},${healthWord(primary.health)};${chain}`
  } catch (err) {
    warnRead(deps, 'llms', err)
    return READ_FAILED
  }
}

async function outageLine(deps: ButlerSelfStatusDeps, now: number): Promise<string> {
  const surface = deps.health?.()
  if (!surface) return NOT_WIRED
  try {
    const snap = await surface.snapshot()
    // 三态如实:字段缺席 = host 没接断供监测(体检面在但这格没有),
    // 与整个体检面缺席(未接)是两回事——模型追问时该指的路不同。
    if (snap.llmOutage === undefined) return '(未接断供监测)'
    if (snap.llmOutage === null) return '无'
    const mins = Math.max(0, Math.round((now - snap.llmOutage.since) / 60_000))
    return `断供中约 ${mins} 分钟(${outageHeadline(snap.llmOutage.kind, 'zh')})`
  } catch (err) {
    warnRead(deps, 'health', err)
    return READ_FAILED
  }
}

function usageLine(deps: ButlerSelfStatusDeps): string {
  if (!deps.usage) return NOT_WIRED
  try {
    const rows = deps.usage.aggregateForUser(deps.userId)
    if (rows.length === 0) return '还没有用量记录'
    const calls = rows.reduce((a, r) => a + r.calls, 0)
    const cost = rows.reduce((a, r) => a + r.costMicros, 0)
    return `${calls} 次调用,约 ${fmtCost(cost)}`
  } catch (err) {
    warnRead(deps, 'usage', err)
    return READ_FAILED
  }
}

/**
 * M-HEALTH — 记忆行的后半句:后台维护到底还在不在跑。
 *
 * 只在**有话说**的时候出现:台账缺席(还没扫过 / 读不动)= 未知,一个字不加,
 * 绝不把「我不知道」渲染成「一切正常」也不渲染成「坏了」;干净跑成的常态
 * 同样不加——每一轮都报一句「维护正常」是噪音,记忆行的主语是记忆不是运维。
 * 读失败只 warn,绝不连累整张自检卡(与本文件其余读者同姿态)。
 */
async function maintenanceHalf(deps: ButlerSelfStatusDeps, now: number): Promise<string> {
  if (!deps.memoryHealth) return ''
  let h: ButlerMemoryHealth | null
  try {
    h = await deps.memoryHealth()
  } catch (err) {
    warnRead(deps, 'memoryHealth', err)
    return ''
  }
  if (!h) return ''
  if (h.consecutiveFailedSweeps >= MEMORY_FAILED_SWEEPS_THRESHOLD) {
    return `;⚠️ 后台维护连续 ${h.consecutiveFailedSweeps} 轮出错,长期记忆正停在旧样子`
  }
  if (h.lastOkAt !== undefined && now - h.lastOkAt > MEMORY_STALE_MS) {
    return `;⚠️ 后台维护上次跑成还是 ${fmtAgo(now - h.lastOkAt)},看着是停了`
  }
  return ''
}

async function memoryLine(deps: ButlerSelfStatusDeps, now: number): Promise<string> {
  if (!deps.memory) return NOT_WIRED
  try {
    const snap = await deps.memory.read(deps.userId)
    const base = `长期 ${snap.profile.length} 条,近期 ${snap.recent.length} 条`
    const dream = snap.lastDream
      ? `;上次蒸馏 ${fmtAgo(now - snap.lastDream.firedAt)}(提升 ${snap.lastDream.promoted} 条,封存 ${snap.lastDream.pruned} 条)`
      : ';还没跑过蒸馏'
    return base + dream + (await maintenanceHalf(deps, now))
  } catch (err) {
    warnRead(deps, 'memory', err)
    return READ_FAILED
  }
}

async function notebookLine(deps: ButlerSelfStatusDeps): Promise<string> {
  if (!deps.notebook) return NOT_WIRED
  try {
    const open = (await deps.notebook.list()).filter((t) => t.status === 'open').length
    return open === 0 ? '没有进行中的任务' : `进行中 ${open} 件`
  } catch (err) {
    warnRead(deps, 'notebook', err)
    return READ_FAILED
  }
}

function backupLine(deps: ButlerSelfStatusDeps, now: number): string {
  if (!deps.backup) return NOT_WIRED
  try {
    const fact = deps.backup.lastBackup()
    if (!fact) return '从未打过(建议至少打一份身份档)'
    return `上次 ${fmtAgo(now - fact.at)}(${tierLabel(fact.tier)})`
  } catch (err) {
    warnRead(deps, 'backup', err)
    return READ_FAILED
  }
}

/**
 * HANDS-M2 「手」行:boot 时定的 hub 级事实,不是探针——装了印监狱种类,没装印
 * 原因(hands.json 缺席 / 监狱缺席 / governed 关着),缺席=host 太老没接。
 */
function handsLine(deps: ButlerSelfStatusDeps): string {
  const h = deps.hands
  if (!h) return NOT_WIRED
  return h.armed ? `已装(${h.kind} 监狱,工作区里写/读/跑;联网命令先请你确认)` : `未装(${h.reason})`
}

/** 纯投影渲染(零 LLM 决策):七块碎片 → 固定七行自检卡。导出给测试直打。 */
export async function renderSelfStatus(deps: ButlerSelfStatusDeps): Promise<string> {
  const now = deps.now?.() ?? Date.now()
  return [
    '我的状态(阿同自检):',
    `- 大脑:${await brainLine(deps)}`,
    `- 断供:${await outageLine(deps, now)}`,
    `- 累计用量:${usageLine(deps)}`,
    `- 记忆:${await memoryLine(deps, now)}`,
    `- 手上任务:${await notebookLine(deps)}`,
    `- hub 备份:${backupLine(deps, now)}`,
    `- 手:${handsLine(deps)}`,
  ].join('\n')
}

class ButlerSelfStatusToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerSelfStatusDeps) {}

  listTools(): LlmToolDefinition[] {
    return [STATUS_TOOL]
  }

  async callTool(name: string): Promise<LlmToolCallResult> {
    if (name !== 'my_status') return text(`未知工具:${name}`, true)
    try {
      return text(await renderSelfStatus(this.deps))
    } catch (err) {
      // 逐行 catch 已兜住碎片失败;这层只防注入的 now/logger 本身出错。
      this.deps.logger?.warn('butler self-status: render failed', { err })
      return text('暂时读不到自检状态,稍后再试。', true)
    }
  }
}

/**
 * 组一张自我状态卡。所有碎片 dep 可选——工具无条件装(至少笔记本永远在),
 * 缺哪块哪行「(未接)」。
 */
export function buildButlerSelfStatusToolset(deps: ButlerSelfStatusDeps): LlmAgentToolset {
  return new ButlerSelfStatusToolset(deps)
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}
