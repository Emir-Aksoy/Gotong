/**
 * teach.selfcheck — deterministic unit checks for the PURE `/teach` planner (teach.ts). This
 * is the crisp methodology proof (no Hub, no workflow, no topic-mixing): drive a single
 * learner+topic workspace forward lesson by lesson and pin the `/teach` invariants —
 *   ① the FIRST lesson (no mission) ESTABLISHES the mission;
 *   ② an ADR-grade insight is captured ONLY once there's evidence (not the first lesson);
 *   ③ a later lesson's ZONE OF PROXIMAL DEVELOPMENT references the newest captured insight;
 *   ④ quiz options are EQUAL length (length leaks no answer) and the correct POSITION varies;
 *   ⑤ every lesson cites a primary source (never trust parametric knowledge).
 *
 * Run:  pnpm --filter @gotong/example-family-learning-hub teach:selfcheck
 */

import { dashCase, equalizeOptionLengths, planTeach, type TeachInsight } from './teach.js'

let checks = 0
function assert(cond: boolean, msg: string): void {
  checks += 1
  if (!cond) throw new Error(`teach selfcheck FAILED: ${msg}`)
}

function codepointLen(s: string): number {
  return [...s].length
}

console.log('\n=== family-learning-hub · /teach planner selfcheck ===\n')

const TOPIC = '分数运算'

// [1] First lesson, no mission yet → ESTABLISH the mission, no insight (no evidence yet).
const l1 = planTeach(TOPIC, { learnerId: 'kid', missionPresent: false, priorLessons: 0, priorInsights: [] })
assert(l1.lessonNo === 1, '[1] 第一课 lessonNo=1')
assert(l1.missionEstablished === true, '[1] ★ 没有使命时第一课先立使命 (missionEstablished=true)')
assert(l1.missionWhy.trim().length > 0, '[1] 立了一个非空的「为什么学」')
assert(l1.insight === undefined, '[1] ★ 第一课无证据 → 不写 learning-record (insight 省略)')
assert(l1.concept.trim().length > 0 && l1.practice.trim().length > 0, '[1] 有 concept (知识) + practice (技能)')
assert(l1.citations.length >= 1 && l1.primarySource.trim().length > 0, '[1] ★ 每课引用来源 + 推荐 primarySource')
console.log('  [1] 第一课      → 立使命, 无 insight, 有 concept/practice/citation ✓')

// [2] Second lesson, mission now present → advance one step AND capture the first insight.
const l2 = planTeach(TOPIC, { learnerId: 'kid', missionPresent: true, priorLessons: 1, priorInsights: [] })
assert(l2.lessonNo === 2, '[2] 第二课 lessonNo=2')
assert(l2.missionEstablished === false, '[2] 使命已立, 第二课不再重立')
assert(!!l2.insight && l2.insight.title.length > 0 && l2.insight.insight.length > 0, '[2] ★ 有证据 → 写一条 ADR 式 insight')
console.log('  [2] 第二课      → 不重立使命, 捕获首条 insight ✓')

// [3] Third lesson, carrying the lesson-2 insight → its ZPD references that newest insight.
const prior: TeachInsight = l2.insight!
const l3 = planTeach(TOPIC, { learnerId: 'kid', missionPresent: true, priorLessons: 2, priorInsights: [prior] })
assert(l3.lessonNo === 3, '[3] 第三课 lessonNo=3')
assert(l3.zpd.includes(prior.title), '[3] ★ 最近发展区引用了上一条 insight (档案驱动续课, 非空转计数)')
console.log('  [3] 第三课      → ZPD 引用上一条 insight (where-is-the-learner) ✓')

// [4] Equal-length quiz options + a varying correct position (no length / position clue).
const positions = new Set<number>()
for (let n = 1; n <= 6; n += 1) {
  const l = planTeach(TOPIC, { learnerId: 'kid', missionPresent: n > 1, priorLessons: n - 1, priorInsights: [] })
  const lens = l.quiz.options.map(codepointLen)
  assert(new Set(lens).size === 1, `[4] 第 ${n} 课 quiz 选项等长 (长度不泄露答案), 实际长度=${lens.join('/')}`)
  assert(l.quiz.answer >= 0 && l.quiz.answer < l.quiz.options.length, `[4] 第 ${n} 课 answer 下标在范围内`)
  positions.add(l.quiz.answer)
}
assert(positions.size >= 2, '[4] ★ 正确项位置随课变化 (「总选 A」无效)')
console.log('  [4] 小测        → 选项等长 + 正确位置随课变化 ✓')

// [5] equalizeOptionLengths + dashCase primitives.
const eq = equalizeOptionLengths(['一', '三个字', '两字'])
assert(new Set(eq.map(codepointLen)).size === 1, '[5] equalizeOptionLengths 把不等长选项补成等长')
assert(dashCase('分数运算 / 第 2 课，要点') === '分数运算-第-2-课-要点', '[5] dashCase 归一空白/分隔/标点')
console.log('  [5] 原语        → equalizeOptionLengths / dashCase ✓')

console.log(`\n✅ /teach planner selfcheck passed (${checks} assertions).\n`)
process.exit(0)
