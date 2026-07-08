/**
 * recall-cases.ts — a small, bilingual, LongMemEval/LoCoMo-STYLE fixture for the
 * memory recall benchmark (MU-M1). Each case is a self-contained corpus (gold +
 * distractors) + a query + the gold ids a correct recall should surface.
 *
 * The categories are chosen so the SCORE tells a layered story about where each
 * later milestone earns its lift — a ruler is only useful if its graduations sit
 * exactly in the range the next milestone moves:
 *
 *   - `direct` — keyword already ranks the gold first; these pin recall@5 = 1 and
 *     MRR = 1 so a fusion change can't silently REGRESS the easy cases.
 *   - `cross-session` — the gold is OLD and FOCUSED (it repeats the query term),
 *     while newer distractors mention it once in passing. Keyword coverage is a
 *     coarse binary, so it TIES them and the tie falls to recency → the gold is
 *     buried (MRR ≈ 0.3). recall@5 is still 1 (gold is in the page), so this is
 *     pure RANK headroom: MU-M2's term-frequency cosine arm lifts the focused
 *     gold to rank 1. This is the category M2 must move.
 *   - `temporal` — a superseded fact must NOT be recalled; `activeOnly` (the
 *     production default) drops the closed interval. The gold is the CURRENT fact.
 *   - `multi-hop` — two entries are jointly relevant; recall@k = fraction found.
 *   - `semantic` — the query shares NO term with the gold (「饮料」vs「珍珠奶茶」,
 *     "electric vehicle" vs "Tesla Model 3"), and ENOUGH decoys that DO contain
 *     the query word fill the top-k. Pure keyword scores 0 BY CONSTRUCTION, and
 *     so does a char-overlap embedder (a true synonym is orthogonal) — so this is
 *     the honest CEILING that MU-M3 (a consolidated fact bridging category→
 *     specific) and MU-M4 (a real embedding provider) fill, NOT M2. Kept in the
 *     floor set on purpose: it documents the gap instead of hiding it.
 *
 * All timestamps are fixed constants (no `Date.now()`), so scores are byte-stable.
 */

import type { MemoryEntry } from '@gotong/services-sdk'

import { META_VALID_TO } from '../../src/bitemporal.js'
import type { RecallCase } from '../../src/benchmark.js'

/** A fixed clock origin — Nov 2023. Every entry ts and validity stamp derives from it. */
export const T0 = 1_700_000_000_000

/** The benchmark's "now" — 30 days past T0, so every closed interval below is inactive. */
export const BENCH_NOW = T0 + 30 * 24 * 3600 * 1000

/** Concise entry builder. `min` = minutes past T0 (drives recency ordering). */
function e(id: string, text: string, min: number, meta?: Record<string, unknown>): MemoryEntry {
  return { id, kind: 'semantic', text, ts: T0 + min * 60_000, ...(meta ? { meta } : {}) }
}

/** A closed (superseded) fact — its interval ended early, so `activeOnly` drops it. */
function closed(id: string, text: string, min: number): MemoryEntry {
  return e(id, text, min, { [META_VALID_TO]: T0 + 60_000 })
}

export const RECALL_CASES: RecallCase[] = [
  // ── direct: keyword ranks the gold first; pins recall@5 = MRR = 1. ───────────
  {
    name: 'direct-email-latin',
    category: 'direct',
    corpus: [
      e('d1-gold', '我的邮箱是 emir@example.com', 1),
      e('d1-x1', '我的电话是 012-3456789', 2),
      e('d1-x2', '公司地址在吉隆坡市中心', 3),
      e('d1-x3', '我喜欢用 Figma 做设计', 4),
    ],
    query: { text: 'emir 邮箱' },
    relevantIds: ['d1-gold'],
  },
  {
    name: 'direct-allergy-cn',
    category: 'direct',
    corpus: [
      e('d2-gold', '我对花生过敏', 1),
      e('d2-x1', '我喜欢吃辣', 2),
      e('d2-x2', '周末想去爬山', 3),
      e('d2-x3', '最近在学做面包', 4),
    ],
    query: { text: '花生过敏' },
    relevantIds: ['d2-gold'],
  },
  {
    name: 'direct-project-latin',
    category: 'direct',
    corpus: [
      e('d3-gold', 'Gotong 项目用 pnpm workspace 管理', 1),
      e('d3-x1', '前端用 esbuild 打包', 2),
      e('d3-x2', '测试框架是 vitest', 3),
      e('d3-x3', '数据库用 SQLite', 4),
    ],
    query: { text: 'gotong pnpm' },
    relevantIds: ['d3-gold'],
  },

  // ── cross-session: gold is OLD + FOCUSED, distractors NEW + passing. Keyword
  //    coverage ties them → recency buries the gold (MRR headroom for M2). The
  //    inverted index still makes the old gold a candidate (recall@5 = 1). ───────
  {
    name: 'cross-teahouse-focus',
    category: 'cross-session',
    corpus: [
      e('c1-gold', '我最爱的奶茶店是喜茶,他家的奶茶特别好喝,我常去喝奶茶', 1), // 奶茶 ×3, OLD
      e('c1-x1', '今天路过一家奶茶店', 40),
      e('c1-x2', '奶茶喝多了对身体不好', 50),
      e('c1-x3', '楼下新开了一家奶茶店', 60),
    ],
    query: { text: '奶茶' },
    relevantIds: ['c1-gold'],
    note: 'keyword ties all on substring 奶茶 → recency buries the focused gold at rank 4',
  },
  {
    name: 'cross-coffee-focus-latin',
    category: 'cross-session',
    corpus: [
      e('c2-gold', 'I love coffee, I drink coffee every morning, coffee keeps me going', 1),
      e('c2-x1', 'the coffee shop downstairs is nice', 40),
      e('c2-x2', 'I spilled coffee on my shirt today', 50),
    ],
    query: { text: 'coffee' },
    relevantIds: ['c2-gold'],
  },
  {
    name: 'cross-fitness-multiterm',
    category: 'cross-session',
    corpus: [
      e('c3-gold', '我的健身计划是每周三次,这个健身计划坚持了三个月,健身计划很有效', 1),
      e('c3-x1', '今天健身房好多人', 40),
      e('c3-x2', '周末有个旅行计划', 50),
      e('c3-x3', '健身计划要坚持才行', 60),
    ],
    query: { text: '健身 计划' },
    relevantIds: ['c3-gold'],
    note: 'gold and c3-x3 tie on coverage → recency picks x3; TF cosine lifts the focused gold',
  },
  {
    name: 'cross-reading-focus',
    category: 'cross-session',
    corpus: [
      e('c4-gold', '我很喜欢读书,每天睡前都要读书,读书让我很放松', 1),
      e('c4-x1', '读书会这周末举办', 40),
      e('c4-x2', '读书笔记要及时整理', 50),
      e('c4-x3', '他其实不太爱读书', 60),
    ],
    query: { text: '读书' },
    relevantIds: ['c4-gold'],
  },

  // ── temporal: the CURRENT fact is gold; the superseded one is closed and must
  //    be dropped by activeOnly. (The test also asserts the closed id is absent.) ─
  {
    name: 'temporal-color',
    category: 'temporal',
    corpus: [
      closed('t1-old', '我以前喜欢的颜色是蓝色', 10), // superseded → inactive
      e('t1-gold', '我现在喜欢的颜色是绿色', 5), // current truth (older ts, but active)
      e('t1-x1', '我喜欢喝咖啡', 20),
      e('t1-x2', '颜色搭配很重要', 30),
    ],
    query: { text: '喜欢 颜色', k: 1 },
    relevantIds: ['t1-gold'],
    note: 'k=1: without activeOnly the closed fact (newer ts, equal coverage) would steal rank 1',
  },
  {
    name: 'temporal-job',
    category: 'temporal',
    corpus: [
      closed('t2-old', '我在谷歌工作负责搜索', 10),
      e('t2-gold', '我现在在苹果工作做芯片', 5),
      e('t2-x1', '工作最近有点忙', 20),
      e('t2-x2', '周末想休息一下', 30),
    ],
    query: { text: '工作 现在', k: 2 },
    relevantIds: ['t2-gold'],
  },

  // ── multi-hop: two entries are jointly relevant; recall@k = fraction found. ───
  {
    name: 'multihop-japan-cost',
    category: 'multi-hop',
    corpus: [
      e('m1-a', '去日本旅行的机票花了 5000 块', 1),
      e('m1-b', '在日本旅行住酒店花了 3000 块', 2),
      e('m1-x1', '去年去泰国玩过', 30),
      e('m1-x2', '想学做日本料理', 40),
      e('m1-x3', '最近汇率有点高', 50),
    ],
    query: { text: '日本 旅行 花费' },
    relevantIds: ['m1-a', 'm1-b'],
  },
  {
    name: 'multihop-birthday',
    category: 'multi-hop',
    corpus: [
      e('m2-a', '我妈妈的生日是三月十号', 1),
      e('m2-b', '我女儿的生日是十月二号', 2),
      e('m2-x1', '生日蛋糕要提前订', 30),
      e('m2-x2', '上个月过了自己的生日', 40),
    ],
    query: { text: '生日' },
    relevantIds: ['m2-a', 'm2-b'],
  },

  // ── semantic: query shares NO term with the gold, and ENOUGH query-word decoys
  //    fill the top-k. Keyword AND a char-overlap embedder score 0 BY
  //    CONSTRUCTION → the honest ceiling M3/M4 fill (NOT M2). ─────────────────────
  {
    name: 'semantic-drink',
    category: 'semantic',
    corpus: [
      e('s1-gold', '上周我在城里点了一杯珍珠奶茶很好喝', 1), // the answer to "什么饮料"
      e('s1-d1', '冰箱里常备一些饮料', 30),
      e('s1-d2', '便利店买了两瓶饮料', 40),
      e('s1-d3', '这个饮料太甜了', 50),
      e('s1-d4', '饮料喝多了对身体不好', 60),
      e('s1-d5', '他最爱喝碳酸饮料', 70),
      e('s1-d6', '办公室有饮料自动贩卖机', 80),
    ],
    query: { text: '饮料' },
    relevantIds: ['s1-gold'],
    note: '饮料 shares no bigram with 珍珠奶茶 → keyword recall 0, 6 decoys fill top-5',
  },
  {
    name: 'semantic-pet',
    category: 'semantic',
    corpus: [
      e('s2-gold', '我家的金毛叫大黄', 1),
      e('s2-d1', '楼下宠物店周末促销', 30),
      e('s2-d2', '养宠物要有耐心', 40),
      e('s2-d3', '宠物医院要提前预约', 50),
      e('s2-d4', '邻居的宠物很吵', 60),
      e('s2-d5', '宠物用品在打折', 70),
      e('s2-d6', '这里禁止携带宠物', 80),
    ],
    query: { text: '宠物' },
    relevantIds: ['s2-gold'],
    note: '宠物 shares no bigram with 金毛/大黄 → keyword recall 0',
  },
  {
    name: 'semantic-vehicle-latin',
    category: 'semantic',
    corpus: [
      e('s3-gold', 'I drive a Tesla Model 3', 1),
      e('s3-d1', 'my vehicle registration expired', 30),
      e('s3-d2', 'the electric bill was high this month', 40),
      e('s3-d3', 'a vehicle is blocking the driveway', 50),
      e('s3-d4', 'electric scooters are everywhere now', 60),
      e('s3-d5', 'vehicle insurance is due for renewal', 70),
      e('s3-d6', 'the electric fence is broken', 80),
    ],
    query: { text: 'electric vehicle' },
    relevantIds: ['s3-gold'],
    note: '"electric"/"vehicle" share no token with tesla/model → keyword recall 0',
  },
]
