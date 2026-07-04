/**
 * tea-supply-link — runnable demo of a CROSS-ORG link between a 奶茶店 (milk-tea
 * shop) and its 供货商 (supplier), built on Stream G cross-hub orchestration.
 *
 * The shop (org A) runs a declarative restock workflow. One of its steps —
 * `place` — dispatches a capability (`supplier.confirm-order`) that lives on the
 * SUPPLIER's hub (org B). The workflow YAML names NO peer; cross-org ordering is
 * just capability dispatch where the capability happens to live on another hub.
 * Whether the order may LEAVE the org is decided by the runtime OUTBOUND APPROVAL
 * GATE (the supplier peer flagged `requireApprovalOutbound`): the 店长 approves
 * from their inbox before the order crosses the boundary.
 *
 * The teaching point (the user's "模版和框架是分离关系"): the cross-org LINK —
 * the peer, its outbound capability allowlist, and its approval policy — is
 * RUNTIME peer config (an `installPeerLink` call here; the admin「联邦」tab in
 * production). It is NOT in the template and NOT in the workflow. The template
 * (examples/tea-supply-link/template/tea-shop.template.yaml) carries only the
 * orchestration skeleton.
 *
 * Note this differs from cafe-ops: there the approval was an in-store workflow
 * `human:` step. Here the approval is the cross-ORG outbound gate — invisible to
 * the workflow, a property of the link.
 *
 * What this demo proves end to end (deterministic, no API key):
 *
 *   [A] approve — the shop's workflow drafts an order LOCALLY, then `place`
 *       dispatches to the supplier's capability. The run SUSPENDS at the approval
 *       gate (nothing has crossed yet). The 店长 approves; the order finally
 *       crosses to the supplier; the supplier prices it (deterministically) and
 *       returns a confirmation; the next (LOCAL) `record` step files it; done.
 *   [B] reject — a suspicious bulk order; the 店长 rejects. The supplier is NEVER
 *       contacted, the local record step never runs, the run fails closed.
 *
 * Host-free on purpose (same precedent as cafe-ops / cross-hub-workflow): core +
 * workflow + inbox + a ~40-line inline mirror of the host's
 * ApprovalGatedParticipant (host/src/outbound-approval.ts) and HostInboxService
 * two-step resume (host/src/inbox-service.ts), so the mechanism is visible.
 *
 * Run:  pnpm demo:tea-supply-link
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
} from '@gotong/core'
import { FileInboxStore, NEVER_RESUME_AT, type InboxDecision, type InboxItem } from '@gotong/inbox'
import { parseWorkflow, WorkflowRunner } from '@gotong/workflow'

import { ShopDeskStandin, SupplierStandin } from './standins.js'

const WORKFLOWS_DIR = fileURLToPath(new URL('../workflows', import.meta.url))
const SHOP_MANAGER = 'shop-manager' as ParticipantId // approves outbound orders from their /me inbox
const SUPPLIER_CAP = 'supplier.confirm-order' // the one capability the shop reaches across the boundary

/** In-memory stand-in for identity.suspended_tasks — what a parked task needs to resume. */
interface ParkedRow {
  agentId: ParticipantId
  state: unknown
  taskJson: string
}

/**
 * Minimal mirror of host/src/outbound-approval.ts. Wraps the outbound peer
 * wrapper (the RemoteHubViaLink installPeerLink hands to `wrapOutbound`) so an
 * outbound order PARKS in the 店长's inbox; on approval its `onResume` FORWARDS
 * to the wrapped remote (the real cross-org send), on rejection it fails closed.
 * id/capabilities delegate to the inner so the hub registers the gate under the
 * wrapper id and capability dispatch still selects it for the supplier's caps.
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
      prompt: `批准把这张补货单发给供货商 '${this.peerLabel}'?`,
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
  console.log('\n=== Gotong case: tea-supply-link — 奶茶店 ↔ 供货商 (跨组织供货链接) ===\n')

  const tmp = mkdtempSync(join(tmpdir(), 'gotong-tea-supply-'))
  const parked = new Map<string, ParkedRow>()
  const inbox = new FileInboxStore(tmp)
  inbox.ensureDirs()

  // --- 供货商 hub (org B, provider): owns supplier.confirm-order ----------------
  const supplierHub = new Hub({ storage: new InMemoryStorage() })
  await supplierHub.start()
  const supplier = new SupplierStandin()
  supplierHub.register(supplier)

  // --- 奶茶店 hub (org A, orchestrator): runs the workflow, parks outbound orders -
  // A real host parks suspended tasks in identity.suspended_tasks; the demo
  // records them in `parked` and wakes them by hand (resolveApproval below).
  const shopHub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, by, s) => {
      parked.set(task.id, { agentId: by, state: s.state, taskJson: JSON.stringify(task) })
    },
  })
  await shopHub.start()
  const shopDesk = new ShopDeskStandin()
  shopHub.register(shopDesk) // local draft-order + record-order worker

  // --- the cross-org LINK — RUNTIME peer config, NOT in any template ------------
  // This is the user's "模版和框架是分离关系": the peer, its outbound capability
  // allowlist, and its approval policy live HERE (runtime), never in the template
  // or the workflow. The supplier wrapper ADVERTISES [supplier.confirm-order] (so
  // the `place` step can route to it) and the SAME allowlist AUTHORIZES the cross
  // (G-M1: advertise = authorize). requireApprovalOutbound is modelled by wrapping
  // the wrapper in the OutboundApprovalGate.
  section('[0] 连接两个 hub (运行时 peer 链接, 不在模板里) + 载入工作流')
  const { a, b } = createInprocHubLinkPair({ aPeerId: 'supplier-org', bPeerId: 'tea-shop-org' })
  installPeerLink({
    hub: shopHub,
    link: a,
    selfHubId: 'tea-shop-org',
    remoteCapabilities: [SUPPLIER_CAP], // G-M1 — advertise so the `place` step can route here
    outboundCaps: [SUPPLIER_CAP], // P4-M1 — the same allowlist authorizes the cross
    wrapOutbound: (inner) => new OutboundApprovalGate(inner, inbox, SHOP_MANAGER, '城西原料供货商'),
  })
  installPeerLink({ hub: supplierHub, link: b, selfHubId: 'supplier-org' })
  console.log(`  tea-shop-org → supplier-org linked; 对端通告能力 [${SUPPLIER_CAP}], 出站需 ${String(SHOP_MANAGER)} 审批`)

  // Load the restock workflow — parsed by the REAL parseWorkflow (the same one the
  // template importer runs), so a broken workflow YAML fails the demo loudly.
  const def = parseWorkflow(readFileSync(join(WORKFLOWS_DIR, 'tea-shop-restock.yaml'), 'utf8'))
  shopHub.register(new WorkflowRunner({ definition: def, hub: shopHub }))
  console.log(`  ${def.id}  (trigger: ${def.trigger.capability}, ${def.steps.length} step(s): ${def.steps.map((s) => s.id).join(' → ')})`)

  // --- [A] approve — the headline cross-org restock ----------------------------
  section('[A] 批准: 奶茶店补货单跨组织下单 (起草 → 店长批 → 供货商确认 → 本地建档)')
  const fired = await shopHub.dispatch({
    from: 'tea-shop-ops' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    // /me would force payload[requested_by]=the member's own userId; we pass it directly.
    payload: { items: '珍珠 20\n红茶叶 10\n全脂牛奶 30', requested_by: 'staff-mei' },
    title: '门店补货申请',
  })
  if (fired.kind !== 'suspended') {
    throw new Error(`expected the run to SUSPEND at the outbound approval gate, got '${fired.kind}'`)
  }
  console.log('  工作流跑到 `place` 步 → 出站审批闸挂起 (补货单还没离开奶茶店)')
  // Read into a number local: guarding `supplier.confirmed.length` directly would
  // permanently narrow it to literal 0 (TS can't see the push inside dispatch),
  // breaking the `=== 1` assertions below.
  const crossedBeforeApproval: number = supplier.confirmed.length
  if (crossedBeforeApproval !== 0) throw new Error('nothing should have crossed to the supplier yet')

  const pendingA = await inbox.listPending(SHOP_MANAGER)
  if (pendingA.length !== 1 || pendingA[0]!.kind !== 'approval' || pendingA[0]!.parentKind !== 'workflow') {
    throw new Error(`expected 1 workflow-parented approval for the 店长, got ${pendingA.length}`)
  }
  const itemA = pendingA[0]!
  console.log(`  店长 /me 收件箱: 1 条待办 [${itemA.kind}] "${itemA.prompt}" (parent=${itemA.parentKind})`)

  const approveResult = await resolveApproval(shopHub, inbox, parked, itemA.itemId, { kind: 'approval', approved: true })
  const out = okOutput(approveResult, 'run after approval') as {
    confirmation?: { total?: number; etaDays?: number; allAvailable?: boolean; supplierNote?: string }
    record?: { po?: string; total?: number; lineCount?: number }
  }
  console.log('  店长批了 → 补货单跨到供货商 → 供货商定价 + 货期 → 回流给本地 `record` 步 → 工作流完成')
  console.log(`  供货商确认 (回流到本地步): ${out.confirmation?.supplierNote}`)
  console.log(`  奶茶店本地建档: 采购单 ${out.record?.po} (${out.record?.lineCount} 项, 合计 ¥${out.record?.total})`)

  // --- [B] reject — fail closed: the supplier is never contacted ----------------
  section('[B] 拒绝: 闸前拦下可疑大单, 供货商永不被联系 (fail-closed)')
  const fired2 = await shopHub.dispatch({
    from: 'tea-shop-ops' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    payload: { items: '珍珠 5000', requested_by: 'staff-???' },
    title: '可疑的超量补货',
  })
  if (fired2.kind !== 'suspended') throw new Error(`expected suspend, got '${fired2.kind}'`)
  const itemB = (await inbox.listPending(SHOP_MANAGER))[0]!
  console.log(`  又一条出站审批挂起: "${itemB.title ?? itemB.prompt}"`)
  const rejectResult = await resolveApproval(shopHub, inbox, parked, itemB.itemId, { kind: 'approval', approved: false })
  console.log(`  店长拒了 → 工作流 fail-closed (result.kind=${rejectResult.kind}); 供货商从未被联系`)

  // --- self-assertions (this demo doubles as a smoke test) ---------------------
  section('[verify]')
  assert(fired.kind === 'suspended', 'the cross-org `place` step suspended at the outbound approval gate')
  assert(itemA.parentKind === 'workflow', 'the approval item is parented to the workflow run (two-step resume)')
  assert(approveResult.kind === 'ok', 'the run resumed to completion after approval')
  assert(supplier.confirmed.length === 1, 'the supplier was contacted exactly once — only after approval')
  assert(out.confirmation?.total === 990, '供货商 priced it deterministically: 18×20 + 45×10 + 6×30 = ¥990')
  assert(out.confirmation?.allAvailable === true, 'every line was in stock at the supplier')
  assert(out.record?.total === 990, "the supplier's total flowed back into the local record step")
  assert(out.record?.po === 'PO-3L-990', 'the local record step filed a deterministic purchase order')
  assert(rejectResult.kind !== 'ok', 'a rejected outbound order fails closed')
  assert(supplier.confirmed.length === 1, 'reject NEVER crossed the boundary (supplier contact count unchanged)')
  assert((await inbox.listPending(SHOP_MANAGER)).length === 0, 'both inbox items are resolved, none left pending')
  console.log('  all checks passed.')

  await Promise.all([shopHub.stop(), supplierHub.stop()])
  rmSync(tmp, { recursive: true, force: true })

  section('done')
  console.log('  奶茶店的补货工作流编排供货商的能力, 跨组织走出站审批闸 — 链接是运行时的, 不在模板里.\n')
  process.exit(0)
}

/**
 * Resolve a parked outbound-approval item and resume — the two-step pattern from
 * HostInboxService.resolve (host/src/inbox-service.ts), hand-rolled so the
 * mechanism is visible. Identical to cafe-ops's `resolveHumanStep` and
 * cross-hub-workflow's `resolveApproval`: the child broker is the
 * OutboundApprovalGate, whose approval resume CROSSES the hub boundary instead of
 * returning the decision.
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
  // is where the order crosses to the supplier hub.
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
