/**
 * federation.ts — family-learning over a REAL WebSocket (C-M1).
 *
 * The hermetic demo (`index.ts`) and real mode (`index.real.ts`) link the 孩子 and 家长
 * hubs with an INPROC HubLink pair — same process, no socket, no auth. That's the right
 * call for proving the gate LOGIC (it runs through the real predicate + real workflow),
 * but it dodges the part a real family deployment forces: the two hubs are different
 * machines, the link is a network socket, and the only thing between the 家长's
 * subscription and any stranger is a shared secret on the wire.
 *
 * This is the transport twin — the WS version of the CHILD-form story (the original FL-M1
 * topology): the 孩子 hub runs the `child-guided-lesson` workflow and reaches the 家长's
 * AI tutor across the federation boundary. The headline `tutor.teach` send is gated by a
 * RUNTIME outbound approval gate (the 家长's topic whitelist), NOT a workflow `human:` step
 * — because a 孩子-hub-local `human:` can only assign to a 孩子-hub user, never the 家长
 * (FAMILY-LEARNING-HUB-DESIGN.md §七). This is the same equivalent gating form FL-M1 used,
 * now over a real `ws` link with a bearer token on BOTH sides. (The 家长-WORKFLOW form,
 * with the parent-local `human:` approval + content-moderation steps, is the OTHER half —
 * proven through the real predicate by the hermetic `index.ts` / `index.real.ts`.)
 *
 * The per-link TRUST CONTRACT the 家长 sets is configured on the real link, exactly as the
 * runbook spells out (docs/zh/FEDERATION-RUNBOOK.md):
 *   - `allowedDataClasses: [child-learning]` — the data-class lock (the 孩子's learning
 *     data clears to the 家长, fail-closed to anyone else; [E] proves the teeth).
 *   - `outboundCaps: [tutor.teach, report.to-guardian]` — the capability allowlist.
 *   - per-link inbound quota — the 家长 caps how much the 孩子 can send (fail-closed when
 *     the budget is spent; the host wires a windowed FixedWindowLimiter, modelled here).
 *
 * What this demo proves end to end (deterministic, NO API key):
 *
 *   [A] off-whitelist approve — the 孩子 workflow reaches `tutor.teach`; the request PARKS
 *       at the gate (nothing has crossed — no frame on the wire). The 家长 approves from
 *       their inbox; the request finally travels the socket to the 家长's tutor; the lesson
 *       flows back over the link; the LOCAL `records.append` step files the MASTER copy on
 *       the 孩子 hub; the `report.to-guardian` fork crosses to the 家长.
 *   [B] on-whitelist passthrough — a pre-approved topic is NOT gated: it crosses straight
 *       across, teaches, records, forks. No inbox item. (The gate is SELECTIVE.)
 *   [C] reject — an off-whitelist topic the 家长 REJECTS. The tutor is NEVER contacted, no
 *       frame crosses, the run fails closed, no new master record.
 *   [D] wrong token — a third hub dials the 家长 presenting the WRONG bearer token. The 家长
 *       rejects it at the handshake; the dial throws and no inbound link is installed.
 *   [E] data-class teeth — a `tutor.teach` carrying a data class the link does NOT clear is
 *       fail-closed at the outbound data-class gate BEFORE the wire (the contract bites).
 *
 * Host-free on purpose (same precedent as cross-hub-federation / cafe-ops): core + workflow
 * + inbox + transport-ws + a ~40-line inline mirror of the host's selective outbound gate
 * (host/src/outbound-approval.ts) and HostInboxService two-step resume
 * (host/src/inbox-service.ts). In production those are the real host components, driven by
 * installPeerLink's `wrapOutbound` hook + a /me inbox click, over the same
 * `connectHubLink`/`acceptHubLinks` transport used here.
 *
 * Run:  pnpm demo:family-learning-hub:federation
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Hub,
  InMemoryStorage,
  SuspendTaskError,
  installPeerLink,
  type HubLink,
  type Message,
  type ParticipantId,
  type Task,
  type TaskResult,
} from '@gotong/core'
import { acceptHubLinks, bearerAuth, connectHubLink } from '@gotong/transport-ws'
import { FileInboxStore, NEVER_RESUME_AT, type InboxDecision, type InboxItem } from '@gotong/inbox'
import { parseWorkflow, WorkflowRunner } from '@gotong/workflow'
import { WebSocketServer } from 'ws'

import {
  LessonTutorStandin,
  RecordsAppendParticipant,
  ReportToGuardianParticipant,
  type LearningRecord,
  type Lesson,
} from './participants.js'

const WORKFLOWS_DIR = fileURLToPath(new URL('../workflows', import.meta.url))

const GUARDIAN = 'guardian-parent' as ParticipantId // approves off-whitelist topics from their inbox
const LEARNER = 'kid-lin' // the 孩子 member; /me would force payload.learner_id = this userId

const TUTOR_CAP = 'tutor.teach' // the lesson capability — gated by the 家长's topic whitelist
const REPORT_CAP = 'report.to-guardian' // the oversight fork — crosses freely, never gated
const CHILD_LEARNING = 'child-learning' // the data class tagged on every cross-hub step

// The 家长's per-link topic whitelist. Published by the 家长 on the link; the 孩子 can't
// change it (the outbound gate is the 家长's, immutable to the 孩子). On-whitelist → flow;
// off-whitelist → the 家长 approves.
const TOPIC_WHITELIST = ['分数运算', '数学', '英语阅读', '科学常识', '编程基础', '自然拼读']

// How many cross-org sends the 家长's link will accept before failing closed. The host
// wires a WINDOWED FixedWindowLimiter (packages/host/src/peer-registry.ts); a plain counter
// stands in here. Set generously so the demo's handful of sends pass; exhaustion →
// `cross_org_policy_denied` is proven over a real socket in host/tests/peer-isolation-ws-e2e.test.ts.
const PER_LINK_QUOTA_BUDGET = 50

// In production this is minted by `gotong mint-peer-token` (256-bit base64url) and handed
// to the other operator out-of-band (FEDERATION-RUNBOOK.md). A fixed constant keeps the demo
// deterministic — NEVER reuse a literal token like this for real.
const PEER_TOKEN = 'demo-family-shared-peer-token-do-not-reuse'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** In-memory stand-in for identity.suspended_tasks — what a parked task needs to resume. */
interface ParkedRow {
  agentId: ParticipantId
  state: unknown
  taskJson: string
}

/** child-guided-lesson's output shape (steps: tutor → record → report). */
interface ChildLessonOut {
  lesson?: Lesson
  record?: LearningRecord
  report?: { forked?: boolean }
}

/**
 * The per-link inbound quota the 家长 sets — a plain counter standing in for the host's
 * windowed FixedWindowLimiter. Returns `{ok:false}` once the budget is spent, so the
 * inbound task is refused (`cross_org_policy_denied`) before it reaches a participant.
 */
function makePerLinkQuota(budget: number): (task: Task) => { ok: true } | { ok: false; reason: string } {
  let used = 0
  return () => {
    if (used >= budget) return { ok: false, reason: `per_link_quota_exceeded (budget ${budget})` }
    used += 1
    return { ok: true }
  }
}

/**
 * Minimal mirror of host/src/outbound-approval.ts, made SELECTIVE for this scenario (same
 * inline gate FL-M1 used, now wrapping the WS peer wrapper). Wraps the outbound peer wrapper
 * (the RemoteHubViaLink installPeerLink hands to `wrapOutbound`) so that:
 *   - `report.to-guardian` (the oversight fork) passes STRAIGHT THROUGH — never gated.
 *   - `tutor.teach` is screened against the 家长's topic whitelist: on-whitelist → straight
 *     across (the frame crosses the socket); off-whitelist → PARK in the 家长's inbox until
 *     they approve (nothing crosses until then).
 * id/capabilities delegate to the inner so the hub registers the gate under the wrapper id
 * (== link.peerId == 'parent-hub') and capability dispatch still selects it for BOTH caps.
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
    // The fork is NEVER gated — oversight copies cross freely to the 家长.
    if (this.capOf(task) !== TUTOR_CAP) return this.inner.onTask(task)

    const topic = String((task.payload as { topic?: string } | undefined)?.topic ?? '').trim()
    // Pre-approved topic → straight across the boundary, no human in the loop.
    if (this.whitelist.includes(topic)) return this.inner.onTask(task)

    // Off-whitelist → park for the 家长. Nothing has crossed the boundary yet.
    // parentKind from ancestry: a workflow-dispatched lesson (from = `workflow:<id>`) parks
    // its OWN run too, so it recovers via the two-step path below.
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
      // Approved → the tutoring request finally crosses the socket to the 家长 hub.
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
  console.log('\n=== Gotong case: family-learning-hub — 孩子 hub 过真 WebSocket 借家长订阅的 AI 导师 ===\n')

  const tmp = mkdtempSync(join(tmpdir(), 'gotong-family-fed-'))
  const childRecordsRoot = join(tmp, 'child-hub')
  const parked = new Map<string, ParkedRow>()
  const inbox = new FileInboxStore(tmp)
  inbox.ensureDirs()

  // --- 家长 hub (provider): holds the subscription; serves tutor.teach + the fork sink ----
  // Runs a real ws server; every accepted inbound link is gated by the bearer token
  // (fail-closed against a wrong-token peer) + the per-link inbound quota.
  const parentHub = new Hub({ storage: new InMemoryStorage() })
  await parentHub.start()
  const tutor = new LessonTutorStandin(TUTOR_CAP) // serves tutor.teach (the model is billed to the 家长)
  const guardianFork = new ReportToGuardianParticipant() // serves report.to-guardian (oversight copies)
  parentHub.register(tutor)
  parentHub.register(guardianFork)

  const parentInbound: HubLink[] = []
  const parentQuota = makePerLinkQuota(PER_LINK_QUOTA_BUDGET)
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const addr = wss.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const parentUrl = `ws://127.0.0.1:${port}`
  const stopAccepting = acceptHubLinks({
    server: wss,
    selfId: 'parent-hub',
    auth: bearerAuth({ token: PEER_TOKEN }),
    onLink: (link) => {
      parentInbound.push(link)
      installPeerLink({ hub: parentHub, link, selfHubId: 'parent-hub', inboundGate: parentQuota })
    },
  })

  // --- 孩子 hub (consumer): runs the lesson workflow, owns the master, parks outbound ------
  // A real host parks suspended tasks in identity.suspended_tasks; the demo records them in
  // `parked` and wakes them by hand (resolveApproval below).
  const childHub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, by, s) => {
      parked.set(task.id, { agentId: by, state: s.state, taskJson: JSON.stringify(task) })
    },
  })
  await childHub.start()
  const childDesk = new RecordsAppendParticipant(childRecordsRoot) // records.append — LOCAL master copy
  childHub.register(childDesk)

  // --- dial 孩子 → 家长 over a REAL ws link, presenting the bearer token -------------------
  section('[0] 两 hub 过真 WebSocket 握手 (bearerAuth, 双方 token 匹配) + 设 per-link 信任契约 + 载入工作流')
  const linkToParent = await connectHubLink({
    url: parentUrl,
    selfId: 'child-hub',
    expectedPeerId: 'parent-hub',
    auth: bearerAuth({ token: PEER_TOKEN }),
  })
  for (let i = 0; i < 50 && parentInbound.length === 0; i++) await delay(10)
  if (parentInbound.length === 0) throw new Error('the 家长 hub never accepted the inbound link')
  installPeerLink({
    hub: childHub,
    link: linkToParent,
    selfHubId: 'child-hub',
    remoteCapabilities: [TUTOR_CAP, REPORT_CAP], // advertise so the workflow steps can route here
    outboundCaps: [TUTOR_CAP, REPORT_CAP], // the capability allowlist (same set authorizes the cross)
    allowedDataClasses: [CHILD_LEARNING], // the data-class lock — child data clears to the 家长 only
    wrapOutbound: (inner) => new TopicWhitelistGate(inner, inbox, GUARDIAN, TOPIC_WHITELIST),
  })
  console.log(`  child-hub ⇄ parent-hub 握手成功 over ${parentUrl} (双方 bearer token 匹配)`)
  console.log(`  per-link 契约: dataClasses=[${CHILD_LEARNING}] · outboundCaps=[${TUTOR_CAP}, ${REPORT_CAP}] · 入站配额预算=${PER_LINK_QUOTA_BUDGET}`)
  console.log(`  主题白名单 (家长设, 孩子改不了): [${TOPIC_WHITELIST.join(', ')}]`)

  // Load the 孩子-side workflow — parsed by the REAL parseWorkflow (the same one the template
  // importer runs), so a broken workflow YAML fails the demo loudly.
  const def = parseWorkflow(readFileSync(join(WORKFLOWS_DIR, 'child-guided-lesson.yaml'), 'utf8'))
  childHub.register(new WorkflowRunner({ definition: def, hub: childHub }))
  console.log(`  ${def.id}  (trigger: ${def.trigger.capability}, ${def.steps.length} 步: ${def.steps.map((s) => s.id).join(' → ')})`)

  // --- [A] off-whitelist approve — the headline cross-hub lesson OVER THE WIRE -------------
  section('[A] 白名单外 (投资理财): 挂起等家长 → 批准后跨真 socket 上课 → 建档主副本 (孩子) + fork (家长)')
  const firedA = await childHub.dispatch({
    from: 'child-portal' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    // /me would force payload.learner_id = the member's own userId; we pass it directly.
    payload: { topic: '投资理财', learner_id: LEARNER },
    title: '孩子的学习申请 (白名单外)',
  })
  if (firedA.kind !== 'suspended') {
    throw new Error(`expected the run to SUSPEND at the topic whitelist gate, got '${firedA.kind}'`)
  }
  console.log('  工作流跑到 `tutor` 步 → 主题白名单闸挂起 (请求还没离开孩子 hub, 没有任何帧上线)')
  // Read into a number local: guarding `tutor.taught.length` directly would permanently
  // narrow it to literal 0 (TS can't see the push inside dispatch), breaking `=== 1` below.
  const taughtBeforeApproval: number = tutor.taught.length
  if (taughtBeforeApproval !== 0) throw new Error('the tutor should not have been contacted yet')

  const pendingA = await inbox.listPending(GUARDIAN)
  if (pendingA.length !== 1 || pendingA[0]!.kind !== 'approval' || pendingA[0]!.parentKind !== 'workflow') {
    throw new Error(`expected 1 workflow-parented approval for the 家长, got ${pendingA.length}`)
  }
  const itemA = pendingA[0]!
  console.log(`  家长 /me 收件箱: 1 条待办 [${itemA.kind}] "${itemA.prompt}" (parent=${itemA.parentKind})`)

  const approveResult = await resolveApproval(childHub, inbox, parked, itemA.itemId, { kind: 'approval', approved: true })
  const outA = okOutput(approveResult, 'run after approval') as ChildLessonOut
  console.log('  家长批了 → 请求跨真 socket 到家长导师 → 课跨 ws 回流 → 本地 `record` 步建档 → `report` 步 fork → 工作流完成')
  console.log(`  导师产出 (经 ws 回流): 「${outA.lesson?.title}」 (第 ${outA.lesson?.lessonNo} 课) 自评 flagged=${outA.lesson?.flagged}`)
  console.log(`  主副本 → ${outA.record?.recordPath}`)

  // --- [B] on-whitelist passthrough — the gate is SELECTIVE --------------------------------
  section('[B] 白名单内 (分数运算): 主题白名单内 → 不卡闸不挂起 → 直接跨 ws 上课 → 建档 + fork')
  const firedB = await childHub.dispatch({
    from: 'child-portal' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    payload: { topic: '分数运算', learner_id: LEARNER },
    title: '孩子的学习申请 (白名单内)',
  })
  if (firedB.kind !== 'ok') throw new Error(`expected on-whitelist run to complete (ok), got '${firedB.kind}'`)
  const outB = (firedB as { output: ChildLessonOut }).output
  console.log(`  白名单内主题旁路审批 (无收件箱待办) → 导师产出「${outB.lesson?.title}」; 主副本累计 ${outB.record?.totalRecords} 条`)

  // --- [C] reject — fail closed: the tutor is NEVER contacted ------------------------------
  section('[C] 白名单外 (网络赌博): 家长拒绝 → 导师从不被联系, socket 上零帧 → 这一课不上 (fail-closed)')
  const firedC = await childHub.dispatch({
    from: 'child-portal' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    payload: { topic: '网络赌博', learner_id: LEARNER },
    title: '可疑的学习申请',
  })
  if (firedC.kind !== 'suspended') throw new Error(`expected suspend, got '${firedC.kind}'`)
  const itemC = (await inbox.listPending(GUARDIAN))[0]!
  console.log(`  又一条白名单外审批挂起: "${itemC.prompt}"`)
  const taughtBeforeReject: number = tutor.taught.length
  const rejectResult = await resolveApproval(childHub, inbox, parked, itemC.itemId, { kind: 'approval', approved: false })
  console.log(`  家长拒了 → 工作流 fail-closed (result.kind=${rejectResult.kind}); 导师从未被联系`)

  // --- [D] wrong token — the auth is real, not decorative ---------------------------------
  section('[D] 错 token 被拒: 冒名 hub 拨号, 家长握手期拒掉 (auth 是真的)')
  let imposterRejected = false
  const inboundBefore = parentInbound.length
  try {
    // A third hub shows up with the WRONG bearer token. The 家长's accept-side resolver
    // rejects it and closes the socket WITHOUT a failure frame (anti-enumeration): the
    // dialer only observes the close, never the reason.
    await connectHubLink({
      url: parentUrl,
      selfId: 'child-imposter',
      expectedPeerId: 'parent-hub',
      auth: bearerAuth({ token: 'WRONG-token' }),
      handshakeTimeoutMs: 1500,
    })
  } catch (err) {
    imposterRejected = true
    console.log(`  冒名 hub 拨号被拒 (token 不符, 看到的只是链接被关): ${(err as Error).message}`)
  }
  await delay(30) // let any server-side teardown settle before counting inbound links

  // --- [E] data-class teeth — the contract bites BEFORE the wire ---------------------------
  section('[E] 数据类不符: tutor.teach 带未授权 data-class → 出站 data-class 闸 fail-closed (帧从不上线)')
  // On-whitelist topic so the topic gate PASSES — then the outbound data-class gate denies it
  // because the link only clears `child-learning`. Proves the data-class lock has teeth on
  // the real ws edge, independent of the topic gate.
  const firedE = await childHub.dispatch({
    from: 'child-portal' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [TUTOR_CAP] },
    dataClasses: ['pii'], // a data class the link does NOT clear
    payload: { topic: '分数运算', learner_id: LEARNER },
    title: '数据类不符的探针 (应被出站闸拒)',
  })
  const taughtAfterProbe: number = tutor.taught.length
  console.log(`  result.kind=${firedE.kind}` + (firedE.kind === 'failed' ? ` error=${firedE.error}` : ''))

  // --- self-assertions (this demo doubles as a smoke test) --------------------------------
  section('[verify]')
  assert(firedA.kind === 'suspended', 'off-whitelist lesson suspended at the topic whitelist gate (no frame sent)')
  assert(itemA.parentKind === 'workflow', 'the approval item is parented to the 孩子 workflow run (two-step resume)')
  assert(approveResult.kind === 'ok', 'the run resumed to completion after the 家长 approved')
  assert(tutor.taught.length === 2, 'the tutor was contacted across the wire only for the APPROVED + on-whitelist lessons')
  assert(
    (tutor.taught[0]!.payload as { topic?: string }).topic === '投资理财',
    'the off-whitelist lesson payload reached the 家长 intact across the real socket',
  )
  assert(outA.lesson?.lessonNo === 1 && outA.lesson?.topic === '投资理财', "the 家长's lesson flowed back over ws as the step output")
  assert(typeof outA.record?.recordPath === 'string' && existsSync(outA.record.recordPath), 'the MASTER copy was written to the 孩子 hub disk (records.append is LOCAL)')
  assert(outA.record?.totalRecords === 1, 'the 孩子 hub master copy holds exactly the one approved lesson')
  assert(guardianFork.received.length === 2, 'the 家长 received an oversight fork for each lesson that ran')
  assert(firedB.kind === 'ok', 'an on-whitelist lesson crosses straight across — no park, no inbox item')
  assert(outB.lesson?.lessonNo === 2, 'the on-whitelist lesson continued the same learner (lesson 2)')
  assert(rejectResult.kind !== 'ok', 'a rejected lesson fails closed (the run does not complete)')
  assert(taughtBeforeReject === 2 && tutor.taught.length === 2, 'reject NEVER crossed the socket (tutor contact count unchanged)')
  assert(imposterRejected, 'a peer presenting the WRONG bearer token is rejected at the ws handshake (auth is real)')
  assert(parentInbound.length === inboundBefore, 'the rejected imposter never installed an inbound link on the 家长')
  assert(firedE.kind === 'failed' && /data_class/.test(firedE.error), 'a task carrying an uncleared data class is fail-closed at the outbound gate')
  assert(taughtAfterProbe === 2, 'the data-class probe never reached the tutor (denied before the wire)')
  console.log('  all checks passed.')

  // --- cleanup ----------------------------------------------------------------------------
  stopAccepting()
  await linkToParent.close().catch(() => {})
  for (const link of parentInbound) await link.close().catch(() => {})
  for (const c of wss.clients) {
    try {
      c.terminate()
    } catch {
      /* swallow */
    }
  }
  await new Promise<void>((r) => wss.close(() => r()))
  await Promise.all([childHub.stop(), parentHub.stop()])
  rmSync(tmp, { recursive: true, force: true })

  section('done')
  console.log('  家庭学习联邦跑在真 WebSocket 上: 孩子借家长订阅的 AI 导师, 白名单外要家长批,')
  console.log('  per-link 契约锁孩子数据 + 配额, 错 token 进不来. 两机操作员落地见 docs/zh/FEDERATION-RUNBOOK.md.\n')
  process.exit(0)
}

/**
 * Resolve a parked approval item and resume — the two-step pattern from
 * HostInboxService.resolve (host/src/inbox-service.ts), hand-rolled so the mechanism is
 * visible. Identical to cross-hub-federation's `resolveApproval`; the only difference is
 * invisible here: the child gate's approval resume now CROSSES A REAL SOCKET (inner.onTask
 * sends a MESH_TASK frame and awaits the response) instead of an inproc call.
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

  // (2a) resume the CHILD gate with the decision as its answer; on approve this is where the
  // task crosses the ws link to the 家长 hub.
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
