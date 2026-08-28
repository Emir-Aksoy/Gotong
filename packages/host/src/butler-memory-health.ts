/**
 * M-HEALTH — 记忆维护的健康台账。
 *
 * 病根不是某一行写错了,是三件各自正确的事合起来撒了谎:
 * `composeReviewers` 把抛错的 pass 折成一句 `review error: …` 摘要(**这是对的**,
 * 一个坏 pass 不能饿死其余的),`maintainOne` 把摘要交上去,sweeper 的
 * `if (summary) active++` 于是把「一句道歉」读成「干了活」,最后落一行
 * `level:"info"` `sweep complete`。生产上整整两周每一轮 6h 维护全线失败,
 * 而日志里一个 warn 都没有、面板一张牌都没有、IM 一声都没有。
 *
 * 这份台账就是那个缺掉的证据面:每轮扫完落一条结构化事实行,
 * 与 self-heal 台账(`runtime/self-heal-log.jsonl`)同族——**先落账,再有人来读**。
 * 读者(巡检牌 / `my_status`)一律只读不写,故这里不设内存缓存:
 * 权威是盘上那份,旁观者每次拉最新(`readOutageSnapshotFile` 同一纪律)。
 *
 * 三条边界:
 * ① **读者永不抛**——不存在 / 损坏 / 形状不对一律当 null。「读不到」与
 *    「没发生」在这儿收敛成同一个诚实答案:**未知**,而未知不产生任何牌
 *    (EFF-M3「把读不动计成 0 会谎报一切安静」的反面同样成立:把读不动
 *    计成坏,会凭空造一场故障)。
 * ② **写盘失败不连累扫描**——账是派生物,维护本身已经做完了;写不进去
 *    只 warn 一次,绝不让一次磁盘打嗝把整轮维护变成失败。
 * ③ **没有 provider 的那一趟什么都不写**——没 key 的 hub 每轮都走
 *    project-only 分支,那不是失败;给它记一笔会让一台全新的、还没配
 *    key 的 hub 在第一天就自称有病。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Logger } from '@gotong/core'

/** 最多留几条错误样本。台账是给人看的线索,不是第二份日志。 */
const MAX_ERROR_SAMPLES = 3
/** 单条错误样本的字符上限——provider 的原始 message 可以任意长。 */
const MAX_ERROR_CHARS = 200

/**
 * 连续几轮 6h 扫描出错才算「一直在错」(≈12 小时,跨过单次抖动)。
 * 判据住在这儿而不是读者那儿:巡检牌与 `my_status` 都要用它,两处各写
 * 一个数字迟早会不一样,而那天没有人会被通知。
 */
export const MEMORY_FAILED_SWEEPS_THRESHOLD = 2
/** 距上次干净跑成多久算「维护停摆」(48h ≈ 连续 8 个 6h 周期没成)。 */
export const MEMORY_STALE_MS = 48 * 60 * 60 * 1000

/** 落盘形状。文件不存在 = 还没扫过(未知),**不等于**健康。 */
export interface ButlerMemoryHealth {
  v: 1
  /** 最后一次「真的跑了维护」的扫描时刻(project-only 的那趟不算)。 */
  checkedAt: number
  /** 那一轮扫了几个成员。 */
  members: number
  /** 其中干净且真干了活的。 */
  active: number
  /** 其中出错的(某个 pass 抛了,或整个成员 tick 抛了)。 */
  failed: number
  /** 最近一次 `failed === 0` 的扫描时刻。从没干净跑成过就缺席。 */
  lastOkAt?: number
  /** 连续几轮扫描 `failed > 0`。干净一轮即归零。 */
  consecutiveFailedSweeps: number
  /** 最近一轮的错误样本(≤3 条,各截 200 字)。干净一轮清空。 */
  lastErrors: readonly string[]
}

function isHealth(v: unknown): v is ButlerMemoryHealth {
  if (!v || typeof v !== 'object') return false
  const h = v as Partial<ButlerMemoryHealth>
  return h.v === 1
    && typeof h.checkedAt === 'number' && Number.isFinite(h.checkedAt)
    && typeof h.members === 'number' && Number.isFinite(h.members)
    && typeof h.active === 'number' && Number.isFinite(h.active)
    && typeof h.failed === 'number' && Number.isFinite(h.failed)
    && typeof h.consecutiveFailedSweeps === 'number'
    && Number.isFinite(h.consecutiveFailedSweeps)
    && Array.isArray(h.lastErrors) && h.lastErrors.every((e) => typeof e === 'string')
    && (h.lastOkAt === undefined || (typeof h.lastOkAt === 'number' && Number.isFinite(h.lastOkAt)))
}

/**
 * 读一次台账,**无缓存**。不存在 / 损坏 / 形状不对一律 null(见文件头 ①)。
 * 巡检与 `my_status` 都走这一条,解析与校验只有一处。
 */
export async function readButlerMemoryHealth(file: string): Promise<ButlerMemoryHealth | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return isHealth(parsed) ? parsed : null
  } catch {
    return null // 不存在或损坏当未知
  }
}

/** 一轮扫描的原始观察值——`foldMaintenanceSweep` 的输入。 */
export interface MaintenanceSweepTick {
  at: number
  members: number
  active: number
  failed: number
  errors: readonly string[]
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= MAX_ERROR_CHARS ? one : `${one.slice(0, MAX_ERROR_CHARS)}…`
}

/**
 * 把这一轮折进上一份台账。纯函数——写盘与判定分开,才好单测。
 *
 * `lastOkAt` 是**高水位**:它答的是「上一次干净跑成是什么时候」,失败的
 * 一轮必须原样把它抬过去,否则「多久没成功过」这个问题会在第一次失败时
 * 就失去答案——而那恰好正是要问它的时刻(self-heal 高水位标记同一形状)。
 */
export function foldMaintenanceSweep(
  prev: ButlerMemoryHealth | null,
  tick: MaintenanceSweepTick,
): ButlerMemoryHealth {
  const clean = tick.failed === 0
  const carriedOk = clean ? tick.at : prev?.lastOkAt
  return {
    v: 1,
    checkedAt: tick.at,
    members: tick.members,
    active: tick.active,
    failed: tick.failed,
    ...(carriedOk !== undefined ? { lastOkAt: carriedOk } : {}),
    consecutiveFailedSweeps: clean ? 0 : (prev?.consecutiveFailedSweeps ?? 0) + 1,
    lastErrors: clean ? [] : tick.errors.slice(0, MAX_ERROR_SAMPLES).map(clip),
  }
}

/**
 * 读-改-写一轮。best-effort:写不进去只 warn(见文件头 ②)。
 * 返回落盘的那份,方便调用方/测试直接断言,不必再读一遍。
 */
export async function recordMaintenanceSweep(
  file: string,
  tick: MaintenanceSweepTick,
  logger?: Logger,
): Promise<ButlerMemoryHealth> {
  const next = foldMaintenanceSweep(await readButlerMemoryHealth(file), tick)
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    logger?.warn('butler maintenance: health ledger write failed', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
  return next
}
