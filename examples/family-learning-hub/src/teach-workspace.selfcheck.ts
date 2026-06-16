/**
 * teach-workspace.selfcheck — deterministic unit checks for the file-first `/teach` WORKSPACE
 * writer (teach-workspace.ts). Drives a single learner forward lesson by lesson and pins the
 * artifact invariants that make this a faithful `/teach` workspace, not a flat log:
 *   ① the FIRST lesson writes MISSION.md (mission grounding) — and it persists, not re-written;
 *   ② EVERY lesson writes a lessons/NNNN-slug.md;
 *   ③ a records/NNNN-slug.md (ADR-grade learning-record) is written ONLY when the lesson carries
 *      an insight (evidence) — not a per-lesson journal;
 *   ④ RESOURCES.md / GLOSSARY.md ACCUMULATE across lessons and DEDUP (re-teaching never grows them).
 *
 * Run:  pnpm --filter @aipehub/example-family-learning-hub teach-workspace:selfcheck
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planTeach, type TeachInsight } from './teach.js'
import type { Lesson } from './participants.js'
import { writeTeachWorkspace } from './teach-workspace.js'

let checks = 0
function assert(cond: boolean, msg: string): void {
  checks += 1
  if (!cond) throw new Error(`teach-workspace selfcheck FAILED: ${msg}`)
}

/** Build a complete Lesson from the pure planner (same shape the real tutor produces). */
function lessonFor(
  topic: string,
  learnerId: string,
  opts: { missionPresent: boolean; priorLessons: number; priorInsights: TeachInsight[] },
): Lesson {
  const plan = planTeach(topic, { learnerId, ...opts })
  return {
    learnerId,
    topic,
    lessonNo: plan.lessonNo,
    title: plan.title,
    body: plan.body,
    flagged: false,
    missionEstablished: plan.missionEstablished,
    missionWhy: plan.missionWhy,
    zpd: plan.zpd,
    concept: plan.concept,
    citations: plan.citations,
    practice: plan.practice,
    quiz: plan.quiz,
    primarySource: plan.primarySource,
    glossary: plan.glossary,
    ...(plan.insight ? { insight: plan.insight } : {}),
    followUp: plan.followUp,
  }
}

console.log('\n=== family-learning-hub · /teach workspace selfcheck ===\n')

const root = mkdtempSync(join(tmpdir(), 'aipehub-fl-teach-ws-'))
const container = join(root, 'learning-records')
const LEARNER = 'kid'
const TOPIC = '分数运算'
try {
  // [1] First lesson — mission established, NO insight yet.
  const l1 = lessonFor(TOPIC, LEARNER, { missionPresent: false, priorLessons: 0, priorInsights: [] })
  const w1 = writeTeachWorkspace(container, l1)
  assert(!!w1.missionPath && existsSync(w1.missionPath), '[1] ★ 第一课写出 MISSION.md (使命锚定)')
  assert(existsSync(w1.lessonPath) && w1.lessonPath.includes('/lessons/'), '[1] 第一课写出 lessons/NNNN-slug.md')
  assert(w1.lessonPath.includes('0001-'), '[1] 文件名是 4 位零填充课号 (NNNN-slug, /teach 约定)')
  assert(w1.totalLessons === 1, '[1] 课文件累计 1')
  assert(w1.insightPath === undefined && w1.totalInsights === 0, '[1] ★ 无证据 → 不写 records/ 学习档案')
  assert(w1.totalResources >= 1, '[1] RESOURCES.md 收录了推荐的一手来源')
  assert(w1.totalTerms >= 1, '[1] GLOSSARY.md 收录了本课术语')
  console.log('  [1] 第一课      → MISSION.md + lessons/0001 + RESOURCES/GLOSSARY, 无 records/ ✓')

  // [2] Second lesson — carries an insight (evidence) → an ADR-grade learning-record IS written;
  //     the mission is NOT re-established (already present).
  const l2 = lessonFor(TOPIC, LEARNER, { missionPresent: true, priorLessons: 1, priorInsights: [] })
  const w2 = writeTeachWorkspace(container, l2)
  assert(w2.missionPath === undefined, '[2] ★ 使命已立, 第二课不再重写 MISSION.md')
  assert(!!w2.insightPath && existsSync(w2.insightPath) && w2.insightPath.includes('/records/'), '[2] ★ 有证据 → 写 records/NNNN 学习档案 (ADR)')
  assert(w2.insightPath!.includes('0002-'), '[2] 学习档案文件名带第二课课号')
  assert(w2.totalLessons === 2 && w2.totalInsights === 1, '[2] 累计 2 课 / 1 条学习档案 (档案 ≠ 课, 只在有证据时记)')
  console.log('  [2] 第二课      → lessons/0002 + records/0002 (有 insight), MISSION 不重写 ✓')

  // [3] Re-teach the SAME lesson 2 → RESOURCES/GLOSSARY must NOT duplicate (dedup), lesson count
  //     stays 2 (same file overwritten). This is the idempotency / accumulate-with-dedup proof.
  const resourcesBefore = w2.totalResources
  const termsBefore = w2.totalTerms
  const w3 = writeTeachWorkspace(container, l2)
  assert(w3.totalResources === resourcesBefore, '[3] ★ 重教同一课 → RESOURCES.md 不重复累积 (dedup)')
  assert(w3.totalTerms === termsBefore, '[3] ★ 重教同一课 → GLOSSARY.md 不重复累积 (dedup)')
  assert(w3.totalLessons === 2, '[3] 重教覆盖同一课文件, 课数不虚增')
  console.log('  [3] 重教同一课  → RESOURCES/GLOSSARY 去重不虚增, 课数稳定 ✓')

  // [4] MISSION.md content carries the reason-to-learn (not an empty placeholder).
  const mission = readFileSync(w1.missionPath!, 'utf8')
  assert(mission.includes('为什么学') && mission.includes(LEARNER), '[4] MISSION.md 写明「为什么学」+ 学习者')
  console.log('  [4] MISSION.md  → 含「为什么学」+ 学习者 ✓')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n✅ /teach workspace selfcheck passed (${checks} assertions).\n`)
process.exit(0)
