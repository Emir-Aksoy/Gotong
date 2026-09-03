/**
 * eviction-benchmark.ts — 逐出这件事的尺子（记忆经济 M3b）。
 *
 * # 为什么要有这把尺
 *
 * M3b 要做的事一句话就能说完：把 `DEFAULT_SALIENCE_HALF_LIFE_MS` 与
 * `DEFAULT_REINFORCE_WEIGHT` 真的喂给 `enforceBudget`。可「传了两个参数」是
 * **形状**不是**效果**——一条断言「参数被传下去了」的测试,在参数完全无效时
 * 照样是绿的。要证明显著性通电有意义,得能回答一个可证伪的问题:
 *
 *   **同样的一批记忆、同样的预算,换上显著性之后,活下来的是不是更该活的那些?**
 *
 * 所以这里量的是**保留率**:一份夹具里每条都标好「该留 / 该逐」,预算刚好卡在
 * 「该留的那些正好装得下」,于是完美的策略得 1.0、把该留的全逐光得 0。
 *
 * # 判据是最终存活,不是逐出顺序
 *
 * 只看排序会把「顺序对但被保护规则救回来了」判成对的。真正要紧的是这一轮跑完
 * 之后**盘上还剩谁**,所以驱动的是真的 `enforceBudget`,读的是它跑完之后的
 * `list()`。策略换了什么参数是入参,得分只看后果。
 *
 * # 纪律(照抄 `write-benchmark.ts` 的那几条)
 *
 *   - 尺子住 `src/` 而不是 `tests/`:CI 门与将来的真档 runner 必须跑**同一份**
 *     代码,否则两条路会各自漂移。
 *   - **零模型调用、零墙上时钟**:唯一的「现在」是 {@link EVICTION_BENCH_NOW},
 *     所以同一份夹具的分数逐字节可复现。
 *   - **不新建旋钮**:被测的两个数字都是包里早就写好的常量。
 *   - 字节度量复用 `entryBytes` —— 尺子和执法必须用同一把秤,否则量出来的
 *     「抬升」可能只是两套四舍五入的差。
 */

import type { MemoryEntry, MemoryHandle } from '@gotong/services-sdk'

import { enforceBudget, entryBytes, type EnforceBudgetOptions } from './budget.js'

/** 这把尺子唯一的「现在」。固定值 ⇒ 分数可复现。 */
export const EVICTION_BENCH_NOW = 1_700_000_000_000

const DAY = 24 * 60 * 60 * 1000

/** 造一条语义事实。`recalled` 给了就写进 meta,那正是「被用过」的痕迹。 */
export function benchEntry(opts: {
  id: string
  text: string
  /** 写下的时间,相对 {@link EVICTION_BENCH_NOW} 往前几天。 */
  writtenDaysAgo: number
  importance?: number
  /** 最近一次被召回,相对现在往前几天。不给 = 从没被召回过。 */
  recalledDaysAgo?: number
  /** 被召回过几次。不给 = 0。 */
  recallCount?: number
  /** 双时态:已翻篇的事实在这个时间点之后失效。 */
  validToDaysAgo?: number
}): MemoryEntry {
  const meta: Record<string, unknown> = { importance: opts.importance ?? 3 }
  if (opts.recalledDaysAgo !== undefined) {
    meta['lastRecalledTs'] = EVICTION_BENCH_NOW - opts.recalledDaysAgo * DAY
  }
  if (opts.recallCount !== undefined) meta['recallCount'] = opts.recallCount
  if (opts.validToDaysAgo !== undefined) {
    meta['validTo'] = EVICTION_BENCH_NOW - opts.validToDaysAgo * DAY
  }
  return {
    id: opts.id,
    kind: 'semantic',
    text: opts.text,
    ts: EVICTION_BENCH_NOW - opts.writtenDaysAgo * DAY,
    meta,
  } as unknown as MemoryEntry
}

export interface EvictionCase {
  readonly name: string
  /** 这条用例在论证什么。空的用例不许进夹具。 */
  readonly why: string
  readonly corpus: readonly MemoryEntry[]
  /** 一个好的策略应该留下的那些 id。预算按它们的字节之和设。 */
  readonly shouldKeep: readonly string[]
}

/** 造一个装着这批条目的记忆句柄(调用方给,尺子不认识具体实现)。 */
export type BenchMemoryFactory = (
  corpus: readonly MemoryEntry[],
) => MemoryHandle | Promise<MemoryHandle>

/** 被测的策略 = `enforceBudget` 里那几个「通不通电」的选项。 */
export type EvictionPolicy = Pick<
  EnforceBudgetOptions,
  'salience' | 'evictExpiredFirst' | 'protectRecentEpisodic'
>

export interface EvictionCaseScore {
  readonly name: string
  /** 该留的里面留下了几成。 */
  readonly keepRate: number
  /** 该逐的里面逐掉了几成。预算固定时它由 keepRate 决定,列出来是为了看得见。 */
  readonly dropRate: number
  /** 实际逐掉了几条。 */
  readonly evicted: number
}

export interface EvictionBenchResult {
  readonly keepRate: number
  readonly dropRate: number
  readonly perCase: readonly EvictionCaseScore[]
}

/**
 * 跑一遍夹具:每条用例都真的驱动 `enforceBudget`,按最终存活打分。
 *
 * 预算 = `shouldKeep` 那些条目的字节之和,所以**完美的策略恰好一条不多一条不少**。
 * 这一点让分数有绝对意义:1.0 就是满分,不是「比另一个高一点」。
 */
export async function scoreEviction(
  make: BenchMemoryFactory,
  cases: readonly EvictionCase[],
  policy: EvictionPolicy = {},
): Promise<EvictionBenchResult> {
  const perCase: EvictionCaseScore[] = []

  for (const c of cases) {
    const keepSet = new Set(c.shouldKeep)
    const budgetBytes = c.corpus
      .filter((e) => keepSet.has(e.id))
      .reduce((sum, e) => sum + entryBytes(e), 0)

    const memory = await make(c.corpus)
    const result = await enforceBudget({
      memory,
      budgetBytes,
      now: () => EVICTION_BENCH_NOW,
      ...policy,
    })

    const survivors = new Set((await memory.list({ limit: 10_000 })).map((e) => e.id))
    const keptGold = c.shouldKeep.filter((id) => survivors.has(id)).length
    const shouldDrop = c.corpus.map((e) => e.id).filter((id) => !keepSet.has(id))
    const droppedGold = shouldDrop.filter((id) => !survivors.has(id)).length

    perCase.push({
      name: c.name,
      keepRate: c.shouldKeep.length === 0 ? 1 : keptGold / c.shouldKeep.length,
      dropRate: shouldDrop.length === 0 ? 1 : droppedGold / shouldDrop.length,
      evicted: result?.evicted ?? 0,
    })
  }

  const mean = (xs: readonly number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
  return {
    keepRate: mean(perCase.map((c) => c.keepRate)),
    dropRate: mean(perCase.map((c) => c.dropRate)),
    perCase,
  }
}

/** 一行人话,进 CI 日志 —— 免得只有地板没有实测值。 */
export function formatEvictionResult(label: string, r: EvictionBenchResult): string {
  const head = `【${label}】该留的留住 ${(r.keepRate * 100).toFixed(1)}%  该逐的逐掉 ${(r.dropRate * 100).toFixed(1)}%`
  const rows = r.perCase.map(
    (c) => `  · ${c.name}  留 ${(c.keepRate * 100).toFixed(0)}%  逐 ${(c.dropRate * 100).toFixed(0)}%  (逐了 ${c.evicted} 条)`,
  )
  return [head, ...rows].join('\n')
}
