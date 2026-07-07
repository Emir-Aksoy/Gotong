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
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Logger } from '@gotong/core'

import type { AdminHealthSurface, HealthSnapshot } from './admin-health.js'
import { translateLlmFailureKind } from './failure-translator.js'
import { readOutageSnapshotFile, type LlmOutageSnapshot } from './llm-outage.js'
import { readButlerRunBroadcastConfig } from './personal-butler-run-broadcast.js'

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
    fact: `管家大脑已经断供约 ${mins} 分钟(${t.headline})——不是临时抖动了,查查 provider 状态 / key / 额度。命令面(/help /agents /workflow)仍照常。`,
  }
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
}

function emptyState(): PatrolState {
  return { cards: {} }
}

async function loadPatrolState(file: string): Promise<PatrolState> {
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
    return { cards }
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
      const currentAll = escalation ? [...current, escalation] : current
      const prev = await loadPatrolState(this.stateFile)
      const { appeared, recovered } = diffPatrolCards(prev.cards, currentAll)

      // 无边沿:静默把 severity/label 漂移写回(一张牌一场事,不重播)。
      const nextCards: Record<string, StoredCard> = {}
      for (const c of currentAll) {
        nextCards[c.id] = {
          severity: c.severity,
          label: c.label,
          since: prev.cards[c.id]?.since ?? this.now(),
        }
      }
      await this.saveState({ cards: nextCards })

      // CARE-M6 — 断供牌的**恢复**交给 CARE-M2/M5 的即时「✅ 恢复了」:断供文件
      // 只被 onProviderSuccess 清,而它清时必播恢复,巡检再播一次恒冗余(还晚一个
      // 节律)。这里静默过滤它的恢复文案;状态照常 diff/落盘,bookkeeping 不变。
      // (升级牌的**出现**照常播——那正是升级的价值。)
      const recoveredSpoken = recovered.filter((c) => c.id !== OUTAGE_CARD_ID)
      if (appeared.length === 0 && recoveredSpoken.length === 0) return

      const messages: string[] = []
      if (appeared.length > 0) messages.push(patrolAppearMessage(appeared))
      if (recoveredSpoken.length > 0) messages.push(patrolRecoverMessage(recoveredSpoken))
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
