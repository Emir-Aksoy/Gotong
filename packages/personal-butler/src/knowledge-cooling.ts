/**
 * knowledge-cooling.ts — 阶梯第 ③ 级在**知识库**这一面:货架满了自动归档最冷的几份
 * (记忆经济 M3d)。
 *
 * # 为什么知识库要单独一刀
 *
 * M3c 的记忆账是**字节制**的,而知识库真正会先撞上的顶不是字节:
 *
 *   - `maxFiles: 200` 只数**上架区** —— 它守的是导航性。撞顶的表现是 `write` 抛
 *     `knowledge_limit`,叫模型「先 archive 掉不再需要的」。
 *   - `maxTotalBytes: 4 MiB` 数**全树含 `archive/`** —— 它守的是磁盘真实占用。
 *
 * 归档是 `rename`,**字节一个都不少**。所以归档能缓解的只有前者。字节制的记忆账
 * 结构上看不见货架压力,把货架数塞进 `LedgerLine.usedBytes` 只是让字段名说谎——
 * 于是这一层自己算货架压力,但**共用 `rungFor`**:阈值、滞回、逐级累加的语义全部
 * 同源,只是喂进去的比值换了个量纲。
 *
 * # 字节那一面:这一层不动它,但**已经有人管**
 *
 * 归档是 `rename`,字节一个不少;能减字节的只有删文件,而记忆经济这一层不新增任何
 * 删除执法点。
 *
 * 关键是:**那把剪刀早就存在,只是不在这一层**。STOR-M3 的保留阶梯
 * (`host/src/space-retention.ts`)有一条 `memory_archive_days`,剪的恰好就是
 * `knowledge/archive/**`——opt-in 的 `retention.json` 策略、天数下限 30、而且每一条
 * 删除都硬前置「已进最近一次备份或 git 快照」。
 *
 * 所以 M3d 与它是**接力**不是缺口:降温把冷件挪进归档区,保留阶梯在成员配了策略之后
 * 按天龄清它。本模块对字节压力只**报**——报进 summary 让成员在 STATUS.md 上看见,并
 * 直接说出那个策略键的名字,而不是含糊地说「需要人来清」。
 *
 * # 谁算冷:`mtime`,以及它错在哪
 *
 * 冷度用最后写入时间。这个信号有个真实的毛病:**它跟踪写不跟踪读**——一份天天被
 * 翻阅却从不修改的参考件,在这里看着和一份被遗忘的草稿一样冷。
 *
 * 之所以还敢用:①它零成本(walk 本来就在 stat);②这座图书馆的写者是阿同自己,
 * `write_knowledge_file` 是**整篇覆盖**,所以「还在被维护」几乎必然留下 mtime;
 * ③最要紧的是**猜错的代价**——归档不是删除,文件还在、还能 `read`、还在 `list` 里,
 * 只是多了个 `archive/` 前缀。在一个「猜错只赔一个路径前缀」的地方用一个便宜的弱
 * 信号,比为它新建一套读计数状态划算。
 *
 * # 两样东西永不归档
 *
 *   - **`INDEX.md`**:总索引,归档它等于自断导航(`archive()` 本来就响亮拒,这里
 *     提前挡掉,免得每个 tick 都去撞一次那个必然的错)。
 *   - **刚写过的**:保护期,同 M3c 的理由——「刚记下的东西立刻被判定为不重要」是
 *     任何记忆系统最难看的失败。
 */

import {
  RUNG_HYSTERESIS,
  RUNG_OPEN_AT,
  rungFor,
  type LedgerRung,
  type MemoryReviewer,
  type ReviewContext,
  type ReviewOutcome,
} from '@gotong/personal-memory'

import {
  KNOWLEDGE_INDEX_FILE,
  KNOWLEDGE_LIBRARY_LIMITS,
  type KnowledgeFileInfo,
  type KnowledgeLibrary,
  type KnowledgeLibraryLimits,
} from './knowledge-library.js'

/** 保护期:最近写过的这么多份不参与归档。 */
export const DEFAULT_PROTECT_RECENT_FILES = 8

/** 一个 tick 最多归档多少份。一次压力尖峰不该把半座图书馆搬进 archive/。 */
export const DEFAULT_MAX_ARCHIVE_PER_TICK = 20

export interface KnowledgeCoolingSkipped {
  /** 归档区里的(本来就不在货架上)。 */
  readonly archived: number
  /** `INDEX.md`。 */
  readonly index: number
  /** 落在保护期里。 */
  readonly recent: number
}

export interface KnowledgeCoolingSelection {
  /** 该归档的路径,最冷的在前。 */
  readonly archive: readonly string[]
  /** 货架压力 = 上架份数 / `maxFiles`。 */
  readonly shelfPressure: number
  /** 全树字节压力 = (上架 + 归档) / `maxTotalBytes`。**归档动不了它**,只报。 */
  readonly bytePressure: number
  readonly skipped: KnowledgeCoolingSkipped
}

export interface SelectForArchiveOptions {
  /** 上限。默认 {@link KNOWLEDGE_LIBRARY_LIMITS}。 */
  readonly limits?: KnowledgeLibraryLimits
  /** 要把上架份数降到多少(含)以下。低于它就一份都不归档。 */
  readonly targetActive: number
  /** 保护期份数。默认 {@link DEFAULT_PROTECT_RECENT_FILES}。 */
  readonly protectRecent?: number
  /** 每 tick 硬顶。默认 {@link DEFAULT_MAX_ARCHIVE_PER_TICK}。 */
  readonly maxPerTick?: number
}

/**
 * 挑出该归档的那些。**纯函数**:不碰入参,不碰磁盘,同样入参同样出参。
 */
export function selectForArchive(
  files: readonly KnowledgeFileInfo[],
  opts: SelectForArchiveOptions,
): KnowledgeCoolingSelection {
  const limits = opts.limits ?? KNOWLEDGE_LIBRARY_LIMITS
  const protectRecent = Math.max(0, Math.floor(opts.protectRecent ?? DEFAULT_PROTECT_RECENT_FILES))
  const maxPerTick = Math.max(0, Math.floor(opts.maxPerTick ?? DEFAULT_MAX_ARCHIVE_PER_TICK))

  const active = files.filter((f) => !f.archived)
  const skipped = { archived: files.length - active.length, index: 0, recent: 0 }

  const shelfPressure = limits.maxFiles > 0 ? active.length / limits.maxFiles : 0
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0)
  const bytePressure = limits.maxTotalBytes > 0 ? totalBytes / limits.maxTotalBytes : 0

  // 保护期在**上架区内部**数:归档区的份数再多也不该顶掉货架上的保护名额。
  const recent = new Set(
    [...active]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, protectRecent)
      .map((f) => f.path),
  )

  const eligible: KnowledgeFileInfo[] = []
  for (const f of active) {
    if (f.path === KNOWLEDGE_INDEX_FILE) {
      skipped.index += 1
      continue
    }
    if (recent.has(f.path)) {
      skipped.recent += 1
      continue
    }
    eligible.push(f)
  }

  const ranked = eligible.sort((a, b) =>
    a.mtimeMs !== b.mtimeMs ? a.mtimeMs - b.mtimeMs : a.path < b.path ? -1 : 1,
  )
  const want = Math.max(0, active.length - Math.max(0, Math.floor(opts.targetActive)))
  return {
    archive: ranked.slice(0, Math.min(want, maxPerTick)).map((f) => f.path),
    shelfPressure,
    bytePressure,
    skipped,
  }
}

/** 归档后货架该停在哪:比降级线**再低一档**,好让阶梯真的走下来。 */
export function restingActiveCount(maxFiles: number, downLine: number): number {
  // 停在降级线**上**的话,`rungFor` 下一 tick 仍判第 ③ 级(它守的是 `>=`),于是
  // 日志里会永远挂着「③ 降温」却一份都不动。少一份,阶梯就真的落下去了。
  return Math.max(0, Math.floor(maxFiles * downLine) - 1)
}

/** 字节压力到这里就在 summary 里提一句。只提醒,不动手 —— 见模块顶注。 */
export const BYTE_PRESSURE_NOTICE = 0.8

/** 阶梯开到这一级(或更高)才归档 —— 与记忆那一面同一级。 */
export const KNOWLEDGE_COOLING_RUNG = 3 satisfies LedgerRung

export interface KnowledgeCoolingReviewerOptions {
  readonly library: KnowledgeLibrary
  /** 上限。默认 {@link KNOWLEDGE_LIBRARY_LIMITS};测试收紧用。 */
  readonly limits?: KnowledgeLibraryLimits
  readonly protectRecent?: number
  readonly maxPerTick?: number
  readonly logger?: { warn(msg: string, meta?: Record<string, unknown>): void }
}

/**
 * 把知识库归档包成 6h 链上的一个 reviewer。
 *
 * # 目标为什么瞄降级线,不瞄上限
 *
 * 记忆那一面的目标是「回到预算内」,因为**超预算是可能发生的**——执法(`enforceBudget`)
 * 事后才跑。货架不一样:`write` 在第 200 份就**当场抛** `knowledge_limit`,所以上架数
 * 永远 ≤ `maxFiles`,「超过上限多少」恒为 0。照抄记忆那一面的算法会得到一个**永远为零
 * 的目标**——一段永远不执行的代码,而且每道门都会绿。
 *
 * 于是这一面瞄的是**降级线之下一档**({@link restingActiveCount}):第 ③ 级在九成满
 * 时开,归档到八成半再低一份,阶梯真的落回第 ② 级,下一个 tick 安静。
 *
 * # 失败姿态
 *
 * 单份归档失败(并发、权限、文件刚被别人挪走)只跳过它,不中断整趟——与
 * `composeReviewers` 对待抛错子 pass 的姿态一致:一份坏文件不该让整座图书馆停摆。
 *
 * 压力不到第 ③ 级 ⇒ 一份都不动,返回 `{}`(空闲)。
 */
export function knowledgeCoolingReviewer(opts: KnowledgeCoolingReviewerOptions): MemoryReviewer {
  const limits = opts.limits ?? KNOWLEDGE_LIBRARY_LIMITS
  const downLine = RUNG_OPEN_AT[KNOWLEDGE_COOLING_RUNG] - RUNG_HYSTERESIS
  let priorRung: LedgerRung = 0

  return async (_ctx: ReviewContext): Promise<ReviewOutcome> => {
    const listing = await opts.library.list()
    if (listing.files.length === 0) return {}

    const shelfPressure = limits.maxFiles > 0 ? listing.activeCount / limits.maxFiles : 0
    const rung = rungFor(shelfPressure, priorRung)
    priorRung = rung
    if (rung < KNOWLEDGE_COOLING_RUNG) return {}

    const sel = selectForArchive(listing.files, {
      limits,
      targetActive: restingActiveCount(limits.maxFiles, downLine),
      ...(opts.protectRecent !== undefined ? { protectRecent: opts.protectRecent } : {}),
      ...(opts.maxPerTick !== undefined ? { maxPerTick: opts.maxPerTick } : {}),
    })

    let archived = 0
    for (const path of sel.archive) {
      try {
        await opts.library.archive(path)
        archived += 1
      } catch (err) {
        // 一份挪不动不该拖垮整趟。记一笔,继续下一份。
        opts.logger?.warn('knowledge cooling: archive failed', {
          path,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (archived === 0) return {}

    const parts = [
      `知识库降温:归档 ${archived} 份最久没维护的(货架 ${listing.activeCount} → ${listing.activeCount - archived}/${limits.maxFiles})`,
    ]
    // 字节那一面只报不动:归档是 rename,字节一个都没少。八成满就说一声,并把那个
    // 真的能减字节的策略键点名说出来 —— 一句「需要人来清」不告诉成员该去按哪个键。
    if (sel.bytePressure >= BYTE_PRESSURE_NOTICE) {
      parts.push(
        `注意总字节已达 ${(sel.bytePressure * 100).toFixed(0)}%(含归档区);归档不减字节,` +
          `要真的回收请设 retention 策略的 memory_archive_days(它剪的就是 archive/)`,
      )
    }
    return { summary: parts.join(';') }
  }
}
