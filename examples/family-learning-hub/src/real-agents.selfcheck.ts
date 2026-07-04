/**
 * real-agents.selfcheck — deterministic guard for `coerceLesson`, the safety-critical
 * parse that turns the real tutor's text into a structured `Lesson`.
 *
 * Why this is worth its own check: `coerceLesson` decides the `flagged` boolean the 家长
 * content-review gate reads (`$teach.output.flagged`). A parse bug that silently cleared a
 * self-flag the model RAISED would be a fail-open — exactly the class the deterministic
 * gates exist to prevent. So the invariants pinned here are: a raised flag survives, a
 * missing/false flag stays false, and a malformed reply degrades to a valid Lesson WITHOUT
 * inventing a flag either way (the rule-engine layer + whitelist + transcript fork remain
 * the stronger floor regardless). No API key — pure function, runs hermetic.
 *
 * Run:  pnpm --filter @gotong/example-family-learning-hub real-agents:selfcheck
 */

import { coerceLesson } from './real-agents.js'

let checks = 0
function assert(cond: boolean, msg: string): void {
  checks += 1
  if (!cond) throw new Error(`real-agents selfcheck FAILED: ${msg}`)
}

console.log('\n=== family-learning-hub · real-agents coerceLesson selfcheck ===\n')

// [1] Clean JSON — all fields parsed through.
{
  const l = coerceLesson(
    '{"lessonNo": 3, "title": "分数加法", "body": "讲解 + 练习", "flagged": false, "flagReason": ""}',
    'kid',
    '分数运算',
  )
  assert(l.lessonNo === 3, 'clean JSON lessonNo')
  assert(l.title === '分数加法', 'clean JSON title')
  assert(l.body === '讲解 + 练习', 'clean JSON body')
  assert(l.flagged === false, 'clean JSON flagged false')
  assert(l.flagReason === undefined, 'clean JSON no flagReason when not flagged')
  assert(l.learnerId === 'kid' && l.topic === '分数运算', 'learnerId/topic from caller, not model')
  console.log('  [1] clean JSON           → parsed structurally ✓')
}

// [2] Fenced ```json``` block — common model formatting.
{
  const l = coerceLesson(
    '好的, 这是这节课:\n```json\n{"lessonNo": 5, "title": "T", "body": "B", "flagged": false}\n```\n',
    'kid',
    '数学',
  )
  assert(l.lessonNo === 5 && l.title === 'T' && l.body === 'B', 'fenced json parsed')
  console.log('  [2] fenced ```json```      → unwrapped + parsed ✓')
}

// [3] ★ A RAISED self-flag survives the parse (the fail-open invariant).
{
  const l = coerceLesson(
    '{"lessonNo": 1, "title": "零花钱", "body": "怎么把零花钱拿去炒股", "flagged": true, "flagReason": "涉及投资/炒股"}',
    'kid',
    '理财',
  )
  assert(l.flagged === true, 'raised flag preserved')
  assert(l.flagReason === '涉及投资/炒股', 'flagReason preserved')
  console.log('  [3] model raised flagged   → flagged=true survives (gate will fire) ✓')
}

// [4] Missing `flagged` field → false (a flag is NEVER invented), but ALSO never silently
//     cleared: the model simply didn't raise one here.
{
  const l = coerceLesson('{"lessonNo": 2, "title": "T", "body": "B"}', 'kid', '科学常识')
  assert(l.flagged === false, 'missing flagged → false (not invented)')
  console.log('  [4] flagged field absent   → false (never invented) ✓')
}

// [5] Malformed / non-JSON reply → a VALID Lesson, body = raw text, flagged=false
//     (degrade safe; downstream steps never break on a bad model reply).
{
  const l = coerceLesson('抱歉我今天没法上课。', 'kid', '英语阅读')
  assert(l.lessonNo === 1, 'malformed → lessonNo defaults to 1')
  assert(l.body === '抱歉我今天没法上课。', 'malformed → body is the raw text')
  assert(l.flagged === false, 'malformed → flagged false, not invented')
  assert(l.title === '第 1 课 · 英语阅读', 'malformed → synthesized title from topic')
  console.log('  [5] malformed reply        → valid Lesson, safe defaults ✓')
}

// [6] lessonNo as a string → coerced to int; bare object embedded in prose still extracted.
{
  const l = coerceLesson('这一课是: {"lessonNo": "7", "title": "T", "body": "B"} 就这样。', 'kid', '编程基础')
  assert(l.lessonNo === 7, 'string lessonNo coerced to int 7')
  console.log('  [6] string lessonNo + prose → extracted + coerced ✓')
}

console.log(`\n✅ coerceLesson selfcheck passed (${checks} assertions).\n`)
process.exit(0)
