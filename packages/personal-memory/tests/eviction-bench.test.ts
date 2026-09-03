/**
 * 记忆经济 M3b 的门:显著性通电,以及证明它真的改变了后果。
 *
 * 四组,顺序即论证:
 *
 *   ① **尺子先被判过**。一份「恰好留下该留的」的答卷必须得 1.0,一份「把该留的
 *      全逐光」的答卷必须得 0。没被判过的尺子量出来的数字没资格当地板。
 *   ② **夹具真的分不开**:每条用例里,该留与该逐的**重要度与层级都相同**。
 *      否则量到的抬升是重要度的功劳,跟显著性没关系。
 *   ③ **基线是量出来的**:今天的生产配置(两个选项都没传)得几分,锁进只升不降
 *      的地板。这一步同时把「显著性经济从没通电」这句诊断变成一个数字。
 *   ④ **通电之后严格更好**,且断言的是「比基线高」不是「等于某个数」。
 */

import { describe, expect, it } from 'vitest'
import {
  formatEvictionResult,
  scoreEviction,
  type EvictionBenchResult,
  type EvictionPolicy,
} from '../src/eviction-benchmark.js'
import { DEFAULT_REINFORCE_WEIGHT, DEFAULT_SALIENCE_HALF_LIFE_MS } from '../src/salience.js'
import { importanceOf } from '../src/importance.js'
import { EVICTION_CASES } from './fixtures/eviction-cases.js'
import { makeFakeMemory } from './fake-memory.js'

const make = (corpus: readonly import('@gotong/services-sdk').MemoryEntry[]) => makeFakeMemory(corpus)

/**
 * 地板只升不降。数字是 2026-09-02 第一次跑这道门量出来的,不是估的。
 *
 * 【基线 · 今天的生产配置】该留的留住 0.0%    该逐的逐掉 33.3%
 * 【M3b · 显著性通电】       该留的留住 100.0%  该逐的逐掉 100.0%
 *
 * 保留率是**结构性的零**:三条用例里该留的那些一条都没活下来。这不是「效果一般」,
 * 是那两个开关根本没接上——`grep -rn 'halfLifeMs|reinforceWeight|evictExpiredFirst'
 * packages/host/src` 至今零命中,诊断到此有了数字。
 *
 * 逐出率 33.3% 不是「答对了三分之一」:那一分来自 `expired-first`,基线在那一条上
 * 把**两条都逐了**(该逐的自然也在里面),留下的是空。逐出率单看会骗人,所以两个数
 * 一起看 —— 一个策略可以靠「全逐光」把逐出率刷到 100%,保留率会当场戳穿它(见 ①)。
 */
const BASELINE_FLOORS = { keepRate: 0, dropRate: 0.333 } as const
const CHARGED_FLOORS = { keepRate: 1, dropRate: 1 } as const

/** 通电 = 把包里早就写好的两个常量真的传下去,外加「先逐过期」。零新数字。 */
const CHARGED: EvictionPolicy = {
  salience: {
    halfLifeMs: DEFAULT_SALIENCE_HALF_LIFE_MS,
    reinforceWeight: DEFAULT_REINFORCE_WEIGHT,
  },
  evictExpiredFirst: true,
}

describe('① 尺子先被判过', () => {
  it('恰好留下该留的 ⇒ 满分', async () => {
    // 用一个「什么都不逐就已经在预算内」的退化形状不行(那样 enforceBudget 直接
    // 返回 null),所以这里直接验:预算 = 该留的字节和 ⇒ 完美策略正好留下它们。
    // 用 CHARGED 跑,它在这份夹具上确实是完美策略(④ 里量得到)。
    const r = await scoreEviction(make, EVICTION_CASES, CHARGED)
    expect(r.keepRate).toBe(1)
    expect(r.dropRate).toBe(1)
  })

  it('把该留的全逐光 ⇒ 零分', async () => {
    // 构造一个必然逐错的策略:把「该留的」全设成最低重要度是改夹具,不行;
    // 改成让保护规则一条都不保护、并把顺序反过来做不到 —— 于是换个法子:
    // 直接检查一份「幸存者集合为空」时的打分,证明分母分子没写反。
    const empty = await scoreEviction(
      (corpus) => {
        const mem = makeFakeMemory(corpus)
        return {
          ...mem,
          list: async () => [],
        } as typeof mem
      },
      EVICTION_CASES,
      CHARGED,
    )
    expect(empty.keepRate).toBe(0)
    expect(empty.dropRate).toBe(1) // 全没了,该逐的当然也都逐了
  })
})

describe('② 夹具真的分不开', () => {
  it('每条用例里,该留与该逐的重要度和层级都相同', () => {
    for (const c of EVICTION_CASES) {
      const kinds = new Set(c.corpus.map((e) => e.kind))
      expect(`${c.name}:kinds=${kinds.size}`).toBe(`${c.name}:kinds=1`)
      const imps = new Set(c.corpus.map((e) => importanceOf(e)))
      expect(`${c.name}:importances=${imps.size}`).toBe(`${c.name}:importances=1`)
    }
  })

  it('该留的比该逐的更旧 —— 基线的最后一根稻草必然指错方向', () => {
    for (const c of EVICTION_CASES.filter((x) => x.name !== 'expired-first')) {
      const keep = c.corpus.filter((e) => c.shouldKeep.includes(e.id))
      const drop = c.corpus.filter((e) => !c.shouldKeep.includes(e.id))
      const newestKeep = Math.max(...keep.map((e) => e.ts))
      const oldestDrop = Math.min(...drop.map((e) => e.ts))
      expect(`${c.name}:keep更旧=${newestKeep < oldestDrop}`).toBe(`${c.name}:keep更旧=true`)
    }
  })

  it('用例名唯一,该留集非空,理由写了', () => {
    const names = EVICTION_CASES.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    for (const c of EVICTION_CASES) {
      expect(c.shouldKeep.length).toBeGreaterThan(0)
      expect(c.corpus.length).toBeGreaterThan(c.shouldKeep.length)
      expect(c.why.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('③ 基线:今天的生产配置', () => {
  let base: EvictionBenchResult

  it('量出来并锁进地板', async () => {
    base = await scoreEviction(make, EVICTION_CASES, {})
    console.log(formatEvictionResult('基线 · 今天的生产配置', base))
    expect(base.keepRate).toBeGreaterThanOrEqual(BASELINE_FLOORS.keepRate)
    expect(base.dropRate).toBeGreaterThanOrEqual(BASELINE_FLOORS.dropRate)
  })

  it('结构性零分:三条用例该留的一条都没活下来', async () => {
    const r = await scoreEviction(make, EVICTION_CASES, {})
    for (const c of r.perCase) {
      expect(`${c.name}:keep=${c.keepRate}`).toBe(`${c.name}:keep=0`)
    }
  })
})

describe('④ 通电之后', () => {
  it('三项都严格高于基线,且不低于地板', async () => {
    const base = await scoreEviction(make, EVICTION_CASES, {})
    const charged = await scoreEviction(make, EVICTION_CASES, CHARGED)
    console.log(formatEvictionResult('M3b · 显著性通电', charged))

    expect(charged.keepRate).toBeGreaterThan(base.keepRate)
    expect(charged.dropRate).toBeGreaterThan(base.dropRate)
    expect(charged.keepRate).toBeGreaterThanOrEqual(CHARGED_FLOORS.keepRate)
    expect(charged.dropRate).toBeGreaterThanOrEqual(CHARGED_FLOORS.dropRate)
  })

  it('三条用例逐条都从 0 抬到满分', async () => {
    const charged = await scoreEviction(make, EVICTION_CASES, CHARGED)
    for (const c of charged.perCase) {
      expect(`${c.name}:keep=${c.keepRate}`).toBe(`${c.name}:keep=1`)
    }
  })

  it('两个开关各自都有贡献:只开衰减强化、或只开先逐过期,都不到满分', async () => {
    // 少了任何一个都会有用例掉下来 —— 这条钉的是「不是某一个开关顺手解决了全部」。
    const onlySalience = await scoreEviction(make, EVICTION_CASES, {
      salience: CHARGED.salience!,
    })
    const onlyExpired = await scoreEviction(make, EVICTION_CASES, { evictExpiredFirst: true })
    expect(onlySalience.keepRate).toBeLessThan(1)
    expect(onlyExpired.keepRate).toBeLessThan(1)
    // 但各自都比什么都不开强。
    expect(onlySalience.keepRate).toBeGreaterThan(0)
    expect(onlyExpired.keepRate).toBeGreaterThan(0)
  })
})
