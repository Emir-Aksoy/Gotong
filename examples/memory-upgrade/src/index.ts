/**
 * MU capstone — "the same memory, the same ruler, progressively better recall".
 *
 * The Memory Upgrade track has ONE falsifiable headline: the butler's recall got
 * measurably better. This demo proves it end-to-end, composing the REAL exported
 * MU code (nothing reimplemented) over one person's butler memory, and measuring
 * with the very ruler MU-M1 shipped (`scoreRetriever`). Two acts:
 *
 *   Act 1 — MU-M2 fusion reranks. The SAME corpus, scored by the SAME cases:
 *           keyword baseline vs the fused retriever. recall@5 is already fine on
 *           these cases; what MU-M2 moves is the RANK — the focused, on-topic fact
 *           that keyword buries under newer passing mentions gets lifted to #1
 *           (MRR jumps). A `direct` control pins the easy cases so fusion can't
 *           silently regress them.
 *
 *   Act 2 — MU-M3 closes the synonym gap. A category query 「饮料」 shares NO term
 *           with its answer 「珍珠奶茶」 — keyword AND the local-fusion embedder
 *           both score 0 by construction (the honest ceiling M2 can't lift). The
 *           real `atomicFactsReviewer` (the 6h maintenance extractor) writes a
 *           self-contained bridge fact 「用户最爱的饮料是珍珠奶茶」, and the same
 *           query now hits it: recall 0 → 1.
 *
 * Then a closing ledger places MU-M4 (external Mem0 provider) and MU-M5 (git
 * snapshot) — the two OPT-IN facets that deliberately don't move the recall
 * number — and echoes the north star: the framework ran ZERO models here. The one
 * "model call" (Act 2's extraction) is a DETERMINISTIC stand-in; in production it
 * is the butler's own model, on the 6h BACKGROUND maintenance sweep, never the
 * per-turn hot path. No API key, fully reproducible.
 *
 *   pnpm demo:memory-upgrade      # exits 0 iff every lift holds, 1 otherwise
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
// Act 2 — MU-M3 atomic-fact extraction closes the synonym gap (recall 0 → 1)
// ───────────────────────────────────────────────────────────────────────────

/** A synonym case: the ANSWER lives only in a raw episodic mention (no category
 *  word), the category query shares no term with it, and query-word decoys fill
 *  the page. `fact` is the self-contained bridge the 6h extraction should write. */
interface SynCase {
  q: string
  answer: string
  episodic: string
  decoys: string[]
  fact: string
}
const SYN_CASES: SynCase[] = [
  {
    q: '饮料',
    answer: '珍珠奶茶',
    episodic: '小美上周在城里点了一杯珍珠奶茶,说很好喝',
    decoys: ['冰箱里常备一些饮料', '便利店买了两瓶饮料', '这个饮料太甜了', '饮料喝多了对身体不好', '办公室有饮料贩卖机'],
    fact: '小美最爱的饮料是珍珠奶茶',
  },
  {
    q: 'electric vehicle',
    answer: 'Tesla',
    episodic: 'Mira drives a Tesla Model 3 to work',
    decoys: [
      'her vehicle registration expired',
      'the electric bill was high this month',
      'a vehicle is blocking the driveway',
      'electric scooters are everywhere now',
      'vehicle insurance is due for renewal',
    ],
    fact: "Mira's vehicle is an electric Tesla Model 3",
  },
]

/**
 * A tiny in-memory `MemoryHandle` — substring recall, newest-first, per-kind
 * filter — mirroring the file backend closely enough to drive the REAL
 * `atomicFactsReviewer`, without touching disk. (The reviewer only calls
 * `recall` + `remember`; the rest satisfy the interface.)
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

/** Fraction of synonym cases whose category query surfaces the ANSWER in top-5,
 *  over the given corpus-per-case — the text-based lift measure MU-M3 uses (the
 *  bridging fact carries the answer, so answer-in-page = the gap closed).
 *
 *  Held at the BASELINE keyword retriever on purpose: Act 1 changed the retriever
 *  (isolating M2); Act 2 changes only what's in the STORE (isolating M3), so the
 *  retriever is the control. This is the exact isolation the shipped MU-M3
 *  consolidation gate uses — a synonym M2's fusion still can't bridge (the bench's
 *  `semantic` category stays 0 under fusion) becomes findable because the store
 *  now holds a category+specific fact the baseline retriever CAN reach. */
async function answerRecall(corpusFor: (c: SynCase) => MemoryEntry[]): Promise<number> {
  let hits = 0
  for (const c of SYN_CASES) {
    const page = await invertedIndexRetriever(buildInvertedIndex(corpusFor(c))).retrieve({ text: c.q, k: 5 })
    if (page.some((x) => x.text.includes(c.answer))) hits++
  }
  return hits / SYN_CASES.length
}

async function act2(): Promise<void> {
  console.log('\n═══ Act 2 — MU-M3 原子事实抽取把检索器够不到的同义词,蒸馏成够得到的事实(recall 0 → 1) ═══\n')

  // BEFORE — a true synonym neither keyword nor M2's fusion can bridge (the
  // bench's `semantic` category stays 0 under both): raw episodic holds the
  // answer but shares no term with the query; category-word decoys fill the page.
  const before = await answerRecall((c) => [
    { id: `${c.q}-ep`, kind: 'episodic', text: c.episodic, ts: T0 + 60_000 },
    ...c.decoys.map((d, i): MemoryEntry => e(`${c.q}-d${i}`, d, 10 + i)),
  ])

  // Run the REAL 6h extractor ONCE over all episodic. The summarizer is a
  // DETERMINISTIC stand-in for the butler's model (so the demo is key-free +
  // reproducible) — in production this is the model reading the transcript on
  // the 6h background sweep. Two benign fillers clear the extraction trigger (4).
  const episodic: MemoryEntry[] = [
    ...SYN_CASES.map((c, i): MemoryEntry => ({ id: `ep-${i}`, kind: 'episodic', text: c.episodic, ts: T0 + (10 + i) * 60_000 })),
    { id: 'ep-f1', kind: 'episodic', text: '小美今天心情不错,和管家聊了会儿天', ts: T0 + 20 * 60_000 },
    { id: 'ep-f2', kind: 'episodic', text: '外面在下雨,小美说想早点回家', ts: T0 + 21 * 60_000 },
  ]
  const memory = inMemory(episodic)
  const summarize: MemorySummarizer = async () => SYN_CASES.map((c) => c.fact).join('\n')
  const out = await atomicFactsReviewer({ summarize })({ memory, episodic, now: T0 + 100 * 60_000 })

  const facts = (await memory.recall({ kinds: ['semantic'], k: 50 })).filter(isAtomicFact)

  // AFTER — the same corpus + the extracted self-contained facts. The category
  // query now hits the bridge fact, which carries the specific answer.
  const after = await answerRecall((c) => [
    { id: `${c.q}-ep`, kind: 'episodic', text: c.episodic, ts: T0 + 60_000 },
    ...c.decoys.map((d, i): MemoryEntry => e(`${c.q}-d${i}`, d, 10 + i)),
    ...facts.map((f, i): MemoryEntry => e(`${c.q}-f${i}`, f.text, 50 + i)),
  ])

  console.log(`  抽取的桥接事实(真 atomicFactsReviewer 写入,带 provenance 标记):`)
  for (const f of facts) console.log(`    · ${f.text}`)
  console.log(`\n  semantic 同义词类 answer-recall@5:  ${(before * 100).toFixed(0)}%  →  ${(after * 100).toFixed(0)}%\n`)

  check(`抽取写入 ${SYN_CASES.length} 条事实,且都带 atomicFact 出处标记`, out.consolidated === SYN_CASES.length && facts.length === SYN_CASES.length)
  check('诚实天花板:抽取前 answer-recall = 0(同义词零共享词,keyword 与 M2 融合皆桥不了)', before === 0)
  check('MU-M3 抬升:抽取后 answer-recall = 100%(桥接事实让类别 query 命中具体答案)', after === 1)
  check('累积:after > before(库里有了可召回的桥接事实)', after > before)
}

// ───────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════════════╗')
  console.log('║  MU capstone — 同一份管家记忆,同一把尺子,召回逐里程碑变好              ║')
  console.log('╚══════════════════════════════════════════════════════════════════════╝')

  await act1()
  await act2()

  console.log('\n═══ 收尾账本 — 五项里程碑各归其位 ═══\n')
  console.log('  MU-M1 尺子  : scoreRetriever(recall@k / MRR)—— 本 demo 两幕都用它量,「变好」可证伪。')
  console.log('  MU-M2 融合  : fusedRetriever + 本地 embedder —— Act 1 把聚焦金标从被埋提到第 1(MRR↑)。')
  console.log('  MU-M3 抽取  : atomicFactsReviewer —— Act 2 把同义词 recall 从 0 抬到 100%(改库不改检索器)。')
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
  console.log('✓ MU capstone 全数通过:M1 尺子量得 M2 重排(MRR↑)+ M3 补召回(0→100%),累积升级成立。')
}

main().catch((err) => {
  console.error('MU capstone 崩溃:', err)
  process.exit(1)
})
