/**
 * assoc-net.test.ts — 联想网 (memory economy M2a) 的承重门。
 *
 * 论证顺序就是可信度的依赖链,和 M1 那把尺一样:
 *
 *   ① **四类边各自只在该出现时出现**。一条无差别乱连的边等于没有边——
 *      扩散会把每个节点都激活,分数排序退化成显著性排序,而那正是今天已经有的东西。
 *      所以先钉「不该连的不连」,再谈连对了能捞回什么。
 *   ② **大小是构造性有界的**。设计承诺「没有一层随对话轮数线性增长」,落到代码就是
 *      每类边总数 ≤ 节点数 × topK。界在总数上而不在单点度数上——一个枢纽节点会被
 *      很多别人选进各自的 top-K,度数可以高于 topK,但每跳工作量 O(边数) 仍然线性。
 *      这条不写成断言,承诺就只是句话。
 *   ③ **扩散的三条设计承诺各配一条会红的用例**:多路径求和 / 显著性只乘一次 /
 *      翻篇的既不被激活也不被穿过。第三条尤其要钉「不被穿过」——只过滤输出的话,
 *      一条已作废的事实照样能当桥把无关的东西连进来。
 *   ④ **配额与记忆单**是给模型看的那一页,判据是保序、带出处、按字节而非按行收口。
 *   ⑤ **fuseArms 与抽取前的算术逐值相同**。抽取的目的就是「两把尺公式同源」,
 *      抽完却变了值,等于把要证的东西弄丢了。
 */

import { describe, expect, it } from 'vitest'

import {
  applyStoreQuota,
  deriveEdges,
  diffuse,
  fuseArms,
  renderMemorySheet,
  localBigramEmbedder,
  relevanceScore,
  cosineSimilarity,
  DEFAULT_NODE_SALIENCE,
  EDGE_KIND_WEIGHT,
  type AssocEdge,
  type AssocEdgeKind,
  type AssocNode,
} from '../src/index.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_700_000_000_000

function node(part: Partial<AssocNode> & Pick<AssocNode, 'id' | 'store' | 'text'>): AssocNode {
  return { ts: T0, salience: DEFAULT_NODE_SALIENCE, ...part }
}

/** Edges of one kind, as `from->to` strings — the shape assertions read from. */
function pairs(edges: readonly AssocEdge[], kind: AssocEdgeKind): string[] {
  return edges.filter((e) => e.kind === kind).map((e) => `${e.from}->${e.to}`)
}

describe('① 四类边各自只在该出现时出现', () => {
  it('semantic 边逐字来自 links,悬空 id 不造边', () => {
    const nodes = [
      node({ id: 'memory:a', store: 'memory', text: '甲', links: ['memory:b', 'memory:GHOST'] }),
      node({ id: 'memory:b', store: 'memory', text: '乙' }),
    ]
    const e = deriveEdges(nodes, { cooccurMin: 2, temporalWindowMs: 0 })
    expect(pairs(e, 'semantic')).toEqual(['memory:a->memory:b'])
    // 悬空 id 既不成边,也没有被凭空造成节点。
    expect(e.every((x) => x.from !== 'memory:GHOST' && x.to !== 'memory:GHOST')).toBe(true)
  })

  it('origin 边要求指针逐字出现,且短指针不算', () => {
    const long = [
      node({ id: 'task:tn-1', store: 'task', text: '照 appliances/coffee.md 修咖啡机' }),
      node({ id: 'knowledge:appliances/coffee.md', store: 'knowledge', text: '拆洗冲泡头' }),
    ]
    expect(pairs(deriveEdges(long, { cooccurMin: 2, temporalWindowMs: 0 }), 'origin')).toEqual([
      'knowledge:appliances/coffee.md->task:tn-1',
    ])
    // 指针只有两个字符时,任何一段文本都可能偶然包含它 ⇒ 结构上不认。
    // 注意「含短指针的必须是对方的文本」——写成自己含自己的指针,这条用例会空洞
    // 地真:拆掉护栏也照样绿(2026-09-02 变异 N-D 抓到过一次)。
    const short = [
      node({ id: 'task:tn-9', store: 'task', text: '这句话里含 m1 这两个字符' }),
      node({ id: 'memory:m1', store: 'memory', text: '一段与任务无关的话' }),
    ]
    expect(pairs(deriveEdges(short, { cooccurMin: 2, temporalWindowMs: 0 }), 'origin')).toEqual([])
    // 同一对节点,把门槛降到 1 个字符就必须连上 —— 证明拦住它的确实是长度护栏。
    expect(
      deriveEdges(
        [
          node({ id: 'task:tn-9', store: 'task', text: '这句话里含 mem 这三个字符' }),
          node({ id: 'memory:mem', store: 'memory', text: '一段与任务无关的话' }),
        ],
        { cooccurMin: 2, temporalWindowMs: 0 },
      ).filter((e) => e.kind === 'origin'),
    ).toHaveLength(1)
  })

  it('cooccur 边低于阈值不连:同一对节点,抬高阈值就该断', () => {
    const nodes = [
      node({ id: 'a:1', store: 'a', text: '咖啡机出水慢要拆洗' }),
      node({ id: 'b:1', store: 'b', text: '咖啡机的冲泡头该拆洗了' }),
    ]
    const loose = deriveEdges(nodes, { cooccurMin: 0, temporalWindowMs: 0 })
    expect(pairs(loose, 'cooccur')).toEqual(['a:1->b:1'])
    // 阈值抬到 1(完全相同才算)后同一对必须断开——证明阈值真的在把关。
    expect(pairs(deriveEdges(nodes, { cooccurMin: 1, temporalWindowMs: 0 }), 'cooccur')).toEqual([])
  })

  it('temporal 边超窗不连,窗内权重随间隔单调下降', () => {
    const mk = (gap: number): AssocEdge[] =>
      deriveEdges(
        [
          node({ id: 'a:1', store: 'a', text: '甲', ts: T0 }),
          node({ id: 'b:1', store: 'b', text: '乙', ts: T0 + gap }),
        ],
        { cooccurMin: 2, temporalWindowMs: DAY },
      )
    const near = mk(1000)
    const far = mk(DAY - 1000)
    expect(pairs(near, 'temporal')).toEqual(['a:1->b:1'])
    expect(pairs(mk(DAY + 1), 'temporal')).toEqual([])
    expect(near[0]!.weight).toBeGreaterThan(far[0]!.weight)
  })

  it('边权 = 类型基权 × 该对的强度,类型排序固定', () => {
    expect(EDGE_KIND_WEIGHT.semantic).toBeGreaterThan(EDGE_KIND_WEIGHT.origin)
    expect(EDGE_KIND_WEIGHT.origin).toBeGreaterThan(EDGE_KIND_WEIGHT.cooccur)
    expect(EDGE_KIND_WEIGHT.cooccur).toBeGreaterThan(EDGE_KIND_WEIGHT.temporal)
    const e = deriveEdges(
      [
        node({ id: 'memory:a', store: 'memory', text: '甲', links: ['memory:b'] }),
        node({ id: 'memory:b', store: 'memory', text: '乙' }),
      ],
      { cooccurMin: 2, temporalWindowMs: 0 },
    )
    expect(e).toHaveLength(1)
    expect(e[0]!.weight).toBeCloseTo(EDGE_KIND_WEIGHT.semantic, 10)
  })

  it('确定性:打乱输入顺序,边列表逐条相同', () => {
    const nodes = [
      node({ id: 'a:1', store: 'a', text: '咖啡机出水慢', ts: T0 }),
      node({ id: 'b:1', store: 'b', text: '咖啡机拆洗步骤', ts: T0 + 500 }),
      node({ id: 'c:1', store: 'c', text: '番茄该施肥了', ts: T0 + 900 }),
      node({ id: 'd:1', store: 'd', text: '番茄苗长得慢', ts: T0 + 1200 }),
    ]
    const a = deriveEdges(nodes)
    const b = deriveEdges([...nodes].reverse())
    expect(b).toEqual(a)
    // 而且真的连出了东西,否则上面那条断言空洞地真。
    expect(a.length).toBeGreaterThan(0)
  })
})

describe('② 大小是构造性有界的', () => {
  const many: AssocNode[] = Array.from({ length: 40 }, (_, i) =>
    node({ id: `s${i % 4}:${i}`, store: `s${i % 4}`, text: `咖啡机出水慢第 ${i} 条记录`, ts: T0 + i }),
  )

  it('每类边的总数不超过 节点数 × topK', () => {
    const topK = 3
    const edges = deriveEdges(many, { topK })
    for (const kind of ['semantic', 'origin', 'cooccur', 'temporal'] as const) {
      expect(edges.filter((x) => x.kind === kind).length).toBeLessThanOrEqual(many.length * topK)
    }
    // 注意界在总数上,不在单点度数上:一个「人人都像它」的枢纽节点会被很多别人
    // 选进各自的 top-K,度数因此可以高于 topK。这不破坏大小承诺——扩散每跳的
    // 工作量是 O(边数),而边数照上面这条界仍然随节点数线性。想把度数也压住就得
    // 剪掉对称回边,那会让结果依赖剪枝顺序,代价比收益大。
    expect(edges.length).toBeGreaterThan(0)
  })

  it('边总数 ≤ 节点数 × 边类数 × topK', () => {
    const topK = 3
    const edges = deriveEdges(many, { topK })
    expect(edges.length).toBeLessThanOrEqual(many.length * 4 * topK)
    expect(edges.length).toBeGreaterThan(0)
  })

  it('topK=0 ⇒ 一条边都不连(整层可关)', () => {
    expect(deriveEdges(many, { topK: 0 })).toEqual([])
  })
})

describe('③ 扩散的三条设计承诺', () => {
  const edge = (from: string, to: string, weight: number): AssocEdge => ({
    from,
    to,
    kind: 'cooccur',
    weight,
  })

  it('多路径求和:被两个种子都指到,分数是两条路之和', () => {
    const nodes = [
      node({ id: 'a:1', store: 'a', text: '种子甲' }),
      node({ id: 'b:1', store: 'b', text: '种子乙' }),
      node({ id: 'c:1', store: 'c', text: '中间那个' }),
    ]
    const edges = [edge('a:1', 'c:1', 0.5), edge('b:1', 'c:1', 0.5)]
    const one = diffuse(new Map([['a:1', 1]]), nodes, edges, { hops: 1 })
    const two = diffuse(
      new Map([
        ['a:1', 1],
        ['b:1', 1],
      ]),
      nodes,
      edges,
      { hops: 1 },
    )
    const c1 = one.find((x) => x.id === 'c:1')!.score
    const c2 = two.find((x) => x.id === 'c:1')!.score
    expect(c2).toBeCloseTo(2 * c1, 10)
  })

  it('多路径求和是排序上的差别:两个种子指到的,压过一个种子指到的', () => {
    const nodes = [
      node({ id: 'a:1', store: 'a', text: '种子甲' }),
      node({ id: 'b:1', store: 'b', text: '种子乙' }),
      node({ id: 'both:1', store: 'c', text: '两边都指到的' }),
      node({ id: 'one:1', store: 'c', text: '只有甲指到的' }),
    ]
    const edges = [
      edge('a:1', 'both:1', 0.5),
      edge('b:1', 'both:1', 0.5),
      edge('a:1', 'one:1', 0.5),
    ]
    const r = diffuse(
      new Map([
        ['a:1', 1],
        ['b:1', 1],
      ]),
      nodes,
      edges,
      { hops: 1 },
    )
    const by = new Map(r.map((x) => [x.id, x.score]))
    // 边权、跳数、显著性全都相同,唯一的差别就是被几条路指到。
    expect(by.get('both:1')!).toBeGreaterThan(by.get('one:1')!)
    // 种子本身仍在最前——直接命中比联想到的更可信,求和不该把这条颠倒过来。
    expect(r[0]!.hops).toBe(0)
  })

  it('显著性只乘一次:2 跳外的节点不吃平方', () => {
    const nodes = [
      node({ id: 'a:1', store: 'a', text: '种子', salience: 1 }),
      node({ id: 'b:1', store: 'b', text: '一跳', salience: 3 }),
      node({ id: 'c:1', store: 'c', text: '两跳', salience: 3 }),
    ]
    const edges = [edge('a:1', 'b:1', 1), edge('b:1', 'c:1', 1)]
    const r = diffuse(new Map([['a:1', 1]]), nodes, edges, { hops: 2, hopDecay: 0.5 })
    const by = new Map(r.map((x) => [x.id, x.score]))
    // 一跳:1 × 0.5 × 1 × salience(3) = 1.5
    expect(by.get('b:1')).toBeCloseTo(1.5, 10)
    // 两跳:1 × 0.5² × 1 × salience(3) = 0.75。若显著性按跳数累乘,这里会是 2.25。
    expect(by.get('c:1')).toBeCloseTo(0.75, 10)
  })

  it('翻篇的既不被激活,也不能当桥被穿过', () => {
    const now = T0 + 10 * DAY
    const nodes = [
      node({ id: 'a:1', store: 'a', text: '种子' }),
      node({ id: 'bridge:1', store: 'b', text: '已作废的中转', validTo: T0 + DAY }),
      node({ id: 'c:1', store: 'c', text: '桥那头' }),
    ]
    const edges = [edge('a:1', 'bridge:1', 1), edge('bridge:1', 'c:1', 1)]
    const open = diffuse(new Map([['a:1', 1]]), nodes, edges, { hops: 2 })
    expect(open.map((x) => x.id).sort()).toEqual(['a:1', 'bridge:1', 'c:1'])
    const closed = diffuse(new Map([['a:1', 1]]), nodes, edges, { hops: 2, now })
    // 作废节点本身不出现,是「不被激活」;桥那头也不出现,才是「不被穿过」。
    expect(closed.map((x) => x.id)).toEqual(['a:1'])
  })

  it('跳数是硬上限:第 3 跳外拿不到分', () => {
    const nodes = ['a:1', 'b:1', 'c:1', 'd:1'].map((id) =>
      node({ id, store: id.split(':')[0]!, text: id }),
    )
    const edges = [edge('a:1', 'b:1', 1), edge('b:1', 'c:1', 1), edge('c:1', 'd:1', 1)]
    const r = diffuse(new Map([['a:1', 1]]), nodes, edges, { hops: 2 })
    expect(r.map((x) => x.id).sort()).toEqual(['a:1', 'b:1', 'c:1'])
    expect(r.find((x) => x.id === 'b:1')!.hops).toBe(1)
    expect(r.find((x) => x.id === 'c:1')!.hops).toBe(2)
  })

  it('不在节点集里的种子被忽略,不会凭空造节点', () => {
    const nodes = [node({ id: 'a:1', store: 'a', text: '在' })]
    const r = diffuse(
      new Map([
        ['a:1', 1],
        ['ghost:1', 9],
      ]),
      nodes,
      [],
      {},
    )
    expect(r.map((x) => x.id)).toEqual(['a:1'])
  })
})

describe('④ 配额与记忆单', () => {
  const ranked = [
    { id: 's1', store: 'session' },
    { id: 's2', store: 'session' },
    { id: 's3', store: 'session' },
    { id: 'k1', store: 'knowledge' },
    { id: 'm1', store: 'memory' },
  ]

  it('配额按店封顶且保序', () => {
    expect(applyStoreQuota(ranked, 2).map((x) => x.id)).toEqual(['s1', 's2', 'k1', 'm1'])
    const perStore = new Map([
      ['session', 1],
      ['knowledge', 0],
    ])
    // 未列出的店不受限(memory 留着),列成 0 的店被完全挡住。
    expect(applyStoreQuota(ranked, perStore).map((x) => x.id)).toEqual(['s1', 'm1'])
  })

  it('记忆单每行都带日期与出处店名', () => {
    const sheet = renderMemorySheet([
      node({ id: 'knowledge:a.md', store: 'knowledge', text: '拆洗冲泡头', ts: T0 }),
    ])
    expect(sheet).toBe('- [2023-11-14 knowledge] 拆洗冲泡头')
  })

  it('字节预算:超预算的行被跳过而不是截断,后面的短行仍能进', () => {
    const rows = [
      node({ id: 'a:1', store: 'a', text: '长'.repeat(100) }),
      node({ id: 'b:1', store: 'b', text: '短' }),
    ]
    const sheet = renderMemorySheet(rows, { maxBytes: 60 })
    expect(sheet.split('\n')).toHaveLength(1)
    // 被跳过的那行不能留下半句话。
    expect(sheet).not.toContain('长')
    expect(sheet).toContain('短')
  })

  it('行数与字节两个上限各自都封得住', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      node({ id: `a:${i}`, store: 'a', text: `第 ${i} 行` }),
    )
    expect(renderMemorySheet(rows, { maxLines: 3 }).split('\n')).toHaveLength(3)
    expect(renderMemorySheet(rows, { maxBytes: 0 })).toBe('')
    expect(renderMemorySheet(rows, { maxLines: 0 })).toBe('')
  })

  it('确定性:同样的行进去,同样的字符串出来', () => {
    const rows = [
      node({ id: 'a:1', store: 'a', text: '甲', ts: T0 }),
      node({ id: 'b:1', store: 'b', text: '乙', ts: T0 + DAY }),
    ]
    expect(renderMemorySheet(rows)).toBe(renderMemorySheet(rows))
  })
})

describe('⑤ fuseArms 与抽取前的算术逐值相同', () => {
  // 无信号项放在 **最前**:两臂归一化必须只在有信号的子集上做,若换成在全体上做,
  // 下标会错位、最小值会被 0 拉低,排序当场翻转。把它放最后则两种公式碰巧同值
  // ——夹具会退化成空洞地真(2026-09-02 变异 N-F 抓到过一次)。
  const items = [
    { id: '0', text: '完全无关的一句话' },
    { id: '1', text: '咖啡机出水慢要拆洗冲泡头' },
    { id: '3', text: '咖啡豆放在柜子里' },
    { id: '2', text: '番茄苗该施肥了' },
  ]

  /** 抽取前 `fusedRetriever` 内联的那段算术,逐行照抄,作为对照实现。 */
  async function legacyFuse(q: string, kw = 0.5, sem = 0.5): Promise<Map<string, number>> {
    const embed = localBigramEmbedder()
    const rel = new Map<string, number>()
    for (const e of items) rel.set(e.id, relevanceScore(q, e.text))
    const cos = new Map<string, number>()
    const vectors = await embed([q, ...items.map((e) => e.text)])
    const qv = vectors[0]!
    items.forEach((e, i) => cos.set(e.id, cosineSimilarity(qv, vectors[i + 1] ?? [])))
    const live = items.filter((e) => (rel.get(e.id) ?? 0) > 0 || (cos.get(e.id) ?? 0) > 0)
    const minMax = (xs: number[]): number[] => {
      const lo = Math.min(...xs)
      const hi = Math.max(...xs)
      const range = hi - lo
      if (!(range > 0)) return xs.map(() => 0)
      return xs.map((x) => (x - lo) / range)
    }
    const relN = minMax(live.map((e) => rel.get(e.id) ?? 0))
    const cosN = minMax(live.map((e) => cos.get(e.id) ?? 0))
    const out = new Map<string, number>()
    live.forEach((e, i) => out.set(e.id, kw * relN[i]! + sem * cosN[i]!))
    return out
  }

  it('三个查询下,逐 id 的融合分与对照实现完全一致', async () => {
    for (const q of ['咖啡机怎么修', '番茄施肥', '柜子']) {
      const got = await fuseArms(q, items)
      const want = await legacyFuse(q)
      expect([...got.keys()].sort()).toEqual([...want.keys()].sort())
      for (const [id, v] of want) expect(got.get(id)).toBeCloseTo(v, 12)
    }
  })

  it('换权重也一致(不是只在默认档下巧合相等)', async () => {
    const got = await fuseArms('咖啡机怎么修', items, { keywordWeight: 0.8, semanticWeight: 0.2 })
    const want = await legacyFuse('咖啡机怎么修', 0.8, 0.2)
    for (const [id, v] of want) expect(got.get(id)).toBeCloseTo(v, 12)
  })

  it('两臂都没信号的项不在 map 里(那是调用方的丢弃名单)', async () => {
    const got = await fuseArms('番茄施肥', items)
    expect(got.has('2')).toBe(true)
    expect(got.has('0')).toBe(false)
    // 空查询 / 空语料 ⇒ 空 map,而不是抛错。
    expect((await fuseArms('   ', items)).size).toBe(0)
    expect((await fuseArms('番茄', [])).size).toBe(0)
  })

  it('embedder 抛错时降级为纯关键词,不把召回变成错误', async () => {
    const boom = async (): Promise<number[][]> => {
      throw new Error('embedder down')
    }
    const got = await fuseArms('咖啡机怎么修', items, { embed: boom })
    expect(got.size).toBeGreaterThan(0)
    expect(got.has('1')).toBe(true)
  })
})
