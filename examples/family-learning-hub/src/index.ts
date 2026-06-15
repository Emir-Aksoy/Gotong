/**
 * family-learning-hub — a parent gives a child an AI subscription to LEARN with,
 * keeps JURISDICTION over it, and the AI's own safety hazards are held shut
 * STRUCTURALLY. Built on the same Stream G cross-hub orchestration as
 * tea-supply-link / tea-chain-hq, but the "capability" is "teach a lesson".
 *
 * Two SOVEREIGN hubs:
 *   - 孩子 hub (child)    — runs the lesson workflow, owns the learning-records
 *     MASTER copy, parks off-whitelist tutoring requests.
 *   - 家长 hub (guardian) — holds the AI subscription; serves `tutor.teach` (the
 *     model runs HERE = billed to the 家长) + `report.to-guardian` (oversight fork).
 *
 * The 孩子 workflow `child-guided-lesson` dispatches `tutor.teach` — a capability
 * that lives on the 家长 hub. The YAML names NO peer: cross-org tutoring is just
 * capability dispatch where the capability happens to live on another hub. Whether
 * a lesson may run is decided by the RUNTIME per-link contract the 家长 set: a topic
 * whitelist + an outbound approval gate. On-whitelist topics flow straight across;
 * off-whitelist topics PARK in the 家长's inbox until the 家长 approves.
 *
 * 管辖权 (jurisdiction) comes from THREE pre-shipped pillars, none new:
 *   ① the 家长 holds the subscription (the model call crosses to the 家长 hub) —
 *      cut the link and the child has no AI;
 *   ② the per-link trust contract (outbound caps + data-class allowlist + approval);
 *   ③ the lesson transcript + the explicit `report.to-guardian` fork (oversight).
 *
 * What this demo proves end to end (deterministic, NO API key):
 *
 *   [A] off-whitelist (投资理财) — the 孩子 workflow reaches `tutor.teach`; the
 *       request PARKS at the gate (nothing has crossed). The 家长 approves; the
 *       tutor teaches lesson 1 (self-flagged: it involves money); the lesson flows
 *       back; `records.append` files the MASTER copy on the 孩子 hub;
 *       `report.to-guardian` forks a copy to the 家长.
 *   [B] on-whitelist (分数运算) — pre-approved, so it does NOT park: tutor teaches
 *       lesson 2 (continuing the same learner), records, forks. No inbox item.
 *   [C] data-class confinement — the 孩子 hub also links a THIRD party whose contract
 *       does NOT clear `child-learning`. The SAME child-learning task crosses to the
 *       家长 (allowed) but is FAIL-CLOSED to the third party. Child data flows only
 *       to the 家长, never to a third party.
 *
 * Host-free on purpose (same precedent as cafe-ops / cross-hub-workflow /
 * tea-supply-link): core + workflow + inbox + a ~40-line inline mirror of the host's
 * ApprovalGatedParticipant (host/src/outbound-approval.ts) and HostInboxService
 * two-step resume (host/src/inbox-service.ts), so the mechanism is visible.
 *
 * NOTE on the gate vs the design doc (docs/zh/FAMILY-LEARNING-HUB-DESIGN.md): §七
 * shows the whitelist+approval as a 家长-hub workflow `topic.screen` + `human:` step;
 * this FL-M1 demo uses the equivalent RUNTIME outbound gate (§十一's "内联 ~40 行
 * 出站审批闸"). Both express the SAME 家长 policy; the workflow-step form is the
 * direction FL-M2's loadable template takes. Either way the 家长 is the approver and
 * the topic whitelist is the 家长's, published on the link, immutable to the child.
 *
 * Run:  pnpm demo:family-learning-hub
 */

import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import {
  Hub,
  InMemoryStorage,
  SuspendTaskError,
  createInprocHubLinkPair,
  installPeerLink,
  type Message,
  type ParticipantId,
  type Task,
  type TaskResult,
} from '@aipehub/core'
import { FileInboxStore, NEVER_RESUME_AT, type InboxDecision, type InboxItem } from '@aipehub/inbox'
import { parseWorkflow, WorkflowRunner } from '@aipehub/workflow'

import {
  ChildDeskStandin,
  GuardianInboxStandin,
  ThirdPartyStandin,
  TutorStandin,
  type LearningRecord,
  type Lesson,
} from './standins.js'

const WORKFLOWS_DIR = fileURLToPath(new URL('../workflows', import.meta.url))
const GUARDIAN = 'guardian-parent' as ParticipantId // approves off-whitelist topics from their inbox
const LEARNER = 'kid-lin' // the child member; /me would force payload.learner_id = this userId

const TUTOR_CAP = 'tutor.teach' // the lesson capability — gated by the topic whitelist
const REPORT_CAP = 'report.to-guardian' // the oversight fork — NEVER gated
const CHILD_LEARNING = 'child-learning' // the data class tagged on every cross-hub step

// The 家长's per-link topic whitelist. Published by the 家长 on the link; the child
// can't change it (out-bound-gate lock). On-whitelist → flow; off-whitelist → 家长 approves.
const TOPIC_WHITELIST = ['分数运算', '数学', '英语阅读', '科学常识', '编程基础', '自然拼读']

/** In-memory stand-in for identity.suspended_tasks — what a parked task needs to resume. */
interface ParkedRow {
  agentId: ParticipantId
  state: unknown
  taskJson: string
}

/**
 * Minimal mirror of host/src/outbound-approval.ts, made SELECTIVE for this scenario.
 * Wraps the outbound peer wrapper (the RemoteHubViaLink installPeerLink hands to
 * `wrapOutbound`) so that:
 *   - `report.to-guardian` (the oversight fork) passes STRAIGHT THROUGH — never gated.
 *   - `tutor.teach` is screened against the 家长's topic whitelist: on-whitelist →
 *     straight through; off-whitelist → PARK in the 家长's inbox until they approve.
 * id/capabilities delegate to the inner so the hub registers the gate under the
 * wrapper id and capability dispatch still selects it for BOTH the 家长's caps.
 */
interface OutboundInner {
  readonly id: ParticipantId
  readonly capabilities: readonly string[]
  onTask(task: Task): Promise<TaskResult>
  onMessage?(msg: Message): void | Promise<void>
}

class TopicWhitelistGate {
  readonly kind = 'agent' as const
  constructor(
    private readonly inner: OutboundInner,
    private readonly store: FileInboxStore,
    private readonly approver: ParticipantId,
    private readonly whitelist: readonly string[],
  ) {}

  get id(): ParticipantId {
    return this.inner.id
  }
  get capabilities(): readonly string[] {
    return this.inner.capabilities
  }

  private capOf(task: Task): string | undefined {
    return task.strategy?.kind === 'capability' ? task.strategy.capabilities?.[0] : undefined
  }

  async onTask(task: Task): Promise<TaskResult> {
    // The fork is NEVER gated — oversight copies flow freely to the 家长.
    if (this.capOf(task) !== TUTOR_CAP) return this.inner.onTask(task)

    const topic = String((task.payload as { topic?: string } | undefined)?.topic ?? '').trim()
    // Pre-approved topic → straight across the boundary, no human in the loop.
    if (this.whitelist.includes(topic)) return this.inner.onTask(task)

    // Off-whitelist → park for the 家长. Nothing has crossed the boundary yet.
    // parentKind from ancestry: a workflow-dispatched lesson (from = `workflow:<id>`)
    // parks its OWN run too, so it recovers via the two-step path below.
    const parentNode = task.ancestry?.at(-1)
    const parentKind: InboxItem['parentKind'] = !parentNode
      ? 'none'
      : parentNode.by.startsWith('workflow:')
        ? 'workflow'
        : 'agent'

    const item: InboxItem = {
      itemId: task.id,
      userId: this.approver,
      kind: 'approval',
      prompt: `孩子想学「白名单外」的主题:「${topic || '(未填)'}」。允许这次用 AI 导师上这一课吗?`,
      parentKind,
      status: 'pending',
      createdAt: 1,
    }
    if (task.title !== undefined) item.title = task.title
    if (parentNode) item.parent = { taskId: parentNode.taskId, by: parentNode.by }
    await this.store.write(item)

    // A person (the 家长), not a timer, wakes this — the lesson hasn't crossed yet.
    throw new SuspendTaskError({ resumeAt: NEVER_RESUME_AT, state: { inboxItemId: item.itemId } })
  }

  async onResume(task: Task, state: unknown): Promise<TaskResult> {
    const answer = (state as { answer?: { kind?: string; approved?: boolean } }).answer
    if (answer?.kind === 'approval' && typeof answer.approved === 'boolean') {
      // Approved → the tutoring request finally crosses to the 家长 hub.
      if (answer.approved) return this.inner.onTask(task)
      return { kind: 'failed', taskId: task.id, by: this.id, error: 'tutor_request_denied', ts: 1 }
    }
    // A stray wake without a decision — re-park rather than silently teach.
    throw new SuspendTaskError({ resumeAt: NEVER_RESUME_AT, state })
  }

  async onMessage(msg: Message): Promise<void> {
    await this.inner.onMessage?.(msg)
  }
}

async function main(): Promise<void> {
  console.log('\n=== AipeHub case: family-learning-hub — 家长给孩子开 AI 订阅 + 管辖权 + AI 安全 ===\n')

  const tmp = mkdtempSync(join(tmpdir(), 'aipehub-family-learning-'))
  const childRecordsRoot = join(tmp, 'child-hub')
  const parked = new Map<string, ParkedRow>()
  const inbox = new FileInboxStore(tmp)
  inbox.ensureDirs()

  // --- 家长 hub (guardian): holds the subscription; owns tutor.teach + the fork sink ---
  const guardianHub = new Hub({ storage: new InMemoryStorage() })
  await guardianHub.start()
  const tutor = new TutorStandin()
  const guardianInbox = new GuardianInboxStandin()
  guardianHub.register(tutor)
  guardianHub.register(guardianInbox)

  // --- 孩子 hub (child): runs the lesson workflow, owns the learning-records master ----
  // A real host parks suspended tasks in identity.suspended_tasks; the demo records
  // them in `parked` and wakes them by hand (resolveApproval below).
  const childHub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, by, s) => {
      parked.set(task.id, { agentId: by, state: s.state, taskJson: JSON.stringify(task) })
    },
  })
  await childHub.start()
  const childDesk = new ChildDeskStandin(childRecordsRoot)
  childHub.register(childDesk) // local records.append → master copy on this hub's disk

  // --- third-party hub: only here to PROVE child data can't escape to it -------------
  const thirdPartyHub = new Hub({ storage: new InMemoryStorage() })
  await thirdPartyHub.start()
  const thirdParty = new ThirdPartyStandin()
  thirdPartyHub.register(thirdParty)

  // --- the cross-org LINKS — RUNTIME peer config, NOT in any template ----------------
  section('[0] 连接 孩子↔家长 + 孩子↔第三方 (运行时 peer 链接) + 载入工作流')

  // 孩子 → 家长: the subscription link. The 家长 wrapper ADVERTISES [tutor.teach,
  // report.to-guardian] (so the workflow can route to them) and the SAME allowlist
  // AUTHORIZES the cross (G-M1: advertise = authorize). The 家长's per-link contract:
  // allowedDataClasses = [child-learning] (this is what the child's data IS), and an
  // outbound approval gate enforcing the topic whitelist.
  const guardianLink = createInprocHubLinkPair({ aPeerId: 'guardian-hub', bPeerId: 'child-hub' })
  installPeerLink({
    hub: childHub,
    link: guardianLink.a,
    selfHubId: 'child-hub',
    remoteCapabilities: [TUTOR_CAP, REPORT_CAP],
    outboundCaps: [TUTOR_CAP, REPORT_CAP],
    allowedDataClasses: [CHILD_LEARNING], // the per-link data-class contract — child data is cleared for the 家长
    wrapOutbound: (inner) => new TopicWhitelistGate(inner, inbox, GUARDIAN, TOPIC_WHITELIST),
  })
  installPeerLink({ hub: guardianHub, link: guardianLink.b, selfHubId: 'guardian-hub' })
  console.log(
    `  child-hub → guardian-hub linked; 通告 [${TUTOR_CAP}, ${REPORT_CAP}], ` +
      `data-class 契约 [${CHILD_LEARNING}], 白名单外需 ${String(GUARDIAN)} 审批`,
  )

  // 孩子 → 第三方: a SECOND link whose contract does NOT clear child-learning. Anything
  // tagged child-learning is fail-closed here — the data-class lock (§六). We allow
  // only ['public'], so child-learning is denied at the link.
  const thirdLink = createInprocHubLinkPair({ aPeerId: 'third-party-hub', bPeerId: 'child-hub' })
  installPeerLink({
    hub: childHub,
    link: thirdLink.a,
    selfHubId: 'child-hub',
    remoteCapabilities: ['thirdparty.ingest'],
    outboundCaps: ['thirdparty.ingest'],
    allowedDataClasses: ['public'], // does NOT include child-learning → child data fails closed here
  })
  installPeerLink({ hub: thirdPartyHub, link: thirdLink.b, selfHubId: 'third-party-hub' })
  console.log('  child-hub → third-party-hub linked; data-class 契约 [public] (不含 child-learning)')

  // Load the lesson workflow — parsed by the REAL parseWorkflow (the same one the
  // template importer runs), so a broken workflow YAML fails the demo loudly.
  const def = parseWorkflow(readFileSync(join(WORKFLOWS_DIR, 'child-guided-lesson.yaml'), 'utf8'))
  childHub.register(new WorkflowRunner({ definition: def, hub: childHub }))
  console.log(
    `  ${def.id}  (trigger: ${def.trigger.capability}, ${def.steps.length} step(s): ` +
      `${def.steps.map((s) => s.id).join(' → ')})`,
  )

  // --- [A] off-whitelist — the headline parent-approval path -------------------------
  section('[A] 白名单外 (投资理财): 孩子发起 → 家长批 → 导师上课 → 本地建档 → fork 给家长')
  const firedA = await childHub.dispatch({
    from: 'child-portal' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    // /me would force payload.learner_id = the member's own userId; we pass it directly.
    payload: { topic: '投资理财', learner_id: LEARNER },
    title: '孩子的学习申请',
  })
  if (firedA.kind !== 'suspended') {
    throw new Error(`expected the run to SUSPEND at the topic-whitelist gate, got '${firedA.kind}'`)
  }
  console.log('  工作流跑到 `tutor` 步 → 主题白名单外 → 挂起 (这一课还没用到家长的订阅)')
  // Read into a number local so TS doesn't permanently narrow `taught.length` to 0.
  const taughtBeforeApproval: number = tutor.taught.length
  if (taughtBeforeApproval !== 0) throw new Error('nothing should have reached the tutor yet')

  const pendingA = await inbox.listPending(GUARDIAN)
  if (pendingA.length !== 1 || pendingA[0]!.kind !== 'approval' || pendingA[0]!.parentKind !== 'workflow') {
    throw new Error(`expected 1 workflow-parented approval for the 家长, got ${pendingA.length}`)
  }
  const itemA = pendingA[0]!
  console.log(`  家长 /me 收件箱: 1 条待办 [${itemA.kind}] "${itemA.prompt}" (parent=${itemA.parentKind})`)

  const approveResult = await resolveApproval(childHub, inbox, parked, itemA.itemId, {
    kind: 'approval',
    approved: true,
  })
  const outA = okOutput(approveResult, 'run after approval') as {
    lesson?: Lesson
    record?: LearningRecord
    report?: { forked?: boolean }
  }
  console.log('  家长批了 → 导师跨 hub 上课 (模型在家长 hub, 计家长订阅) → 回流孩子 hub')
  console.log(`  导师产出: ${outA.lesson?.title}  自评标记=${outA.lesson?.flagged}${outA.lesson?.flagReason ? ` (${outA.lesson.flagReason})` : ''}`)
  console.log(`  本地学习档案 (主副本): ${outA.record?.note}  → ${outA.record?.recordPath}`)
  console.log(`  fork 给家长: ${outA.report?.forked ? '已同步一份小结副本' : '未同步'}`)

  // --- [B] on-whitelist — pre-approved, no human in the loop -------------------------
  section('[B] 白名单内 (分数运算): 直接开课, 不挂起 (续上第 2 课)')
  const firedB = await childHub.dispatch({
    from: 'child-portal' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    payload: { topic: '分数运算', learner_id: LEARNER },
    title: '孩子的学习申请',
  })
  const outB = okOutput(firedB, 'on-whitelist run') as {
    lesson?: Lesson
    record?: LearningRecord
    report?: { forked?: boolean }
  }
  console.log(`  没挂起, 直接上课: ${outB.lesson?.title}  自评标记=${outB.lesson?.flagged}`)
  console.log(`  本地学习档案: 累计 ${outB.record?.totalRecords} 条; fork 给家长: ${outB.report?.forked ? '已同步' : '未同步'}`)

  // --- [C] data-class confinement — child data can't escape to a third party ---------
  section('[C] 数据外泄闸: 同一 child-learning 任务发家长通、发第三方拒 (夹紧一条不外溢)')
  const firedC = await childHub.dispatch({
    from: 'child-portal' as ParticipantId,
    strategy: { kind: 'capability', capabilities: ['thirdparty.ingest'] },
    dataClasses: [CHILD_LEARNING],
    payload: { note: '孩子的学习记录想发给第三方' },
    title: '试图把孩子数据发给第三方',
  })
  console.log(`  发第三方: result.kind=${firedC.kind}` + (firedC.kind === 'failed' ? ` (${firedC.error})` : ''))
  console.log(`  第三方收到的孩子数据条数: ${thirdParty.received.length} (应为 0 — data-class 闸 fail-closed)`)

  // --- self-assertions (this demo doubles as a smoke test) ---------------------------
  section('[verify]')
  assert(firedA.kind === 'suspended', '[A] 白名单外的 `tutor` 步挂起在出站审批闸')
  assert(itemA.parentKind === 'workflow', '[A] 审批项 parent 是工作流 run (两步恢复)')
  assert(approveResult.kind === 'ok', '[A] 家长批准后 run 跑到完成')
  assert(tutor.taught.length >= 1, '[A] 导师只在家长批准后才被联系 (park 期间 0 次)')
  assert(outA.lesson?.lessonNo === 1, '[A] 导师续上第 1 课 (按学习档案进度)')
  assert(outA.lesson?.flagged === true, '[A] 导师自评把「投资理财」内容打了标 (决策 1.a)')
  assert(typeof outA.record?.recordPath === 'string' && existsSync(outA.record.recordPath), '[A] 学习档案主副本真写到孩子 hub 磁盘')
  assert(outA.record?.totalRecords === 1, '[A] 本地主副本累计 1 条')
  // `guardianInbox.received` is a LIVE array; by [verify] it holds both [A] and [B]'s
  // forks. Assert [A]'s fork via its frozen output here; [B] checks the cumulative live count.
  assert(outA.report?.forked === true, '[A] 家长收到一份 fork 小结 (oversight 副本)')

  assert(firedB.kind === 'ok', '[B] 白名单内主题不挂起, 直接完成')
  assert(outB.lesson?.lessonNo === 2, '[B] 同一学习者续上第 2 课 (进度递增 = /teach 文件状态当时钟)')
  assert(outB.lesson?.flagged === false, '[B]「分数运算」不触发自评标记')
  assert(outB.record?.totalRecords === 2, '[B] 本地主副本累计 2 条')
  assert(guardianInbox.received.length === 2, '[B] 家长又收到 1 份 fork (共 2 份)')
  assert(tutor.taught.length === 2, '[B] 导师共被联系 2 次 (= 2 节课都跨到了家长 hub)')

  assert(firedC.kind === 'failed', '[C] child-learning 任务发第三方被拒 (data-class fail-closed)')
  assert(
    firedC.kind === 'failed' && firedC.error.startsWith('outbound_data_class_denied'),
    '[C] 拒绝原因是出站 data-class 闸',
  )
  assert(thirdParty.received.length === 0, '[C] 第三方一条孩子数据都没收到 (只流向家长)')
  assert((await inbox.listPending(GUARDIAN)).length === 0, '收件箱无遗留待办')
  console.log('  all checks passed.')

  await Promise.all([childHub.stop(), guardianHub.stop(), thirdPartyHub.stop()])
  rmSync(tmp, { recursive: true, force: true })

  section('done')
  console.log('  孩子 hub 借家长订阅学习, 跨组织走主题白名单 + 出站审批闸; 学习数据主副本留孩子、fork 给家长、锁死不外泄第三方.')
  console.log('  管辖权 = 家长持订阅 + per-link 契约 + transcript fork; AI 安全 = 框架不跑 LLM, 每步穿闸.\n')
  process.exit(0)
}

/**
 * Resolve a parked approval item and resume — the two-step pattern from
 * HostInboxService.resolve (host/src/inbox-service.ts), hand-rolled so the mechanism
 * is visible. Identical to tea-supply-link's `resolveApproval`: the child broker is
 * the TopicWhitelistGate, whose approval resume CROSSES the hub boundary (to the
 * 家长 tutor) instead of just returning the decision.
 *   1. flip pending→resolved FIRST (race guard).
 *   2. resume the CHILD gate before the PARENT workflow (until the child resumes, the
 *      parent's lookup of the child result is still `suspended`).
 *   3. only drop the parent row when the run actually finished.
 */
async function resolveApproval(
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

  // (2a) resume the CHILD gate with the decision as its answer; on approve this is
  // where the tutoring request crosses to the 家长 hub.
  const childRow = parked.get(itemId)
  if (!childRow) throw new Error('outbound gate task was not parked')
  const childTask = JSON.parse(childRow.taskJson) as Task
  await hub.resumeTask(childRow.agentId, childTask, { answer: decision })
  parked.delete(itemId)

  // (2b) resume the PARENT workflow run (child strictly before parent).
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
  // (3) only drop the parent row once the run is actually done (not re-suspended).
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
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
