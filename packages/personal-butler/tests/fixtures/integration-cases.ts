/**
 * integration-cases.ts — the M1 fixture: ONE member's whole memory space, laid
 * out across all five stores, plus the questions that only get a right answer
 * if you can walk between them.
 *
 * # Why one space and not one corpus per case
 *
 * `recall-cases.ts` gives every case its own private corpus, because there the
 * unit under test is a retriever over a bag of entries. Here the unit under
 * test is a SPACE: the diagnosis being measured is 「记忆是一块一块的」, and a
 * per-case corpus would quietly hand the retriever a pre-filtered world in
 * which the other topics do not exist. So every case queries the same seeded
 * space, and the other cases' facts are its distractors — a coffee memory sits
 * next to a coffee knowledge page next to a coffee repair task, and any recall
 * that reaches only one store must visibly pick the wrong one.
 *
 * # Three shapes are load-bearing, not decoration
 *
 *   1. **The closed task is gold.** `tn-1`(订槟城搬家公司) is closed, and
 *      `move-penang` still expects it: 「搬家这件事进展如何」 is answered by the
 *      fact that it is DONE. A store that drops closed notes answers worse.
 *   2. **The session seed alternates and ends on an assistant turn**, because
 *      `history()` merges same-role neighbours and drops a trailing user turn.
 *      Ending on assistant makes the rendered index equal the seed index, so
 *      `session:<user>#i` pointers stay readable. (The hygiene test is what
 *      catches it if that ever stops being true.)
 *   3. **Two single-store cases point at DIFFERENT stores** — one memory, one
 *      knowledge. A single-store category rigged to be all-memory would look
 *      like a passing baseline while measuring nothing.
 *
 * Fixed clock throughout: no `Date.now`, so every score is byte-stable.
 */

import type { MemoryEntry } from '@gotong/services-sdk'

import type { IntegrationCase, IntegrationSpaceSeed } from '../../src/memory-integration-benchmark.js'

/** Same anchor as `recall-cases.ts` — the two rulers share a calendar. */
export const T0 = 1_700_000_000_000
/** 30 days later: everything seeded is comfortably in the past. */
export const INTEGRATION_NOW = T0 + 30 * 24 * 3600 * 1000
export const INTEGRATION_USER = 'u-mei'

function fact(id: string, text: string, ageDays: number): MemoryEntry {
  return { id, kind: 'semantic', text, ts: T0 + ageDays * 24 * 3600 * 1000 }
}

/**
 * 8 active semantic facts. Three of them (咖啡 / 报税 / 搬家) exist ONLY to be
 * plausible wrong answers: they share the query's words but not its question,
 * so a memory-only recall returns something confident and useless.
 */
const ENTRIES: readonly MemoryEntry[] = [
  fact('m-penang', '我 2026 年 6 月搬到了槟城,现在住在槟城乔治市', 1),
  fact('m-weight-goal', '我的目标体重是 68 公斤', 2),
  fact('m-peanut', '我对花生过敏,吃到会起疹子', 3),
  fact('m-coffee-habit', '我每天早上喝一杯手冲咖啡', 4),
  fact('m-tax-habit', '去年报税我拖到最后一天才交', 5),
  fact('m-move-old', '上次搬家我把书都寄丢了', 6),
  fact('m-kids', '我家两个孩子分别上小学三年级和一年级', 7),
  fact('m-lang', '我平时说中文,也能用英文读技术文档', 8),
]

export const INTEGRATION_SEED: IntegrationSpaceSeed = {
  entries: ENTRIES,
  knowledge: [
    {
      path: 'INDEX.md',
      markdown: [
        '# 索引',
        '',
        '- [[appliances/coffee-machine]] 咖啡机的保养和故障处理',
        '- [[garden/tomato]] 番茄的种植与施肥',
        '- [[finance/tax-checklist]] 每年报税要准备的材料',
      ].join('\n'),
    },
    {
      path: 'appliances/coffee-machine.md',
      markdown: [
        '# 咖啡机',
        '',
        '型号 Gaggia Classic,2024 年买的。',
        '',
        '## 出水变慢怎么办',
        '',
        '多半是水垢。用柠檬酸泡冲煮头,泡二十分钟再冲三遍清水。',
        '每三个月除一次垢,槟城的水偏硬要更勤一点。',
      ].join('\n'),
    },
    {
      path: 'garden/tomato.md',
      markdown: [
        '# 番茄',
        '',
        '## 施肥',
        '',
        '苗期两周一次薄肥,开花之后改成一周一次的高钾肥。',
        '结果期最忌一次施浓肥,会裂果。',
      ].join('\n'),
    },
    {
      path: 'finance/tax-checklist.md',
      markdown: [
        '# 报税材料清单',
        '',
        '- 公司发的 EA 表',
        '- 全年的医疗收据',
        '- 保险保单的年度对账单',
        '- 上一年的报税回执',
      ].join('\n'),
    },
  ],
  // 顺序即 id:tn-1 … tn-4(`openTaskNotebook` 的 nextId 从 1 起单调递增)。
  tasks: [
    {
      title: '订槟城搬家公司',
      steps: ['比三家报价', '定日期', '付定金'],
      note: '最后定了 Lian Hoe,六月十二号搬。',
      close: true,
    },
    { title: '修好厨房的咖啡机', steps: ['买柠檬酸', '除垢', '试冲一杯'], note: '出水越来越慢了。' },
    { title: '2026 报税', steps: ['跟公司要 EA 表', '整理医疗收据', '网上提交'] },
    { title: '换新窗帘', steps: ['量尺寸', '选布'] },
  ],
  // 一问一答两轮:交替且以 assistant 收尾,渲染下标 == 种子下标。
  session: [
    { role: 'user', text: '这周去槟城看了两套房,搬家公司还没订' },
    { role: 'assistant', text: '要我把看房的两套记下来吗?搬家公司可以先比价。' },
    { role: 'user', text: '报税那边我 EA 表还没跟公司要' },
    { role: 'assistant', text: '好,我把它记在报税那条任务下面。' },
  ],
  dossiers: [
    {
      taskId: 'weight-track',
      objective: '跟踪我的体重,每周提醒记录一次',
      journal: [
        { did: '第一次记录', facts: ['2026-06-01 体重 74 公斤'] },
        { did: '第二次记录', facts: ['2026-07-01 体重 72.5 公斤,比上月轻了 1.5 公斤'] },
      ],
    },
  ],
}

/**
 * Six questions. Four cross-store, two single-store.
 *
 * `single-store` is NOT the rigged-to-pass half: one of the two points at
 * `knowledge`, which a memory-only recall structurally cannot reach. The split
 * is by how many stores the ANSWER spans, not by how easy it is.
 */
export const INTEGRATION_CASES: readonly IntegrationCase[] = [
  {
    name: 'move-penang',
    category: 'cross-store',
    query: { text: '搬到槟城这件事进展如何' },
    gold: ['memory:m-penang', 'task:tn-1', 'session:u-mei#0'],
    why: '住哪(记忆) + 搬家公司订了没(已关闭的任务) + 这周刚说的看房(会话),缺一件答案就是错的。',
  },
  {
    name: 'coffee-repair',
    category: 'cross-store',
    query: { text: '咖啡机出水慢要怎么处理' },
    gold: ['knowledge:appliances/coffee-machine.md', 'task:tn-2'],
    why: '修法在书架上,进度在笔记本里 —— 记忆里那条「每天喝手冲」是最像答案的错答案。',
  },
  {
    name: 'tax-prep',
    category: 'cross-store',
    query: { text: '报税还差什么没准备' },
    gold: ['knowledge:finance/tax-checklist.md', 'task:tn-3', 'session:u-mei#2'],
    why: '清单在书架、进度在笔记本、最新一句「EA 表还没要」只在会话里。',
  },
  {
    name: 'weight-trend',
    category: 'cross-store',
    query: { text: '我的体重最近怎么变化的' },
    gold: ['dossier:weight-track#1', 'dossier:weight-track#2', 'memory:m-weight-goal'],
    why: '两次读数在长任务档案的日志里,目标值在记忆里 —— 只有记忆时只答得出目标答不出趋势。',
  },
  {
    name: 'peanut-allergy',
    category: 'single-store',
    query: { text: '我对什么过敏' },
    gold: ['memory:m-peanut'],
    why: '基线本来就该满分的那一条:它是回归钉子,任何一版整合把它弄丢都算退步。',
  },
  {
    name: 'tomato-fertilizer',
    category: 'single-store',
    query: { text: '番茄开花以后多久施一次肥' },
    gold: ['knowledge:garden/tomato.md'],
    why: '答案完整地躺在一篇笔记里,单店就够 —— 但那个店不是记忆,基线够不到。',
  },
]
