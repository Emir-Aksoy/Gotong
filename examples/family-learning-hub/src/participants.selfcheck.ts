/**
 * Self-check for the deterministic gate participants (A-M1). Exercises each
 * participant's STRUCTURED output directly via `onTask` (no Hub needed) and asserts the
 * two safety-critical contracts:
 *   ★ topic.screen returns a REAL boolean `allowed` — so the workflow predicate
 *     `$screen.output.allowed == false` can read it (the fail-open fix); and
 *   ★ an EMPTY moderation rule list NEVER flags (opt-out) — the rule-engine layer is
 *     optional on top of the always-on self-flag.
 *
 * Run:  pnpm --filter @aipehub/example-family-learning-hub selfcheck
 */

import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Task, TaskResult } from '@aipehub/core'

import {
  LessonTutorStandin,
  ModerationParticipant,
  RecordsAppendParticipant,
  ReportToGuardianParticipant,
  TopicScreenParticipant,
  type Lesson,
  type LearningRecord,
  type ModerationResult,
  type ScreenResult,
} from './participants.js'

let seq = 0
function mkTask(cap: string, payload: unknown): Task {
  seq += 1
  return {
    id: `selfcheck-${seq}`,
    from: 'selfcheck',
    strategy: { kind: 'capability', capabilities: [cap] },
    payload,
  } as unknown as Task
}

function okOut(r: TaskResult): unknown {
  if (r.kind !== 'ok') throw new Error(`expected an 'ok' result, got '${r.kind}'`)
  return (r as { output: unknown }).output
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`)
  console.log(`  ✓ ${label}`)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`)
}

async function main(): Promise<void> {
  console.log('\n=== family-learning-hub: 确定性闸参与者自检 (A-M1) ===')

  // --- topic.screen — ★ the fail-open fix: a real boolean the predicate can read ----
  section('[1] topic.screen — 主题白名单 (确定性, 非 LLM)')
  const screen = new TopicScreenParticipant()
  assert(screen.capabilities.includes('topic.screen'), 'screen 服务 topic.screen')
  const sAllow = okOut(await screen.onTask(mkTask('topic.screen', { topic: '分数运算练习' }))) as ScreenResult
  assert(sAllow.allowed === true && typeof sAllow.reason === 'string', '白名单内主题 allowed=true 且带 reason')
  const sDeny = okOut(await screen.onTask(mkTask('topic.screen', { topic: '投资理财' }))) as ScreenResult
  assert(sDeny.allowed === false, '白名单外主题 allowed=false (= 需家长审批, 非静默放行)')
  assert(typeof sDeny.allowed === 'boolean', '★ allowed 是真布尔 (predicate 读得到, 不会 undefined→fail-open)')
  const sEmpty = okOut(await screen.onTask(mkTask('topic.screen', {}))) as ScreenResult
  assert(sEmpty.allowed === false, '空主题保守判 allowed=false (conservative)')

  // --- content.moderate — the OPTIONAL rule-engine layer ----------------------------
  section('[2] content.moderate — 规则引擎 (可选第二层)')
  const cleanLesson: Lesson = {
    learnerId: 'k',
    topic: '分数运算',
    lessonNo: 1,
    title: '第 1 课 · 分数运算',
    body: '分数运算的入门讲解 + 一个小练习。',
    flagged: false,
  }
  // A topic that PASSES the whitelist ("编程基础") but whose angle ("外挂") trips a rule.
  const cheatLesson: Lesson = {
    learnerId: 'k',
    topic: '编程基础之游戏外挂',
    lessonNo: 2,
    title: '第 2 课 · 编程基础之游戏外挂',
    body: '讲解怎么给游戏写外挂脚本……',
    flagged: false,
  }

  const mod = new ModerationParticipant() // default rules incl. 外挂/充值/私聊
  assert(mod.capabilities.includes('content.moderate'), 'moderate 服务 content.moderate')
  const mClean = okOut(await mod.onTask(mkTask('content.moderate', cleanLesson))) as ModerationResult
  assert(mClean.flagged === false && mClean.reasons.length === 0, '干净内容 flagged=false, reasons 空')
  const mHit = okOut(await mod.onTask(mkTask('content.moderate', cheatLesson))) as ModerationResult
  assert(mHit.flagged === true && mHit.reasons.length >= 1, '命中规则的内容 flagged=true 带 reasons')

  const modOff = new ModerationParticipant([]) // empty list = opt-out
  const mOff = okOut(await modOff.onTask(mkTask('content.moderate', cheatLesson))) as ModerationResult
  assert(mOff.flagged === false, '★ 空规则清单 = opt-out: 命中关键词也 flagged=false (只剩自评层)')

  // --- records.append — the MASTER copy on the 孩子 hub disk -------------------------
  section('[3] records.append — 学习档案主副本 (真写盘)')
  const tmp = mkdtempSync(join(tmpdir(), 'aipehub-fl-participants-'))
  try {
    const desk = new RecordsAppendParticipant(tmp)
    const rec1 = okOut(
      await desk.onTask(mkTask('records.append', { learner_id: 'k', topic: '分数运算', lesson: cleanLesson })),
    ) as LearningRecord
    assert(typeof rec1.recordPath === 'string' && existsSync(rec1.recordPath), '主副本真写到磁盘')
    assert(rec1.totalRecords === 1, '累计 1 条')
    const rec2 = okOut(
      await desk.onTask(
        mkTask('records.append', { learner_id: 'k', topic: '数学', lesson: { ...cleanLesson, lessonNo: 2 } }),
      ),
    ) as LearningRecord
    assert(rec2.totalRecords === 2, '累计递增到 2')

    // --- report.to-guardian — the oversight fork ------------------------------------
    section('[4] report.to-guardian — fork 给家长 (监督副本)')
    const report = new ReportToGuardianParticipant()
    const rep = okOut(
      await report.onTask(mkTask('report.to-guardian', { learner_id: 'k', summary: { lessonNo: 1 } })),
    ) as { forked?: boolean }
    assert(rep.forked === true, 'fork forked=true')
    assert(report.received.length === 1, '家长收到 1 份 fork')

    // --- teach.lesson — deterministic tutor stand-in (self-flag layer) --------------
    section('[5] teach.lesson — 导师替身 (自评层)')
    const tutor = new LessonTutorStandin()
    assert(
      tutor.capabilities.includes('teach.lesson'),
      '导师服务 teach.lesson (非 tutor.teach — 那是家长工作流的 trigger)',
    )
    const l1 = okOut(await tutor.onTask(mkTask('teach.lesson', { topic: '分数运算', learner_id: 'k' }))) as Lesson
    assert(l1.lessonNo === 1 && l1.flagged === false, '第 1 课, 普通主题不自评')
    assert(l1.missionEstablished === true, '★ /teach: 第 1 课先立学习使命 (missionEstablished=true)')
    assert((l1.concept?.trim().length ?? 0) > 0 && (l1.citations?.length ?? 0) >= 1, '第 1 课有 concept + 引用来源')
    assert(
      (l1.quiz?.options?.length ?? 0) === 3 && new Set(l1.quiz!.options.map((o) => [...o].length)).size === 1,
      '第 1 课小测三选项等长 (长度不泄露答案)',
    )
    assert(l1.insight === undefined, '第 1 课无证据 → 不写 insight')
    const l2 = okOut(await tutor.onTask(mkTask('teach.lesson', { topic: '投资理财', learner_id: 'k' }))) as Lesson
    assert(l2.lessonNo === 2, '同学习者续第 2 课 (进度递增)')
    assert(l2.missionEstablished === false, '第 2 课不再重立使命')
    assert(!!l2.insight && (l2.insight.insight?.length ?? 0) > 0, '★ 第 2 课有证据 → 捕获一条 ADR 式 insight')
    assert(l2.flagged === true && typeof l2.flagReason === 'string', '财经内容自评 flagged=true (决策 1.a)')
    assert(tutor.taught.length === 2, '导师被调 2 次')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  section('done')
  console.log('  确定性闸参与者全部就绪 — topic.screen 返真布尔 (修 fail-open), moderation 可选 (空=opt-out).\n')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
