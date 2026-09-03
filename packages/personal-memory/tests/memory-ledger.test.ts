/**
 * 记忆账纯核的门(M3a)。
 *
 * 四组,顺序即论证:
 *
 *   ① **压力取最大值这件事本身**。只看总和比会漏掉「一个面已经写不进去了」,
 *      只看单面最大值会在五个面都七成满时装作没事。两条各配一个会红的用例。
 *   ② **上限未知不等于压力无穷大**。算不出上限的面必须被跳过,而不是当成 0 除。
 *   ③ **滞回真的咬人**:同一个压力,来路不同、结论不同。这是整个 M3a 唯一有
 *      状态的地方,也是最容易写成「摆设」的地方 —— 所以正反两向各钉一次。
 *   ④ **这一层什么都不动**:纯函数,同样入参同样出参,不碰输入对象。
 */

import { describe, expect, it } from 'vitest'

import {
  formatLedger,
  readLedger,
  rungFor,
  RUNG_HYSTERESIS,
  RUNG_OPEN_AT,
  type LedgerLine,
} from '../src/memory-ledger.js'

const line = (store: string, used: number, budget: number): LedgerLine => ({
  store,
  usedBytes: used,
  budgetBytes: budget,
})

describe('① 压力取的是最紧那个面', () => {
  it('一个面爆了就是爆了,哪怕总和比很低', () => {
    // 知识库满,记忆区几乎空:总和比 = 4/12 ≈ 33%,可知识库已经写不进去了。
    const r = readLedger([line('knowledge', 4_000_000, 4_000_000), line('memory', 0, 8_000_000)])
    expect(r.usedBytes / r.budgetBytes).toBeCloseTo(1 / 3, 6)
    expect(r.pressure).toBe(1)
    expect(r.hottest).toBe('knowledge')
    expect(r.rung).toBe(4)
  })

  it('全体都紧时,最大值与总和比同值,判据不因此变形', () => {
    const r = readLedger([line('a', 800, 1000), line('b', 800, 1000)])
    expect(r.pressure).toBeCloseTo(0.8, 6)
    expect(r.usedBytes / r.budgetBytes).toBeCloseTo(0.8, 6)
    expect(r.rung).toBe(2)
  })

  it('总和比恒 ≤ 最大值 —— 这就是它不能当判据的理由', () => {
    // 总和比 = Σuᵢ/Σbᵢ = 各面压力按预算加权的平均,加权平均永远越不过最大值。
    // 随手撒一批形状差别很大的读数,把这条性质钉成断言:哪天有人想把判据换回
    // 「总和比」或「两者取大」,这条会告诉他那等价于什么、或者什么都没变。
    const cases: LedgerLine[][] = [
      [line('big', 9_500, 10_000), line('small', 10, 100)],
      [line('a', 1, 1_000_000), line('b', 999, 1000)],
      [line('a', 500, 1000), line('b', 500, 1000), line('c', 999, 1000)],
      [line('a', 3000, 1000), line('b', 0, 1_000_000)],
    ]
    for (const lines of cases) {
      const r = readLedger(lines)
      expect(r.usedBytes / r.budgetBytes).toBeLessThanOrEqual(r.pressure + 1e-12)
      expect(r.pressure).toBeCloseTo(Math.max(...r.stores.map((s) => s.pressure)), 12)
    }
  })
})

describe('② 上限未知 ≠ 压力无穷大', () => {
  it('上限 ≤0 或非有限的面被跳过,不参与任何一项', () => {
    const r = readLedger([
      line('memory', 100, 1000),
      line('未知', 999_999, 0),
      line('也未知', 999_999, Number.NaN),
    ])
    expect(r.stores.map((s) => s.store)).toEqual(['memory'])
    expect(r.budgetBytes).toBe(1000)
    expect(r.usedBytes).toBe(100)
    expect(r.pressure).toBeCloseTo(0.1, 6)
    expect(r.rung).toBe(0)
  })

  it('一个有效面都没有 ⇒ 压力 0、级数 0、hottest 为 null', () => {
    const r = readLedger([line('未知', 5, 0)])
    expect(r.pressure).toBe(0)
    expect(r.rung).toBe(0)
    expect(r.hottest).toBeNull()
    expect(r.budgetBytes).toBe(0)
  })

  it('用量为负按 0 算,不产生负压力', () => {
    const r = readLedger([line('memory', -50, 1000)])
    expect(r.stores[0]!.usedBytes).toBe(0)
    expect(r.pressure).toBe(0)
  })
})

describe('③ 滞回', () => {
  it('升级看高线:恰好到线就开,差一点就不开', () => {
    expect(rungFor(RUNG_OPEN_AT[3], 0)).toBe(3)
    expect(rungFor(RUNG_OPEN_AT[3] - 1e-9, 0)).toBe(2)
  })

  it('降级看低线:同一个压力,来路不同结论不同', () => {
    // 恰好落在高线与低线之间的那条缝里 —— 滞回唯一能被观测到的地方。
    const between = RUNG_OPEN_AT[3] - RUNG_HYSTERESIS / 2
    expect(rungFor(between, 0)).toBe(2) // 从下面上来:还没够到高线
    expect(rungFor(between, 3)).toBe(3) // 从三级下来:还没掉够低线,继续守着
  })

  it('掉够了就真的降,滞回不是永不下降', () => {
    const below = RUNG_OPEN_AT[3] - RUNG_HYSTERESIS - 1e-9
    expect(rungFor(below, 3)).toBe(2)
  })

  it('滞回一次只护一级,不会把整座阶梯钉住', () => {
    // 压力崩到很低时,哪怕上一轮在四级,也该一路落到 0。
    expect(rungFor(0.01, 4)).toBe(0)
  })

  it('逐级累加的语义:开的是**最高**那一级,不是最低那一级', () => {
    // 只断言「单调不减」是不够的:一个只返回「最低开的级」的实现(把逐级试的
    // 方向写反)也满足单调 —— 2026-09-02 变异 N4-F 就是这么溜过去的。所以这里
    // 逐点钉死期望值。
    const expected: readonly [number, number][] = [
      [0, 0],
      [0.3, 0],
      [0.59, 0],
      [0.6, 1],
      [0.74, 1],
      [0.75, 2],
      [0.89, 2],
      [0.9, 3],
      [0.99, 3],
      [1, 4],
      [1.5, 4],
    ]
    for (const [p, want] of expected) expect(`${p}⇒${rungFor(p, 0)}`).toBe(`${p}⇒${want}`)
  })

  it('压力非有限数按 0 算', () => {
    expect(rungFor(Number.NaN, 0)).toBe(0)
    expect(rungFor(Number.NaN, 4)).toBe(0)
  })
})

describe('④ 这一层什么都不动', () => {
  it('纯函数:同样入参同样出参,且不碰输入', () => {
    const input: LedgerLine[] = [line('memory', 100, 1000), line('knowledge', 900, 1000)]
    const snapshot = JSON.stringify(input)
    const a = readLedger(input, 2)
    const b = readLedger(input, 2)
    expect(JSON.stringify(input)).toBe(snapshot)
    expect(b).toEqual(a)
  })

  it('渲染出的一行带压力、级数与最紧的面', () => {
    const text = formatLedger(readLedger([line('memory', 100, 1000), line('knowledge', 950, 1000)]))
    expect(text).toContain('95.0%')
    expect(text).toContain('降温')
    expect(text).toContain('最紧的是 knowledge')
    // 逐面一行,加抬头一行。
    expect(text.split('\n')).toHaveLength(3)
  })
})
