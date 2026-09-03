/**
 * memory-ledger.ts — 记忆账的纯核：把「用了多少 / 上限多少」折成一个压力数，
 * 再折成一个**该开到第几级**的判断（记忆经济 M3a）。
 *
 * # 这一层的契约
 *
 * **它只算账，不动任何东西。** 零 I/O、零模型调用、零副作用——传进来一组读数，
 * 返回一个判断。谁去执行第几级、执行成什么样，是调用方的事；这里连一个 store
 * 的名字都不认识（`store` 是一个开放的字符串），因为记忆账要能同时管住五个
 * 结构完全不同的面。
 *
 * 两条红线在这一层的形式：这个模块**没有一行删除**，也没有任何一处调用模型。
 * 第 ④ 级返回的只是「④」这个数字；真正的剪刀在别处，且全仓恰好一把。
 *
 * # 压力取的是**最紧那个面**,不是总和比
 *
 * `pressure = max(每个面各自的用量/预算)`。
 *
 * 只看总和比会漏掉真问题:知识库塞满 4 MiB、记忆区空着 8 MiB 时,总和比只有
 * 33%,可知识库**已经写不进去了**——下一次上架就会失败。
 *
 * 一度写成 `max(总和比, 单面最大)`,写用例时才发现那个 `max` 是**死的**:总和比
 * = `Σuᵢ/Σbᵢ` = 各面压力按预算加权的平均,而加权平均恒 ≤ 最大值,所以总和比那
 * 一项永远赢不了。顺带推翻了当初写它的理由(「五个面都七成满时总量已越界」——
 * 都七成满,总量就是七成)。于是只留最大值;总用量/总预算仍照报,但那是**报表
 * 不是判据**。
 *
 * # 阶梯为什么带滞回
 *
 * 阶梯是**逐级累加**的：开到第三级意味着一二三都做。所以级数在阈值上下抖动的
 * 代价不是「多做一点」，而是「每个 tick 都在开关一整套动作」——降温刚把一批
 * 事实翻篇、压力落回阈值下、下一个 tick 又不降温、再下一个 tick 又降温。
 *
 * 于是每一级有两条线:**升级看高线,降级看低线**(高线 − {@link RUNG_HYSTERESIS})。
 * 升级不需要滞回,升得越快越好;要防的是**降下来之后又立刻升回去**。
 *
 * # 阈值是模块常量,不是旋钮
 *
 * M0 把 `GOTONG_*` 旋钮数冻结在 114。这里的四个阈值是**代码常量**:它们描述的是
 * 「多满算满」这件事本身,不是部署差异。要改就改代码、跑门、留 commit 记录,
 * 而不是让某台机器上的环境变量悄悄换掉记忆的行为。
 */

/** 一个面的读数:用了多少字节,上限多少字节。 */
export interface LedgerLine {
  /** 面的名字。开放字符串——这一层不认识具体有哪几个店。 */
  readonly store: string
  readonly usedBytes: number
  /** 该面的上限。必须 > 0;≤0 视为「这个面没有上限」而被跳过(见 {@link readLedger})。 */
  readonly budgetBytes: number
}

/** 一个面算完之后的读数。 */
export interface LedgerStoreReading extends LedgerLine {
  /** `usedBytes / budgetBytes`,不封顶——1.4 就是超了四成,截到 1 会把「爆了多少」抹掉。 */
  readonly pressure: number
}

/**
 * 四级阶梯。数字**就是**级数,`0` = 什么都不用做。
 *
 * 逐级累加:`3` 意味着一二三都开。每一级具体做什么由调用方定义,这一层只判
 * 「开到几」。
 */
export type LedgerRung = 0 | 1 | 2 | 3 | 4

/** 各级的**升级**线(压力 ≥ 该值即开)。降级线是它减去 {@link RUNG_HYSTERESIS}。 */
export const RUNG_OPEN_AT: Readonly<Record<Exclude<LedgerRung, 0>, number>> = {
  /** ① 合并去重:六成满就该开始折叠复述了 —— 这一级不损失任何信息。 */
  1: 0.6,
  /** ② 压缩:蒸馏与上架。有损但可读,所以比①晚。 */
  2: 0.75,
  /** ③ 降温:翻篇与归档。开始有东西离开视野,所以要接近满才开。 */
  3: 0.9,
  /** ④ 遗忘:只有真的越界才谈得上,而且执行方还得先确认有备份。 */
  4: 1,
}

/**
 * 滞回带宽。升到某级后,压力要掉到「升级线 − 这个值」以下才降级。
 *
 * 0.05 挑的是「比一次降温通常能回收的量小,比测量噪声大」:小于它,阶梯会在
 * 一次成功的降温之后立刻自我否定;大于它,系统会在明显不紧的时候还在做重活。
 */
export const RUNG_HYSTERESIS = 0.05

export interface LedgerReading {
  /** 逐面读数,顺序与输入相同。 */
  readonly stores: readonly LedgerStoreReading[]
  /** 全部面的用量之和。 */
  readonly usedBytes: number
  /** 全部面的上限之和。 */
  readonly budgetBytes: number
  /** 最紧那个面的压力。**不是**总和比 —— 见模块顶注里那段推导。 */
  readonly pressure: number
  /** 压力最大的那个面的名字;没有任何有效面时为 `null`。 */
  readonly hottest: string | null
  /** 该开到第几级(已经算过滞回)。 */
  readonly rung: LedgerRung
}

/**
 * 算一次账。
 *
 * `priorRung` 是**上一次**的级数,滞回据此计算:不传就当从 0 开始(冷启动没有
 * 「刚降下来」这回事,直接按升级线判)。
 *
 * 上限 ≤ 0 或非有限数的面会被**跳过**:那表示调用方还没算出这个面的上限,
 * 而「不知道」不该被当成「压力无穷大」。用量为负数按 0 算。
 */
export function readLedger(
  lines: readonly LedgerLine[],
  priorRung: LedgerRung = 0,
): LedgerReading {
  const stores: LedgerStoreReading[] = []
  let usedBytes = 0
  let budgetBytes = 0
  let worst = 0
  let hottest: string | null = null

  for (const line of lines) {
    if (!Number.isFinite(line.budgetBytes) || line.budgetBytes <= 0) continue
    const used = Number.isFinite(line.usedBytes) ? Math.max(0, line.usedBytes) : 0
    const pressure = used / line.budgetBytes
    stores.push({ store: line.store, usedBytes: used, budgetBytes: line.budgetBytes, pressure })
    usedBytes += used
    budgetBytes += line.budgetBytes
    if (pressure > worst) {
      worst = pressure
      hottest = line.store
    }
  }

  // `worst` 就是压力本身:总和比是它的加权平均,恒不更大(见顶注)。总用量/总预算
  // 仍留在 reading 里,那是给人看的报表,不参与判据。
  return {
    stores,
    usedBytes,
    budgetBytes,
    pressure: worst,
    hottest,
    rung: rungFor(worst, priorRung),
  }
}

/**
 * 压力 → 级数,带滞回。
 *
 * 规则一句话:**能升就升,要降得降够**。逐级从高往低试,某级的线是
 * 「已经在这一级或更高 ⇒ 用降级线;否则 ⇒ 用升级线」。
 */
export function rungFor(pressure: number, priorRung: LedgerRung = 0): LedgerRung {
  const p = Number.isFinite(pressure) ? pressure : 0
  for (const rung of [4, 3, 2, 1] as const) {
    const open = RUNG_OPEN_AT[rung]
    // 已经开到这一级(或更高)时,守的是低线 —— 这就是滞回:降下来要多降一点。
    const line = priorRung >= rung ? open - RUNG_HYSTERESIS : open
    if (p >= line) return rung
  }
  return 0
}

/** 各级的人话名字,给日志与状态页用。索引即级数。 */
export const RUNG_LABELS: readonly string[] = ['静', '合并去重', '压缩', '降温', '遗忘']

/**
 * 把一次读数折成一行人话,给日志 / 状态页用。
 *
 * 不做截断也不带颜色:调用方要多短由调用方裁。
 */
export function formatLedger(reading: LedgerReading): string {
  const head =
    `【记忆账】压力 ${(reading.pressure * 100).toFixed(1)}% ` +
    `(${reading.usedBytes}/${reading.budgetBytes} 字节) ` +
    `⇒ ${reading.rung} 级「${RUNG_LABELS[reading.rung] ?? '?'}」` +
    (reading.hottest ? ` · 最紧的是 ${reading.hottest}` : '')
  const rows = reading.stores.map(
    (s) => `  · ${s.store} ${(s.pressure * 100).toFixed(1)}% (${s.usedBytes}/${s.budgetBytes})`,
  )
  return [head, ...rows].join('\n')
}
