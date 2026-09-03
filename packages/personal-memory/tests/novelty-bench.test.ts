/**
 * novelty-bench.test.ts — 写侧新颖门的门(记忆经济 M4)。
 *
 * 五组:①红线 ②纯核 ③基线(今天) ④接上门(抬升) ⑤闸门与副作用。
 *
 * 地板是**实测值截到三位小数**,只升不降。基线那一组不是摆设:它证明这份夹具在没有门
 * 的时候确实折不掉任何东西 —— 没有它,④ 的那些 1.0 分不清是门起了作用还是夹具太软。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { MemoryEntry, MemoryHandle, NewMemoryEntry } from '@gotong/services-sdk'

import {
  DEFAULT_NOVELTY_WINDOW,
  META_RESTATED,
  judgeNovelty,
  mutualCoverage,
  rememberNovel,
  restatedCountOf,
} from '../src/novelty.js'
import {
  NOVELTY_BENCH_NOW,
  formatNoveltyResult,
  scoreNovelty,
  type NoveltyWriter,
} from '../src/novelty-benchmark.js'
import { DEFAULT_FACT_DEDUP_THRESHOLD } from '../src/atomic-facts.js'
import { entryBytes } from '../src/budget.js'
import { linksOf } from '../src/links.js'
import { META_RECALL_COUNT } from '../src/salience.js'
import { NOVELTY_CASES } from './fixtures/novelty-cases.js'
import { entry, makeFakeMemory } from './fake-memory.js'

const make = () => makeFakeMemory()

/** 今天:裸 `remember`,一条都不折。 */
const BASELINE: NoveltyWriter = async (memory, e) => {
  await memory.remember(e)
  return { folded: false }
}

/** M4:过门再写。 */
const GATED: NoveltyWriter = async (memory, e, now) =>
  rememberNovel(e, { memory, now: () => now })

const BASELINE_FLOORS = { foldRate: 0, keepRate: 1 } as const
const GATED_FLOORS = { foldRate: 1, keepRate: 1 } as const

describe('M4 红线:新颖门不删任何东西', () => {
  it('模块正文里没有任何删除动作', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/novelty.ts', import.meta.url)),
      'utf8',
    )
    // 顶注里会讨论删除,判据只看正文。
    const body = src.slice(src.indexOf('*/') + 2)
    expect(body).not.toMatch(/\bforget\s*\(/)
    expect(body).not.toMatch(/\bunlink\b/)
    expect(body).not.toMatch(/\bclear\s*\(/)
    expect(body).not.toMatch(/enforceBudget/)
  })

  it('折叠 = 不写,不是写了再删', async () => {
    const memory = makeFakeMemory()
    const first = await rememberNovel(
      { kind: 'episodic', text: 'User: 明天几点开会?\nButler: 上午 10 点。' },
      { memory, now: () => NOVELTY_BENCH_NOW },
    )
    const out = await rememberNovel(
      { kind: 'episodic', text: 'User: 明天几点开会?\nButler: 上午 10 点。' },
      { memory, now: () => NOVELTY_BENCH_NOW },
    )
    expect(out.folded).toBe(true)
    expect(out.id).toBe(first.id)
    // 全程只有一条,而且就是最早那条 —— 没有「先写后删」的中间态。
    expect(memory.entries).toHaveLength(1)
    expect(memory.entries[0]!.id).toBe(first.id)
  })
})

describe('M4 纯核:mutualCoverage / judgeNovelty', () => {
  it('对称:换个顺序分数一样', () => {
    const a = 'User: 好的\nButler: 好的。'
    const b = 'User: 帮我把周报整理成三段发给张经理。\nButler: 好的,已经发了。'
    expect(mutualCoverage(a, b)).toBe(mutualCoverage(b, a))
  })

  it('短文本不会被长文本吞掉(单向会,双向不会)', async () => {
    const short = 'User: 好的\nButler: 好的。'
    const long =
      'User: 帮我把上周的项目周报整理成三段:进度、风险、下周计划,发给张经理。\n' +
      'Butler: 好的,已经整理好三段发给张经理了,风险那段我把服务器扩容排在第一位。'
    const { relevanceScore } = await import('../src/relevance.js')
    // 阳性对照:单向覆盖率确实高到会误折 —— 这一条红了说明陷阱本身失效了。
    expect(relevanceScore(short, long)).toBeGreaterThanOrEqual(DEFAULT_FACT_DEDUP_THRESHOLD)
    expect(mutualCoverage(short, long)).toBeLessThan(DEFAULT_FACT_DEDUP_THRESHOLD)
  })

  it('空店 / 无重合 ⇒ 新颖', () => {
    expect(judgeNovelty('随便一句', []).novel).toBe(true)
    const other = [entry('a', 'episodic', 'zzz completely unrelated', 1)]
    expect(judgeNovelty('毫不相干的中文', other).novel).toBe(true)
  })

  it('原样复述 ⇒ 折,并指名折进哪一条', () => {
    const e = entry('a', 'episodic', 'User: 明天几点开会?\nButler: 上午 10 点。', 1)
    const v = judgeNovelty(e.text, [e])
    expect(v.novel).toBe(false)
    expect(v.foldInto).toBe('a')
    expect(v.score).toBe(1)
  })

  it('同分取最新的那条(复述要把最新的链往前推)', () => {
    const text = 'User: 明天几点开会?\nButler: 上午 10 点。'
    const older = entry('old', 'episodic', text, 100)
    const newer = entry('new', 'episodic', text, 900)
    // 故意把旧的排在前面,证明挑的是 ts 而不是数组顺序。
    expect(judgeNovelty(text, [older, newer]).foldInto).toBe('new')
  })

  it('阈值与 6h 链去重同源', async () => {
    const mod = await import('../src/novelty.js')
    const src = readFileSync(
      fileURLToPath(new URL('../src/novelty.ts', import.meta.url)),
      'utf8',
    )
    expect(src).toMatch(/DEFAULT_FACT_DEDUP_THRESHOLD/)
    expect(mod.DEFAULT_NOVELTY_WINDOW).toBeLessThan(1000)
  })

  it('纯:同样入参同样出参,不碰入参', () => {
    const corpus = [entry('a', 'episodic', 'User: 明天几点开会?\nButler: 上午 10 点。', 1)]
    const snapshot = JSON.stringify(corpus)
    const first = judgeNovelty('User: 明天几点开会?\nButler: 上午 10 点。', corpus)
    const second = judgeNovelty('User: 明天几点开会?\nButler: 上午 10 点。', corpus)
    expect(second).toEqual(first)
    expect(JSON.stringify(corpus)).toBe(snapshot)
  })
})

describe('M4 基线:今天的裸 remember', () => {
  it('一条都折不掉,但一条也没丢', async () => {
    const r = await scoreNovelty(make, NOVELTY_CASES, BASELINE)
    // eslint-disable-next-line no-console
    console.log(formatNoveltyResult('基线(今天)', r))
    expect(r.foldRate).toBe(BASELINE_FLOORS.foldRate)
    expect(r.keepRate).toBe(BASELINE_FLOORS.keepRate)
    // 夹具里确实有该折的轮次 —— 否则 ④ 的满分是空洞的。
    expect(r.perCase.reduce((a, c) => a + c.foldTotal, 0)).toBeGreaterThan(0)
  })
})

describe('M4 接上新颖门', () => {
  it('该折的折掉,该留的一条没少,字节下降', async () => {
    const base = await scoreNovelty(make, NOVELTY_CASES, BASELINE)
    const gated = await scoreNovelty(make, NOVELTY_CASES, GATED)
    // eslint-disable-next-line no-console
    console.log(formatNoveltyResult('接上新颖门', gated))
    expect(gated.foldRate).toBeGreaterThanOrEqual(GATED_FLOORS.foldRate)
    expect(gated.keepRate).toBeGreaterThanOrEqual(GATED_FLOORS.keepRate)
    expect(gated.foldRate).toBeGreaterThan(base.foldRate)
    expect(gated.bytes).toBeLessThan(base.bytes)
  })

  it('控制组一条都不许折', async () => {
    const gated = await scoreNovelty(make, NOVELTY_CASES, GATED)
    const control = gated.perCase.find((c) => c.name === 'all-novel')!
    expect(control.foldTotal).toBe(0)
    expect(control.kept).toBe(control.keepTotal)
  })

  it('只差一个词的两件事没被合成一件', async () => {
    const gated = await scoreNovelty(make, NOVELTY_CASES, GATED)
    const c = gated.perCase.find((c) => c.name === 'one-word-apart')!
    expect(c.kept).toBe(2)
  })
})

describe('M4 闸门:出岔一律照常写(fail-open)', () => {
  const dup = { kind: 'episodic' as const, text: 'User: 明天几点开会?\nButler: 上午 10 点。' }

  const seeded = (): MemoryHandle & { entries: readonly MemoryEntry[] } => {
    const m = makeFakeMemory()
    void m.remember(dup as NewMemoryEntry)
    return m
  }

  it('没有 patchMeta ⇒ 照常写', async () => {
    const m = seeded()
    const noPatch: MemoryHandle = { ...m, patchMeta: undefined }
    const out = await rememberNovel(dup, { memory: noPatch, now: () => NOVELTY_BENCH_NOW })
    expect(out.folded).toBe(false)
    expect(m.entries).toHaveLength(2)
  })

  it('recall 抛错 ⇒ 照常写', async () => {
    const m = seeded()
    const broken: MemoryHandle = {
      ...m,
      recall: async () => {
        throw new Error('backend down')
      },
    }
    const out = await rememberNovel(dup, { memory: broken, now: () => NOVELTY_BENCH_NOW })
    expect(out.folded).toBe(false)
    expect(m.entries).toHaveLength(2)
  })

  it('patchMeta 返回 false(目标条并发没了)⇒ 照常写', async () => {
    const m = seeded()
    const gone: MemoryHandle = { ...m, patchMeta: async () => false }
    const out = await rememberNovel(dup, { memory: gone, now: () => NOVELTY_BENCH_NOW })
    expect(out.folded).toBe(false)
    expect(m.entries).toHaveLength(2)
  })

  it('patchMeta 抛错 ⇒ 照常写', async () => {
    const m = seeded()
    const boom: MemoryHandle = {
      ...m,
      patchMeta: async () => {
        throw new Error('disk full')
      },
    }
    const out = await rememberNovel(dup, { memory: boom, now: () => NOVELTY_BENCH_NOW })
    expect(out.folded).toBe(false)
    expect(m.entries).toHaveLength(2)
  })

  it('回看窗是硬边界:掉出窗外的复述不折(带阳性对照)', async () => {
    const memory = makeFakeMemory()
    const text = 'User: 明天几点开会?\nButler: 上午 10 点。'
    const filler = ['User: 磁盘还剩多少?\nButler: 剩 12 GB。', 'User: 学费何时交?\nButler: 8 月 15 起。']
    await rememberNovel({ kind: 'episodic', text }, { memory, window: 2 })
    for (const t of filler) await rememberNovel({ kind: 'episodic', text: t }, { memory, window: 2 })

    // 原始那条已经被两条无关的顶出 2 条的窗外 —— 折不到。
    expect((await rememberNovel({ kind: 'episodic', text }, { memory, window: 2 })).folded).toBe(false)
    // 阳性对照:同样的店、同样的文本,窗放大就折得到 —— 证明上面那个 false 是窗造成的,
    // 不是「这两条根本不像」。
    expect((await rememberNovel({ kind: 'episodic', text }, { memory, window: 10 })).folded).toBe(true)
  })

  it('回看窗只看最近若干条,而且只看同 kind', async () => {
    const m = makeFakeMemory()
    const seen: unknown[] = []
    const spy: MemoryHandle = {
      ...m,
      recall: async (q) => {
        seen.push(q)
        return m.recall(q)
      },
    }
    await rememberNovel({ kind: 'semantic', text: '用户最爱珍珠奶茶' }, { memory: spy })
    expect(seen).toEqual([{ kinds: ['semantic'], k: DEFAULT_NOVELTY_WINDOW }])
  })
})

describe('M4 折叠的副作用:强化 + 审计痕迹 + 时序边', () => {
  it('recallCount+1、restatedCount+1', async () => {
    const memory = makeFakeMemory()
    const text = 'User: 明天几点开会?\nButler: 上午 10 点。'
    const first = await rememberNovel({ kind: 'episodic', text }, { memory, now: () => 5_000 })
    await rememberNovel({ kind: 'episodic', text }, { memory, now: () => 6_000 })
    await rememberNovel({ kind: 'episodic', text }, { memory, now: () => 7_000 })

    const target = memory.entries.find((e) => e.id === first.id)!
    expect(target.meta?.[META_RECALL_COUNT]).toBe(2)
    expect(restatedCountOf(target)).toBe(2)
    expect(target.meta?.[META_RESTATED]).toBe(2)
    expect(memory.entries).toHaveLength(1)
  })

  it('折进的那条连上当下最新的一条(把旧节点拉回现在的邻域)', async () => {
    const memory = makeFakeMemory()
    const old = await rememberNovel(
      { kind: 'episodic', text: 'User: 明天几点开会?\nButler: 上午 10 点。' },
      { memory, now: () => 1_000 },
    )
    const recent = await rememberNovel(
      { kind: 'episodic', text: 'User: 帮我订周五飞吉隆坡的机票。\nButler: 最早 7 点 40。' },
      { memory, now: () => 2_000 },
    )
    expect(recent.folded).toBe(false)

    await rememberNovel(
      { kind: 'episodic', text: 'User: 明天几点开会?\nButler: 上午 10 点。' },
      { memory, now: () => 3_000 },
    )
    const target = memory.entries.find((e) => e.id === old.id)!
    expect(linksOf(target)).toContain(recent.id)
  })

  it('目标条自己就是最新那条时,连 links 键都不写', async () => {
    const memory = makeFakeMemory()
    const text = 'User: 明天几点开会?\nButler: 上午 10 点。'
    const first = await rememberNovel({ kind: 'episodic', text }, { memory, now: () => 1_000 })
    await rememberNovel({ kind: 'episodic', text }, { memory, now: () => 2_000 })
    const target = memory.entries.find((e) => e.id === first.id)!
    expect(linksOf(target)).toEqual([])
    // 判据是**没有这个键**,不是「键在但是空的」。第一版就写成了后者,于是拿掉那道
    // `neighbour.id !== target.id` 守卫时它照样绿(N8-K)——因为 `mergeLinks` 的
    // `selfId` 早把自己滤掉了。守卫真正买到的不是「不自链」,是「不落一个 links: []
    // 的空键」,那才是它省下的那十来个字节。判据得对着后果写。
    expect(target.meta).not.toHaveProperty('links')
  })
})

describe('M4 字节账:折叠付常量、省线性', () => {
  const bytesAfter = async (text: string, n: number, gated: boolean): Promise<number> => {
    const m = makeFakeMemory()
    for (let i = 0; i < n; i++) {
      const e: NewMemoryEntry = { kind: 'episodic', text, meta: { turn: true } }
      if (gated) await rememberNovel(e, { memory: m, now: () => 1_000 + i })
      else await m.remember(e)
    }
    return (await m.list({ limit: 10_000 })).reduce((s, x) => s + entryBytes(x), 0)
  }

  const SHORT = 'User: 好的\nButler: 好的。'
  const LONG = 'User: 明天下午的会议改到几点了?\nButler: 改到明天下午 4 点,在三号会议室。'

  it('复述再多,盘上字节加不满一条(增长从线性降到对数)', async () => {
    // 第一版这里断言的是「字节恒定」,当场红了:99 → 101。原因是计数器本身要占位
    // ——`recallCount: 1` 到 `recallCount: 49` 多了一位数字。所以真相不是恒定而是
    // **对数**(计数器的位数)。改断言,不改实现:量到什么就说什么。
    for (const text of [SHORT, LONG]) {
      const one = await bytesAfter(text, 1, true)
      const at2 = await bytesAfter(text, 2, true)
      const at50 = await bytesAfter(text, 50, true)
      // 48 次复述加起来,涨的还不到一条条目 —— 这就是「万轮不膨胀」的形状。
      expect(at50 - at2).toBeLessThan(one)
      // 阳性对照:同一份夹具在基线下确实是线性涨的,不是「本来就不涨」。
      const baseAt2 = await bytesAfter(text, 2, false)
      expect((await bytesAfter(text, 50, false)) - baseAt2).toBeGreaterThan(one * 40)
    }
  })

  it('转正点:短条目要第 3 次复述才回本,长条目第 2 次就回本', async () => {
    // 折叠给目标条加了 recallCount / lastRecalledTs / restatedCount,这是**一次性**成本;
    // 省下的是每一次复述的整条。所以极短的条目恰好复述 2 次时会小亏 —— 如实量出来,
    // 而不是只报总账把它盖过去。
    const rows: string[] = []
    for (const [label, text] of [
      ['短', SHORT],
      ['长', LONG],
    ] as const) {
      for (const n of [2, 3]) {
        const base = await bytesAfter(text, n, false)
        const gated = await bytesAfter(text, n, true)
        rows.push(`${label} n=${n}: 基线 ${base} / 门 ${gated}`)
      }
    }
    // eslint-disable-next-line no-console
    console.log('字节账 ' + rows.join('  |  '))

    expect(await bytesAfter(SHORT, 2, true)).toBeGreaterThan(await bytesAfter(SHORT, 2, false))
    expect(await bytesAfter(SHORT, 3, true)).toBeLessThan(await bytesAfter(SHORT, 3, false))
    expect(await bytesAfter(LONG, 2, true)).toBeLessThan(await bytesAfter(LONG, 2, false))
  })
})

describe('M4 已知局限:词面差一个词、答案又一样时会误折', () => {
  const t = (u: string, b: string) => `User: ${u}\nButler: ${b}`

  it('「周三/周四 + 同一个答案」会被折(实测 0.889,如实钉住当前行为)', () => {
    const wed = t('周三的例会在哪个会议室?', '在三号会议室,下午 2 点。')
    const thu = t('周四的例会在哪个会议室?', '在三号会议室,下午 2 点。')
    const score = mutualCoverage(wed, thu)
    expect(score).toBeGreaterThan(DEFAULT_FACT_DEDUP_THRESHOLD)
    expect(judgeNovelty(thu, [entry('a', 'episodic', wed, 1)]).novel).toBe(false)

    // 这一条**不是**回归测试,是一块界碑。要分清「周三」和「周四」是语义判断:得知道
    // 日期这类词是承重的、别的词面差异不是 —— 那要模型,而新颖门的立身之本正是零模型
    // (「只判像不像,永远不判对不对」)。所以这里不修,只钉住,并说清代价的**边界**。
    //
    // 代价没有看上去那么大,而且这一点是量得出来的:误折要求**两半都**近乎一样。
    // 同一个问题若答案不同(改期了、换房间了),分数当场掉到阈值以下 —— 下面就是阳性
    // 对照。也就是说丢掉的是「那天也问过」,不是「答案是什么」。
    const changed = t('周四的例会在哪个会议室?', '改到二号会议室了,时间不变。')
    expect(mutualCoverage(wed, changed)).toBeLessThan(DEFAULT_FACT_DEDUP_THRESHOLD)
    expect(judgeNovelty(changed, [entry('a', 'episodic', wed, 1)]).novel).toBe(true)
  })
})
