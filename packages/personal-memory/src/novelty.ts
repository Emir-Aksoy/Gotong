/**
 * novelty.ts — 写侧新颖门:复述在**写下的那一刻**就折进既有条(记忆经济 M4)。
 *
 * # 它在哪一条线上
 *
 * 只挂在 **turn capture** 这一处 —— 每轮一条、无界增长的唯一热路径写入,也正是设计
 * 说的「capture 的那一刻」。刻意**不**挂在另外三处:
 *
 *   - **profile / digest**(分级蒸馏产物):连续两份摘要天然相似,折它等于把分级蒸馏
 *     打断 —— 新摘要折进旧摘要,那一层就永远停在第一版。
 *   - **atomic-facts 的 semantic 写入**:那里 6h 跑一次、自己已经有 0.8 去重
 *     (`isCovered`),同一件事不设两道卡。
 *   - **模型自己调 `remember` 工具**:那是模型的显式意图。写侧把它折掉,会让模型
 *     「我明明记下了」与盘上不符 —— 折叠必须发生在模型看不见的那一侧。
 *
 * # 红线:这一层不删任何东西
 *
 * 「折叠」= **不写**,不是「写了再删」。被折的那一轮没有变成孤儿字节再被回收,它从
 * 一开始就没落盘;旧条上多出 `recallCount+1` / `restatedCount+1` / 一条边。所以记忆
 * 经济这一层仍然**一处删除执法点都不新增**(压力驱动的自动逐出仍只有 `enforceBudget`)。
 *
 * # 判据为什么必须**双向**
 *
 * `relevanceScore` 是**查询覆盖率**,不对称:它问「query 的词有几成被 text 盖住」,还
 * 会在整句子串命中时直接给 1。轮次条目的长度差着两个数量级(`User: 好的` 对 2000 字
 * 的一轮),单向 `relevanceScore(新, 旧)` 于是有个致命后果 —— **任何短文本会被任何长
 * 文本吞掉**:「好的」的词全被一条长轮次覆盖 ⇒ 1.0 ⇒ 折叠,而它们根本不是同一件事。
 *
 * atomic-facts 敢用单向,是因为那里两边都是等长的单句事实;这里不行。于是取
 * {@link mutualCoverage} = 两个方向的**较小者**:短的要被长的盖住,长的也要被短的盖住,
 * 只有真的「说的是同一件事」才两头都过。阈值仍与 `DEFAULT_FACT_DEDUP_THRESHOLD` **同源**
 * —— 变严的是比法,不是那个数。
 *
 * # 失败姿态:fail-**open**(与 M3c 相反,这是故意的)
 *
 * 任何一步出岔(没有 `patchMeta`、`recall` 抛错、目标条并发消失、patch 返回 false)
 * ⇒ **照常写下这一轮**。M3c 降温失败 = 少回收一点字节,忍得了;M4 失败若 fail-closed
 * = **丢掉用户这一轮对话**,忍不了。省字节永远排在不丢记录后面。
 */

import type { MemoryEntry, MemoryHandle, NewMemoryEntry } from '@gotong/services-sdk'

import { DEFAULT_FACT_DEDUP_THRESHOLD } from './atomic-facts.js'
import { linksOf, mergeLinks, META_LINKS } from './links.js'
import { relevanceScore } from './relevance.js'
import { reinforcedMeta } from './salience.js'
import { temporalOf } from './temporal.js'

/**
 * 回看窗:只比同 kind 最近这么多条。
 *
 * 比 atomic-facts 的 `ATOMIC_FACTS_RECALL_WINDOW = 10_000` 小三个数量级,因为两者跑
 * 的频率差三个数量级:那个 6h 一次、要覆盖全店;这个**每轮都跑**,扫一万条就是把成本
 * 从蒸馏挪到了热路径。复述几乎总是紧邻发生,小窗够用。
 */
export const DEFAULT_NOVELTY_WINDOW = 20

/** meta 键:这一条吸收过多少次复述。 */
export const META_RESTATED = 'restatedCount'

/**
 * 读一条吸收过的复述次数。
 *
 * 为什么不复用 `recallCount` 一个数了事:`recallCount` 的语义是「被召回过几次」(读),
 * 复述是**写**。设计要求折叠时 `recallCount+1`(这样 `effectiveSalience` 会把反复被
 * 提起的事顶上去 —— 正是「用则存」),照办;但两者混在一个计数里之后,盘上就再也分不
 * 清「被翻出来看了 10 次」和「被重复说了 10 次」。多一个小整数换回这个区分,也正好是
 * 折叠发生过的**审计痕迹** —— 否则一次折叠在盘上不留任何可证伪的印子。
 */
export function restatedCountOf(entry: Pick<MemoryEntry, 'meta'>): number {
  const raw = (entry.meta as Record<string, unknown> | undefined)?.[META_RESTATED]
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

/**
 * 双向覆盖度 ∈ [0,1]:两个方向 {@link relevanceScore} 的较小者。对称
 * (`mutualCoverage(a,b) === mutualCoverage(b,a)`),这正是「像不像」该有的性质。
 */
export function mutualCoverage(a: string, b: string): number {
  return Math.min(relevanceScore(a, b), relevanceScore(b, a))
}

export interface NoveltyVerdict {
  /** 新颖 ⇒ 照常写。 */
  readonly novel: boolean
  /** 复述时:该折进哪一条。新颖时 `undefined`。 */
  readonly foldInto?: string
  /** 命中的最高双向覆盖度(没有候选时 0)。 */
  readonly score: number
}

export interface JudgeNoveltyOptions {
  /** 折叠阈值。默认 {@link DEFAULT_FACT_DEDUP_THRESHOLD} —— 与 6h 链去重同源。 */
  readonly threshold?: number
}

/**
 * 判新颖还是复述。**纯函数**:不碰入参、不碰磁盘、不叫模型,同样入参同样出参。
 *
 * 它只判「像不像」,**永远不判「对不对」** —— 判对错要模型、要上下文、会误删,那是
 * 6h 链上 reconcile 的活。
 *
 * 平手时取**分高**的;同分取**最新**的(`ts` 大)。取最新而不是最旧,是因为折叠会给
 * 目标条 `recallCount+1`,落在最新的那条上,那条链才继续往前走;落在最旧的那条上,
 * 一串复述会把一个早就该被 tiered 蒸馏掉的老条钉在高显著性上。
 */
export function judgeNovelty(
  text: string,
  recent: readonly MemoryEntry[],
  opts: JudgeNoveltyOptions = {},
): NoveltyVerdict {
  const threshold = opts.threshold ?? DEFAULT_FACT_DEDUP_THRESHOLD
  let best: MemoryEntry | undefined
  let bestScore = 0
  for (const e of recent) {
    const s = mutualCoverage(text, e.text)
    if (s <= 0) continue
    if (s > bestScore || (s === bestScore && best !== undefined && e.ts > best.ts)) {
      best = e
      bestScore = s
    }
  }
  if (!best || bestScore < threshold) return { novel: true, score: bestScore }
  return { novel: false, foldInto: best.id, score: bestScore }
}

export interface NoveltyGateOptions {
  readonly memory: MemoryHandle
  /** 现在。默认 `Date.now`。 */
  readonly now?: () => number
  /** 回看窗。默认 {@link DEFAULT_NOVELTY_WINDOW}。 */
  readonly window?: number
  /** 阈值。默认 {@link DEFAULT_FACT_DEDUP_THRESHOLD}。 */
  readonly threshold?: number
}

export interface NoveltyOutcome {
  /** true = 折进既有条,盘上没有新条目。 */
  readonly folded: boolean
  /** 折进的既有条 id,或新写下那条的 id。 */
  readonly id: string
  /** 判定时的最高双向覆盖度。 */
  readonly score: number
}

/**
 * 过门再写:近重复 ⇒ 强化既有条 + 一条时序边,**不产生新字节**;否则照常 `remember`。
 *
 * # 那条时序边连到哪
 *
 * 折叠不产生新节点,所以边不可能连到「新条」。它连的是 **目标条 ↔ 当下最新的那条**:
 * 这次复述发生在当下这段对话旁边,这条边把一个躺在过去的节点**拉回现在的邻域**。
 * 没有它,一条被反复提起的记忆显著性会涨,却在联想网里仍然孤悬在旧时间段 —— 从当下
 * 的种子两跳走不到它。边在 `assoc-net` 里**是无向的**(`diffuse` 两头都走),所以只
 * patch 目标条一处就够,不必再回写一次。
 */
export async function rememberNovel(
  entry: NewMemoryEntry,
  opts: NoveltyGateOptions,
): Promise<NoveltyOutcome> {
  const append = async (score: number): Promise<NoveltyOutcome> => {
    const e = await opts.memory.remember(entry)
    return { folded: false, id: e.id, score }
  }

  // Lexical similarity cannot prove two timed occurrences are the same event.
  if (temporalOf(entry)) return append(0)
  // 没有改 meta 的手 ⇒ 折叠无处落账(强化、边、审计痕迹都写不下)⇒ 照常写。
  const patch = opts.memory.patchMeta?.bind(opts.memory)
  if (!patch) return append(0)

  const k = Math.max(1, Math.floor(opts.window ?? DEFAULT_NOVELTY_WINDOW))
  let recent: MemoryEntry[]
  try {
    recent = await opts.memory.recall({ kinds: [entry.kind], k })
  } catch {
    return append(0)
  }

  const verdict = judgeNovelty(
    entry.text,
    recent.filter(e => !temporalOf(e)),
    opts.threshold !== undefined ? { threshold: opts.threshold } : {},
  )
  if (verdict.novel || verdict.foldInto === undefined) return append(verdict.score)

  const target = recent.find((e) => e.id === verdict.foldInto)
  if (!target) return append(verdict.score)

  const now = (opts.now ?? Date.now)()
  // `recall` 是新到旧,所以 [0] 就是当下最新的那条。它正是目标条时不写这条边 ——
  // 自链本来就会被 `mergeLinks` 的 `selfId` 滤掉,这道守卫省的是**那个空的 `links: []`
  // 键**:每次自折都白落十来个字节的噪声。
  const neighbour = recent[0]
  const add = neighbour && neighbour.id !== target.id ? [neighbour.id] : []
  try {
    const ok = await patch(target.id, {
      ...reinforcedMeta(target, now),
      [META_RESTATED]: restatedCountOf(target) + 1,
      ...(add.length > 0
        ? { [META_LINKS]: mergeLinks(linksOf(target), add, target.id) }
        : {}),
    })
    // 目标条并发没了 ⇒ 强化落空 ⇒ 这一轮必须照常留下,否则它凭空消失。
    if (!ok) return append(verdict.score)
  } catch {
    return append(verdict.score)
  }
  return { folded: true, id: target.id, score: verdict.score }
}
