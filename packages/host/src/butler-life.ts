/**
 * butler-life.ts — LIFE。生活档案的宿主侧三件:驾驶舱卡、稳定段拼卡、后台扫描。
 *
 *   buildButlerLifeCockpitCard  稳定段常驻卡(紧跟知识库索引卡);没有登记表 → null
 *   composeStableCards          把几张稳定段卡拼成一个 provider(注入点仍唯一)
 *   ButlerLifeSweeper           每 15 分钟:重算派生状态 / 每晚心境签到 /
 *                               新出现的推送型提醒 / 周一的周回顾
 *
 * # 零模型
 *
 * 扫描里没有一次模型调用:签到是模板句,提醒文本来自模板规则,周回顾是代码算的
 * 事实汇总(条数、均值、预算、临期事项)。判断留给成员开口时的那一轮——数由代码
 * 算、判断由模型做,后台只负责「到点把事实摆出来」。
 *
 * # 推送
 *
 * 推送走 `armButlerSweeps` 交来的 push,也就是推送闸之后的那个:签到在 21 点
 * (免打扰从 22 点开始),错过窗口就不补(半夜补一句「今晚怎么样」是打扰);
 * 提醒与周回顾若撞上免打扰,由闸暂存到早上。每条推送型提醒按稳定 id 只推一次。
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Logger } from '@gotong/core'
import {
  LIFE_DOMAIN_TEMPLATES,
  lifeAddDays,
  lifeIsoWeekLabel,
  lifeLocalHour,
  lifeLocalTime,
  lifeWeekStart,
  openLifeArchive,
  queryLifeRecords,
  renderLifeCockpit,
  resolveActiveLifeRecords,
  type LifeArchive,
  type LifeCheckinState,
  type LifeRegistry,
  type LifeState,
} from '@gotong/personal-butler'
import { assertSafeOwnerId } from '@gotong/services-sdk'

import type { ButlerBriefPush } from './personal-butler-proactive.js'

export const LIFE_SWEEP_INTERVAL_MS = 15 * 60 * 1000
/** 签到窗口的上沿:免打扰开始前停止(与推送闸同一个 22 点)。 */
const CHECKIN_LAST_HOUR = 21
/** 周回顾:周一几点后发。 */
const REVIEW_HOUR = 9
const MAX_ALERT_IDS = 300

export const LIFE_CHECKIN_TEXT =
  '今天过得怎么样?方便的话打个分:情绪、压力、精力各 1–10,随口一句也行;不想说就跳过。'

/** `life/push-state.json`:扫描器自己的记账,驾驶舱卡读其中的签到时刻。 */
export interface LifePushState {
  checkin?: LifeCheckinState
  alertsSent?: string[]
  reviewWeek?: string
}

const pushStateFile = (archive: LifeArchive) => join(archive.dir, 'push-state.json')

export async function readLifePushState(archive: LifeArchive): Promise<LifePushState> {
  try {
    const raw = JSON.parse(await readFile(pushStateFile(archive), 'utf8')) as LifePushState
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

async function writeLifePushState(archive: LifeArchive, state: LifePushState): Promise<void> {
  const file = pushStateFile(archive)
  await mkdir(archive.dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

export interface ButlerLifeCockpitCardOptions {
  archive: LifeArchive
  logger?: { warn?: (msg: string, meta?: Record<string, unknown>) => void }
}

/**
 * 稳定段卡 provider。派生状态是昨天算的(日期翻了)就先重算一次,保证卡上的
 * 「截至」与提醒是今天的;其余时候只读盘,字节随盘上状态确定。
 */
export function buildButlerLifeCockpitCard(opts: ButlerLifeCockpitCardOptions): () => Promise<string | null> {
  let warned = false
  return async () => {
    try {
      const registry = await opts.archive.readRegistry()
      if (!registry) return null
      let state = await opts.archive.readState()
      if (!state || state.today !== opts.archive.today()) state = await opts.archive.recomputeState()
      const push = await readLifePushState(opts.archive)
      return renderLifeCockpit(registry, state, push.checkin)
    } catch (err) {
      if (!warned) {
        warned = true
        opts.logger?.warn?.('butler life cockpit card degraded to none', { err: String(err) })
      }
      return null
    }
  }
}

/** 几张稳定段卡拼成一张:各自 null 就跳过,单张失败不拖累其他,全空 → null。 */
export function composeStableCards(
  ...providers: ReadonlyArray<() => Promise<string | null>>
): () => Promise<string | null> {
  return async () => {
    const parts: string[] = []
    for (const p of providers) {
      try {
        const t = await p()
        if (t) parts.push(t)
      } catch {
        // 稳定段卡是顾问:一张坏了,其余照常
      }
    }
    return parts.length ? parts.join('\n\n') : null
  }
}

// ─── 周回顾(代码算的事实) ───────────────────────────────────────────────────

/** 上一个完整周(周一~周日)的事实汇总;没有任何记录 → null(不发空回顾)。 */
export async function buildLifeWeeklyReview(
  archive: LifeArchive,
  registry: LifeRegistry,
  today: string,
): Promise<{ week: string; markdown: string; message: string } | null> {
  const from = lifeAddDays(lifeWeekStart(today), -7)
  const to = lifeAddDays(from, 6)
  const week = lifeIsoWeekLabel(from)
  const sections: string[] = []
  const brief: string[] = []
  for (const domain of LIFE_DOMAIN_TEMPLATES) {
    if (!registry.domains.includes(domain.id)) continue
    const snap = await archive.snapshot(domain.id)
    const lines: string[] = []
    let total = 0
    for (const s of domain.streams) {
      const active = resolveActiveLifeRecords(await archive.readRecords(`${domain.id}.${s.id}`), s)
      const n = queryLifeRecords(active, s, { agg: 'count', from, to }).value ?? 0
      total += n
      if (n > 0) lines.push(`- ${s.label}:${n} 条`)
    }
    if (total === 0 && snap.alerts.length === 0) continue
    const status = snap.statusLines.map((l) => `- ${l}`)
    const alerts = snap.alerts.map((a) => `- ${a.text}`)
    sections.push(
      [`## ${domain.label}`, '', ...lines, ...(status.length ? ['', '现状:', ...status] : []), ...(alerts.length ? ['', '提醒:', ...alerts] : [])].join('\n'),
    )
    const head = snap.statusLines.slice(0, 2).join(';')
    brief.push(`· ${domain.label}:本周记了 ${total} 条${head ? `;${head}` : ''}${snap.alerts.length ? `;${snap.alerts.length} 条提醒` : ''}`)
  }
  if (sections.length === 0) return null
  const markdown = [
    '---',
    'generated: true',
    `week: ${week}`,
    '---',
    `# 周回顾 ${week}(${from} ~ ${to})`,
    '',
    '> 自动生成的事实汇总:数字由代码计算,判断留给对话。',
    '',
    ...sections.flatMap((s) => [s, '']),
  ].join('\n')
  const message = [`上周(${from.slice(5)} ~ ${to.slice(5)})的生活档案小结:`, ...brief, '想细看哪一块,跟我说一声。'].join('\n')
  return { week, markdown, message }
}

// ─── 扫描器 ──────────────────────────────────────────────────────────────────

export interface ButlerLifeSweeperOptions {
  /** `<space>/butler/memory`;每成员档案在 `user/<id>/life/`。 */
  memoryRoot: string
  push: ButlerBriefPush
  logger: Logger
  intervalMs?: number
  now?: () => number
  timeZone?: string
  /** 签到窗口用的成员本地钟。缺省 = 档案时区;生产传免打扰闸的钟(两者口径一致,
   *  服务器不在 +8 时签到也不会落进免打扰段被丢)。 */
  memberClock?: (ms: number) => { hour: number; time: string }
}

export class ButlerLifeSweeper {
  private readonly opts: ButlerLifeSweeperOptions
  private readonly intervalMs: number
  private readonly now: () => number
  private timer?: ReturnType<typeof setInterval>
  private running = false

  constructor(opts: ButlerLifeSweeperOptions) {
    this.opts = opts
    this.intervalMs = opts.intervalMs ?? LIFE_SWEEP_INTERVAL_MS
    this.now = opts.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) =>
        this.opts.logger.warn('butler life: tick failed', { err: err instanceof Error ? err.message : String(err) }),
      )
    }, this.intervalMs)
    this.timer.unref?.()
    // 与其余扫描器同一口径:启动日志是部署后确认它挂上的唯一凭据(签到要到晚上才看得见)。
    this.opts.logger.info('butler life sweep armed', { intervalMs: this.intervalMs, rootDir: this.opts.memoryRoot })
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      let ids: string[]
      try {
        ids = await readdir(join(this.opts.memoryRoot, 'user'))
      } catch {
        return
      }
      for (const userId of ids) {
        try {
          assertSafeOwnerId(userId)
        } catch {
          continue
        }
        try {
          await this.sweepUser(userId)
        } catch (err) {
          this.opts.logger.warn('butler life: member sweep failed', { userId, err: err instanceof Error ? err.message : String(err) })
        }
      }
    } finally {
      this.running = false
    }
  }

  /** 单个成员一轮。暴露给测试。 */
  async sweepUser(userId: string): Promise<void> {
    const archive = openLifeArchive({
      dir: join(this.opts.memoryRoot, 'user', userId, 'life'),
      now: this.now,
      ...(this.opts.timeZone ? { timeZone: this.opts.timeZone } : {}),
      logger: this.opts.logger,
    })
    const registry = await archive.readRegistry()
    if (!registry) return
    const state = await archive.recomputeState()
    const ps = await readLifePushState(archive)
    let next: LifePushState = { ...ps }
    const clock = this.opts.memberClock?.(this.now()) ?? {
      hour: lifeLocalHour(this.now(), archive.timeZone),
      time: lifeLocalTime(this.now(), archive.timeZone),
    }

    const checkin = await this.maybeCheckin(userId, registry, state, ps, clock.hour)
    if (checkin) {
      next = {
        ...next,
        checkin: { lastSentDate: state.today, lastSentTime: clock.time, ...(checkin === 'queued' ? { undelivered: true } : {}) },
      }
    }

    if (registry.push.alerts) {
      const sent = new Set(ps.alertsSent ?? [])
      const fresh = LIFE_DOMAIN_TEMPLATES.flatMap((d) =>
        registry.domains.includes(d.id)
          ? (state.domains[d.id]?.alerts ?? []).filter((a) => a.push && !sent.has(a.id)).map((a) => ({ d, a }))
          : [],
      )
      if (fresh.length > 0) {
        const text =
          fresh.length === 1
            ? `【${fresh[0]!.d.label}】${fresh[0]!.a.text}`
            : ['生活档案有几件事提醒你:', ...fresh.map(({ d, a }) => `· 【${d.label}】${a.text}`)].join('\n')
        // 交出即记:底层 outbox 已把失败落盘待重投,再按 15 分钟重推只会在队列里攒重复。
        await this.opts.push(userId, text)
        next = { ...next, alertsSent: [...(ps.alertsSent ?? []), ...fresh.map(({ a }) => a.id)].slice(-MAX_ALERT_IDS) }
      }
    }

    const lastWeek = lifeIsoWeekLabel(lifeAddDays(lifeWeekStart(state.today), -7))
    const isMonday = new Date(`${state.today}T00:00:00Z`).getUTCDay() === 1
    if (registry.push.review && isMonday && clock.hour >= REVIEW_HOUR && ps.reviewWeek !== lastWeek) {
      const review = await buildLifeWeeklyReview(archive, registry, state.today)
      if (!review) {
        next = { ...next, reviewWeek: lastWeek } // 上周一条记录都没有:不发空回顾,也不再每轮重算
      } else {
        await archive.writeDerived(`reviews/${review.week}.md`, review.markdown)
        await this.opts.push(userId, review.message)
        next = { ...next, reviewWeek: review.week }
      }
    }

    if (JSON.stringify(next) !== JSON.stringify(ps)) await writeLifePushState(archive, next)
  }

  private async maybeCheckin(
    userId: string,
    registry: LifeRegistry,
    state: LifeState,
    ps: LifePushState,
    hour: number,
  ): Promise<'sent' | 'queued' | false> {
    const c = registry.checkin.mind
    if (!c.enabled || !registry.domains.includes('mind')) return false
    if (hour < c.hour || hour > CHECKIN_LAST_HOUR) return false
    if (ps.checkin?.lastSentDate === state.today) return false
    // 今天已经记过心境,就不必再问
    if (state.domains.mind?.lastAt === state.today) return false
    // 签到过时即无意义:免打扰/当日上限下直接丢弃(dropped_*),不记「已发」,窗口内下一轮再试。
    // 投递失败已由 outbox 排队待重投:记为今天已交出(不重推,否则重复),但标「未送达」,
    // 驾驶舱卡不说「已发出」——成员没看到的签到,不能让阿同把之后的话当成回答。
    const res = await this.opts.push(userId, LIFE_CHECKIN_TEXT, { dropIfDeferred: true })
    if (!res || res.delivered) return 'sent'
    if (res.reason?.startsWith('dropped_') || res.reason === 'defer_failed') return false
    return 'queued'
  }
}
