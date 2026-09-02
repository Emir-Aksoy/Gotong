/**
 * 记忆经济 M1 的门:整合召回这把尺子本身。
 *
 * 四组,顺序即论证:
 *
 * ① **尺子先被判过**。喂它一份满分答卷必须得 1.0,喂它一份空答卷必须得 0,
 *    喂它一份「黄金全排在第 k 名之后」的答卷必须 recall=0 而 MRR>0 ——最后
 *    那条钉的是 `scoreRankedIds` 里那条刻意的不对称(recall 只数前 k,倒数
 *    排名扫整页)。一把没被判过的尺子,量出来的数字没有资格当地板。
 *
 * ② **夹具卫生**。每个黄金 id 必须真能在空间里指到东西。这是漂移捕手:
 *    `tn-3`、`session:u-mei#2` 这些下标是**手写**的,哪天笔记本改了 id 规则、
 *    或者会话渲染多合并了一轮,受害的用例会静默永远得 0 分而不是变红。
 *
 * ③ **基线是量出来的不是估出来的**,量完锁进只升不降的地板。
 *
 * ④ **今天的结构性天花板**:生产召回吐出来的 id 只可能带 `memory:` 前缀。
 *    这不是实现细节,这就是「记忆一块一块」那句诊断的可执行形式;M2 把别的
 *    店接进来时,红的正是这一条。
 *
 * ⑤ **M2b 的抬升是量出来的**,同一批用例、同一把尺子、同一份融合算术,只换
 *    被测件。抬升按**逐项严格大于基线**断言 —— 写死一个「M2 应该得几分」的
 *    数字等于把答案抄进门里;写「必须比基线高」才是在量。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  enumerateNodes,
  formatIntegrationResult,
  openIntegrationSpace,
  memoryOnlyRecall,
  netRecall,
  parseNodeId,
  resolveNode,
  scoreIntegration,
  type IntegratedRecall,
  type IntegrationBenchResult,
  type IntegrationSpace,
} from '../src/memory-integration-benchmark.js'
import { buildMemoryNet, crossStoreRecall, DEFAULT_STORE_QUOTA } from '../src/memory-net.js'
import { INTEGRATION_CASES, INTEGRATION_NOW, INTEGRATION_SEED, INTEGRATION_USER } from './fixtures/integration-cases.js'

/**
 * 地板只升不降。
 *
 * Never lower a floor (or widen a ceiling) to make it pass. 数字变差的那一刻,
 * 该红的是实现,不是这一行常量。抬地板要在提交信息里说明抬的理由。
 *
 * 这几个数字是 2026-09-02 第一次跑这道门量出来的,不是估的:
 *   【基线 · 只读记忆】recall@5=27.8%  MRR=0.500  命中率=50.0%
 *     · cross-store   recall@5=16.7%  MRR=0.500  (4 例)
 *     · single-store  recall@5=50.0%  MRR=0.500  (2 例)
 * 精确值 = 5/18 与 1/6(每条用例的构成由下面 ③ 的逐例钉子钉死),按仓里既有
 * 召回门的惯例截到三位小数当地板——留的那点余量是给浮点的,不是给退步的。
 */
const BASELINE_FLOORS = { recallAtK: 0.277, mrr: 0.5, hitRate: 0.5 } as const
/** 跨店那半就是 M2 要抬的那条线,单列出来免得被单店的满分稀释掉。 */
const BASELINE_CROSS_STORE_FLOOR = 0.166

/**
 * M2b(跨店联想网)的地板,同样是 2026-09-02 量出来的:
 *   【M2b · 跨店联想网】recall@5=100.0%  MRR=0.833  命中率=100.0%
 *     · cross-store   recall@5=100.0%  MRR=0.750  (4 例)
 *     · single-store  recall@5=100.0%  MRR=1.000  (2 例)
 *
 * 两件事要如实记在这里,免得下一个人把满分当成「做完了」:
 *
 *   - **recall 这根轴在这份夹具上已经到顶**(6 例 23 节点全中)。到顶的尺子
 *     不再量得出东西 —— M3/M4 想在召回上证明自己,得先把夹具加厚,而不是看
 *     着这行 1.0 自我感觉良好。MRR 还没到顶(0.833),排名仍有量的余地。
 *   - **抬召回是有排名代价的**:`weight-trend` 的首位命中从 1.000 掉到 0.500
 *     —— 联想进来的邻居挤在了黄金前面。总分是涨的,但这一例确实退了。这里
 *     只写地板不写等式:哪天 M3 的显著性把它救回来,不该有一条门为此变红。
 */
const NET_FLOORS = { recallAtK: 1, mrr: 0.833, hitRate: 1 } as const
const NET_CROSS_STORE_FLOOR = 1

let space: IntegrationSpace
let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gotong-integration-bench-'))
  space = await openIntegrationSpace({
    dir: join(dir, 'space'),
    userId: INTEGRATION_USER,
    now: () => INTEGRATION_NOW,
    seed: INTEGRATION_SEED,
  })
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('① 尺子先被判过', () => {
  /** 一份「每题都恰好答出黄金集」的满分答卷。 */
  const oracleSheet = () => {
    const byQuery = new Map(INTEGRATION_CASES.map((c) => [c.query.text, c.gold]))
    const recall: IntegratedRecall = async (q) => byQuery.get(q.text) ?? []
    return recall
  }

  it('满分答卷得满分', async () => {
    const r = await scoreIntegration(oracleSheet, space, INTEGRATION_CASES)
    expect(r.recallAtK).toBe(1)
    expect(r.mrr).toBe(1)
    expect(r.hitRate).toBe(1)
    for (const c of r.perCase) expect(c.recallAtK).toBe(1)
  })

  it('空答卷得零分', async () => {
    const r = await scoreIntegration(() => async () => [], space, INTEGRATION_CASES)
    expect(r.recallAtK).toBe(0)
    expect(r.mrr).toBe(0)
    expect(r.hitRate).toBe(0)
  })

  it('黄金排在第 k 名之后:recall 归零,倒数排名仍记分', async () => {
    const pad = ['memory:__pad0', 'memory:__pad1', 'memory:__pad2', 'memory:__pad3', 'memory:__pad4']
    const byQuery = new Map(INTEGRATION_CASES.map((c) => [c.query.text, c.gold]))
    const r = await scoreIntegration(
      () => async (q) => [...pad, ...(byQuery.get(q.text) ?? [])],
      space,
      INTEGRATION_CASES,
    )
    // k 默认 5,五个填充占满整页 ⇒ 前 k 里一个黄金都没有。
    expect(r.recallAtK).toBe(0)
    expect(r.hitRate).toBe(0)
    // 但倒数排名扫的是整页:第 6 名 ⇒ 1/6。
    expect(r.mrr).toBeCloseTo(1 / 6, 10)
  })
})

describe('② 夹具卫生', () => {
  it('每个黄金 id 都真能指到空间里的一段字', async () => {
    const missing: string[] = []
    for (const c of INTEGRATION_CASES) {
      for (const id of c.gold) {
        const node = await resolveNode(space, id)
        if (!node || !node.text.trim()) missing.push(`${c.name} → ${id}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('用例名唯一,黄金集非空且不重复', () => {
    const names = INTEGRATION_CASES.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    for (const c of INTEGRATION_CASES) {
      expect(c.gold.length).toBeGreaterThan(0)
      expect(new Set(c.gold).size).toBe(c.gold.length)
      expect(c.why.trim().length).toBeGreaterThan(0)
    }
  })

  it('类别名副其实:cross-store 跨 ≥2 个店,single-store 恰好 1 个', () => {
    for (const c of INTEGRATION_CASES) {
      const stores = new Set(c.gold.map((id) => parseNodeId(id)?.store))
      expect(stores.has(undefined)).toBe(false)
      if (c.category === 'cross-store') expect(stores.size).toBeGreaterThanOrEqual(2)
      else expect(stores.size).toBe(1)
    }
  })

  it('single-store 不是清一色记忆:对照组也得考到别的店', () => {
    const stores = INTEGRATION_CASES.filter((c) => c.category === 'single-store').flatMap((c) =>
      c.gold.map((id) => parseNodeId(id)!.store),
    )
    expect(new Set(stores).size).toBeGreaterThanOrEqual(2)
  })

  it('节点足够多,k=5 才是有选择性的', async () => {
    const nodes = await enumerateNodes(space)
    const ids = nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    // 5 个名额 / 20+ 个节点 ⇒ 蒙对的概率低到分数有意义。
    expect(nodes.length).toBeGreaterThanOrEqual(20)
    // 五个店一个都不能空,否则某一店的漏检永远量不出来。
    const stores = new Set(nodes.map((n) => n.store))
    expect([...stores].sort()).toEqual(['dossier', 'knowledge', 'memory', 'session', 'task'])
  })

  it('列举是确定性的:同一个空间连列两次逐条相同', async () => {
    const a = await enumerateNodes(space)
    const b = await enumerateNodes(space)
    expect(b.map((n) => n.id)).toEqual(a.map((n) => n.id))
    expect(b.map((n) => n.text)).toEqual(a.map((n) => n.text))
  })
})

describe('③ 基线(今天的生产召回)', () => {
  let base: IntegrationBenchResult

  beforeAll(async () => {
    base = await scoreIntegration(memoryOnlyRecall, space, INTEGRATION_CASES)
    // 数字进 CI 日志,免得只有地板没有实测值。
    console.log(formatIntegrationResult('基线 · 只读记忆', base))
  })

  it('总体不低于地板', () => {
    expect(base.recallAtK).toBeGreaterThanOrEqual(BASELINE_FLOORS.recallAtK)
    expect(base.mrr).toBeGreaterThanOrEqual(BASELINE_FLOORS.mrr)
    expect(base.hitRate).toBeGreaterThanOrEqual(BASELINE_FLOORS.hitRate)
  })

  it('跨店那半不低于地板', () => {
    expect(base.byCategory['cross-store']!.recallAtK).toBeGreaterThanOrEqual(BASELINE_CROSS_STORE_FLOOR)
  })

  it('回归钉子:答案完整躺在记忆里的那一条必须满分', () => {
    const peanut = base.perCase.find((c) => c.name === 'peanut-allergy')!
    expect(peanut.recallAtK).toBe(1)
    expect(peanut.reciprocalRank).toBe(1)
  })

  it('钉住今天够不到的那些:黄金全在别的店 ⇒ 一分不得', () => {
    for (const name of ['coffee-repair', 'tax-prep', 'tomato-fertilizer']) {
      const c = base.perCase.find((x) => x.name === name)!
      expect(c.recallAtK).toBe(0)
      expect(c.hit).toBe(false)
    }
  })
})

describe('④ 今天的结构性天花板', () => {
  it('生产召回只可能吐 memory: 前缀的 id', async () => {
    const recall = memoryOnlyRecall(space)
    const seen: string[] = []
    for (const c of INTEGRATION_CASES) {
      seen.push(...(await recall({ text: c.query.text, k: 5 })))
    }
    // 六问下来它确实开过口(否则下面那条断言空洞地真)。
    expect(seen.length).toBeGreaterThan(0)
    for (const id of seen) expect(parseNodeId(id)?.store).toBe('memory')
  })

  it('它给的是自信的错答案,不是沉默', async () => {
    // 「咖啡机出水慢」在记忆里只有「我每天喝手冲咖啡」——最像答案的那条,
    // 恰恰不是答案。M2 之前这道题结构上无解,量出来的就该是这个形状。
    const recall = memoryOnlyRecall(space)
    const page = await recall({ text: '咖啡机出水慢要怎么处理', k: 5 })
    expect(page).toContain('memory:m-coffee-habit')
    const gold = new Set(INTEGRATION_CASES.find((c) => c.name === 'coffee-repair')!.gold)
    for (const id of page) expect(gold.has(id)).toBe(false)
  })
})

describe('⑤ M2b · 跨店联想网', () => {
  let base: IntegrationBenchResult
  let net: IntegrationBenchResult

  beforeAll(async () => {
    base = await scoreIntegration(memoryOnlyRecall, space, INTEGRATION_CASES)
    net = await scoreIntegration(netRecall(space), space, INTEGRATION_CASES)
    console.log(formatIntegrationResult('M2b · 跨店联想网', net))
  })

  it('总体不低于地板', () => {
    expect(net.recallAtK).toBeGreaterThanOrEqual(NET_FLOORS.recallAtK)
    expect(net.mrr).toBeGreaterThanOrEqual(NET_FLOORS.mrr)
    expect(net.hitRate).toBeGreaterThanOrEqual(NET_FLOORS.hitRate)
  })

  it('跨店那半不低于地板', () => {
    expect(net.byCategory['cross-store']!.recallAtK).toBeGreaterThanOrEqual(NET_CROSS_STORE_FLOOR)
  })

  it('抬升是同尺同夹具量出来的:三项都严格高于基线', () => {
    // 断言的是「比基线高」而不是「等于某个数」——后者等于把答案抄进门里。
    expect(net.recallAtK).toBeGreaterThan(base.recallAtK)
    expect(net.mrr).toBeGreaterThan(base.mrr)
    expect(net.hitRate).toBeGreaterThan(base.hitRate)
    expect(net.byCategory['cross-store']!.recallAtK).toBeGreaterThan(base.byCategory['cross-store']!.recallAtK)
  })

  it('M1 钉死的三条零分用例,现在真的够得到别的店', () => {
    // ③ 里那条钉子说的是「今天的生产召回」一分不得;这条说的是同一批题,
    // 换成跨店召回之后不再是零。两条都留着,退步时红的是后面这条。
    for (const name of ['coffee-repair', 'tax-prep', 'tomato-fertilizer']) {
      const c = net.perCase.find((x) => x.name === name)!
      expect(c.recallAtK).toBeGreaterThan(0)
      expect(c.hit).toBe(true)
    }
  })

  it('回归钉子:全场只有一个节点有信号时,不许返空', async () => {
    // 这条钉的是 SEED_FLOOR。`fuseArms` 的分是相对的,唯一幸存者会被 min-max
    // 归一成 0;若拿它当种子推力,扩散全灭、整页返空——而它正是唯一的正确
    // 答案。2026-09-02 实测撞到过:基线满分的 peanut-allergy 接上网反而归零。
    const peanut = net.perCase.find((c) => c.name === 'peanut-allergy')!
    expect(peanut.recallAtK).toBe(1)
    expect(peanut.reciprocalRank).toBe(1)

    // 端到端之外再直接钉一次「只有一个节点有信号」这个形状本身,
    // 免得哪天夹具变厚、peanut 不再是独苗,这条钉子静默退化成空洞地真。
    const built = await buildMemoryNet(space)
    const page = await crossStoreRecall(built, '我对什么过敏', { k: 5 })
    expect(page[0]).toBe('memory:m-peanut')
  })

  it('每店配额:任何一个店都占不满一页', async () => {
    // k **必须比配额宽出去**才量得到这件事。这道门平时跑 k=5,而 k=5 时这份
    // 夹具上根本没有哪个店能凑够 4 条 —— 拿 k=5 写这条断言,拆掉配额它照样
    // 绿(2026-09-02 变异 N2-B 抓到过一次:那时它是空洞地真)。
    const built = await buildMemoryNet(space)
    const K = 8
    let bindingCases = 0
    for (const c of INTEGRATION_CASES) {
      const countByStore = async (quota: number): Promise<Map<string, number>> => {
        const page = await crossStoreRecall(built, c.query.text, { k: K, quota })
        const m = new Map<string, number>()
        for (const id of page) {
          const st = parseNodeId(id)!.store
          m.set(st, (m.get(st) ?? 0) + 1)
        }
        return m
      }
      // 阳性对照:不设配额时确实有店会超额 —— 否则下面那条不算量到了配额。
      const free = await countByStore(Number.MAX_SAFE_INTEGER)
      if ([...free.values()].some((n) => n > DEFAULT_STORE_QUOTA)) bindingCases += 1

      const capped = await countByStore(DEFAULT_STORE_QUOTA)
      for (const [st, n] of capped) {
        expect(`${c.name}/${st}=${n}`).toBe(`${c.name}/${st}=${Math.min(n, DEFAULT_STORE_QUOTA)}`)
      }
    }
    // 至少一半用例里配额是真咬着的,这条断言才不是摆设。
    expect(bindingCases).toBeGreaterThanOrEqual(3)
  })

  it('吐出来的 id 真跨得出 memory 一店:④ 那条天花板被顶破了', async () => {
    const built = await buildMemoryNet(space)
    const stores = new Set<string>()
    for (const c of INTEGRATION_CASES) {
      for (const id of await crossStoreRecall(built, c.query.text, { k: 5 })) {
        stores.add(parseNodeId(id)!.store)
      }
    }
    // ④ 量到的是清一色 `memory:`;这里必须五个店都出得来。
    expect([...stores].sort()).toEqual(['dossier', 'knowledge', 'memory', 'session', 'task'])
  })
})
