/**
 * personal-butler-patrol.ts — CARE-M3 主动巡检:管家的值班表。
 *
 * BE-M1/M2 给了管家「被问才看」的眼睛;CARE-M2 让断供时不失联。这块补
 * 最后一环:**没人问也有人看着**——后台每 10 分钟跑一遍 admin-health 的
 * 纯判定,与上次的牌面 diff,只在**边沿**说话:
 *
 *   - 新出现的黄/红牌 → 推一条「事实一句 + 回『为什么』我展开」;
 *   - 之前的牌消失   → 推一条恢复;
 *   - 牌面没变       → 一个字不说(不修不重播,值班不是唠叨)。
 *
 * ── 为什么零 LLM ─────────────────────────────────────────────────────
 * 播报是事实转述(与 BE-M5 run 播报、CARE-M2 断供播报同姿态):牌面来自
 * host 亲证的体检快照,文案是确定性模板。本模块**结构上不认识任何
 * provider**——用户回「为什么」才进管家正常的 LLM 回合(管家的眼睛读的
 * 是同一份体检,无新工具)。断供期间巡检照常工作,这正是它的价值时刻。
 *
 * ── 牌怎么来 ─────────────────────────────────────────────────────────
 * {@link derivePatrolCards} 把 HealthSnapshot 折成有 id 的牌,判据与
 * admin 面板同源:空间不可写=红(host 亲证的硬故障);缺 key / IM 通道
 * 全无 / MCP 未接线 / 连接器槽位未接=黄(advisory,honesty ladder 同
 * FDE-M1b——第三方声明升不了红)。`imBridges` 缺席(host 没接 IM 子系
 * 统)≠ 空数组:缺席是「不知道」,不发牌——诚实的未知不制造焦虑。
 *
 * ── 状态与边沿 ───────────────────────────────────────────────────────
 * `butler/patrol-state.json` 存上次牌面(id → {severity, label, since});
 * 损坏当空(大不了多播一次,绝不崩);写失败只 warn(下轮可能重播——
 * 宁重不漏)。事实措辞漂移、severity 漂移都静默更新(同 llm-outage 的
 * kind 漂移姿态):一张牌一场事,播一次。fire=attempt:状态在推送前后
 * 都会落盘,个别成员投递失败不回滚边沿(与调度 sweep 的 mark 哲学同)。
 *
 * ── 同意面 ───────────────────────────────────────────────────────────
 * 骑 BE-M5 的同一份 per-member 同意(`run-broadcast.json` enabled),
 * 枚举 `<memoryRoot>/user/*`——开了运行播报的成员才收巡检,零新旋钮、
 * 零新文件(CARE-M2 断供播报也是这份同意)。
 *
 * ── HEAL-M4 自愈台账播报 ─────────────────────────────────────────────
 * 看门狗重启/非正常停止是**事件**不是**状况**:牌面模型(出现→播,消失→播
 * 恢复)套不上一瞬即逝的事。所以走高水位标:状态文件记「播到哪条 at」
 * (ISO 字典序即时序),每轮把标以上的 watchdog-restart / watchdog-throttled /
 * unclean boot 讲一遍(clean/none boot=日常部署重启/首跑,播它们=每次发版
 * 都吵人)。**首见只立标不播**——功能上线时台账里的旧账留在面板,不倒灌
 * IM;标损坏同首见=重新基线,事件侧「宁漏不刷」与牌面侧「宁重不漏」刻意
 * 相反(牌是仍在的状况重播无害,事件倒灌历史就是刷屏)。这条播报天然是
 * **事后叙述**:hub 卡死时它自己发不出任何东西(看门狗零凭证也不会发 IM),
 * 恢复后的下一轮巡检才补告——文案全部过去时。
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Logger } from '@gotong/core'

import type { AdminHealthSurface, HealthSnapshot } from './admin-health.js'
import { translateLlmFailureKind } from './failure-translator.js'
import {
  MEMORY_FAILED_SWEEPS_THRESHOLD,
  MEMORY_STALE_MS,
  readButlerMemoryHealth,
  type ButlerMemoryHealth,
} from './butler-memory-health.js'
import { readOutageSnapshotFile, type LlmOutageSnapshot } from './llm-outage.js'
import { guideBreadcrumb } from './personal-butler-guide.js'
import { readButlerRunBroadcastConfig } from './personal-butler-run-broadcast.js'
import type { SelfHealEntry } from './self-heal-log.js'

/** 默认巡检节奏 — 10 分钟。本轮不加旋钮:要更密/更疏等真实需求出现。 */
export const BUTLER_PATROL_INTERVAL_MS = 10 * 60 * 1000

/**
 * CARE-M6 — 断供升级门槛:断供**持续**超过它,巡检才把它当一张红牌升级。
 * 区别于 CARE-M2 的即时「坏了」(用户在场那条线立刻说);这里是「没人问也
 * 有人看着」的值班视角——半小时还没好,就不是临时抖动,该运维看了。常量
 * 非旋钮(同 CARE-M2/M3/M5 零新旋钮惯例)。 */
export const OUTAGE_ESCALATION_MS = 30 * 60 * 1000

/** 一条播报里最多点名几张牌——首轮巡检可能一次冒一堆,给个涓流帽。 */
const MAX_CARDS_PER_MESSAGE = 5

/** HEAL-M4 — 自愈播报涓流帽:详述最多 3 条,其余指路面板「自愈历史」。 */
const MAX_SELF_HEAL_PER_MESSAGE = 3

export type PatrolSeverity = 'yellow' | 'red'

export interface PatrolCard {
  /** 稳定 id——同一问题跨 tick 同 id,diff 靠它认「同一张牌」。 */
  id: string
  severity: PatrolSeverity
  /** 短名词短语,恢复播报点名用(「Agent「x」缺 API key 已恢复」)。 */
  label: string
  /** 事实一句,新牌播报的正文。 */
  fact: string
}

/**
 * 体检快照 → 牌面。判据与 admin 面板同源;顺序红先黄后、同级按 id,
 * 输出稳定(diff 与断言都省心)。
 */
export function derivePatrolCards(s: HealthSnapshot): PatrolCard[] {
  const red: PatrolCard[] = []
  const yellow: PatrolCard[] = []
  if (!s.spaceWritable) {
    red.push({
      id: 'space:unwritable',
      severity: 'red',
      label: '空间目录不可写',
      fact: `空间目录写不进了(${s.spacePath})——磁盘满了或权限变了,transcript 和运行记录正在丢。`,
    })
  }
  for (const a of s.agents) {
    if (a.missingKey) {
      yellow.push({
        id: `agent-key:${a.id}`,
        severity: 'yellow',
        label: `Agent「${a.id}」缺 API key`,
        fact: `Agent「${a.id}」(${a.provider})的 API key 现在解析不到,它的回合会失败。`,
      })
    }
  }
  // imBridges 缺席 = host 没接 IM 子系统 = 「不知道」,不发牌;空数组才是事实上的零通道。
  if (s.imBridges !== undefined && s.imBridges.length === 0) {
    yellow.push({
      id: 'im:none',
      severity: 'yellow',
      label: 'IM 通道全无',
      fact: 'IM 通道一个都没挂——手机上找不到管家,只能开网页。',
    })
  }
  for (const m of s.mcpServers) {
    if (!m.wired) {
      yellow.push({
        id: `mcp-unwired:${m.name}`,
        severity: 'yellow',
        label: `MCP「${m.name}」未接线`,
        fact: `MCP 服务「${m.name}」配了但没有任何 agent 在用它。`,
      })
    }
  }
  for (const c of s.connectorSlots ?? []) {
    if (!c.filled) {
      yellow.push({
        id: `connector:${c.pack}/${c.id}`,
        severity: 'yellow',
        label: `连接器槽位「${c.id}」未接`,
        fact: `模板「${c.pack}」声明的连接器槽位「${c.id}」还没接上${c.optional ? '(可选,不接也能跑)' : ''}。`,
      })
    }
  }
  const byId = (a: PatrolCard, b: PatrolCard): number => (a.id < b.id ? -1 : 1)
  return [...red.sort(byId), ...yellow.sort(byId)]
}

/** 升级红牌的稳定 id;runOnce 追加它、恢复静默过滤它都认这个常量。 */
export const OUTAGE_CARD_ID = 'llm:outage'

/**
 * CARE-M6 — 把断供状态文件(另一模块写的事实)折成一张升级红牌。巡检借此在
 * 「没人问」的时段也盯着断供,但只在**持续**超阈值时升级——避免与 CARE-M2
 * 的即时「坏了」撞车。读的是 `{kind, since}`,never 认识任何 provider,
 * provider-blind 不变式仍成立(病名走 CARE-M1 纯翻译表)。
 * 返回 null = 无断供 / 还没到阈值,不出牌。since 在未来(时钟偏移/损坏)→
 * downMs 为负 < 阈值 → 也不出牌。
 */
export function outageEscalationCard(
  outage: LlmOutageSnapshot | null,
  now: number,
  thresholdMs: number,
): PatrolCard | null {
  if (!outage) return null
  const downMs = now - outage.since
  if (downMs < thresholdMs) return null
  const mins = Math.max(1, Math.round(downMs / 60_000))
  const t = translateLlmFailureKind(outage.kind, 'zh')
  return {
    id: OUTAGE_CARD_ID,
    severity: 'red',
    label: '管家大脑持续断供',
    fact: `管家大脑已经断供约 ${mins} 分钟(${t.headline})——不是临时抖动了,查查 provider 状态 / key / 额度。命令面(/help /agents /workflow)仍照常。${guideBreadcrumb('llm-outage', '恢复后想看完整修法')}`,
  }
}

/** 记忆维护牌的稳定 id。 */
export const MEMORY_MAINTENANCE_CARD_ID = 'memory:maintenance'

/**
 * M-HEALTH — 把记忆维护台账(另一模块写的事实)折成一张巡检牌。CARE-M6 的
 * `outageEscalationCard` 同一形状:巡检不认识维护那条链,只读它落下的事实。
 *
 * **两个触发口,同一张牌**:
 *   (a) 连续 ≥2 轮出错 —— 「一直在错」;
 *   (b) 上次干净跑成已过 48h —— 「压根没在跑了」。后者才抓得住 sweeper
 *       自己没转起来的形态(那时根本不会有新的失败记录产生)。
 *
 * **只有一档黄牌**,不设红:巡检对同一 id 只在**出现**那一刻播,severity
 * 漂移是静默写回的(「一张牌一场事,不重播」),黄→红翻面没人会知道;而红
 * 是留给 `space:unwritable` / `llm:outage` 那种「hub 现在就不工作了」的,
 * 记忆维护死掉是慢性退化,不是当场停摆。
 *
 * 台账缺席(null)→ 不出牌:那是**未知**,不是坏。一台还没扫过第一轮的
 * hub 不该自称有病(EFF-M3「读不动 ≠ 没发生」的另一面)。
 */
export function memoryMaintenanceCard(
  health: ButlerMemoryHealth | null,
  now: number,
): PatrolCard | null {
  if (!health) return null
  const failing = health.consecutiveFailedSweeps >= MEMORY_FAILED_SWEEPS_THRESHOLD
  const staleMs = health.lastOkAt === undefined ? 0 : now - health.lastOkAt
  const stale = health.lastOkAt !== undefined && staleMs > MEMORY_STALE_MS
  if (!failing && !stale) return null
  const why = failing
    ? `连续 ${health.consecutiveFailedSweeps} 轮维护出错`
    : `已经约 ${Math.max(1, Math.round(staleMs / (60 * 60 * 1000)))} 小时没有成功跑过一轮维护`
  const sample = health.lastErrors.length > 0 ? `最近一条:${health.lastErrors[0]}。` : ''
  return {
    id: MEMORY_MAINTENANCE_CARD_ID,
    severity: 'yellow',
    label: '记忆维护没在正常跑',
    fact: `记忆的后台维护(蒸馏 / 校正 / 上架)${why}。${sample}日常聊天照常,但长期记忆会停在旧样子——新说的事进不了长期档。`,
  }
}

// ---------------------------------------------------------------------------
// HEAL-M4 — 自愈台账播报的纯核(选行 + 文案),导出给单测。
// ---------------------------------------------------------------------------

/**
 * 台账里值得主动说的行:看门狗动过手(restart/throttled)与非正常停止
 * (unclean boot)。clean/none boot 结构性排除——那是部署重启/首跑的日常。
 * 高水位比较是严格 `>`(ISO 字典序即时序);两写入方跨秒落笔,同毫秒撞 at
 * 实际不可能,真撞了漏一条也只是少一句事后叙述(面板里仍在)。
 */
export function selectAnnounceableSelfHeal(
  entries: readonly SelfHealEntry[],
  announcedThrough: string,
): SelfHealEntry[] {
  return entries
    .filter(
      (e) =>
        e.at > announcedThrough &&
        (e.kind === 'watchdog-restart' ||
          e.kind === 'watchdog-throttled' ||
          (e.kind === 'boot' && e.prev === 'unclean')),
    )
    .sort((a, b) => (a.at < b.at ? -1 : 1))
}

/** ISO → 部署时区的「MM-DD HH:mm」(时区以部署环境为准,clock probe 同一立场);解析不动原样返回。 */
function fmtSelfHealAt(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 自愈播报文案 — 确定性模板零 LLM,全部过去时(事后叙述:hub 卡死期间自己
 * 发不出,恢复后才补告)。journalTail 刻意不进 IM(低信息纪律——日志尾巴在
 * 面板与 restart_history 工具里);「回『为什么』」有真实兜底:阿同的
 * restart_history 工具读的就是同一份台账。
 */
export function selfHealAnnounceMessage(rows: readonly SelfHealEntry[]): string {
  const shown = rows.slice(0, MAX_SELF_HEAL_PER_MESSAGE)
  const lines = shown.map((e) => {
    const t = fmtSelfHealAt(e.at)
    if (e.kind === 'watchdog-restart') {
      const fails = typeof e.fails === 'number' ? `连续 ${e.fails} 次不应答` : '不应答'
      return `🛠 ${t} hub 曾卡死(健康探针${fails}),看门狗已自动重启救回。`
    }
    if (e.kind === 'watchdog-throttled') {
      const n = typeof e.restartsInLastHour === 'number' ? `一小时内已重启 ${e.restartsInLastHour} 次、` : ''
      return `🔴 ${t} hub 当时反复卡死,${n}看门狗暂停了自动重启等人处理——反复挂说明重启治不了,得查根因。`
    }
    const dur =
      typeof e.downMs === 'number'
        ? e.downMs < 60_000
          ? '不到 1 分钟'
          : `约 ${Math.round(e.downMs / 60_000)} 分钟`
        : '未知时长'
    return `🛠 ${t} hub 曾非正常停止(疑似崩溃/强杀/断电),已自动恢复,停机${dur}。`
  })
  const overflow =
    rows.length > shown.length
      ? `\n……还有 ${rows.length - shown.length} 条,管理页「体检 → 自愈历史」里全都在。`
      : ''
  return `🩺 自愈记录:\n${lines.join('\n')}${overflow}\n回「为什么」我展开。`
}

// ---------------------------------------------------------------------------
// 状态文件 — 上次牌面,损坏当空。
// ---------------------------------------------------------------------------

interface StoredCard {
  severity: PatrolSeverity
  label: string
  since: number
}

interface PatrolState {
  cards: Record<string, StoredCard>
  /** HEAL-M4 — 自愈播报高水位(播到哪条 at)。undefined=从未见过台账 ⇒ 首见
   * 只立标不播;整文件损坏也回到 undefined ⇒ 重新基线(事件宁漏不刷)。 */
  selfHealAnnouncedThrough?: string
}

function emptyState(): PatrolState {
  return { cards: {} }
}

/** SEN-M1 hub-sense 探针复用同一份解析(判定/解析永不两份)——损坏当空。 */
export async function loadPatrolState(file: string): Promise<PatrolState> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return emptyState()
  }
  try {
    const v = JSON.parse(raw) as Partial<PatrolState>
    if (!v || typeof v !== 'object' || !v.cards || typeof v.cards !== 'object' || Array.isArray(v.cards)) {
      return emptyState()
    }
    const cards: Record<string, StoredCard> = {}
    for (const [id, c] of Object.entries(v.cards)) {
      if (!c || typeof c !== 'object') continue
      const cc = c as Partial<StoredCard>
      if ((cc.severity !== 'yellow' && cc.severity !== 'red') || typeof cc.label !== 'string') continue
      cards[id] = {
        severity: cc.severity,
        label: cc.label,
        since: typeof cc.since === 'number' && Number.isFinite(cc.since) ? cc.since : 0,
      }
    }
    const through = (v as Partial<PatrolState>).selfHealAnnouncedThrough
    return { cards, ...(typeof through === 'string' ? { selfHealAnnouncedThrough: through } : {}) }
  } catch {
    return emptyState() // 损坏当空 — 大不了多播一次,绝不崩
  }
}

/** 恢复牌带上自己的 id——恢复静默过滤(CARE-M6)按 id 认牌,不靠脆弱的 label 比对。 */
export type RecoveredCard = StoredCard & { id: string }

/** diff 的纯核,导出给单测:上次牌面 vs 本次,谁新来、谁走了。 */
export function diffPatrolCards(
  prev: Readonly<Record<string, StoredCard>>,
  current: readonly PatrolCard[],
): { appeared: PatrolCard[]; recovered: RecoveredCard[] } {
  const appeared = current.filter((c) => !(c.id in prev))
  const currentIds = new Set(current.map((c) => c.id))
  const recovered = Object.entries(prev)
    .filter(([id]) => !currentIds.has(id))
    .map(([id, c]) => ({ id, ...c }))
  return { appeared, recovered }
}

// ---------------------------------------------------------------------------
// 文案 — 确定性模板,零 LLM。
// ---------------------------------------------------------------------------

export function patrolAppearMessage(cards: readonly PatrolCard[]): string {
  const shown = cards.slice(0, MAX_CARDS_PER_MESSAGE)
  const lines = shown.map((c) => `${c.severity === 'red' ? '🔴' : '🟡'} ${c.fact}`)
  const overflow =
    cards.length > shown.length ? `\n……还有 ${cards.length - shown.length} 项,管理页「体检」里全都在。` : ''
  return `⚠️ 巡检发现新问题:\n${lines.join('\n')}${overflow}\n回「为什么」我展开细讲。`
}

export function patrolRecoverMessage(cards: readonly StoredCard[]): string {
  const shown = cards.slice(0, MAX_CARDS_PER_MESSAGE)
  const names = shown.map((c) => `「${c.label}」`).join('、')
  const overflow = cards.length > shown.length ? ` 等 ${cards.length} 项` : ''
  return `✅ 巡检:${names}${overflow}已恢复。`
}

// ---------------------------------------------------------------------------
// The sweeper.
// ---------------------------------------------------------------------------

/** 与 ButlerRunBroadcastPush 同形;本地声明以免模块间横向依赖。 */
export type ButlerPatrolPush = (
  userId: string,
  text: string,
) => Promise<{ delivered: boolean; reason?: string } | void>

export interface ButlerPatrolSweeperOptions {
  /** 状态文件(`<space>/butler/patrol-state.json`)。 */
  stateFile: string
  /** Butler memory root — 同意面(run-broadcast.json)按成员住在它下面。 */
  memoryRoot: string
  /**
   * 体检面,**lazy**:main.ts 在巡检 arm 之后才建 adminHealth(装配顺序),
   * 首 tick 落在一个 interval 之后,届时已就位;仍是 undefined 就安静跳过。
   */
  health: () => AdminHealthSurface | undefined
  push: ButlerPatrolPush
  logger: Logger
  /** 节奏;默认 {@link BUTLER_PATROL_INTERVAL_MS}(10 分钟)。 */
  intervalMs?: number
  /** 注入时钟(测试确定性);默认 Date.now。只喂 `since` 戳。 */
  now?: () => number
  /**
   * CARE-M6 — 断供状态文件路径(`<space>/runtime/llm-outage.json`,CARE-M2
   * 写的那份)。给了它,巡检每轮读一次新值,持续断供超阈值就升级一张红牌。
   * 缺省 → 不读、不出断供牌(纯 health 牌面,与 CARE-M3 字节一致)。
   */
  outageFile?: string
  /** 断供升级门槛;默认 {@link OUTAGE_ESCALATION_MS}(30 分钟)。 */
  outageEscalationMs?: number
  /**
   * HEAL-M4 — 自愈台账最近行(`SelfHealLog.recent`,永不抛的读者)。给了它,
   * 巡检把高水位以上的看门狗/非正常停止行事后播报一遍。缺省 → 不读不播,
   * 状态文件也不长新字段(pre-HEAL 调用点字节不变)。
   */
  selfHealRecent?: () => Promise<SelfHealEntry[]>
  /**
   * M-HEALTH — 记忆维护台账路径(`<space>/butler/memory-health.json`,
   * `ButlerMaintenanceSweeper` 写的那份)。给了它,巡检每轮读一次新值,
   * 维护持续失败 / 长期没跑成就多一张黄牌。缺省 → 不读不出牌。
   */
  memoryHealthFile?: string
}

export class ButlerPatrolSweeper {
  private readonly stateFile: string
  private readonly memoryRoot: string
  private readonly health: () => AdminHealthSurface | undefined
  private readonly push: ButlerPatrolPush
  private readonly log: Logger
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly outageFile?: string
  private readonly outageEscalationMs: number
  private readonly memoryHealthFile?: string

  private readonly selfHealRecent?: () => Promise<SelfHealEntry[]>

  private timer?: ReturnType<typeof setInterval>
  private running = false

  constructor(opts: ButlerPatrolSweeperOptions) {
    this.stateFile = opts.stateFile
    this.memoryRoot = opts.memoryRoot
    this.health = opts.health
    this.push = opts.push
    this.log = opts.logger
    this.intervalMs = opts.intervalMs ?? BUTLER_PATROL_INTERVAL_MS
    this.now = opts.now ?? Date.now
    if (opts.outageFile) this.outageFile = opts.outageFile
    this.outageEscalationMs = opts.outageEscalationMs ?? OUTAGE_ESCALATION_MS
    if (opts.selfHealRecent) this.selfHealRecent = opts.selfHealRecent
    if (opts.memoryHealthFile) this.memoryHealthFile = opts.memoryHealthFile
  }

  /** 与姊妹 sweep 同姿态:不在启动瞬间跑,首 tick 一个 interval 之后。 */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.intervalMs)
    this.timer.unref?.()
    this.log.info('butler patrol sweep armed', { intervalMs: this.intervalMs, stateFile: this.stateFile })
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 一轮巡检。测试直呼(注入时钟 = 不等 interval)。 */
  async runOnce(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const surface = this.health()
      if (!surface) return // 体检面还没接上(装配早期)——安静等下轮
      let snapshot: HealthSnapshot
      try {
        snapshot = await surface.snapshot()
      } catch (err) {
        // 体检自己病了不算牌面变化:状态不动,下轮再看。
        this.log.warn('butler patrol: health snapshot failed', {
          err: err instanceof Error ? err.message : String(err),
        })
        return
      }
      const current = derivePatrolCards(snapshot)
      // CARE-M6 — 断供升级:读断供状态文件(每轮拉最新,不借 tracker 的内存缓存),
      // 持续超阈值就多一张红牌。巡检仍 provider-blind——读的是别人写的事实。
      const escalation = this.outageFile
        ? outageEscalationCard(await readOutageSnapshotFile(this.outageFile), this.now(), this.outageEscalationMs)
        : null
      // M-HEALTH — 记忆维护牌:同样是「读别人写的事实文件」,与断供升级并列。
      const memHealth = this.memoryHealthFile
        ? memoryMaintenanceCard(await readButlerMemoryHealth(this.memoryHealthFile), this.now())
        : null
      const currentAll = [...current, ...(escalation ? [escalation] : []), ...(memHealth ? [memHealth] : [])]
      const prev = await loadPatrolState(this.stateFile)
      const { appeared, recovered } = diffPatrolCards(prev.cards, currentAll)

      // HEAL-M4 — 自愈台账:首见只立高水位不播(旧账不倒灌);之后播标以上的
      // 看门狗/非正常停止行。台账读失败 = 标不动本轮跳过,下轮再看。标推进
      // 与推送解耦(fire=attempt,同牌面姿态):零同意成员也推进——事件的
      // 存档处是面板,IM 只负责「事发后尽快告一声」,不负责补历史课。
      let selfHealMsg: string | null = null
      let selfHealThrough = prev.selfHealAnnouncedThrough
      if (this.selfHealRecent) {
        try {
          const entries = await this.selfHealRecent()
          const newest = entries.reduce<string | undefined>(
            (m, e) => (m === undefined || e.at > m ? e.at : m),
            undefined,
          )
          if (selfHealThrough === undefined) {
            selfHealThrough = newest ?? '' // 空台账也立标:此后每一行都算新
          } else {
            const rows = selectAnnounceableSelfHeal(entries, selfHealThrough)
            if (rows.length > 0) selfHealMsg = selfHealAnnounceMessage(rows)
            if (newest !== undefined && newest > selfHealThrough) selfHealThrough = newest
          }
        } catch (err) {
          this.log.warn('butler patrol: self-heal ledger read failed', {
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // 无边沿:静默把 severity/label 漂移写回(一张牌一场事,不重播)。
      const nextCards: Record<string, StoredCard> = {}
      for (const c of currentAll) {
        nextCards[c.id] = {
          severity: c.severity,
          label: c.label,
          since: prev.cards[c.id]?.since ?? this.now(),
        }
      }
      await this.saveState({
        cards: nextCards,
        ...(selfHealThrough !== undefined ? { selfHealAnnouncedThrough: selfHealThrough } : {}),
      })

      // CARE-M6 — 断供牌的**恢复**交给 CARE-M2/M5 的即时「✅ 恢复了」:断供文件
      // 只被 onProviderSuccess 清,而它清时必播恢复,巡检再播一次恒冗余(还晚一个
      // 节律)。这里静默过滤它的恢复文案;状态照常 diff/落盘,bookkeeping 不变。
      // (升级牌的**出现**照常播——那正是升级的价值。)
      const recoveredSpoken = recovered.filter((c) => c.id !== OUTAGE_CARD_ID)
      if (appeared.length === 0 && recoveredSpoken.length === 0 && !selfHealMsg) return

      const messages: string[] = []
      if (appeared.length > 0) messages.push(patrolAppearMessage(appeared))
      if (recoveredSpoken.length > 0) messages.push(patrolRecoverMessage(recoveredSpoken))
      if (selfHealMsg) messages.push(selfHealMsg)
      const reachable = await this.listConsentingUserIds()
      if (reachable.length === 0) {
        this.log.info('butler patrol: edge detected but no member opted into broadcasts', {
          appeared: appeared.length,
          recovered: recovered.length,
        })
        return
      }
      for (const userId of reachable) {
        for (const text of messages) {
          try {
            await this.push(userId, text)
          } catch (err) {
            this.log.warn('butler patrol: push failed', {
              userId,
              err: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
      this.log.info('butler patrol: edges announced', {
        appeared: appeared.length,
        recovered: recovered.length,
        members: reachable.length,
      })
    } finally {
      this.running = false
    }
  }

  private async saveState(state: PatrolState): Promise<void> {
    try {
      await mkdir(dirname(this.stateFile), { recursive: true })
      await writeFile(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch (err) {
      // 写失败宁重不漏:下轮 diff 会再报一次,好过边沿静默蒸发。
      this.log.warn('butler patrol: state write failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** BE-M5 的同意面:开了运行播报的成员才收巡检(零新旋钮/文件)。 */
  private async listConsentingUserIds(): Promise<string[]> {
    let ids: string[]
    try {
      const entries = await readdir(join(this.memoryRoot, 'user'), { withFileTypes: true })
      ids = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return []
    }
    const consenting: string[] = []
    for (const id of ids) {
      try {
        const cfg = await readButlerRunBroadcastConfig(this.memoryRoot, id)
        if (cfg?.enabled) consenting.push(id)
      } catch {
        // 单个成员的同意面读失败只影响他自己这轮
      }
    }
    return consenting
  }
}
