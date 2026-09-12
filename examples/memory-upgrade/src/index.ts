/**
 * MU capstone — measured retrieval ranking and evidence-grounded memory.
 *
 * Composes the real exported MU code over synthetic personal memory. Act 1
 * measures ranking with MU-M1's scoreRetriever; Act 2 checks exact-source recall.
 *
 *   Act 1 — MU-M2 fusion reranks. The SAME corpus, scored by the SAME cases:
 *           keyword baseline vs the fused retriever. recall@5 is already fine on
 *           these cases; what MU-M2 moves is the RANK — the focused, on-topic fact
 *           that keyword buries under newer passing mentions gets lifted to #1
 *           (MRR jumps). A `direct` control pins the easy cases so fusion can't
 *           silently regress them.
 *
 *   Act 2 — MU-M3 selects durable user statements by source ID and retains exact
 *           quotes, speaker and turn time. Literal recall stays 100%; no invented
 *           synonym bridge or favorite inferred from one purchase. This checks
 *           storage/recall, not a real model's judgment of statement durability.
 *
 * Then a closing ledger places MU-M4 (external Mem0 provider) and MU-M5 (git
 * snapshot) — the two OPT-IN facets that deliberately don't move the recall
 * number — and echoes the north star: the framework ran ZERO models here. The one
 * "model call" (Act 2's extraction) is a DETERMINISTIC stand-in; in production it
 * is the butler's own model, on the 6h BACKGROUND maintenance sweep, never the
 * per-turn hot path. No API key, fully reproducible.
 *
 *   pnpm demo:memory-upgrade      # exits 0 iff every check holds, 1 otherwise
 */

import {
  atomicFactsReviewer,
  buildInvertedIndex,
  formatBenchResult,
  fusedRetriever,
  invertedIndexRetriever,
  isAtomicFact,
  scoreRetriever,
  type MemorySummarizer,
  type RecallCase,
} from '@gotong/personal-memory'
import type {
  MemoryEntry,
  MemoryHandle,
  MemoryKind,
  MemoryQuery,
  NewMemoryEntry,
} from '@gotong/services-sdk'

/** A fixed clock origin (Nov 2023) so every ts — and thus every score — is byte-stable. */
const T0 = 1_700_000_000_000
/** Concise semantic-entry builder. `min` = minutes past T0, which drives recency ties. */
const e = (id: string, text: string, min: number): MemoryEntry => ({
  id,
  kind: 'semantic',
  text,
  ts: T0 + min * 60_000,
})

const failures: string[] = []
/** Record a named check; a false condition fails the demo (non-zero exit). */
function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(label)
}

// ───────────────────────────────────────────────────────────────────────────
// Act 1 — MU-M2 fusion reranks the focused fact to #1 (the MU-M1 ruler measures it)
// ───────────────────────────────────────────────────────────────────────────

/**
 * 小美 (Mira)'s butler memory, as MU-M1 benchmark cases. `direct` is a control
 * (keyword already ranks the answer first — fusion must not regress it);
 * `cross-session` is where MU-M2 earns its keep — the gold is OLD and FOCUSED (it
 * repeats the query term), while newer distractors mention it once in passing, so
 * keyword's coarse coverage TIES them and recency buries the gold.
 */
const RANK_CASES: RecallCase[] = [
  {
    name: '直接-邮箱(控制)',
    category: 'direct',
    corpus: [
      e('mail-gold', '小美的邮箱是 mira@example.com', 1),
      e('mail-x1', '小美的电话是 012-3456789', 2),
      e('mail-x2', '公司在吉隆坡市中心', 3),
      e('mail-x3', '小美喜欢用 Figma 做设计', 4),
    ],
    query: { text: 'mira 邮箱' },
    relevantIds: ['mail-gold'],
  },
  {
    name: '跨会话-奶茶',
    category: 'cross-session',
    corpus: [
      e('tea-gold', '小美最爱的奶茶店是喜茶,他家的奶茶特别好喝,她常去喝奶茶', 1), // 奶茶 ×3, OLD + focused
      e('tea-x1', '今天路过一家奶茶店', 40),
      e('tea-x2', '奶茶喝多了对身体不好', 50),
      e('tea-x3', '楼下新开了一家奶茶店', 60),
    ],
    query: { text: '奶茶' },
    relevantIds: ['tea-gold'],
  },
  {
    name: '跨会话-健身',
    category: 'cross-session',
    corpus: [
      e('fit-gold', '小美的健身计划是每周三次,这个健身计划坚持了三个月,健身计划很有效', 1),
      e('fit-x1', '今天健身房好多人', 40),
      e('fit-x2', '周末有个旅行计划', 50),
      e('fit-x3', '健身计划要坚持才行', 60), // ties the gold on coverage → recency would pick this
    ],
    query: { text: '健身 计划' },
    relevantIds: ['fit-gold'],
  },
]

async function act1(): Promise<void> {
  console.log('\n═══ Act 1 — MU-M2 融合把「真正在讲这件事」的旧事实排到第 1(MU-M1 尺子量) ═══\n')

  // Same cases, two retrievers. Keyword baseline = today's default; fused = MU-M2.
  const keyword = await scoreRetriever((corpus) => invertedIndexRetriever(buildInvertedIndex(corpus)), RANK_CASES)
  const fused = await scoreRetriever((corpus) => fusedRetriever(buildInvertedIndex(corpus)), RANK_CASES)

  console.log(formatBenchResult('keyword 基线(升级前)', keyword))
  console.log(formatBenchResult('fused  融合(MU-M2)', fused))
  console.log()

  const kwCross = keyword.byCategory['cross-session']!
  const fzCross = fused.byCategory['cross-session']!
  const kwDirect = keyword.byCategory['direct']!

  check('控制:direct 类 keyword 已 recall@5=MRR=1(易题基准)', kwDirect.recallAtK === 1 && kwDirect.mrr === 1)
  check('无回归:fused recall@5 ≥ keyword(融合只重排不丢召回)', fused.recallAtK >= keyword.recallAtK)
  check(`MU-M2 抬升:fused MRR > keyword MRR(${fused.mrr.toFixed(3)} > ${keyword.mrr.toFixed(3)})`, fused.mrr > keyword.mrr)
  check(
    `目标类:cross-session MRR ${kwCross.mrr.toFixed(3)} → ${fzCross.mrr.toFixed(3)}(聚焦金标提到第 1)`,
    fzCross.mrr > kwCross.mrr,
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Act 2 — MU-M3 retains exact user evidence without invented synonym bridges
// ───────────────────────────────────────────────────────────────────────────

interface EvidenceCase {
  id: string
  q: string
  synonym: string
  answer: string
  user: string
}
const EVIDENCE_CASES: EvidenceCase[] = [
  {
    id: 'pet',
    q: '金毛',
    synonym: '宠物',
    answer: '大黄',
    user: '我养了只金毛叫大黄',
  },
  {
    id: 'car',
    q: 'Tesla',
    synonym: 'electric vehicle',
    answer: 'Model 3',
    user: 'I drive a Tesla Model 3',
  },
]

/**
 * A tiny in-memory `MemoryHandle` — substring recall, newest-first, per-kind
 * filter — mirroring the file backend closely enough to drive the REAL
 * `atomicFactsReviewer`, without touching disk. The reviewer uses list + remember.
 */
function inMemory(seed: readonly MemoryEntry[]): MemoryHandle {
  const entries: MemoryEntry[] = [...seed]
  let seq = 0
  return {
    async recall(q: MemoryQuery): Promise<MemoryEntry[]> {
      const text = q.text?.toLowerCase()
      return entries
        .filter((x) => !q.kinds || q.kinds.includes(x.kind))
        .filter((x) => !text || x.text.toLowerCase().includes(text))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, q.k ?? 20)
    },
    async remember(ne: NewMemoryEntry): Promise<MemoryEntry> {
      const en: MemoryEntry = {
        id: ne.id ?? `fact-${++seq}`,
        kind: ne.kind,
        text: ne.text,
        ts: T0 + 1000 + seq,
        ...(ne.meta !== undefined ? { meta: ne.meta } : {}),
      }
      entries.push(en)
      return en
    },
    async list(opts: { kind?: MemoryKind; limit?: number } = {}): Promise<MemoryEntry[]> {
      return entries.filter((x) => !opts.kind || x.kind === opts.kind).slice(0, opts.limit ?? 100)
    },
    async forget(): Promise<void> {},
    async patchMeta(): Promise<boolean> {
      return false
    },
    async clear(): Promise<void> {},
  }
}

/** Literal and synonym recall are measured separately, with the same retriever. */
async function answerRecall(corpus: readonly MemoryEntry[], synonym = false): Promise<number> {
  const retriever = invertedIndexRetriever(buildInvertedIndex(corpus))
  let hits = 0
  for (const c of EVIDENCE_CASES) {
    const page = await retriever.retrieve({ text: synonym ? c.synonym : c.q, k: 5 })
    if (page.some(x => x.text.includes(c.answer))) hits++
  }
  return hits / EVIDENCE_CASES.length
}

async function act2(): Promise<void> {
  console.log('\n═══ Act 2 — MU-M3 保留用户原句证据,不把一次购买变成最爱 ═══\n')

  // Synthetic structured captures, not a migration of ambiguous legacy transcripts.
  const users = [
    ...EVIDENCE_CASES,
    { id: 'purchase', user: '上周点了一杯珍珠奶茶很好喝' },
    { id: 'filler', user: '今天天气不错' },
  ]
  const episodic: MemoryEntry[] = users.map(({ id, user }, i) => ({
    id, kind: 'episodic', text: `User: ${user} / Butler: 用户最爱的饮料是珍珠奶茶`,
    ts: T0 + i * 60_000,
    meta: {
      userSpan: { v: 1, start: 6, end: 6 + user.length },
      temporal: { v: 1, observedAt: T0 + i * 60_000, timeZone: 'UTC', basis: 'turn-start' },
    },
  }))
  const before = await answerRecall(episodic)
  const synonymBefore = await answerRecall(episodic, true)
  const memory = inMemory(episodic)
  const summarize: MemorySummarizer = async ({ user }) => {
    const supplied = JSON.parse(user) as { sources: { sourceId: string; text: string }[] }
    check('模型输入仅含用户原句,不含助手猜测',
      !user.includes('最爱') && supplied.sources.length === users.length &&
      supplied.sources.every(s => users.some(u => u.id === s.sourceId && u.user === s.text)))
    return JSON.stringify({ sources: EVIDENCE_CASES.map(c => c.id) })
  }
  const out = await atomicFactsReviewer({ summarize })({ memory, episodic, now: T0 + 100 * 60_000 })
  const facts = (await memory.recall({ kinds: ['semantic'], k: 50 })).filter(isAtomicFact)
  const after = await answerRecall(facts)
  const synonymAfter = await answerRecall(facts, true)

  console.log('  保存的用户原句:')
  for (const f of facts) console.log(`    · ${f.text}`)
  console.log(`\n  原词 answer-recall@5: ${before * 100}% → ${after * 100}%`)
  console.log(`  同义词 answer-recall@5: ${synonymBefore * 100}% → ${synonymAfter * 100}%(不声称抬升)\n`)

  check('写入两条带 atomicFact 标记的原句', out.consolidated === 2 && facts.length === 2)
  check('每条写入逐字等于用户原话', EVIDENCE_CASES.every(c => facts.some(f => f.text === c.user)))
  check('来源 ID、user 说话人和时间保留', facts.every(f => {
    const evidence = f.meta?.evidence as {
      v?: number
      sources?: { sourceId: string; speaker: string; start: number; end: number; temporal?: unknown }[]
    } | undefined
    const source = evidence?.sources?.[0]
    const original = episodic.find(e => e.id === source?.sourceId)
    return evidence?.v === 1 && evidence.sources?.length === 1 && source?.speaker === 'user' &&
      source.start === 0 && source.end === f.text.length && original !== undefined &&
      JSON.stringify(source.temporal) === JSON.stringify(original.meta?.temporal)
  }))
  check('未将一次奶茶购买或助手猜测升级成最爱', !facts.some(f => /最爱|favorite|珍珠奶茶/.test(f.text)))
  check('原词召回保持 100%,不是虚构的 0→100% 提升', before === 1 && after === 1)
  check('不添加类别词制造同义词桥接', synonymBefore === 0 && synonymAfter === 0)
  console.log('  边界:确定性来源选择验证保存与召回,不证明真实模型的长期价值判断。')
}

// ───────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════════════╗')
  console.log('║  MU capstone — 检索重排与用户证据保真                                ║')
  console.log('╚══════════════════════════════════════════════════════════════════════╝')

  await act1()
  await act2()

  console.log('\n═══ 收尾账本 — 五项里程碑各归其位 ═══\n')
  console.log('  MU-M1 尺子  : scoreRetriever(recall@k / MRR)—— Act 1 用它量检索重排。')
  console.log('  MU-M2 融合  : fusedRetriever + 本地 embedder —— Act 1 把聚焦金标从被埋提到第 1(MRR↑)。')
  console.log('  MU-M3 抽取  : atomicFactsReviewer —— Act 2 保留用户原句、来源和时间,不虚构偏好或同义词抬升。')
  console.log('  MU-M4 外部  : opt-in Mem0 托管云连接器 + dataLeavesBox 披露 —— 记忆可存云端,不改本地召回数;')
  console.log('               装上≠授权同步出去(见 builtin-mcp-connectors 防腐测试)。')
  console.log('  MU-M5 快照  : opt-in GOTONG_BUTLER_MEMORY_GIT —— 6h 维护里给记忆树 per-user git commit,')
  console.log('               免费的历史/时光机/审计,best-effort 缺 git 优雅降级(见 butler-memory-git 集成测试)。')
  console.log('\n  北极星:本 demo 全程框架跑了 0 个模型。Act 2 唯一的「模型调用」是确定性替身;真实部署里')
  console.log('  它是管家自己的模型,在 6h 后台维护里跑,每轮对话的热路径永远零 LLM。凭证零、可复现。\n')

  if (failures.length > 0) {
    console.error(`✗ MU capstone 失败:${failures.length} 项未通过`)
    for (const f of failures) console.error(`    · ${f}`)
    process.exit(1)
  }
  console.log('✓ MU capstone 全数通过:M2 重排(MRR↑),M3 用户证据保真且原词召回不降。')
}

main().catch((err) => {
  console.error('MU capstone 崩溃:', err)
  process.exit(1)
})
