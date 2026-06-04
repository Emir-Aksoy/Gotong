/**
 * cross-hub-workflow — runnable demo of CROSS-HUB workflow orchestration.
 *
 * 北极星 第 2 层「跨组织协作」: a workflow on ONE hub (org A) drives a step on
 * ANOTHER hub (org B), but credentials / data / billing stay each-its-own. This
 * is the self-graph, not a hierarchy tree — org A doesn't own org B, it just has
 * a curated link to one of org B's capabilities.
 *
 * The whole thing is built from parts that already shipped — no new schema, no
 * new workflow YAML keyword:
 *
 *   - cross-hub dispatch is just CAPABILITY dispatch where the capability lives
 *     on a peer. The workflow step says `{kind: capability, capabilities:
 *     [legal.contract-review]}` and never names a peer; the hub's routing + the
 *     federation link carry it across (G-M1: the peer wrapper ADVERTISES the
 *     curated `outboundCaps` so the step can route to it, and the SAME allowlist
 *     AUTHORIZES the cross — advertise = authorize).
 *   - the human in the loop is the Phase 18 OUTBOUND APPROVAL GATE: a peer
 *     flagged `requireApprovalOutbound` is wrapped so an outbound task PARKS in
 *     the owner's inbox and only crosses the org boundary after they approve.
 *     The gate is the cross-hub twin of the Phase 16 human-inbox broker — same
 *     suspend/resume machinery, it just FORWARDS to the remote on approval
 *     instead of returning the decision.
 *
 * What this demo proves end to end (deterministic, no API key):
 *
 *   [A] approve — org A's workflow dispatches `review` to org B's counsel. The
 *       run SUSPENDS at the approval gate (nothing has crossed yet). The owner
 *       approves from their inbox; the task finally crosses to org B; org B's
 *       verdict flows back as the step output; the next (LOCAL) `archive` step
 *       files that verdict; the run completes.
 *   [B] reject — same setup; the owner rejects. Org B is NEVER contacted, the
 *       local archive step never runs, the run fails closed.
 *
 * This is host-free on purpose (same precedent as cafe-ops / warband-club):
 * core + workflow + inbox + a ~40-line inline mirror of the host's
 * ApprovalGatedParticipant (host/src/outbound-approval.ts) and HostInboxService
 * two-step resume (host/src/inbox-service.ts), so the mechanism is visible
 * rather than buried in the host binary. In production those are the real host
 * components driven by installPeerLink's `wrapOutbound` hook + a /me inbox click.
 *
 * Run:  pnpm demo:cross-hub-workflow
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const WORKFLOWS_DIR = fileURLToPath(new URL('../workflows', import.meta.url))
const OWNER = 'org-a-owner' as ParticipantId // approves outbound sends from their /me inbox

/** In-memory stand-in for identity.suspended_tasks — what a parked task needs to resume. */
interface ParkedRow {
  agentId: ParticipantId
  state: unknown
  taskJson: string
}

/** Provider-side worker on hub B (org B's outside counsel). Deterministic stand-in. */
class CounselAgent {
  readonly kind = 'agent' as const
  readonly id = 'b-counsel' as ParticipantId
  readonly capabilities = ['legal.contract-review']
  readonly seen: Task[] = []
  async onTask(task: Task): Promise<TaskResult> {
    this.seen.push(task)
    const doc = (task.payload as { doc?: string }).doc ?? '(unknown)'
    return {
      kind: 'ok',
      taskId: task.id,
      by: this.id,
      ts: 1,
      output: {
        verdict: 'changes-requested',
        redlines: [`§4 indemnity in ${doc} is uncapped`, '§9 governing-law unspecified'],
      },
    }
  }
}

/** Local worker on hub A — files the peer's verdict (consumes the cross-hub result). */
class RegistryAgent {
  readonly kind = 'agent' as const
  readonly id = 'a-registry' as ParticipantId
  readonly capabilities = ['legal.archive']
  readonly seen: Task[] = []
  async onTask(task: Task): Promise<TaskResult> {
    this.seen.push(task)
    const p = task.payload as { doc?: string; verdict?: string }
    return { kind: 'ok', taskId: task.id, by: this.id, ts: 1, output: { archived: p.doc, verdict: p.verdict } }
  }
}

/**
 * Minimal mirror of host/src/outbound-approval.ts. Wraps the outbound peer
 * wrapper (the RemoteHubViaLink installPeerLink hands to `wrapOutbound`) so an
 * outbound task PARKS in the owner's inbox; on approval its `onResume` FORWARDS
 * to the wrapped remote (the real cross-org send), on rejection it fails closed.
 * id/capabilities delegate to the inner so the hub registers the gate under the
 * wrapper id and capability dispatch still selects it for the peer's caps.
 */
interface OutboundInner {
  readonly id: ParticipantId
  readonly capabilities: readonly string[]
  onTask(task: Task): Promise<TaskResult>
  onMessage?(msg: Message): void | Promise<void>
}

class OutboundApprovalGate {
  readonly kind = 'agent' as const
  constructor(
    private readonly inner: OutboundInner,
    private readonly store: FileInboxStore,
    private readonly approver: ParticipantId,
    private readonly peerLabel: string,
  ) {}

  get id(): ParticipantId {
    return this.inner.id
  }
  get capabilities(): readonly string[] {
    return this.inner.capabilities
  }

  async onTask(task: Task): Promise<TaskResult> {
    // parentKind from ancestry: a workflow-dispatched send (from = `workflow:<id>`)
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
      prompt: `批准把出站任务发给对端 '${this.peerLabel}'?`,
      parentKind,
      status: 'pending',
      createdAt: 1,
    }
    if (task.title !== undefined) item.title = task.title
    if (parentNode) item.parent = { taskId: parentNode.taskId, by: parentNode.by }
    await this.store.write(item)

    // A person, not a timer, wakes this — nothing has crossed the boundary yet.
    throw new SuspendTaskError({ resumeAt: NEVER_RESUME_AT, state: { inboxItemId: item.itemId } })
  }

  async onResume(task: Task, state: unknown): Promise<TaskResult> {
    const answer = (state as { answer?: { kind?: string; approved?: boolean } }).answer
    if (answer?.kind === 'approval' && typeof answer.approved === 'boolean') {
      // Approved → the real cross-org send finally fires across the peer link.
      if (answer.approved) return this.inner.onTask(task)
      return { kind: 'failed', taskId: task.id, by: this.id, error: 'outbound_approval_denied', ts: 1 }
    }
    // A stray wake without a decision — re-park rather than silently send.
    throw new SuspendTaskError({ resumeAt: NEVER_RESUME_AT, state })
  }

  async onMessage(msg: Message): Promise<void> {
    await this.inner.onMessage?.(msg)
  }
}

async function main(): Promise<void> {
  console.log('\n=== AipeHub case: cross-hub-workflow — 跨 hub 工作流编排 (北极星 第 2 层) ===\n')

  const tmp = mkdtempSync(join(tmpdir(), 'aipehub-cross-hub-wf-'))
  const parked = new Map<string, ParkedRow>()
  const inbox = new FileInboxStore(tmp)
  inbox.ensureDirs()

  // --- org B (provider hub): owns the contract-review capability ---------------
  const hubB = new Hub({ storage: new InMemoryStorage() })
  await hubB.start()
  const counsel = new CounselAgent()
  hubB.register(counsel)

  // --- org A (consumer hub): runs the workflow, parks outbound sends -----------
  // A real host parks suspended tasks in identity.suspended_tasks; the demo
  // records them in `parked` and wakes them by hand (resolveApproval below).
  const hubA = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, by, s) => {
      parked.set(task.id, { agentId: by, state: s.state, taskJson: JSON.stringify(task) })
    },
  })
  await hubA.start()
  const registry = new RegistryAgent()
  hubA.register(registry) // local `archive` worker

  // --- link org A → org B over an inproc HubLink pair --------------------------
  // The peer wrapper ADVERTISES [legal.contract-review] (so the workflow step can
  // route to it) and the SAME allowlist AUTHORIZES the cross. requireApprovalOutbound
  // is modelled by wrapping the wrapper in the OutboundApprovalGate.
  section('[0] 连接两个 hub + 载入工作流 (real installPeerLink + parseWorkflow)')
  const PEER_CAP = 'legal.contract-review'
  const { a, b } = createInprocHubLinkPair({ aPeerId: 'org-b', bPeerId: 'org-a' })
  installPeerLink({
    hub: hubA,
    link: a,
    selfHubId: 'org-a',
    remoteCapabilities: [PEER_CAP], // G-M1 — advertise so the step can route here
    outboundCaps: [PEER_CAP], // P4-M1 — the same allowlist authorizes the cross
    wrapOutbound: (inner) => new OutboundApprovalGate(inner, inbox, OWNER, 'Org B 法务'),
  })
  installPeerLink({ hub: hubB, link: b, selfHubId: 'org-b' })
  console.log(`  org-a → org-b linked; 对端通告能力 [${PEER_CAP}], 出站需 ${String(OWNER)} 审批`)

  // Load the cross-hub workflow — parsed by the REAL parseWorkflow (the same one
  // the template importer runs), so a broken workflow YAML fails the demo loudly.
  const def = parseWorkflow(readFileSync(join(WORKFLOWS_DIR, 'contract-review.yaml'), 'utf8'))
  hubA.register(new WorkflowRunner({ definition: def, hub: hubA }))
  console.log(`  ${def.id}  (trigger: ${def.trigger.capability}, ${def.steps.length} step(s): ${def.steps.map((s) => s.id).join(' → ')})`)

  // --- [A] approve — the headline cross-hub orchestration ----------------------
  section('[A] 批准: 工作流跨 hub 编排 (org A 工作流 → org B 法务 → 回流 → org A 归档)')
  const fired = await hubA.dispatch({
    from: 'a-legal-ops' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    payload: { doc: 'NDA-v3.pdf' },
    title: '跨组织合同审阅',
  })
  if (fired.kind !== 'suspended') {
    throw new Error(`expected the run to SUSPEND at the outbound approval gate, got '${fired.kind}'`)
  }
  console.log('  工作流跑到 `review` 步 → 出站审批闸挂起 (任务还没离开 org A)')
  // Read into a number local: guarding `counsel.seen.length` directly would
  // permanently narrow it to literal 0 (TS can't see the push inside dispatch),
  // breaking the `=== 1` assertions below.
  const crossedBeforeApproval: number = counsel.seen.length
  if (crossedBeforeApproval !== 0) throw new Error('nothing should have crossed to org B yet')

  const pendingA = await inbox.listPending(OWNER)
  if (pendingA.length !== 1 || pendingA[0]!.kind !== 'approval' || pendingA[0]!.parentKind !== 'workflow') {
    throw new Error(`expected 1 workflow-parented approval for the owner, got ${pendingA.length}`)
  }
  const itemA = pendingA[0]!
  console.log(`  owner /me 收件箱: 1 条待办 [${itemA.kind}] "${itemA.prompt}" (parent=${itemA.parentKind})`)

  const approveResult = await resolveApproval(hubA, inbox, parked, itemA.itemId, { kind: 'approval', approved: true })
  const reviewOut = okOutput(approveResult, 'run after approval') as {
    archived?: string
    verdict?: string
  }
  console.log('  owner 批了 → 任务跨到 org B → 法务返回裁决 → 回流给本地 `archive` 步 → 工作流完成')
  console.log(`  org B 法务裁决 (回流到本地步): verdict=${reviewOut.verdict}`)
  console.log(`  org A 本地归档: doc=${reviewOut.archived}`)

  // --- [B] reject — fail closed: org B is never contacted ----------------------
  section('[B] 拒绝: 闸前拦下, org B 永不被联系 (fail-closed)')
  const fired2 = await hubA.dispatch({
    from: 'a-legal-ops' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    payload: { doc: 'leak-it.pdf' },
    title: '可疑的跨组织外发',
  })
  if (fired2.kind !== 'suspended') throw new Error(`expected suspend, got '${fired2.kind}'`)
  const itemB = (await inbox.listPending(OWNER))[0]!
  console.log(`  又一条出站审批挂起: "${itemB.prompt}"`)
  const rejectResult = await resolveApproval(hubA, inbox, parked, itemB.itemId, { kind: 'approval', approved: false })
  console.log(`  owner 拒了 → 工作流 fail-closed (result.kind=${rejectResult.kind}); org B 从未被联系`)

  // --- self-assertions (this demo doubles as a smoke test) ---------------------
  section('[verify]')
  assert(fired.kind === 'suspended', 'cross-hub step suspended at the outbound approval gate')
  assert(itemA.parentKind === 'workflow', 'the approval item is parented to the workflow run (two-step resume)')
  assert(approveResult.kind === 'ok', 'the run resumed to completion after approval')
  assert(counsel.seen.length === 1, 'org B was contacted exactly once — only after approval')
  assert(
    (counsel.seen[0]!.payload as { doc?: string }).doc === 'NDA-v3.pdf',
    'the workflow payload reached org B intact across the boundary',
  )
  assert(reviewOut.verdict === 'changes-requested', "org B's verdict flowed back into the local archive step")
  assert(registry.seen.length === 1, 'the local archive step consumed the cross-hub result')
  assert(rejectResult.kind !== 'ok', 'a rejected outbound run fails closed')
  assert(counsel.seen.length === 1, 'reject NEVER crossed the boundary (org B contact count unchanged)')
  assert(registry.seen.length === 1, 'reject halted before the local archive step (archive count unchanged)')
  assert((await inbox.listPending(OWNER)).length === 0, 'both inbox items are resolved, none left pending')
  console.log('  all checks passed.')

  await Promise.all([hubA.stop(), hubB.stop()])
  rmSync(tmp, { recursive: true, force: true })

  section('done')
  console.log('  一个 hub 的工作流编排另一个 hub 的能力, 跨组织走出站审批闸 — 第 2 层「跨组织协作」.\n')
  process.exit(0)
}

/**
 * Resolve a parked outbound-approval item and resume — the two-step pattern from
 * HostInboxService.resolve (host/src/inbox-service.ts), hand-rolled so the
 * mechanism is visible. Identical to cafe-ops's `resolveHumanStep`: the only
 * difference is the child broker is the OutboundApprovalGate, whose approval
 * resume CROSSES the hub boundary instead of returning the decision.
 *   1. flip pending→resolved FIRST (race guard).
 *   2. resume the CHILD gate before the PARENT workflow (until the child resumes,
 *      the parent's lookup of the child result is still `suspended`).
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

  // (2a) resume the CHILD gate with the decision as its answer; on approve this
  // is where the task crosses to the peer hub.
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
