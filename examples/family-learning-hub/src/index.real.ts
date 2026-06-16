/**
 * index.real.ts — the REAL (non-hermetic) end-to-end run of family-learning-hub (B-M2).
 *
 * SAME world as the hermetic demo (`index.ts`): the 家长 hub runs the REAL `tutor-teach`
 * workflow through the REAL WorkflowRunner + REAL predicate + REAL FileInboxStore + the
 * two-step resume (all in ./harness.ts). The ONE swap is the tutor — `teach.lesson` is
 * served by a genuine LlmAgent (DeepSeek by default) instead of the deterministic
 * stand-in. Every GATE (topic.screen / content.moderate / records.append /
 * report.to-guardian) stays deterministic in real mode too: the framework never lets an
 * LLM make a gate decision.
 *
 * ★ Why this run matters beyond the hermetic demo ★
 *   The real tutor returns a STRUCTURED `Lesson` (a real boolean `flagged`), so the
 *   content-review gate's predicate `$teach.output.flagged == true` stays honest with a
 *   real model — the SAME fail-open class the deterministic gates exist to prevent (see
 *   real-agents.ts). This run proves the real tutor plugs into the real workflow and the
 *   whole chain holds: off-whitelist parks for approval → tutor produces a structured
 *   lesson → master recorded on the 孩子 hub → fork to the 家长 → child data confined.
 *
 * opt-in (mirrors codex-deepseek-hub's index.real.ts):
 *   - REAL tutor needs `FL_REAL=1` AND a DeepSeek/OpenAI-compatible key. e.g.
 *       FL_REAL=1 DEEPSEEK_API_KEY=sk-... pnpm demo:family-learning-hub:real
 *   - The mcp-obsidian vault is ALSO opt-in (OBSIDIAN_API_KEY) — without it the tutor
 *     still runs, it just can't read learning-records to find where the learner is.
 *   - WITHOUT a key (or FL_REAL unset) it falls back to the deterministic stand-in tutor
 *     but STILL drives the real workflow + real inbox + real dispatch — a hermetic CHAIN
 *     SELF-CHECK that the wiring holds (only the tutor's JUDGEMENT is the stand-in):
 *       pnpm demo:family-learning-hub:real
 *
 * The self-check asserts the CHAIN RAN, never the model's exact words: a lesson is a
 * well-formed `Lesson` (numeric lessonNo, non-empty title/body, boolean flagged), parks
 * happen where they should, the master copy lands on disk, the fork reaches the 家长, and
 * child data is fail-closed to a third party. Prints ✅/❌ and exits 0/1.
 *
 * SAFETY: no real key is ever read/written/committed — the key is read from process.env at
 * runtime only, opt-in. The temp world is removed at teardown.
 */

import { existsSync, rmSync } from 'node:fs'

import { DEFAULT_MODERATION_RULES, LessonTutorStandin } from './participants.js'
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, makeTutor, makeTutorToolset } from './real-agents.js'
import {
  APPROVE,
  CHILD_LEARNING,
  GUARDIAN,
  assert,
  buildEnv,
  dispatchLesson,
  driveToCompletion,
  makeTmpRoot,
  okOutput,
  recordAndFork,
  section,
  teardown,
  type Env,
  type LessonOut,
} from './harness.js'
import type { Lesson } from './participants.js'

/** Assert the tutor output is a well-formed Lesson — the SHAPE, never the model's words. */
function assertStructuredLesson(lesson: Lesson | undefined, label: string): asserts lesson is Lesson {
  assert(!!lesson, `${label} 导师产出了一节课 (有结构化输出)`)
  assert(typeof lesson!.lessonNo === 'number' && lesson!.lessonNo >= 1, `${label} lessonNo 是 ≥1 的数字`)
  assert(typeof lesson!.title === 'string' && lesson!.title.length > 0, `${label} title 是非空字符串`)
  assert(typeof lesson!.body === 'string' && lesson!.body.length > 0, `${label} body 是非空字符串`)
  // ★ The whole reason the real tutor returns structured output: a REAL boolean the
  // content-review predicate can read (not undefined → fail-open).
  assert(typeof lesson!.flagged === 'boolean', `${label} flagged 是真布尔 (内容审核闸读得到, 不 fail-open)`)
  // /teach methodology shape — coerceLesson backfills any field the model omitted, so a real
  // (possibly sparse) reply is still a complete /teach lesson the chain can rely on.
  assert(typeof lesson!.concept === 'string' && lesson!.concept.length > 0, `${label} 有 concept (一个要点)`)
  assert(
    !!lesson!.quiz && Array.isArray(lesson!.quiz.options) && lesson!.quiz.options.length >= 2,
    `${label} 有 quiz (≥2 选项的小测)`,
  )
  assert(Array.isArray(lesson!.citations) && lesson!.citations.length >= 1, `${label} 有 citations (引用来源)`)
}

async function main(): Promise<void> {
  const wantReal = process.env.FL_REAL === '1'
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY ?? ''
  const useReal = wantReal && apiKey.length > 0
  const toolset = useReal ? makeTutorToolset() : undefined
  const tutor = useReal ? makeTutor(apiKey, toolset ? { toolset } : {}) : new LessonTutorStandin()

  const tutorMode = useReal
    ? `真 LlmAgent — DeepSeek ${DEEPSEEK_MODEL} @ ${DEEPSEEK_BASE_URL}`
    : wantReal
      ? '确定性 stand-in (FL_REAL=1 但无 DEEPSEEK_API_KEY/OPENAI_API_KEY — 退回链条自检)'
      : '确定性 stand-in (链条自检; 设 FL_REAL=1 + DEEPSEEK_API_KEY 跑真模型)'
  const vaultMode = useReal ? (toolset ? 'mcp-obsidian 已接 (读 learning-records 找进度)' : '未接档案库 (从第 1 课起)') : '不适用'

  console.log('\n=== family-learning-hub — 真实模式端到端 / 链条自检 (B-M2) ===\n')
  console.log(`  导师  : ${tutorMode}`)
  console.log(`  档案库: ${vaultMode}`)
  console.log('  闸    : topic.screen / content.moderate / records.append / report.to-guardian 全程确定性 (LLM 不碰闸决策)\n')

  const tmpRoot = makeTmpRoot()
  let env: Env | undefined
  let chainOk = false
  try {
    // The caller owns the toolset lifecycle (the LlmAgent never connects its own) — connect
    // BEFORE any dispatch, disconnect at teardown (see real-agents.ts / agent.ts).
    if (toolset) await toolset.connect()
    env = await buildEnv('real', tmpRoot, DEFAULT_MODERATION_RULES, tutor)

    // --- [R1] off-whitelist (投资理财): parks for 家长 approval → real tutor teaches ----
    section('[R1] 白名单外 (投资理财): 挂起等家长 → (批准后) 真导师上课 → 建档主副本 + fork 给家长')
    const firedR1 = await dispatchLesson(env, '投资理财')
    assert(firedR1.kind === 'suspended', '[R1] 白名单外 → 工作流挂起在主题审批闸 (导师尚未被联系)')
    const firstR1 = (await env.inbox.listPending(GUARDIAN))[0]
    assert(!!firstR1 && firstR1.parentKind === 'workflow', '[R1] 待办是 workflow-parented 审批 (两步恢复)')
    // Approve every gate this run parks on (topic gate always; content gate too IF the model
    // self-flags 投资理财 — that's model-dependent, so we drive to completion, not assert it).
    const driveR1 = await driveToCompletion(env, firedR1, () => APPROVE)
    const outR1 = okOutput(driveR1.result, '[R1] run after approvals') as LessonOut
    assert(
      driveR1.gates.length >= 1 && driveR1.gates[0]!.title === '白名单外主题审批',
      '[R1] 第一道闸是白名单外主题审批 (确定性 screen 驱动, 与模型无关)',
    )
    assertStructuredLesson(outR1.lesson, '[R1]')
    const recR1 = await recordAndFork(env, outR1.lesson)
    assert(typeof recR1.recordPath === 'string' && existsSync(recR1.recordPath), '[R1] 学习档案主副本真写到孩子 hub 磁盘')
    assert(recR1.totalRecords === 1, '[R1] 孩子 hub 主副本累计 1 条 (导师恰好被调一次)')
    assert(env.guardianInbox.received.length === 1, '[R1] 家长收到一份监督 fork')
    console.log(`  导师产出: 「${outR1.lesson.title}」 (第 ${outR1.lesson.lessonNo} 课) 自评 flagged=${outR1.lesson.flagged}`)
    console.log(`  主副本 → ${recR1.recordPath}`)

    // --- [R2] on-whitelist (分数运算): NO topic approval (deterministic screen bypass) --
    section('[R2] 白名单内 (分数运算): 主题白名单内 → 不卡主题审批闸 → 真导师直接上课')
    const firedR2 = await dispatchLesson(env, '分数运算')
    const driveR2 = await driveToCompletion(env, firedR2, () => APPROVE)
    const outR2 = okOutput(driveR2.result, '[R2] on-whitelist run') as LessonOut
    assert(
      !driveR2.gates.some((g) => g.title === '白名单外主题审批'),
      '[R2] 白名单内主题旁路主题审批闸 (确定性 screen — 与模型无关)',
    )
    assertStructuredLesson(outR2.lesson, '[R2]')
    const recR2 = await recordAndFork(env, outR2.lesson)
    assert(recR2.totalRecords === 2, '[R2] 孩子 hub 主副本累计 2 条')
    console.log(`  导师产出: 「${outR2.lesson.title}」 (第 ${outR2.lesson.lessonNo} 课); 主副本累计 ${recR2.totalRecords} 条`)

    // --- [R3] data-class confinement — child data can't escape to a third party --------
    section('[R3] 数据外泄闸: 标 child-learning 的任务发第三方 → fail-closed (孩子数据只流向家长侧)')
    const firedR3 = await env.parentHub.dispatch({
      from: 'parent-orchestrator',
      strategy: { kind: 'capability', capabilities: ['thirdparty.ingest'] },
      dataClasses: [CHILD_LEARNING],
      payload: { note: '把孩子的学习记录发给第三方' },
      title: '试图把孩子数据发给第三方',
    })
    assert(firedR3.kind === 'failed', '[R3] child-learning 任务发第三方被拒 (data-class fail-closed)')
    assert(
      firedR3.kind === 'failed' && firedR3.error.startsWith('outbound_data_class_denied'),
      '[R3] 拒绝原因是出站 data-class 闸',
    )
    assert(env.thirdParty.received.length === 0, '[R3] 第三方一条孩子数据都没收到')

    section('[verify] 链条自检通过')
    console.log('  导师被调 (产出结构化 Lesson) → 课记孩子 hub 主副本 → fork 投家长 → 数据外泄闸 fail-closed。')
    console.log(`  ${useReal ? '✅ 真导师 (LlmAgent) 接进真工作流, 整条链跑通。' : 'ℹ️  本次用确定性 stand-in 跑通链条 (wiring 自检); 设 FL_REAL=1 + DEEPSEEK_API_KEY 跑真模型。'}`)
    chainOk = true
  } finally {
    if (env) await teardown(env)
    if (toolset) await toolset.disconnect()
    rmSync(tmpRoot, { recursive: true, force: true })
  }

  console.log(
    chainOk
      ? `\n  ✅ 链条跑通: dispatch → 主题白名单闸 → 家长审批 → ${useReal ? '真导师上课' : 'stand-in 上课'} → 内容审核 → 建档主副本 + fork → 数据闸\n`
      : '\n  ❌ 链条未跑通\n',
  )
  process.exit(chainOk ? 0 : 1)
}

main().catch((err) => {
  console.error('[family-learning-hub real] fatal:', err)
  process.exit(1)
})
