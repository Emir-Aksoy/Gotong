/**
 * 记忆经济 M3c 的门:降温,以及证明它真的改变了「回收落在谁头上」。
 *
 * 五组,顺序即论证:
 *
 *   ① **红线是结构性的**:这一层源码里没有一行 `forget` / `unlink`。这条不靠人自觉,
 *      靠读源码断言 —— 它是整个记忆经济唯一一条不能靠尺子量的承诺。
 *   ② **纯核**:选谁翻篇是纯函数,四道保护各配一个会红的用例。
 *   ③ **基线是量出来的**,而且基线**已经是 M3b 通电后的那一套** —— 否则量到的抬升
 *      会混进上一刀的功劳。
 *   ④ **接上降温之后严格更好**,且断言「比基线高」不是「等于某个数」。
 *   ⑤ **闸门**:压力不到第 ③ 级一个字节都不写;后端不支持改 meta 就整条路不存在
 *      (硬删不是退路)。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import type { MemoryEntry, MemoryHandle } from '@gotong/services-sdk'

import {
  coolingReviewer,
  pruneDeadLinks,
  selectForCooling,
  COOLING_RUNG,
  DEFAULT_PROTECT_RECENT,
} from '../src/cooling.js'
import {
  benchEntry,
  formatEvictionResult,
  scoreEviction,
  EVICTION_BENCH_NOW,
  type EvictionBenchResult,
  type EvictionPolicy,
  type EvictionPrePass,
} from '../src/eviction-benchmark.js'
import { validToOf } from '../src/bitemporal.js'
import { entryBytes } from '../src/budget.js'
import { DEFAULT_REINFORCE_WEIGHT, DEFAULT_SALIENCE_HALF_LIFE_MS } from '../src/salience.js'
import { RUNG_OPEN_AT } from '../src/memory-ledger.js'
import { COOLING_CASES } from './fixtures/cooling-cases.js'
import { makeFakeMemory } from './fake-memory.js'

const make = (corpus: readonly MemoryEntry[]): MemoryHandle => makeFakeMemory(corpus)

const SALIENCE = {
  halfLifeMs: DEFAULT_SALIENCE_HALF_LIFE_MS,
  reinforceWeight: DEFAULT_REINFORCE_WEIGHT,
}

/**
 * M3c 的基线**不是**「什么都不开」,而是**今天的生产配置** —— 也就是 M3b 刚接上的
 * 那一套(衰减强化 + 先逐过期)。基线选错,量到的就是上一刀的功劳。
 */
const TODAY: EvictionPolicy = { salience: SALIENCE, evictExpiredFirst: true }

/** 被测件:执法之前先跑一趟降温,预算与执法共用同一个数(生产里就是这么接的)。 */
const COOL: EvictionPrePass = async (memory, now, budgetBytes) => {
  await coolingReviewer({ budgetBytes, salience: SALIENCE })({ memory, episodic: [], now })
}

/**
 * 地板只升不降。数字是 2026-09-02 第一次跑这道门量出来的,不是估的。
 *
 * 【基线 · 今天的生产配置(M3b 通电后)】该留的留住 89.1%  该逐的逐掉 25.0%
 * 【M3c · 接上降温】                     该留的留住 100.0% 该逐的逐掉 100.0%
 *
 * 保留率的基线看着不低(89.1%),那是因为四条用例里每一条的语料大半都活得下来 ——
 * 真正说明问题的是**逐出率 25.0%**:四条里只有一条逐对了,而那一条恰恰是控制组
 * (`protection-holds`,库里根本没有冷事实可翻,基线本来就该满分)。也就是说
 * **在真的有冷事实可翻的三条上,基线一条都没逐对** —— 它把回收全落在了近期流水账上。
 */
const BASELINE_FLOORS = { keepRate: 0.891, dropRate: 0.25 } as const
const COOLED_FLOORS = { keepRate: 1, dropRate: 1 } as const

const COOLING_SRC = readFileSync(fileURLToPath(new URL('../src/cooling.ts', import.meta.url)), 'utf8')

describe('① 红线:这一层不删东西', () => {
  it('源码里没有一行 forget / unlink / rm', () => {
    // 记忆经济全程两条红线之一:**全仓恰好一把剪刀,不在这里**。降温写的是 meta,
    // 回收发生在 `enforceBudget`。这条承诺没有尺子量得了,只能读源码钉死。
    const body = COOLING_SRC.split('*/').slice(1).join('*/') // 掐掉顶注,顶注里会提到这些词
    expect(body).not.toMatch(/\bforget\s*\(/)
    expect(body).not.toMatch(/\bunlink\b/)
    expect(body).not.toMatch(/\brmdir\b|\brm\s+-/)
  })

  it('翻篇写的确实是 validTo,而且条目还在盘上', async () => {
    const corpus = [
      ...Array.from({ length: 10 }, (_, i) =>
        benchEntry({ id: `p${i}`, text: `保护期里的第 ${i} 条`, writtenDaysAgo: 1 + i }),
      ),
      benchEntry({ id: 'cold', text: '很久没人碰过的一条', writtenDaysAgo: 300 }),
    ]
    const memory = makeFakeMemory(corpus)
    // 预算压到只剩一半 ⇒ 压力远超第 ④ 级 ⇒ 必然降温。
    await coolingReviewer({ budgetBytes: 200, salience: SALIENCE })({
      memory,
      episodic: [],
      now: EVICTION_BENCH_NOW,
    })
    const after = await memory.list({ limit: 100 })
    expect(after.length).toBe(corpus.length) // 一条都没少
    const cold = after.find((e) => e.id === 'cold')!
    expect(validToOf(cold)).toBe(EVICTION_BENCH_NOW)
  })
})

describe('② 纯核:选谁翻篇', () => {
  const now = EVICTION_BENCH_NOW
  /** 12 条散装冷事实:8 条占满保护期,4 条真的够得着。 */
  const facts = Array.from({ length: 12 }, (_, i) =>
    benchEntry({ id: `f${String(i).padStart(2, '0')}`, text: `事实 ${i}`, writtenDaysAgo: 10 + i * 10 }),
  )

  it('保护期挡住最新的 8 条散装事实', () => {
    const sel = selectForCooling(facts, { now, targetBytes: 1e9, salience: SALIENCE })
    expect(sel.skipped.recent).toBe(DEFAULT_PROTECT_RECENT)
    // 够得着的只有更旧的 4 条,且**最冷的在前**(这里 = 最旧的在前)。
    expect([...sel.close]).toEqual(['f11', 'f10', 'f09', 'f08'])
  })

  it('钉住的(importance 5)永不翻篇', () => {
    const pinned = benchEntry({ id: 'pin', text: '钉住的', writtenDaysAgo: 999, importance: 5 })
    const sel = selectForCooling([...facts, pinned], { now, targetBytes: 1e9, salience: SALIENCE })
    expect(sel.skipped.pinned).toBe(1)
    expect(sel.close).not.toContain('pin')
  })

  it('已经盖过 validTo 的不再动 —— 再盖一次就是篡改翻篇时间', () => {
    const already = benchEntry({
      id: 'done',
      text: '早就翻过篇了',
      writtenDaysAgo: 999,
      validToDaysAgo: 30,
    })
    const sel = selectForCooling([...facts, already], { now, targetBytes: 1e9, salience: SALIENCE })
    expect(sel.skipped.closed).toBe(1)
    expect(sel.close).not.toContain('done')
  })

  it('还没生效的未来事实不翻 —— 否则造出 validFrom > validTo', () => {
    const future: MemoryEntry = {
      id: 'later',
      kind: 'semantic',
      text: '下个月才生效的安排',
      ts: now - 999 * 86_400_000,
      meta: { importance: 3, validFrom: now + 30 * 86_400_000 },
    }
    const sel = selectForCooling([...facts, future], { now, targetBytes: 1e9, salience: SALIENCE })
    expect(sel.skipped.future).toBe(1)
    expect(sel.close).not.toContain('later')
  })

  it('episodic / digest / profile 一律不碰 —— 翻它们会倒置分层保护', () => {
    const others = [
      benchEntry({ id: 'log', kind: 'episodic', text: '流水账', writtenDaysAgo: 999 }),
      benchEntry({ id: 'prof', text: '画像', writtenDaysAgo: 999, profile: true }),
      { id: 'dg', kind: 'semantic', text: '摘要', ts: 0, meta: { importance: 3, level: 'digest' } },
    ] as MemoryEntry[]
    const sel = selectForCooling([...facts, ...others], { now, targetBytes: 1e9, salience: SALIENCE })
    expect(sel.skipped.notAdHoc).toBe(3)
    for (const id of ['log', 'prof', 'dg']) expect(sel.close).not.toContain(id)
  })

  it('按字节收口:够了就停,不多翻一条', () => {
    const one = selectForCooling(facts, { now, targetBytes: 1, salience: SALIENCE })
    expect(one.close.length).toBe(1)
    expect(one.bytes).toBeGreaterThanOrEqual(1)
    // 目标为 0(还没超预算)⇒ 一条都不翻。降温是「到点了准备好」,不是「到点了动手」。
    const none = selectForCooling(facts, { now, targetBytes: 0, salience: SALIENCE })
    expect(none.close.length).toBe(0)
  })

  it('每 tick 硬顶挡得住压力尖峰', () => {
    const sel = selectForCooling(facts, {
      now,
      targetBytes: 1e9,
      salience: SALIENCE,
      protectRecent: 0,
      maxPerTick: 3,
    })
    expect(sel.close.length).toBe(3)
  })

  it('剪死链:只动真的断了的,链接完好的一条补丁都不出', () => {
    const entries: MemoryEntry[] = [
      { id: 'a', kind: 'semantic', text: 'a', ts: 1, meta: { links: ['b', 'ghost'] } },
      { id: 'b', kind: 'semantic', text: 'b', ts: 2, meta: { links: ['a'] } },
      { id: 'c', kind: 'semantic', text: 'c', ts: 3 },
    ]
    const patches = pruneDeadLinks(entries)
    expect(patches).toEqual([{ id: 'a', patch: { links: ['b'] } }])
  })
})

describe('③ 基线:今天的生产配置(M3b 通电后)', () => {
  let base: EvictionBenchResult

  it('量出来并锁进地板', async () => {
    base = await scoreEviction(make, COOLING_CASES, TODAY)
    console.log(formatEvictionResult('基线 · 今天的生产配置(M3b 通电后)', base))
    expect(base.keepRate).toBeGreaterThanOrEqual(BASELINE_FLOORS.keepRate)
    expect(base.dropRate).toBeGreaterThanOrEqual(BASELINE_FLOORS.dropRate)
  })

  it('有冷事实可翻的三条,基线一条都没逐对', async () => {
    const r = await scoreEviction(make, COOLING_CASES, TODAY)
    for (const c of r.perCase.filter((x) => x.name !== 'protection-holds')) {
      expect(`${c.name}:drop=${c.dropRate}`).toBe(`${c.name}:drop=0`)
    }
  })

  it('控制组本来就该满分 —— 库里没有冷事实,回收落在流水尾巴上是对的', async () => {
    const r = await scoreEviction(make, COOLING_CASES, TODAY)
    const ctrl = r.perCase.find((c) => c.name === 'protection-holds')!
    expect(`keep=${ctrl.keepRate} drop=${ctrl.dropRate}`).toBe('keep=1 drop=1')
  })
})

describe('④ 接上降温之后', () => {
  it('两项都严格高于基线,且不低于地板', async () => {
    const base = await scoreEviction(make, COOLING_CASES, TODAY)
    const cooled = await scoreEviction(make, COOLING_CASES, TODAY, COOL)
    console.log(formatEvictionResult('M3c · 接上降温', cooled))

    expect(cooled.keepRate).toBeGreaterThan(base.keepRate)
    expect(cooled.dropRate).toBeGreaterThan(base.dropRate)
    expect(cooled.keepRate).toBeGreaterThanOrEqual(COOLED_FLOORS.keepRate)
    expect(cooled.dropRate).toBeGreaterThanOrEqual(COOLED_FLOORS.dropRate)
  })

  it('四条用例逐条满分 —— 包括那条「降温该什么都不做」的控制组', async () => {
    const cooled = await scoreEviction(make, COOLING_CASES, TODAY, COOL)
    for (const c of cooled.perCase) {
      expect(`${c.name}:keep=${c.keepRate} drop=${c.dropRate}`).toBe(`${c.name}:keep=1 drop=1`)
    }
  })
})

describe('⑤ 闸门', () => {
  const quiet = (): MemoryEntry[] =>
    Array.from({ length: 12 }, (_, i) =>
      benchEntry({ id: `q${i}`, text: `第 ${i} 条`, writtenDaysAgo: 30 + i * 30 }),
    )

  /** 带一条断链的语料 —— 剪死链是**不看 targetBytes** 的动作,于是它成了闸门开没开的探针。 */
  const withDeadLink = (): MemoryEntry[] => [
    ...quiet(),
    { id: 'linked', kind: 'semantic', text: '链向一个已经不在的 id', ts: 1, meta: { importance: 3, links: ['ghost'] } },
  ]

  /** 把语料的压力钉在指定倍数上 —— 用与执法同一把秤(`entryBytes`)。 */
  const budgetFor = (entries: readonly MemoryEntry[], pressure: number): number =>
    Math.ceil(entries.reduce((s, e) => s + entryBytes(e), 0) / pressure)

  it('压力不到第 ③ 级 ⇒ 一个字节都不写', async () => {
    const corpus = withDeadLink()
    const memory = makeFakeMemory(corpus)
    const before = JSON.stringify(await memory.list({ limit: 100 }))
    const out = await coolingReviewer({
      budgetBytes: budgetFor(corpus, RUNG_OPEN_AT[COOLING_RUNG] - 0.05),
      salience: SALIENCE,
    })({ memory, episodic: [], now: EVICTION_BENCH_NOW })
    expect(out).toEqual({})
    // 连那条明摆着的死链都没剪 —— 闸门关着就是关着,没有「顺手做点好事」。
    expect(JSON.stringify(await memory.list({ limit: 100 }))).toBe(before)
  })

  it('滞回:升上去之后,压力回落到升级线以下仍留在第 ③ 级', async () => {
    // 压力钉在滞回带里(升级线 0.90 之下、降级线 0.85 之上):冷启动判第 ② 级(不动),
    // 已经升到第 ③ 级的判第 ③ 级(动)。两者的可观测差别就是那条死链剪没剪 ——
    // 剪死链不看 targetBytes,所以「没超预算」不会把这个信号糊掉。
    const corpus = withDeadLink()
    const inBand = budgetFor(corpus, 0.87)

    // (a) 冷启动闭包:priorRung = 0 ⇒ 按升级线判 ⇒ 第 ② 级 ⇒ 什么都不做。
    const cold = makeFakeMemory(corpus)
    expect(
      await coolingReviewer({ budgetBytes: inBand, salience: SALIENCE })({
        memory: cold,
        episodic: [],
        now: EVICTION_BENCH_NOW,
      }),
    ).toEqual({})
    expect((await cold.list({ limit: 100 })).find((e) => e.id === 'linked')!.meta).toEqual({
      importance: 3,
      links: ['ghost'],
    })

    // (b) 同一个闭包先被高压顶到第 ③ 级,再看同样的 0.87 ⇒ 滞回让它留在第 ③ 级。
    const warm = coolingReviewer({ budgetBytes: inBand, salience: SALIENCE })
    // 先用一份「远超预算」的语料把级数顶上去:同一个 budgetBytes,语料大得多。
    const bulk = makeFakeMemory([
      ...quiet(),
      ...Array.from({ length: 40 }, (_, i) =>
        benchEntry({ id: `bulk${i}`, text: '把压力顶上去的填充条目'.repeat(20), writtenDaysAgo: 400 + i }),
      ),
    ])
    expect((await warm({ memory: bulk, episodic: [], now: EVICTION_BENCH_NOW })).summary).toMatch(
      /降温翻篇/,
    )
    const banded = makeFakeMemory(corpus)
    const out = await warm({ memory: banded, episodic: [], now: EVICTION_BENCH_NOW })
    expect(out.summary).toMatch(/剪死链 1 条/)
    expect((await banded.list({ limit: 100 })).find((e) => e.id === 'linked')!.meta).toEqual({
      importance: 3,
      links: [],
    })
  })

  it('后端不支持改 meta ⇒ 整条路不存在,硬删不是退路', async () => {
    const base = makeFakeMemory(quiet())
    const noPatch = { ...base, patchMeta: undefined } as unknown as MemoryHandle
    const before = (await base.list({ limit: 100 })).length
    const out = await coolingReviewer({ budgetBytes: 100, salience: SALIENCE })({
      memory: noPatch,
      episodic: [],
      now: EVICTION_BENCH_NOW,
    })
    expect(out).toEqual({})
    expect((await base.list({ limit: 100 })).length).toBe(before) // 一条都没被删
  })
})
