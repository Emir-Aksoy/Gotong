/**
 * cooling.ts — 阶梯第 ③ 级「降温」:把最冷的那些事实**翻篇**,不硬删(记忆经济 M3c)。
 *
 * # 降温不是删除,这一点是结构性的
 *
 * 这个模块**没有一行 `forget`**,也没有任何一处调用模型。它只做两件事,两件都是改
 * meta:
 *
 *   - **翻篇**:给最冷的事实盖一个 `validTo`(`closedMeta`)。事实还在盘上、还能被
 *     按 id 读到、还能被审计翻出来;它只是不再是「现在」的事实。
 *   - **剪死链**:把 `meta.links` 里指向已经不存在的 id 的那些指针摘掉。
 *
 * 字节因此**一个都没少**(翻篇甚至让 meta 微微变大)。真正回收字节的是下一段:
 *
 *   ③ 降温挑出谁是冷的 → 盖 `validTo` → 它们落进「已过期」带
 *     → `enforceBudget` 的 `evictExpiredFirst`(M3b 刚通电)**优先**逐掉它们
 *     → 字节这才下来。
 *
 * 所以两条红线在这一层是这么落地的:**判断谁冷**在这里(纯函数、可复现、零模型),
 * **动手回收**在 `enforceBudget`。
 *
 * 说准一点(第一版写成「全仓恰好一把剪刀」,那是错的:`grep -rn '\.forget('` 在
 * `src/` 下有十几处 —— 模型自己的 `forget` 工具、reconcile 的取代、consolidate 蒸馏
 * 后的收尾、clean-outputs 的陈旧产物、dreaming 的剪枝……)。真正成立的是这一条:
 * **压力驱动的自动逐出只有 `enforceBudget` 一处,而记忆经济这一层一处都不加**。
 *
 * # 只翻「散装语义事实」,不翻别的四种
 *
 * 降温的对象恰好是 `levelRank === 1` 那一层 —— 模型 `remember` 下来的散装事实。
 * 另外三层各有各的不该翻的理由,而且理由都不是口味问题:
 *
 *   - **episodic**:流水账不是「事实」,没有有效区间可言;何况它本来就排在逐出队列
 *     最前面,翻它一个字节都换不来。
 *   - **digest / profile**:它们在逐出序里排 2 和 3,是**最受保护**的两层。翻篇会把
 *     它们送进「已过期」带 —— 那是队列**最前面**。也就是说,一次「降温」会把全库
 *     最该留的东西变成最先被逐的东西,**倒置整个分层保护**。这种反转不该藏在一个
 *     叫「降温」的动作里。
 *
 * 「是不是散装语义」这个判断**借用逐出那一处的 `levelRank`**,不另写一份:两份实现
 * 一旦漂移,上面那个倒置就会悄悄发生,而没有任何一处会报错。
 *
 * 由此也画出了这一刀的适用边界:压力来自 episodic 山堆时降温**帮不上忙**(那种情形
 * `enforceBudget` 本来就先逐 episodic);降温治的是**散装事实层长年累加**那种胖法 ——
 * 也正是原子事实抽取每 6 小时往里加的那一层。
 *
 * # 「冷」怎么定义
 *
 * 用 `effectiveSalience` —— 与逐出**同一个**打分函数。降温和逐出要是各用一套「冷」的
 * 定义,就会出现「降温判它冷、逐出判它热」的对打,谁也说不清系统到底在干什么。
 *
 * # 四种东西永远不降温
 *
 *   - **钉住的**(importance 5):`effectiveSalience` 里钉住的不衰减,已经把它排在最冷序的
 *     最末;这里再挡一道,是因为「钉住的永不自动消失」这条契约不该依赖另一个函数的实现
 *     细节。两层的分工可以量出来:尺子上那条 `pin-never-cools` 只到得了第一层(拆掉这道
 *     守卫它照样满分),真正咬合这道守卫的是压力大到要吃穿整层散装事实的时候。
 *   - **已经盖过 `validTo` 的**:再盖一次只会把翻篇时间改晚,凭空篡改历史。
 *   - **还没生效的未来事实**(`validFrom > now`):给它盖 `validTo` 会造出
 *     `validFrom > validTo` 这种自相矛盾的区间,而它的「意图」本来是明确的。
 *   - **刚写下的**(保护期):把 `DEFAULT_PROTECT_RECENT_EPISODIC` 的思路推广到
 *     事实层 —— 否则「刚说的话立刻被判定为不重要」,那是任何记忆系统最难看的失败。
 *
 * # 降多少
 *
 * 不按条数按**字节**:调用方算出「要让多少字节变得可回收」,这里就按最冷优先累加到够
 * 为止。按条数会在长短悬殊的语料上要么降不够、要么降过头。另有一个每 tick 的硬顶,
 * 免得一次压力尖峰把半个库翻篇。
 */

import { closedMeta, isClosed, validFromOf } from './bitemporal.js'
import { entryBytes, levelRank } from './budget.js'
import { PIN_IMPORTANCE, importanceOf } from './importance.js'
import { linksOf, META_LINKS } from './links.js'
import { readLedger, type LedgerRung } from './memory-ledger.js'
import type { MemoryReviewer, ReviewContext, ReviewOutcome } from './review.js'
import { effectiveSalience, type SalienceOptions } from './salience.js'
import { DEFAULT_TIERS } from './tiers.js'
import type { MemoryEntry } from '@gotong/services-sdk'

/** 逐出序里「散装语义事实」那一层的 rank。降温只动这一层 —— 见模块顶注。 */
export const AD_HOC_LEVEL_RANK = 1

/** 保护期:最近写下的这么多条**散装事实**不参与降温。 */
export const DEFAULT_PROTECT_RECENT = 8

/** 一个 tick 最多翻多少条。压力尖峰不该换来半个库被翻篇。 */
export const DEFAULT_MAX_COOL_PER_TICK = 50

/** 阶梯开到这一级(或更高)才降温。 */
export const COOLING_RUNG: LedgerRung = 3

/** 因保护而被跳过的条数,分门别类。诊断用:降不动时得看得出是被谁挡住的。 */
export interface CoolingSkipped {
  /** 不是散装语义事实(episodic / digest / profile)。 */
  readonly notAdHoc: number
  readonly pinned: number
  /** 已经盖过 `validTo`。 */
  readonly closed: number
  /** `validFrom` 还在未来。 */
  readonly future: number
  /** 落在保护期里。 */
  readonly recent: number
}

export interface CoolingSelection {
  /** 该翻篇的 id,最冷的在前。 */
  readonly close: readonly string[]
  /** 这些条目加起来多少字节 —— 也就是这一轮让多少字节变得可回收。 */
  readonly bytes: number
  readonly skipped: CoolingSkipped
}

export interface SelectForCoolingOptions {
  /** 时钟。衰减、「已翻篇」、「未来事实」三处都要它。 */
  readonly now: number
  /** 要让多少字节变得可回收。累加到够就停。 */
  readonly targetBytes: number
  /** 衰减 / 强化。与逐出用同一份 —— 见模块顶注。 */
  readonly salience?: SalienceOptions
  /** 保护期条数。默认 {@link DEFAULT_PROTECT_RECENT}。 */
  readonly protectRecent?: number
  /** 每 tick 硬顶。默认 {@link DEFAULT_MAX_COOL_PER_TICK}。 */
  readonly maxPerTick?: number
}

/**
 * 挑出该翻篇的那些。**纯函数**:不碰入参,不写盘,同样入参同样出参。
 */
export function selectForCooling(
  entries: readonly MemoryEntry[],
  opts: SelectForCoolingOptions,
): CoolingSelection {
  const protectRecent = Math.max(0, Math.floor(opts.protectRecent ?? DEFAULT_PROTECT_RECENT))
  const maxPerTick = Math.max(0, Math.floor(opts.maxPerTick ?? DEFAULT_MAX_COOL_PER_TICK))

  const adHoc = entries.filter((e) => levelRank(e, DEFAULT_TIERS) === AD_HOC_LEVEL_RANK)
  const skipped = {
    notAdHoc: entries.length - adHoc.length,
    pinned: 0,
    closed: 0,
    future: 0,
    recent: 0,
  }

  // 保护期在**散装事实内部**算:拿全库最新的 8 条会被一堆刚捕获的 episodic 占满,
  // 那样保护期就等于没有 —— 挡住的全是本来就不参与降温的东西。
  const recentIds = new Set(
    [...adHoc]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, protectRecent)
      .map((e) => e.id),
  )

  const eligible: MemoryEntry[] = []
  for (const e of adHoc) {
    if (importanceOf(e) >= PIN_IMPORTANCE) {
      skipped.pinned += 1
      continue
    }
    if (isClosed(e)) {
      skipped.closed += 1
      continue
    }
    const from = validFromOf(e)
    if (from !== undefined && opts.now < from) {
      skipped.future += 1
      continue
    }
    if (recentIds.has(e.id)) {
      skipped.recent += 1
      continue
    }
    eligible.push(e)
  }

  const ranked = eligible.sort((a, b) => {
    const s =
      effectiveSalience(a, opts.now, opts.salience) - effectiveSalience(b, opts.now, opts.salience)
    if (s !== 0) return s
    if (a.ts !== b.ts) return a.ts - b.ts // 同样冷时先翻更旧的
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const close: string[] = []
  let bytes = 0
  for (const e of ranked) {
    if (bytes >= opts.targetBytes || close.length >= maxPerTick) break
    close.push(e.id)
    bytes += entryBytes(e)
  }
  return { close, bytes, skipped }
}

/**
 * 找出所有指向已不存在条目的链接,给出**只含 links 一个键**的 meta 补丁。
 *
 * 返回补丁而不是整份 meta:同 `closedMeta` / `reinforcedMeta` 的纪律 —— 重新摊开整个
 * meta 会把这一刻的陈旧快照写回去,覆盖掉别的写者刚改的东西。
 *
 * 纯函数。链接完好的条目**不出现在结果里**,所以「没有死链」等于「零次写」。
 *
 * 注意「已不存在」判的是 `entries` 里有没有这个 id,所以调用方必须把**整个命名空间**
 * 传进来。只喂一个子集,活着的邻居会被误判成死的 —— 剪掉的是真链接。
 */
export function pruneDeadLinks(
  entries: readonly MemoryEntry[],
): { id: string; patch: Record<string, unknown> }[] {
  const alive = new Set(entries.map((e) => e.id))
  const out: { id: string; patch: Record<string, unknown> }[] = []
  for (const e of entries) {
    const links = linksOf(e)
    if (links.length === 0) continue
    const kept = links.filter((id) => alive.has(id))
    if (kept.length === links.length) continue
    out.push({ id: e.id, patch: { [META_LINKS]: kept } })
  }
  return out
}

export interface CoolingReviewerOptions {
  /** 这个成员的字节预算 —— 压力的分母。与 `tieredReviewer` 用同一个数。 */
  readonly budgetBytes: number
  /** 衰减 / 强化,透传给打分。与逐出用同一份。 */
  readonly salience?: SalienceOptions
  /** 保护期条数。 */
  readonly protectRecent?: number
  /** 每 tick 硬顶。 */
  readonly maxPerTick?: number
}

/**
 * 把降温包成 6h 链上的一个 reviewer。
 *
 * 位置:**链头**,在 `tieredReviewer` 之前。因为 tiered 内部最后一步就是
 * `enforceBudget`(执法回收),降温必须先把冷的翻篇,回收才看得见它们躺在过期带里。
 *
 * 用量与 `enforceBudget` 量的是同一把秤(`entryBytes` 逐条相加,与它的默认 `measure`
 * 逐字节相同),所以「压力」和「会不会真的被逐」说的是同一件事。
 *
 * 账目这里只有**一行**(记忆这一个面),`readLedger` 的跨面取最大在此退化为一个除法 ——
 * 仍然走它,是为了压力这个数只有一处实现:阈值、滞回、上限 ≤0 的保护,统统同源。
 * 知识库那一面不在这里,它守的是货架数不是字节,是另一把刀的事。
 *
 * 阶梯状态(上一次的级数)**住在这个闭包里**:滞回是进程内的平滑,重启回到 0 只意味着
 * 「按升级线判」,那正是 `readLedger` 记录在案的冷启动行为 —— 不为它落一个状态文件。
 *
 * 压力不到第 ③ 级 ⇒ 一条都不翻,返回 `{}`(空闲),链上其余环节照跑。
 */
export function coolingReviewer(opts: CoolingReviewerOptions): MemoryReviewer {
  let priorRung: LedgerRung = 0

  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    const entries = await ctx.memory.list({ limit: 10_000 })
    if (entries.length === 0) return {}

    const used = entries.reduce((sum, e) => sum + entryBytes(e), 0)
    const reading = readLedger(
      [{ store: 'memory', usedBytes: used, budgetBytes: opts.budgetBytes }],
      priorRung,
    )
    priorRung = reading.rung
    if (reading.rung < COOLING_RUNG) return {}

    const patch = ctx.memory.patchMeta?.bind(ctx.memory)
    // 后端不支持改 meta ⇒ 降温这条路在这个部署上不存在。硬删**不是**退路。
    if (!patch) return {}

    // 目标:让「超出预算的那部分」变得可回收。刚好够,不多翻。第 ③ 级的下沿是
    // 九成满,那时还没超预算 ⇒ 目标为 0 ⇒ 一条都不翻,只剪死链。降温因此是
    // 「压力到了就**准备好**」,不是「压力到了就**动手**」。
    const targetBytes = Math.max(0, used - opts.budgetBytes)
    const sel = selectForCooling(entries, {
      now: ctx.now,
      targetBytes,
      ...(opts.salience ? { salience: opts.salience } : {}),
      ...(opts.protectRecent !== undefined ? { protectRecent: opts.protectRecent } : {}),
      ...(opts.maxPerTick !== undefined ? { maxPerTick: opts.maxPerTick } : {}),
    })

    let closed = 0
    for (const id of sel.close) {
      if (await patch(id, closedMeta(undefined, ctx.now))) closed += 1
    }

    // 剪死链也守在这一级下面,不是随手放宽:死链是**逐出造出来的**(被链向的条目
    // 被回收了),而逐出只在有压力时发生。压力没到 ⇒ 没有新死链 ⇒ 这一趟本来就该
    // 一个字节都不写。
    let pruned = 0
    for (const p of pruneDeadLinks(entries)) {
      if (await patch(p.id, p.patch)) pruned += 1
    }

    if (closed === 0 && pruned === 0) return {}
    const parts: string[] = []
    if (closed > 0) parts.push(`降温翻篇 ${closed} 条(${sel.bytes} 字节转为可回收)`)
    if (pruned > 0) parts.push(`剪死链 ${pruned} 条`)
    return { summary: parts.join(';') }
  }
}
