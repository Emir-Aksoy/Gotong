/**
 * butler-push-gate.ts — LIFE。管家**主动**推送的免打扰闸与每日上限。
 *
 * # 为什么要这道闸
 *
 * 阿同的后台扫描(晨报、run 播报、巡检、卡壳任务提醒、备份提醒、生活档案的
 * 签到与提醒)各自判断「该说了」,却没有谁看「现在几点、今天已经说了几次」。
 * 生活档案让主动推送变多(心境签到、预算/扣款/低落提醒、周回顾),冷静的管家
 * 不在半夜两点发巡检黄牌,也不一天刷屏十几条。
 *
 * # 语义
 *
 *   - **免打扰**(成员本地 22:00–07:00,默认按 +08:00):这段时间的推送不丢、
 *     不发,而是**落盘暂存**,到 07:00 后合成一条发出(「夜间暂存的 N 条」)。
 *   - **每日上限**:一个本地日最多 N 条主动推送;超了同样暂存到次日早上,不丢。
 *     成员自己订阅的运行播报带 `capExempt`:只守免打扰,不占也不受上限——那是
 *     成员要的结果,一小时一跑的工作流不该在第 9 条之后被压到第二天,也不该把
 *     签到挤掉。
 *   - 被暂存的推送对调用方报 `{ delivered: true, reason: 'deferred_*' }`:扫描器
 *     看到「没投达」会每 tick 重试,那会在夜里攒出几十条重复——暂存本身就是
 *     「已接收、会投递」的承诺(盘上持久,重启不丢);暂存写盘失败则如实报
 *     `{ delivered: false, reason: 'defer_failed' }`,让调用方下一轮再交。
 *   - 过时即无意义的消息(心境签到)带 `dropIfDeferred`:此刻发不了就丢弃,报
 *     `{ delivered: false, reason: 'dropped_*' }`,不在第二天早上问「今天过得怎么样」。
 *   - 发出时交给底层 push(F1 pushToMember = CARE-M8 outbox.deliver:任何失败都已
 *     落盘待重投),所以本闸只负责「何时」,交出即删,不重交——重交会让 outbox 里
 *     多出一份,桥恢复后同一条消息到达多次。
 *
 * # 只闸主动推送
 *
 * 本闸只包 `armButlerSweeps` 的 push。成员自己设的提醒、审批回推、转派结果、
 * 长任务进展与失败通知不经过这里——那些是成员在等的回音,不该被免打扰压住。
 * 已知不经本闸的主动推送:CARE-M2/M5 断供与恢复播报(IM 桥内部直接投递)。
 * 它是低频运维信号,如实记在文档里。
 *
 * 有界:每成员暂存最多 MAX_QUEUE 条(超了丢最旧,大声记),超过 MAX_AGE_MS 的
 * 暂存丢弃(36 小时前的提醒多半已经过时);合并消息有字数顶,超出的明说条数。
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Logger } from '@gotong/core'
import { assertSafeOwnerId } from '@gotong/services-sdk'

import { DEFAULT_TZ_OFFSET_MIN, memberLocalNow, type ButlerBriefPush } from './personal-butler-proactive.js'

/** 免打扰开始(本地小时,含)。 */
export const QUIET_START_HOUR = 22
/** 免打扰结束(本地小时,不含):07:00 起可发。 */
export const QUIET_END_HOUR = 7
/** 每成员每本地日最多主动推送条数。 */
export const DEFAULT_DAILY_CAP = 8
/** 暂存检查节律。 */
export const PUSH_GATE_INTERVAL_MS = 5 * 60 * 1000

const MAX_QUEUE = 20
const MAX_AGE_MS = 36 * 60 * 60 * 1000
const MAX_MERGED_CHARS = 3000

interface DeferredItem {
  text: string
  /** 入闸时刻(epoch ms)。 */
  at: number
  /** 最早可发时刻(epoch ms)。 */
  notBefore: number
}

interface GateFile {
  /** 本地日期 → 当日已发条数(只留今天)。 */
  sentDate?: string
  sentCount?: number
  queue: DeferredItem[]
}

export interface ButlerPushGateOptions {
  /** `<space>/butler/push-gate` —— 每成员一个 JSON。 */
  dir: string
  push: ButlerBriefPush
  logger: Logger
  now?: () => number
  tzOffsetMinutes?: number
  dailyCap?: number
  intervalMs?: number
}

/** 本地时刻是否在免打扰段。 */
export function inQuietHours(hour: number): boolean {
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR
}

/** 下一个本地 07:00 的 epoch ms(若现在已过今天 07:00 且不在免打扰,返回 now)。 */
export function nextMorningMs(nowMs: number, tzOffsetMinutes: number, forceTomorrow = false): number {
  const shift = tzOffsetMinutes * 60_000
  const local = new Date(nowMs + shift)
  const base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), QUIET_END_HOUR) - shift
  if (forceTomorrow || local.getUTCHours() >= QUIET_END_HOUR) return base + 24 * 60 * 60 * 1000
  return base
}

export class ButlerPushGate {
  private readonly dir: string
  private readonly inner: ButlerBriefPush
  private readonly log: Logger
  private readonly now: () => number
  private readonly tz: number
  private readonly cap: number
  private readonly intervalMs: number
  private readonly locks = new Map<string, Promise<unknown>>()
  private timer?: ReturnType<typeof setInterval>

  constructor(opts: ButlerPushGateOptions) {
    this.dir = opts.dir
    this.inner = opts.push
    this.log = opts.logger
    this.now = opts.now ?? Date.now
    this.tz = opts.tzOffsetMinutes ?? DEFAULT_TZ_OFFSET_MIN
    this.cap = opts.dailyCap ?? DEFAULT_DAILY_CAP
    this.intervalMs = opts.intervalMs ?? PUSH_GATE_INTERVAL_MS
  }

  /** 闸后的 push(形状同 ButlerBriefPush,直接交给各扫描器)。 */
  readonly push: ButlerBriefPush = (userId, text, opts) =>
    this.withLock(userId, async () => {
      const now = this.now()
      const { hour, date } = memberLocalNow(now, this.tz)
      const file = await this.read(userId)
      const count = file.sentDate === date ? (file.sentCount ?? 0) : 0
      const quiet = inQuietHours(hour)
      const exempt = opts?.capExempt === true
      if (!quiet && (exempt || count < this.cap)) {
        const res = await this.inner(userId, text)
        if (res && res.delivered && !exempt) await this.write(userId, { ...file, sentDate: date, sentCount: count + 1 })
        return res
      }
      if (opts?.dropIfDeferred) {
        const reason = quiet ? 'dropped_quiet' : 'dropped_cap'
        this.log.info('butler push-gate: dropped', { userId, reason })
        return { delivered: false, reason }
      }
      const notBefore = quiet ? nextMorningMs(now, this.tz) : nextMorningMs(now, this.tz, true)
      const queue = [...file.queue, { text, at: now, notBefore }]
      const overflow = queue.length - MAX_QUEUE
      if (overflow > 0) {
        queue.splice(0, overflow)
        this.log.warn('butler push-gate: deferred queue full, dropped oldest', { userId, dropped: overflow })
      }
      if (!(await this.write(userId, { ...file, queue }))) return { delivered: false, reason: 'defer_failed' }
      const reason = quiet ? 'deferred_quiet' : 'deferred_cap'
      this.log.info('butler push-gate: deferred', { userId, reason, queued: queue.length })
      return { delivered: true, reason }
    })

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.flushDue().catch((err) =>
        this.log.warn('butler push-gate: flush failed', { err: err instanceof Error ? err.message : String(err) }),
      )
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 把到点的暂存合成一条发出(全部成员)。 */
  async flushDue(): Promise<void> {
    let files: string[]
    try {
      files = await readdir(this.dir)
    } catch {
      return
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const userId = f.slice(0, -'.json'.length)
      try {
        assertSafeOwnerId(userId)
      } catch {
        continue
      }
      await this.flushUser(userId)
    }
  }

  async flushUser(userId: string): Promise<void> {
    await this.withLock(userId, async () => {
      const now = this.now()
      const { hour, date } = memberLocalNow(now, this.tz)
      if (inQuietHours(hour)) return
      const file = await this.read(userId)
      if (file.queue.length === 0) return
      const fresh = file.queue.filter((it) => now - it.at <= MAX_AGE_MS)
      if (fresh.length < file.queue.length) {
        this.log.info('butler push-gate: dropped expired', { userId, expired: file.queue.length - fresh.length })
      }
      const due = fresh.filter((it) => it.notBefore <= now)
      const later = fresh.filter((it) => it.notBefore > now)
      const count = file.sentDate === date ? (file.sentCount ?? 0) : 0
      if (due.length === 0 || count >= this.cap) {
        if (fresh.length !== file.queue.length) await this.write(userId, { ...file, queue: fresh })
        return
      }
      const text = mergeDeferred(due)
      const res = await this.inner(userId, text)
      // 失败已被底层 outbox 接手重投;这里只负责「何时」,交出即删。
      await this.write(userId, { sentDate: date, sentCount: count + 1, queue: later })
      this.log.info('butler push-gate: flushed deferred', { userId, items: due.length, delivered: !!res?.delivered })
    })
  }

  /**
   * 成员本地钟(与免打扰同一口径)。按时刻触发的主动推送(心境签到)用它判窗口:
   * 服务器时区不是 +8 时,按服务器钟的「21 点」可能正落在成员的免打扰段里。
   */
  memberClock(ms: number): { hour: number; time: string } {
    const local = new Date(ms + this.tz * 60_000)
    const hh = String(local.getUTCHours()).padStart(2, '0')
    const mm = String(local.getUTCMinutes()).padStart(2, '0')
    return { hour: local.getUTCHours(), time: `${hh}:${mm}` }
  }

  /** 测试用。 */
  async pending(userId: string): Promise<number> {
    return (await this.read(userId)).queue.length
  }

  private async read(userId: string): Promise<GateFile> {
    let text: string
    try {
      text = await readFile(this.pathFor(userId), 'utf8')
    } catch {
      return { queue: [] }
    }
    try {
      const raw = JSON.parse(text) as Partial<GateFile>
      const queue = Array.isArray(raw.queue)
        ? raw.queue.filter(
            (v): v is DeferredItem =>
              !!v && typeof v.text === 'string' && typeof v.at === 'number' && typeof v.notBefore === 'number',
          )
        : []
      return {
        ...(typeof raw.sentDate === 'string' ? { sentDate: raw.sentDate } : {}),
        ...(typeof raw.sentCount === 'number' ? { sentCount: raw.sentCount } : {}),
        queue,
      }
    } catch (err) {
      this.log.warn('butler push-gate: unreadable state, starting empty', {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
      return { queue: [] }
    }
  }

  private async write(userId: string, file: GateFile): Promise<boolean> {
    const path = this.pathFor(userId)
    try {
      await mkdir(this.dir, { recursive: true })
      const tmp = `${path}.tmp-${process.pid}`
      await writeFile(tmp, JSON.stringify(file), 'utf8')
      await rename(tmp, path)
      return true
    } catch (err) {
      this.log.warn('butler push-gate: persist failed', { userId, err: err instanceof Error ? err.message : String(err) })
      await rm(`${path}.tmp-${process.pid}`, { force: true }).catch(() => undefined)
      return false
    }
  }

  private pathFor(userId: string): string {
    assertSafeOwnerId(userId)
    return join(this.dir, `${userId}.json`)
  }

  private withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(userId) ?? Promise.resolve()).then(fn, fn)
    this.locks.set(
      userId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }
}

/**
 * 暂存合成一条:一条就原样发;多条加一行说明。超出字数顶时**从最新往回**取,
 * 省略的是最早的几条(提醒越新越有用),并明说省略了几条——省略的不再投递。
 */
export function mergeDeferred(items: readonly DeferredItem[]): string {
  if (items.length === 1) return items[0]!.text
  const head = `(免打扰期间暂存的 ${items.length} 条消息)`
  const parts: string[] = []
  let used = head.length
  for (let i = items.length - 1; i >= 0; i--) {
    const piece = `· ${items[i]!.text.trim()}`
    if (parts.length > 0 && used + piece.length + 2 > MAX_MERGED_CHARS) break
    parts.unshift(piece)
    used += piece.length + 2
  }
  const omitted = items.length - parts.length
  return [head, ...(omitted > 0 ? [`(另有 ${omitted} 条较早的消息已省略)`] : []), ...parts].join('\n\n')
}
