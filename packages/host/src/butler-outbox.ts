/**
 * butler-outbox.ts — CARE-M8: 管家推送的持久化投递重试。
 *
 * ButlerReachableRegistry.push 是 best-effort:成员的桥断了 / 正在重连 / 从没绑过
 * 聊天 → `{delivered:false}`,而每个 caller(断供播报、巡检升级、提醒、审批回推、
 * run 播报)都只是把这次失败**记进日志**。消息就此丢失——一个短暂失联的成员,
 * 永远不会知道大脑坏了(或恢复了)。
 *
 * 这层把 push 包成一个 file-first 的每成员队列:push 失败就把这行追加到
 * `<dir>/<userId>.json`;等成员下次跟我们说话(record → flush)或 cadence 巡检
 * (桥恢复了但成员没吭声)时重投。投达的行删掉;FIFO,一次 flush **停在第一个
 * 失败**上以保住顺序(跨重试仍有序)。
 *
 * 有界(一个永远失联的成员不能把文件撑爆):每成员队列上限 MAX_QUEUE(超了丢最
 * 旧、大声记),flush 时超过 MAX_AGE_MS 的行丢弃(一条一天前的「坏了」比沉默更糟
 * ——那时断供多半早恢复了)。两种丢弃都记日志,绝不静默(CONVENTIONS:no silent caps)。
 *
 * 无泄漏同 registry:按成员自己的 userId 存,只推给他自己那条最近聊天,永不外扇。
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { assertSafeOwnerId } from '@gotong/services-sdk'

import type { ButlerPushResult } from './butler-reachable.js'
import type { ImLogger } from './im-bridge.js'

/** 每成员队列默认上限——超了丢最旧(大声)。 */
const DEFAULT_MAX_QUEUE = 50
/** 默认存活期 24h——比这更旧的行 flush 时丢弃(陈旧播报比沉默更误导)。 */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** 一条排队待投的推送。 */
interface OutboxItem {
  text: string
  /** 入队时刻(epoch ms),用于 TTL。 */
  at: number
}

export interface ButlerOutboxOptions {
  /** `<space>/butler/outbox` —— 每成员队列文件住这。 */
  dir: string
  /** 底层真投递(通常是 ButlerReachableRegistry.push)。 */
  push: (userId: string, text: string) => Promise<ButlerPushResult>
  logger: ImLogger
  /** 注入时钟(确定性测试);默认 Date.now。 */
  now?: () => number
  /** 每成员队列上限;默认 {@link DEFAULT_MAX_QUEUE}。 */
  maxQueue?: number
  /** 行存活期;默认 {@link DEFAULT_MAX_AGE_MS}。 */
  maxAgeMs?: number
}

/**
 * file-first 的投递 outbox。`deliver` 先尝试真投,失败入盘;`flush(userId)` /
 * `flushAll()` 重投。每成员一把锁,串行化同一 userId 的读改写,防并发双投。
 */
export class ButlerOutbox {
  private readonly dir: string
  private readonly push: (userId: string, text: string) => Promise<ButlerPushResult>
  private readonly log: ImLogger
  private readonly now: () => number
  private readonly maxQueue: number
  private readonly maxAgeMs: number
  /** 每 userId 的串行锁(promise 链)——同一成员的读改写不交错。 */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(opts: ButlerOutboxOptions) {
    this.dir = opts.dir
    this.push = opts.push
    this.log = opts.logger
    this.now = opts.now ?? Date.now
    this.maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  }

  /**
   * 投一行给成员:先尝试真投。投达 → 原样返回。失败(任何 reason)→ 追加到该
   * 成员的持久队列,仍返回原始失败结果(caller 照样看得到「没投达」,但这条已
   * 落盘,会在成员可达时重投)。unknown_member 也入队:成员日后绑定 + 说话
   * (record → flush)就补投,不是白排。
   */
  async deliver(userId: string, text: string): Promise<ButlerPushResult> {
    const result = await this.push(userId, text)
    if (result.delivered) return result
    await this.withLock(userId, async () => {
      const queue = await this.read(userId)
      queue.push({ text, at: this.now() })
      const overflow = queue.length - this.maxQueue
      if (overflow > 0) {
        queue.splice(0, overflow) // 丢最旧
        this.log.warn('butler outbox: queue full, dropped oldest', { userId, dropped: overflow })
      }
      await this.write(userId, queue)
    })
    return result
  }

  /**
   * 重投某成员的队列。FIFO,停在第一个失败(顺序跨重试保住);投前先丢弃超
   * TTL 的行。空队列 = no-op(常态,零成本)。
   */
  async flush(userId: string): Promise<void> {
    await this.withLock(userId, async () => {
      const queue = await this.read(userId)
      if (queue.length === 0) return
      const cutoff = this.now() - this.maxAgeMs
      const fresh = queue.filter((it) => it.at >= cutoff)
      const expired = queue.length - fresh.length
      if (expired > 0) this.log.info('butler outbox: dropped expired', { userId, expired })

      const remaining = [...fresh]
      let delivered = 0
      while (remaining.length > 0) {
        const item = remaining[0]!
        const r = await this.push(userId, item.text)
        if (!r.delivered) break // 还是不可达 —— 剩下的留到下次 flush
        remaining.shift()
        delivered++
      }
      if (delivered > 0 || expired > 0) await this.write(userId, remaining)
      if (delivered > 0) {
        this.log.info('butler outbox: flushed', { userId, delivered, remaining: remaining.length })
      }
    })
  }

  /** 重投所有有队列的成员(cadence 巡检:桥恢复了但成员没吭声)。 */
  async flushAll(): Promise<void> {
    let files: string[]
    try {
      files = await readdir(this.dir)
    } catch {
      return // 目录还不存在 = 从没排过队
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const userId = file.slice(0, -'.json'.length)
      try {
        assertSafeOwnerId(userId)
      } catch {
        continue // 文件名不是合法 id —— 跳过(防御纵深)
      }
      await this.flush(userId)
    }
  }

  /** 测试用:某成员当前排队条数。 */
  async pending(userId: string): Promise<number> {
    return (await this.read(userId)).length
  }

  // --- 内部:每成员 JSON 数组文件的读改写 ---

  private async read(userId: string): Promise<OutboxItem[]> {
    let raw: string
    try {
      raw = await readFile(this.pathFor(userId), 'utf8')
    } catch {
      return [] // 不存在 = 空队列
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (v): v is OutboxItem =>
          !!v && typeof v === 'object' && typeof (v as OutboxItem).text === 'string' && typeof (v as OutboxItem).at === 'number',
      )
    } catch {
      return [] // 损坏当空 —— 大不了丢几条排队消息,绝不崩
    }
  }

  private async write(userId: string, queue: OutboxItem[]): Promise<void> {
    try {
      if (queue.length === 0) {
        await rm(this.pathFor(userId), { force: true }) // 队列空了删文件,不留空壳
        return
      }
      await mkdir(this.dir, { recursive: true })
      await writeFile(this.pathFor(userId), JSON.stringify(queue), 'utf8')
    } catch (err) {
      // 写失败不炸投递路径(内存里这次投达/失败已定);退化 = 重启后这条排队丢。
      this.log.warn('butler outbox: persist failed', {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private pathFor(userId: string): string {
    assertSafeOwnerId(userId) // 绝不拿文件名/入参当路径直用
    return join(this.dir, `${userId}.json`)
  }

  /** 同一 userId 串行:new 操作接在上一个之后(无论成败),防并发读改写双投。 */
  private withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(userId) ?? Promise.resolve()).then(fn, fn)
    this.locks.set(
      userId,
      run.then(
        () => {},
        () => {},
      ),
    )
    return run
  }
}
