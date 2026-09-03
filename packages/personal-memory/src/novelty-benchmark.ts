/**
 * novelty-benchmark.ts — 写侧折叠这件事的尺子(记忆经济 M4)。
 *
 * # 为什么要有这把尺
 *
 * 「复述被折叠了」很容易自证:随便量一下条数变少就说成功了。可一个**把什么都折掉**
 * 的门,条数最少、字节最省,而它把用户的记忆毁了。所以这把尺必须是**两面**的:
 *
 *   - **该折的折了**(`foldRate`):复述不产生新条目。
 *   - **不该折的一条没少**(`keepRate`):真的新一轮必须落盘。
 *
 * 全折的门在第一项 100%、第二项 0%;今天(没有门)在第一项 0%、第二项 100%。所以
 * `keepRate` 是**只能守不能涨**的那一面 —— 它的地板从第一天起就是 1.0,任何回归立刻红。
 * 省字节永远排在不丢记录后面,尺子的形状先把这句话钉死。
 *
 * # 为什么用**总量**而不是逐用例求平均
 *
 * 夹具里有几条用例是**故意一条都不该折**的(短回合陷阱、只差一个词的两件事)。逐用例
 * 求平均的话,这些用例的 `foldRate` 只能记成「空洞地满分」,于是**今天的裸 remember
 * 会凭空得到一堆 1.0** —— 基线被这些用例抬起来,量出来的抬升就假了。改成跨用例累计
 * 计数:分母是「一共有几轮该折」,没有该折的用例对它一点贡献都没有。
 *
 * (逐出尺那边可以用逐用例平均,是因为那份夹具里每条用例的 `shouldKeep`/`shouldDrop`
 * 都非空;这里不成立,所以换算法而不是照抄。)
 *
 * # 纪律(照抄 `eviction-benchmark.ts`)
 *
 *   - 尺子住 `src/`:CI 门与将来的真档 runner 跑**同一份**代码。
 *   - **零模型调用、零墙上时钟**:唯一的「现在」是 {@link NOVELTY_BENCH_NOW}。
 *   - **不新建旋钮**:阈值取包里早就写好的 `DEFAULT_FACT_DEDUP_THRESHOLD`。
 *   - 字节度量复用 `entryBytes` —— 与逐出尺、与 `enforceBudget` 同一把秤。
 *   - 夹具用的是 `buildTurnCapture` 真的会写出来的那个格式(`User: …\nButler: …`)。
 *     拿裸句子当夹具会量到一个生产里不存在的形状 —— 而且会漏掉最要紧的一件事:
 *     正是**管家的回复一起被写进去**,才让「明天的会」和「后天的会」分得开。
 */

import type { MemoryEntry, MemoryHandle, NewMemoryEntry } from '@gotong/services-sdk'

import { entryBytes } from './budget.js'

/** 这把尺子唯一的「现在」。 */
export const NOVELTY_BENCH_NOW = 1_700_000_000_000

/** 一轮:要写进去的文本,以及它该被折还是该留。 */
export interface NoveltyTurn {
  readonly text: string
  /** `fold` = 复述,不该产生新条;`keep` = 新东西,必须落盘。 */
  readonly verdict: 'fold' | 'keep'
  /** 这一轮在论证什么。空的不许进夹具。 */
  readonly why: string
}

export interface NoveltyCase {
  readonly name: string
  readonly why: string
  /** 按先后顺序写进去。第一轮必然是 `keep`(店是空的)。 */
  readonly turns: readonly NoveltyTurn[]
}

/** 造一个空的记忆句柄(调用方给,尺子不认识具体实现)。 */
export type NoveltyMemoryFactory = () => MemoryHandle | Promise<MemoryHandle>

/**
 * 被测的写侧组装。基线 = 今天的裸 `remember`(永远 `folded: false`);M4 = 过门再写。
 * 两次跑的是同一把尺、同一份夹具,差别只在这一个函数 —— 从 MU-M1 守到现在的同一条纪律。
 */
export type NoveltyWriter = (
  memory: MemoryHandle,
  entry: NewMemoryEntry,
  now: number,
) => Promise<{ readonly folded: boolean }>

export interface NoveltyCaseScore {
  readonly name: string
  /** 该折的轮数 / 其中真的没落盘的轮数。 */
  readonly folded: number
  readonly foldTotal: number
  /** 该留的轮数 / 其中真的落盘了的轮数。 */
  readonly kept: number
  readonly keepTotal: number
  /** 跑完之后这个店里的字节数。 */
  readonly bytes: number
}

export interface NoveltyBenchResult {
  /** 跨用例累计:该折的折掉了几成。没有该折的轮次时为 1(不参与抬升论证)。 */
  readonly foldRate: number
  /** 跨用例累计:该留的留住了几成。 */
  readonly keepRate: number
  /** 所有用例跑完后的字节总和。 */
  readonly bytes: number
  readonly perCase: readonly NoveltyCaseScore[]
}

/**
 * 跑一遍夹具:每条用例开一个空店,把轮次按顺序写进去,按**盘上有没有多一条**打分。
 *
 * 判据是后果不是形状:不看 writer 返回的 `folded` 说了什么,看 `list()` 前后条数有没有
 * 涨。一个返回 `folded: true` 却照样写了新条的实现,在这里必然掉分。
 */
export async function scoreNovelty(
  make: NoveltyMemoryFactory,
  cases: readonly NoveltyCase[],
  writer: NoveltyWriter,
): Promise<NoveltyBenchResult> {
  const perCase: NoveltyCaseScore[] = []

  for (const c of cases) {
    const memory = await make()
    let folded = 0
    let foldTotal = 0
    let kept = 0
    let keepTotal = 0

    for (const turn of c.turns) {
      const before = (await memory.list({ limit: 10_000 })).length
      await writer(memory, { kind: 'episodic', text: turn.text, meta: { turn: true } }, NOVELTY_BENCH_NOW)
      const grew = (await memory.list({ limit: 10_000 })).length > before
      if (turn.verdict === 'fold') {
        foldTotal += 1
        if (!grew) folded += 1
      } else {
        keepTotal += 1
        if (grew) kept += 1
      }
    }

    const left: MemoryEntry[] = await memory.list({ limit: 10_000 })
    perCase.push({
      name: c.name,
      folded,
      foldTotal,
      kept,
      keepTotal,
      bytes: left.reduce((s, e) => s + entryBytes(e), 0),
    })
  }

  const sum = (pick: (s: NoveltyCaseScore) => number): number =>
    perCase.reduce((a, s) => a + pick(s), 0)
  const foldTotal = sum((s) => s.foldTotal)
  const keepTotal = sum((s) => s.keepTotal)
  return {
    foldRate: foldTotal === 0 ? 1 : sum((s) => s.folded) / foldTotal,
    keepRate: keepTotal === 0 ? 1 : sum((s) => s.kept) / keepTotal,
    bytes: sum((s) => s.bytes),
    perCase,
  }
}

/** 一行人话,进 CI 日志 —— 免得只有地板没有实测值。 */
export function formatNoveltyResult(label: string, r: NoveltyBenchResult): string {
  const head =
    `【${label}】该折的折掉 ${(r.foldRate * 100).toFixed(1)}%  ` +
    `该留的留住 ${(r.keepRate * 100).toFixed(1)}%  盘上 ${r.bytes} 字节`
  const rows = r.perCase.map(
    (c) =>
      `  · ${c.name}  折 ${c.folded}/${c.foldTotal}  留 ${c.kept}/${c.keepTotal}  (${c.bytes} 字节)`,
  )
  return [head, ...rows].join('\n')
}
