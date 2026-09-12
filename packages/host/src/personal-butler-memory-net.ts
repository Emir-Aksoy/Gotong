/**
 * personal-butler-memory-net.ts — 生产里那张跨店联想网的**供给方**（记忆经济 M2c）。
 *
 * `crossStoreRecall` 要一张网，网要把四个店整个读一遍。这个文件回答的就是那笔钱
 * 谁出、多久出一次。
 *
 * # 为什么是 TTL 而不是每轮重建
 *
 * 网是**派生视图**，不是真相：删掉它，用户数据一个字节不少，下一次重建原样长回来
 * （M2a 的模块契约）。派生视图落后几十秒的代价，是那几十秒里新写进去的一条记忆
 * 暂时联想不到——而它仍然在冻结块和 `recall` 工具里，一条都不会丢。反过来每轮重建
 * 的代价是每条消息都把知识库整棵树读一遍，那才是真的贵。
 *
 * 整张网都受 TTL 约束；重建时 memory 面走索引的 watermark。每次使用网之前仍须
 * 检查索引可用性，纠正屏障或代际失效不能被 TTL 和旧网回退绕过。
 *
 * # 生产里只有四个面，如实说
 *
 * 尺子上量的是五个店，这里只接得到四个：**会话窗住在 IM 桥的接线里**
 * （`im-bridge-wiring.ts`），不在管家工厂的作用域内。所以 `MemorySpace` 的四个非
 * 记忆店都是可选的——一个只有四个面的调用方应当能如实说「我只有四个」，而不是被
 * 类型逼着编一个假的第五个（与 `AssocNode.ts` 缺席同一条理由）。
 *
 * 少这一面的代价是有界的：会话窗里那段话**本来就在提示词里**（窗把它渲染成了这一
 * 轮的对话原文），模型看得见；真正够不到的只有被窗挤掉的更早几轮，而那条路
 * SESS 探针已经指过了（「更早的对话用 recall 查」）。
 *
 * # 失败姿态
 *
 * 访问屏障失败清缓存并返 `null`；普通辅助库失败只在来源仍可用时回退旧网。
 * 没有可用网时探针静默，提示词字节不变。网是顾问，不是依赖。
 */

import type { Logger } from '@gotong/core'
import {
  buildMemoryNet,
  type KnowledgeLibrary,
  type LongRunDossierStore,
  type MemoryNet,
  type TaskNotebook,
} from '@gotong/personal-butler'

import { isRecallIndexAccessError, type FileBackedInvertedIndex } from './butler-recall-index.js'

/**
 * 网的最长存活时间。
 *
 * 60 秒的量级挑的是「一次对话里不重建、一次泡茶回来必重建」：管家的一轮问答通常
 * 在秒级，人两次开口之间常常是分钟级。调小到每轮一建就退化成没有缓存，调大到小时
 * 级则今天上午归的档下午还联想不到。
 */
export const MEMORY_NET_TTL_MS = 60_000

/** 一次最多列举多少份长任务档案。档案店按 taskId 寻址，没有「列出全部」的天然界。 */
export const MEMORY_NET_MAX_DOSSIERS = 20

export interface ButlerMemoryNetOptions {
  readonly userId: string
  readonly recallIndex: Pick<FileBackedInvertedIndex, 'allEntries' | 'assertUsable'>
  readonly knowledge?: KnowledgeLibrary
  readonly notebook?: TaskNotebook
  readonly dossiers?: LongRunDossierStore
  /** 缓存存活时间。默认 {@link MEMORY_NET_TTL_MS}；传 0 = 每次都重建（测试用）。 */
  readonly ttlMs?: number
  /** 最多列举几份档案。默认 {@link MEMORY_NET_MAX_DOSSIERS}。 */
  readonly maxDossiers?: number
  /** 注入时钟（测试）。 */
  readonly now?: () => number
  readonly logger?: Logger
}

/**
 * 建一个带 TTL 缓存的 `net()` 供给方，形状正是 `buildMemorySheetProbe` 要的那个。
 *
 * 并发合流：TTL 到期后同时来的多轮共享**一次**重建（与召回索引的
 * `ensureFresh` 同一条纪律），否则一阵消息风暴会把知识库读上十遍。
 */
export function buildButlerMemoryNetProvider(
  opts: ButlerMemoryNetOptions,
): () => Promise<MemoryNet | null> {
  const ttlMs = Math.max(0, Math.floor(opts.ttlMs ?? MEMORY_NET_TTL_MS))
  const maxDossiers = Math.max(0, Math.floor(opts.maxDossiers ?? MEMORY_NET_MAX_DOSSIERS))
  const now = opts.now ?? ((): number => Date.now())

  let cached: MemoryNet | null = null
  let builtAt = -Infinity
  let building: Promise<MemoryNet | null> | null = null
  let epoch = 0

  const invalidate = (): void => {
    epoch++
    cached = null
    builtAt = -Infinity
  }

  const usable = async (): Promise<boolean> => {
    try {
      await opts.recallIndex.assertUsable()
      return true
    } catch {
      // A barrier is not an ordinary rebuild failure. Discard both the cached
      // view and any result still being built from its previous evidence.
      invalidate()
      return false
    }
  }

  const build = async (): Promise<MemoryNet | null> => {
    const entries = await opts.recallIndex.allEntries()
    // 档案店按 taskId 寻址,先列摘要拿 id;列不出来就当没有这一面。
    let dossierIds: string[] = []
    if (opts.dossiers && maxDossiers > 0) {
      const summaries = await opts.dossiers.list()
      dossierIds = summaries.slice(0, maxDossiers).map((s) => s.taskId)
    }
    return buildMemoryNet({
      userId: opts.userId,
      entries,
      ...(opts.knowledge ? { knowledge: opts.knowledge } : {}),
      ...(opts.notebook ? { notebook: opts.notebook } : {}),
      ...(opts.dossiers ? { dossiers: opts.dossiers, dossierIds } : {}),
    })
  }

  return async (): Promise<MemoryNet | null> => {
    if (!await usable()) return null
    const ticket = epoch
    if (cached && now() - builtAt < ttlMs) return cached
    if (!building) {
      building = build()
        .then(async (net) => {
          if (!await usable() || ticket !== epoch) return null
          cached = net
          builtAt = now()
          return net
        })
        .catch(async (error: unknown) => {
          if (isRecallIndexAccessError(error)) {
            invalidate()
            return null
          }
          if (!await usable() || ticket !== epoch) return null
          // Ordinary auxiliary-store failure may use the prior view only while
          // its memory source is still usable. Do not log private source text.
          opts.logger?.warn('butler memory net: build failed')
          return cached
        })
        .finally(() => { building = null })
    }
    const result = await building
    if (!await usable() || ticket !== epoch) return null
    return result
  }
}
