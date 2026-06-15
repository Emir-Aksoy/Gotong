/**
 * family-learning-hub — the PRODUCTION-CORRECT core (A-M2). A 家长 gives a 孩子 an AI
 * subscription to learn with, keeps JURISDICTION over it, and the AI's own safety hazards
 * are held shut by DETERMINISTIC gates whose STRUCTURED output a REAL workflow predicate
 * can read.
 *
 * This demo runs the 家长-hub `tutor-teach` WORKFLOW through the REAL WorkflowRunner +
 * REAL predicate + REAL FileInboxStore + the Phase-16 human-inbox broker, with a ~30-line
 * mirror of HostInboxService's two-step resume (cafe-ops / tea-supply-link precedent). It
 * exists to NAIL two fail-OPEN holes a "core selling point" must not ship with:
 *
 *   ① gate-level fail-open (closed by A-M1): the topic whitelist is a DETERMINISTIC
 *      `topic.screen` participant returning a real boolean `{allowed}`. If an LLM served
 *      it, `$screen.output.allowed` would be undefined, `undefined == false` is false, and
 *      the approval step would be SILENTLY SKIPPED — off-whitelist topics reaching the
 *      tutor with zero approval. A real boolean (read by the real predicate) closes it.
 *   ② workflow-level fail-open (closed here): the `human:` approval step only PARKS the
 *      run; the broker returns the decision as the step output and the run CONTINUES
 *      regardless of approved/rejected. So `teach`/`moderate` guard on
 *      `... || $guardian-approval.output.approved == true` — a 家长 who REJECTS actually
 *      STOPS the lesson (scenario [F]). Without that guard, "拒绝" only flows `{approved:
 *      false}` downstream and the tutor teaches anyway.
 *
 * ★ Why the 家长 workflow runs LOCALLY on the 家长 hub (model 2) ★
 *   The approval steps' assignee is a 家长-hub LOCAL user, so the whitelist + content
 *   approvals are `human:` steps INSIDE the 家长 workflow (design §七). A child workflow
 *   can NOT dispatch `tutor.teach` cross-hub and then wait while the 家长 workflow parks at
 *   a human step: `refreshSuspended` re-reads the step result via `hub.taskResult` on the
 *   CALLING hub (packages/workflow/src/step-executors.ts), and a parent workflow that parks
 *   mid-flow on its OWN hub has no way to push the eventual result back across the link.
 *   So here the 家长 workflow runs locally — the 孩子's request is dispatched directly onto
 *   the 家长 hub (it "arrived") — and the 孩子 workflow's downstream steps
 *   (records.append → report.to-guardian) are shown as direct dispatches: records.append
 *   crosses parent→child (the learning-records MASTER copy lives on the 孩子 hub);
 *   report.to-guardian is the local oversight fork.
 *
 * What it proves (deterministic, NO API key):
 *   [A] off-whitelist (投资理财) → 家长 approves → tutor teaches (self-flagged: money) →
 *       the self-flag ALSO trips the content gate → 家长 approves the content → record
 *       (cross-hub master) + fork. PARKS TWICE (exercises the re-suspend path).
 *   [B] on-whitelist (分数运算) → straight through, no human in the loop.
 *   [C] data-class confinement — the SAME child-learning data crosses to the CLEARED 孩子
 *       hub (records.append) but is FAIL-CLOSED to a third party (not cleared).
 *   [D] on-whitelist TOPIC but the CONTENT trips a moderation RULE (编程基础之游戏外挂) →
 *       parks at the CONTENT gate even though the self-flag missed it (the rule-engine
 *       layer earns its keep).
 *   [E] SAME content with an EMPTY rule list → the rule engine is OFF (opt-out); only the
 *       self-flag floor remains (which doesn't catch 外挂) → no content approval.
 *   [F] off-whitelist → 家长 REJECTS → the lesson is NOT taught (workflow-level fail-open
 *       fix). The tutor is never contacted.
 *
 * Host-free on purpose (same precedent as cafe-ops / tea-supply-link): core + workflow +
 * inbox + a ~30-line mirror of HostInboxService's two-step resume, so the mechanism is
 * visible. The deterministic gate participants live in ./participants.ts (shared with real
 * mode); only the TUTOR is swapped for an LlmAgent in Phase B — the gates stay deterministic.
 *
 * Run:  pnpm demo:family-learning-hub
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Hub,
  InMemoryStorage,
  createInprocHubLinkPair,
  installPeerLink,
  type ParticipantId,
  type Task,
  type TaskResult,
} from '@aipehub/core'
import { FileInboxStore, HumanInboxParticipant, type InboxDecision, type InboxItem } from '@aipehub/inbox'
import { parseWorkflow, WorkflowRunner, type WorkflowDefinition } from '@aipehub/workflow'

import {
  DEFAULT_MODERATION_RULES,
  LessonTutorStandin,
  ModerationParticipant,
  RecordsAppendParticipant,
  ReportToGuardianParticipant,
  ThirdPartyStandin,
  TopicScreenParticipant,
  type LearningRecord,
  type Lesson,
  type ModerationResult,
  type ModerationRule,
  type ScreenResult,
} from './participants.js'

const WORKFLOWS_DIR = fileURLToPath(new URL('../workflows', import.meta.url))
const GUARDIAN = 'guardian-parent' as ParticipantId // the 家长 user who approves (local to the 家长 hub)
const LEARNER = 'kid-lin' // the 孩子 member; /me would force payload.learner_id = this userId
const CHILD_LEARNING = 'child-learning' // the data class tagged on every cross-hub step

/** Two reusable decisions the 家长 makes in their inbox. */
const APPROVE: InboxDecision = { kind: 'approval', approved: true }
const REJECT: InboxDecision = { kind: 'approval', approved: false }

/** The `tutor-teach` workflow's output shape (steps: screen → guardian-approval → teach → moderate → mod-approval). */
interface LessonOut {
  screened?: ScreenResult
  lesson?: Lesson
  moderated?: ModerationResult
}

/** In-memory stand-in for identity.suspended_tasks — what a parked task needs to resume. */
interface ParkedRow {
  agentId: ParticipantId
  state: unknown
  taskJson: string
}

/**
 * One self-contained world: a 家长 hub running the real `tutor-teach` workflow, a 孩子 hub
 * owning the learning-records master, a third-party hub (only to prove confinement), and
 * the two cross-org links. The moderation rule list is a per-env knob so the demo can run
 * the SAME content with rules ON ([A]-[D],[F]) and OFF ([E]) and prove the layer is opt-out.
 */
interface Env {
  name: string
  parentHub: Hub
  childHub: Hub
  thirdPartyHub: Hub
  tutor: LessonTutorStandin
  guardianInbox: ReportToGuardianParticipant
  thirdParty: ThirdPartyStandin
  childDesk: RecordsAppendParticipant
  inbox: FileInboxStore
  parked: Map<string, ParkedRow>
  def: WorkflowDefinition
}

async function buildEnv(name: string, tmpRoot: string, moderationRules: readonly ModerationRule[]): Promise<Env> {
  const root = join(tmpRoot, name)
  mkdirSync(root, { recursive: true })
  const childRecordsRoot = join(root, 'child-hub')
  const parked = new Map<string, ParkedRow>()
  const inbox = new FileInboxStore(root)
  inbox.ensureDirs()

  // 家长 hub — runs the tutor-teach WORKFLOW + serves its gate capabilities + the human
  // broker + the local fork sink. A real host parks suspended tasks in
  // identity.suspended_tasks; the demo records them in `parked` and wakes them by hand.
  const parentHub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, by, s) => {
      parked.set(task.id, { agentId: by, state: s.state, taskJson: JSON.stringify(task) })
    },
  })
  await parentHub.start()
  const tutor = new LessonTutorStandin()
  const guardianInbox = new ReportToGuardianParticipant()
  parentHub.register(new HumanInboxParticipant({ store: inbox })) // aipehub.human/v1 — both approval steps
  parentHub.register(new TopicScreenParticipant()) // topic.screen — ★ the gate-level fail-open fix (real boolean)
  parentHub.register(new ModerationParticipant(moderationRules)) // content.moderate — the OPTIONAL rule-engine layer
  parentHub.register(tutor) // teach.lesson — deterministic here, an LlmAgent in Phase B
  parentHub.register(guardianInbox) // report.to-guardian — the local oversight fork sink

  // 孩子 hub — owns the learning-records MASTER copy (records.append writes to ITS disk).
  const childHub = new Hub({ storage: new InMemoryStorage() })
  await childHub.start()
  const childDesk = new RecordsAppendParticipant(childRecordsRoot)
  childHub.register(childDesk)

  // third-party hub — only here to PROVE child data can't escape to it.
  const thirdPartyHub = new Hub({ storage: new InMemoryStorage() })
  await thirdPartyHub.start()
  const thirdParty = new ThirdPartyStandin()
  thirdPartyHub.register(thirdParty)

  // 家长 → 孩子 link: the per-link contract CLEARS child-learning and advertises
  // records.append (advertise = authorize, G-M1). This is how the lesson's master copy
  // crosses to the 孩子 hub where it belongs.
  const childLink = createInprocHubLinkPair({ aPeerId: 'child-hub', bPeerId: 'parent-hub' })
  installPeerLink({
    hub: parentHub,
    link: childLink.a,
    selfHubId: 'parent-hub',
    remoteCapabilities: ['records.append'],
    outboundCaps: ['records.append'],
    allowedDataClasses: [CHILD_LEARNING],
  })
  installPeerLink({ hub: childHub, link: childLink.b, selfHubId: 'child-hub' })

  // 家长 → 第三方 link: clears ONLY 'public' → anything tagged child-learning fails closed
  // here. Same data-class lock as §六; lets [C] prove "child data flows only to the cleared 孩子".
  const thirdLink = createInprocHubLinkPair({ aPeerId: 'third-party-hub', bPeerId: 'parent-hub' })
  installPeerLink({
    hub: parentHub,
    link: thirdLink.a,
    selfHubId: 'parent-hub',
    remoteCapabilities: ['thirdparty.ingest'],
    outboundCaps: ['thirdparty.ingest'],
    allowedDataClasses: ['public'],
  })
  installPeerLink({ hub: thirdPartyHub, link: thirdLink.b, selfHubId: 'third-party-hub' })

  // The 家长 tutor-teach WORKFLOW — parsed by the REAL parseWorkflow (the same one the
  // template importer runs), so a broken workflow YAML fails the demo loudly. topic.screen
  // and content.moderate are served by the deterministic participants above, NOT the agent.
  const def = parseWorkflow(readFileSync(join(WORKFLOWS_DIR, 'tutor-teach.yaml'), 'utf8'))
  parentHub.register(new WorkflowRunner({ definition: def, hub: parentHub }))

  return { name, parentHub, childHub, thirdPartyHub, tutor, guardianInbox, thirdParty, childDesk, inbox, parked, def }
}

async function teardown(env: Env): Promise<void> {
  await Promise.all([env.parentHub.stop(), env.childHub.stop(), env.thirdPartyHub.stop()])
}

/** Dispatch the 孩子's learning request onto the 家长 hub (it "arrived" cross-org — model 2). */
async function dispatchLesson(env: Env, topic: string): Promise<TaskResult> {
  return env.parentHub.dispatch({
    from: 'child-portal' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [env.def.trigger.capability] },
    // /me would force payload.learner_id = the member's own userId; we pass it directly.
    payload: { topic, learner_id: LEARNER, guardian_id: GUARDIAN },
    title: '孩子的学习申请',
  })
}

/** The 孩子 workflow's downstream master write — records.append crosses parent→child (cleared for child-learning). */
async function appendRecord(env: Env, lesson: Lesson): Promise<LearningRecord> {
  const r = await env.parentHub.dispatch({
    from: 'parent-orchestrator' as ParticipantId,
    strategy: { kind: 'capability', capabilities: ['records.append'] },
    dataClasses: [CHILD_LEARNING], // child data — crosses to the CLEARED 孩子 hub, fail-closed everywhere else
    payload: { learner_id: lesson.learnerId, topic: lesson.topic, lesson },
    title: '把这一课记入孩子学习档案 (主副本, 跨 hub 写到孩子)',
  })
  return okOutput(r, 'records.append') as LearningRecord
}

/** The 孩子 workflow's downstream oversight fork — report.to-guardian, LOCAL on the 家长 hub. */
async function reportFork(env: Env, lesson: Lesson): Promise<{ forked?: boolean }> {
  const r = await env.parentHub.dispatch({
    from: 'parent-orchestrator' as ParticipantId,
    strategy: { kind: 'capability', capabilities: ['report.to-guardian'] },
    payload: { learner_id: lesson.learnerId, summary: { lessonNo: lesson.lessonNo, title: lesson.title } },
    title: 'fork 一份监督副本给家长',
  })
  return okOutput(r, 'report.to-guardian') as { forked?: boolean }
}

/** Record the master copy on the 孩子 hub AND fork an oversight copy to the 家长. */
async function recordAndFork(env: Env, lesson: Lesson): Promise<LearningRecord> {
  const record = await appendRecord(env, lesson)
  await reportFork(env, lesson)
  return record
}

async function main(): Promise<void> {
  console.log('\n=== AipeHub case: family-learning-hub — 家长给孩子开 AI 订阅 + 管辖权 + AI 安全 (生产硬化 A-M2) ===\n')
  console.log('  跑的是真·家长 `tutor-teach` 工作流 (真 WorkflowRunner + 真求值器 + 真收件箱), 钉死两处 fail-open。\n')

  const tmpRoot = mkdtempSync(join(tmpdir(), 'aipehub-family-learning-'))
  try {
    // ── env1: the 家长's default moderation rules ON (外挂 / 充值 / 私聊) ──────────────
    const env1 = await buildEnv('rules-on', tmpRoot, DEFAULT_MODERATION_RULES)

    // --- [A] off-whitelist — parks TWICE (topic gate, then content gate) -------------
    section('[A] 白名单外 (投资理财): 家长批主题 → 上课 → 自评触发内容审核 → 家长批内容 → 建档 + fork')
    const taughtBeforeA = env1.tutor.taught.length
    const firedA = await dispatchLesson(env1, '投资理财')
    assert(firedA.kind === 'suspended', '[A] 白名单外 → 工作流挂起在主题审批闸 (这一课还没用到家长订阅)')
    assert(env1.tutor.taught.length === taughtBeforeA, '[A] 挂起期间导师 0 次被联系')
    const firstA = (await env1.inbox.listPending(GUARDIAN))[0]
    assert(!!firstA && firstA.parentKind === 'workflow', '[A] 首个待办是 workflow-parented 审批 (两步恢复)')
    console.log(`  家长 /me 收件箱: [${firstA!.kind}] "${firstA!.title ?? firstA!.prompt}"`)

    const driveA = await driveToCompletion(env1, firedA, () => APPROVE)
    const outA = okOutput(driveA.result, '[A] run after approvals') as LessonOut
    assert(
      driveA.gates.length === 2 &&
        driveA.gates[0]!.title === '白名单外主题审批' &&
        driveA.gates[1]!.title === '课程内容审核',
      '[A] 先卡主题白名单审批, 上课后又卡内容审核 (parks twice)',
    )
    assert(outA.lesson?.lessonNo === 1, '[A] 导师按学习档案续上第 1 课')
    assert(outA.lesson?.flagged === true, '[A] 导师自评把「投资理财」内容打了标 (决策 1.a, 底层)')
    assert(env1.tutor.taught.length === taughtBeforeA + 1, '[A] 导师恰好被联系一次 (批准后才跨, 第二次挂起不重跑 teach)')
    const recA = await recordAndFork(env1, outA.lesson!)
    assert(typeof recA.recordPath === 'string' && existsSync(recA.recordPath), '[A] 学习档案主副本真写到孩子 hub 磁盘')
    assert(recA.totalRecords === 1, '[A] 孩子 hub 主副本累计 1 条')
    assert(env1.guardianInbox.received.length === 1, '[A] 家长收到一份监督 fork')
    console.log(`  导师产出: ${outA.lesson?.title}  自评=${outA.lesson?.flagged} (${outA.lesson?.flagReason})`)
    console.log(`  主副本 → ${recA.recordPath}; fork 给家长: 已同步`)

    // --- [B] on-whitelist — straight through, no human ------------------------------
    section('[B] 白名单内 (分数运算): 直接开课, 不挂起 (续上第 2 课)')
    const firedB = await dispatchLesson(env1, '分数运算')
    const driveB = await driveToCompletion(env1, firedB, () => APPROVE)
    const outB = okOutput(driveB.result, '[B] on-whitelist run') as LessonOut
    assert(firedB.kind === 'ok', '[B] 白名单内主题不挂起, 直接完成')
    assert(driveB.gates.length === 0, '[B] 没有任何审批闸触发 (主题白名单内 + 内容不 flagged)')
    assert(outB.lesson?.lessonNo === 2, '[B] 同一学习者续上第 2 课 (进度递增 = /teach 文件状态当时钟)')
    assert(outB.lesson?.flagged === false, '[B]「分数运算」不触发自评标记')
    const recB = await recordAndFork(env1, outB.lesson!)
    assert(recB.totalRecords === 2, '[B] 孩子 hub 主副本累计 2 条')
    console.log(`  没挂起, 直接上课: ${outB.lesson?.title}; 主副本累计 ${recB.totalRecords} 条`)

    // --- [C] data-class confinement — child data can't escape to a third party -------
    section('[C] 数据外泄闸: child-learning 任务发孩子通 (上面 records.append) / 发第三方拒')
    const firedC = await env1.parentHub.dispatch({
      from: 'parent-orchestrator' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['thirdparty.ingest'] },
      dataClasses: [CHILD_LEARNING],
      payload: { note: '把孩子的学习记录发给第三方' },
      title: '试图把孩子数据发给第三方',
    })
    assert(firedC.kind === 'failed', '[C] child-learning 任务发第三方被拒 (data-class fail-closed)')
    assert(
      firedC.kind === 'failed' && firedC.error.startsWith('outbound_data_class_denied'),
      '[C] 拒绝原因是出站 data-class 闸',
    )
    assert(env1.thirdParty.received.length === 0, '[C] 第三方一条孩子数据都没收到 (只流向家长侧的孩子 hub)')
    console.log(`  发第三方: kind=${firedC.kind}${firedC.kind === 'failed' ? ` (${firedC.error})` : ''}; 第三方收到 ${env1.thirdParty.received.length} 条`)

    // --- [D] on-whitelist topic, but content trips a RULE → content gate (rule layer) -
    section('[D] 白名单内主题但内容命中规则 (编程基础之游戏外挂): 自评漏了, 规则引擎拦下 → 家长审内容')
    const firedD = await dispatchLesson(env1, '编程基础之游戏外挂')
    assert(firedD.kind === 'suspended', '[D] 主题白名单内但内容被规则引擎标记 → 挂起在内容审核闸')
    const firstD = (await env1.inbox.listPending(GUARDIAN))[0]
    assert(!!firstD && firstD.title === '课程内容审核', '[D] 卡的是内容审核闸 (不是主题审批 — 主题在白名单内被旁路)')
    const driveD = await driveToCompletion(env1, firedD, () => APPROVE)
    const outD = okOutput(driveD.result, '[D] content-flagged run') as LessonOut
    assert(driveD.gates.length === 1 && driveD.gates[0]!.title === '课程内容审核', '[D] 只触发内容审核一道闸')
    assert(outD.lesson?.flagged === false, '[D] 导师自评没标 (外挂不是自评关键词) — 漏网的')
    assert(outD.moderated?.flagged === true, '[D] 规则引擎 (第二层) 标了「外挂」→ 这就是它的价值')
    assert((outD.moderated?.reasons.length ?? 0) >= 1, '[D] 规则命中带 reasons')
    await recordAndFork(env1, outD.lesson!)
    console.log(`  自评 flagged=${outD.lesson?.flagged}, 规则引擎 flagged=${outD.moderated?.flagged} (${outD.moderated?.reasons.join(', ')})`)

    // --- [F] off-whitelist → REJECT → the lesson is NOT taught (workflow-level fix) ---
    section('[F] 白名单外 (加密货币) 家长「拒绝」: 这一课不上 (钉死工作流层 fail-open — 拒绝真能拦)')
    const taughtBeforeF = env1.tutor.taught.length
    const firedF = await dispatchLesson(env1, '加密货币')
    assert(firedF.kind === 'suspended', '[F] 白名单外 → 挂起等家长')
    const driveF = await driveToCompletion(env1, firedF, () => REJECT)
    const outF = okOutput(driveF.result, '[F] run after rejection') as LessonOut
    assert(driveF.gates.length === 1 && driveF.gates[0]!.title === '白名单外主题审批', '[F] 只卡主题审批 (拒绝后不再走内容闸)')
    assert(outF.lesson === undefined, '[F] ★ 家长拒绝 → teach 步被 when 跳过 → 没有这一课 (lesson=undefined)')
    assert(env1.tutor.taught.length === taughtBeforeF, '[F] ★ 导师从未被联系 (拒绝真的拦住了, 不是 fail-open 照常上课)')
    console.log(`  家长拒绝 → lesson=${outF.lesson}; 导师被联系次数不变 (${env1.tutor.taught.length})`)

    assert((await env1.inbox.listPending(GUARDIAN)).length === 0, 'env1 收件箱无遗留待办')
    await teardown(env1)

    // ── env2: the SAME content, rule engine OFF (empty list = opt-out) ───────────────
    section('[E] 关掉规则引擎 (空规则清单): 同样的「编程基础之游戏外挂」内容 → 不再卡内容审核, 只剩自评层')
    const env2 = await buildEnv('rules-off', tmpRoot, [])
    const firedE = await dispatchLesson(env2, '编程基础之游戏外挂')
    const driveE = await driveToCompletion(env2, firedE, () => APPROVE)
    const outE = okOutput(driveE.result, '[E] rules-off run') as LessonOut
    assert(firedE.kind === 'ok', '[E] 空规则清单下同样内容不挂起 (规则引擎关 → 内容闸不触发)')
    assert(driveE.gates.length === 0, '[E] 没有任何审批闸触发 (主题白名单内 + 规则引擎 opt-out + 自评没标)')
    assert(outE.moderated?.flagged === false, '[E] ★ 空规则清单 = opt-out: 同样的「外挂」内容也不标')
    assert(outE.lesson?.flagged === false, '[E] 自评层仍在但不把「外挂」当事 (那是规则层的活)')
    console.log(`  规则引擎关 → 规则 flagged=${outE.moderated?.flagged}; 自评 flagged=${outE.lesson?.flagged} (自评底层照常兜底其它内容)`)
    await teardown(env2)

    section('[verify] 全部场景通过')
    console.log('  ① 主题白名单是确定性参与者返真布尔 → 审批闸读得到 (修 gate-level fail-open)。')
    console.log('  ② 家长拒绝经 when 真能拦住上课 (修 workflow-level fail-open)。')
    console.log('  ③ 分层审核: 自评底层始终在 + 规则引擎可选 (空清单=opt-out)。')
    console.log('  ④ 管辖权 = 家长持订阅 + per-link 契约 + transcript fork; 孩子数据主副本留孩子、锁死不外泄第三方。')
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }

  section('done')
  console.log('  孩子借家长订阅学习, 主题白名单 + 分层内容审核 + 家长审批都在家长工作流里, 拒绝真能拦, 数据各归各家。\n')
  process.exit(0)
}

/**
 * Drive a workflow run to completion, resolving each `human:` step it parks on. A single
 * run can park MORE THAN ONCE (scenario [A]: topic gate, then content gate), so this loops
 * until the run is no longer suspended, collecting the gates it hit (for assertions).
 */
async function driveToCompletion(
  env: Env,
  fired: TaskResult,
  decide: (item: InboxItem) => InboxDecision,
): Promise<{ result: TaskResult; gates: InboxItem[] }> {
  let result = fired
  const gates: InboxItem[] = []
  let guard = 0
  while (result.kind === 'suspended') {
    if (++guard > 10) throw new Error('run suspended more than 10 times — possible loop')
    const pending = await env.inbox.listPending(GUARDIAN)
    if (pending.length === 0) throw new Error('run suspended but the 家长 inbox has no pending item')
    const item = pending[0]!
    gates.push(item)
    result = await resolveHumanStep(env.parentHub, env.inbox, env.parked, item.itemId, decide(item))
  }
  return { result, gates }
}

/**
 * Resolve a parked `human:` step and resume — the two-step pattern from
 * `HostInboxService.resolve` (host/src/inbox-service.ts), hand-rolled so the mechanism is
 * visible. The three invariants that keep it correct:
 *   1. flip pending→resolved FIRST (race guard) — a repeat resolve can't double-wake.
 *   2. resume the CHILD broker before the PARENT workflow — until the child resumes, the
 *      parent's lookup of the child result is still `suspended`.
 *   3. only drop the parent row when it actually finished (it could re-suspend on another
 *      human step — [A] parks twice).
 */
async function resolveHumanStep(
  hub: Hub,
  store: FileInboxStore,
  parked: Map<string, ParkedRow>,
  itemId: string,
  decision: InboxDecision,
): Promise<TaskResult> {
  const item = await store.get(itemId)
  if (!item) throw new Error(`inbox item '${itemId}' not found`)

  // (1) race guard — pending → resolved before any resume.
  await store.markResolved(itemId, decision)

  // (2) resume the CHILD broker with the decision as its answer.
  const childRow = parked.get(itemId)
  if (!childRow) throw new Error('child broker task was not parked')
  const childTask = JSON.parse(childRow.taskJson) as Task
  await hub.resumeTask(childRow.agentId, childTask, { answer: decision })
  parked.delete(itemId)

  // (3) resume the PARENT workflow run (child strictly before parent).
  if (item.parentKind !== 'workflow' || !item.parent) {
    throw new Error('expected a workflow parent for this demo step')
  }
  const parentRow = parked.get(item.parent.taskId)
  if (!parentRow) throw new Error('parent workflow task was not parked')
  if (parentRow.agentId !== item.parent.by) {
    throw new Error(`parent agent mismatch: ${parentRow.agentId} !== ${item.parent.by}`)
  }
  const parentTask = JSON.parse(parentRow.taskJson) as Task
  const result = await hub.resumeTask(item.parent.by, parentTask, parentRow.state)
  // only drop the parent row once the run is actually done (not re-suspended on another gate).
  if (result.kind !== 'suspended') parked.delete(item.parent.taskId)
  return result
}

function okOutput(r: TaskResult, label: string): unknown {
  if (r.kind !== 'ok') throw new Error(`${label}: expected an 'ok' result, got '${r.kind}'`)
  return (r as { output: unknown }).output
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`)
  console.log(`  ✓ ${label}`)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
