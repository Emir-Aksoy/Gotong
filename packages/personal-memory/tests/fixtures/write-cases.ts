/**
 * Hand-labelled fixtures for the write-side benchmark (M-EVAL M1).
 *
 * No clocks, no timestamps: the harness seeds the store and stamps validity
 * against its own fixed `WRITE_BENCH_NOW`, so scores are byte-stable.
 *
 * `CLOSE_CASES` — {store before, new episodic candidates, golden postconditions}
 * graded on the FINAL STORE STATE. `oracleOps` is replayed by a scripted decider
 * in the pipeline gate only; the grader never reads it. Every `activeContains`
 * fragment is chosen to be ABSENT from every seed text (the hygiene test pins
 * this), otherwise the check would be trivially true.
 *
 * `CONTAINMENT_FACTS` — bilingual atomic facts with a human label and the
 * reason, used to calibrate `gradeSelfContainment` before its number counts.
 */
import type { CloseCase, ContainmentSpec } from '../../src/index.js'

export const CLOSE_CASES: readonly CloseCase[] = [
  {
    name: 'move-city-zh',
    category: 'update',
    seed: [
      { id: 's1', text: '用户住在吉隆坡' },
      { id: 's2', text: '用户养了一只叫大黄的金毛' },
    ],
    candidates: ['用户上周搬到了槟城,现在住在槟城'],
    expect: { closed: ['s1'], activeContains: ['槟城'], untouched: ['s2'] },
    oracleOps: [{ op: 'update', id: 's1', text: '用户住在槟城' }],
    supersedesBonus: { textFragment: '槟城', oldId: 's1' },
  },
  {
    name: 'job-change-en',
    category: 'update',
    seed: [
      { id: 's1', text: 'User works as a barista at Kopi Corner' },
      { id: 's2', text: 'User is allergic to peanuts' },
    ],
    candidates: ['User started a new job as a pastry chef at Butter Lane'],
    expect: { closed: ['s1'], activeContains: ['pastry chef'], untouched: ['s2'] },
    oracleOps: [{ op: 'update', id: 's1', text: 'User works as a pastry chef at Butter Lane' }],
    supersedesBonus: { textFragment: 'pastry chef', oldId: 's1' },
  },
  {
    name: 'preference-flip-zh',
    category: 'update',
    seed: [
      { id: 's1', text: '用户最爱的饮料是美式咖啡' },
      { id: 's2', text: '用户周三晚上有羽毛球局' },
    ],
    candidates: ['用户说现在最爱的饮料是珍珠奶茶,美式咖啡喝腻了'],
    expect: { closed: ['s1'], activeContains: ['珍珠奶茶'], untouched: ['s2'] },
    oracleOps: [{ op: 'update', id: 's1', text: '用户最爱的饮料是珍珠奶茶' }],
    supersedesBonus: { textFragment: '珍珠奶茶', oldId: 's1' },
    note: '旧偏好翻篇非硬删:美式咖啡那条应留作已关闭的时间边',
  },
  {
    name: 'sold-car-zh',
    category: 'delete',
    seed: [
      { id: 's1', text: '用户开一辆蓝色本田思域' },
      { id: 's2', text: '用户住在吉隆坡' },
    ],
    candidates: ['用户上个月把车卖了,现在没有车'],
    expect: { closed: ['s1'], untouched: ['s2'] },
    oracleOps: [{ op: 'delete', id: 's1' }],
  },
  {
    name: 'project-cancelled-en',
    category: 'delete',
    seed: [
      { id: 's1', text: 'User is planning a trip to Tokyo in December' },
      { id: 's2', text: 'User has a golden retriever named Sunny' },
    ],
    candidates: ['The Tokyo trip is cancelled; user is no longer going'],
    expect: { closed: ['s1'], untouched: ['s2'] },
    oracleOps: [{ op: 'delete', id: 's1' }],
  },
  {
    name: 'new-fact-zh',
    category: 'add',
    seed: [{ id: 's1', text: '用户住在吉隆坡' }],
    candidates: ['用户养了一只叫小白的猫'],
    expect: { activeContains: ['小白'], untouched: ['s1'] },
    oracleOps: [{ op: 'add', text: '用户养了一只叫小白的猫' }],
  },
  {
    name: 'new-fact-empty-en',
    category: 'add',
    seed: [],
    candidates: ['User plays badminton every Wednesday evening'],
    expect: { activeContains: ['badminton'] },
    oracleOps: [{ op: 'add', text: 'User plays badminton every Wednesday evening' }],
    note: '空店况 + 一条候选:reconcile 仍会跑(只有零店况零候选才短路)',
  },
  {
    name: 'restated-fact-zh',
    category: 'noop',
    seed: [
      { id: 's1', text: '用户最爱的饮料是珍珠奶茶' },
      { id: 's2', text: '用户住在吉隆坡' },
    ],
    candidates: ['用户又点了一杯珍珠奶茶,说最爱没变'],
    expect: { untouched: ['s1', 's2'], noNewEntries: true },
    oracleOps: [{ op: 'noop' }],
    note: '复述不是新事实:动了就扣分',
  },
  {
    name: 'unrelated-chatter-en',
    category: 'noop',
    seed: [
      { id: 's1', text: 'User works as a teacher' },
      { id: 's2', text: 'User lives in Penang' },
    ],
    candidates: [],
    expect: { untouched: ['s1', 's2'], noNewEntries: true },
    oracleOps: [{ op: 'noop' }],
    note: '零候选的纯去重扫描:两条不相干的事实必须原样留下',
  },
]

export interface ContainmentLabeled {
  readonly name: string
  readonly fact: string
  readonly spec: ContainmentSpec
  /** Human label: is this fact usable on its own, with no conversation around it? */
  readonly selfContained: boolean
  readonly why: string
}

export const CONTAINMENT_FACTS: readonly ContainmentLabeled[] = [
  // ── self-contained (7) ──
  {
    name: 'drink-zh',
    fact: '用户最爱的饮料是珍珠奶茶',
    spec: { categoryTerms: ['饮料'], valueTerms: ['珍珠奶茶'] },
    selfContained: true,
    why: '类别词 + 具体值 + 主语在场',
  },
  {
    name: 'pet-zh',
    fact: '用户养的宠物是一只叫大黄的金毛',
    spec: { categoryTerms: ['宠物'], valueTerms: ['大黄'] },
    selfContained: true,
    why: '类别词 + 具体值 + 主语在场',
  },
  {
    name: 'lives-en',
    fact: 'User lives in Penang, Malaysia',
    spec: { categoryTerms: ['lives', 'address'], valueTerms: ['penang'] },
    selfContained: true,
    why: 'category verb + concrete place + subject present',
  },
  {
    name: 'drink-en',
    fact: "The user's favorite drink is bubble tea",
    spec: { categoryTerms: ['drink'], valueTerms: ['bubble tea'] },
    selfContained: true,
    why: '"The" is an article, not a dangling pronoun',
  },
  {
    name: 'address-zh',
    fact: '用户的住址在槟城',
    spec: { categoryTerms: ['住址'], valueTerms: ['槟城'] },
    selfContained: true,
    why: '类别词 + 具体值 + 主语在场',
  },
  {
    name: 'job-en',
    fact: 'User works as a pastry chef at Butter Lane',
    spec: { categoryTerms: ['works'], valueTerms: ['pastry chef'] },
    selfContained: true,
    why: 'category verb + concrete value + subject present',
  },
  {
    name: 'cat-pronoun-inside-zh',
    fact: '用户养了一只猫,它叫小白',
    spec: { categoryTerms: ['猫'], valueTerms: ['小白'] },
    selfContained: true,
    why: '「它」不在句首:主语已经给出,句中的代词不悬空',
  },
  // ── not self-contained (10) ──
  {
    name: 'bare-value-zh',
    fact: '珍珠奶茶',
    spec: { categoryTerms: ['饮料'], valueTerms: ['珍珠奶茶'] },
    selfContained: false,
    why: '只有值没有类别:离开对话不知道这是「最爱的饮料」',
  },
  {
    name: 'bare-name-zh',
    fact: '大黄',
    spec: { categoryTerms: ['宠物'], valueTerms: ['大黄'] },
    selfContained: false,
    why: '只有名字没有类别',
  },
  {
    name: 'he-drink-zh',
    fact: '他最爱的是珍珠奶茶',
    spec: { categoryTerms: ['饮料'], valueTerms: ['珍珠奶茶'] },
    selfContained: false,
    why: '裸「他」开头 + 没说是饮料',
  },
  {
    name: 'this-shop-zh',
    fact: '这家店的咖啡不错',
    spec: { categoryTerms: ['咖啡'], valueTerms: ['珍珠奶茶'] },
    selfContained: false,
    why: '裸「这」开头 + 没有具体值',
  },
  {
    name: 'she-moved-en',
    fact: 'She moved there last week',
    spec: { categoryTerms: ['lives', 'moved'], valueTerms: ['penang'] },
    selfContained: false,
    why: 'pronoun lead + "there" carries no place',
  },
  {
    name: 'it-sunny-en',
    fact: 'It is called Sunny',
    spec: { categoryTerms: ['pet', 'dog'], valueTerms: ['sunny'] },
    selfContained: false,
    why: 'pronoun lead + no category',
  },
  {
    name: 'they-badminton-en',
    fact: 'THEY meet at the badminton club on Wednesdays',
    spec: { categoryTerms: ['badminton'], valueTerms: ['wednesday'] },
    selfContained: false,
    why: 'category and value both present; ONLY the upper-case pronoun lead is wrong',
  },
  {
    name: 'his-drink-en',
    fact: 'His favorite drink is bubble tea',
    spec: { categoryTerms: ['drink'], valueTerms: ['bubble tea'] },
    selfContained: false,
    why: 'category and value both present; ONLY the pronoun lead is wrong',
  },
  {
    name: 'she-pet-zh',
    fact: '她养的宠物是一只叫大黄的金毛',
    spec: { categoryTerms: ['宠物'], valueTerms: ['大黄'] },
    selfContained: false,
    why: '类别与值都在;唯一的错是裸「她」开头',
  },
  {
    name: 'no-value-zh',
    fact: '用户有一只宠物',
    spec: { categoryTerms: ['宠物'], valueTerms: ['大黄'] },
    selfContained: false,
    why: '类别在、主语在,但没有具体值',
  },
]
