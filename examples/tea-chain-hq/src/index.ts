/**
 * tea-chain-hq — runnable demo of a CROSS-ORG link between a 连锁奶茶店总部 (chain
 * HQ) and one of its 加盟门店 (franchise shops), built on Stream G cross-hub
 * orchestration. It is the MIRROR of tea-supply-link, one tier up:
 *
 *     连锁总部 (HQ) ──下发指令──▶ 奶茶店 (shop) ──下补货单──▶ 供货商 (supplier)
 *        [this demo: HQ → shop]          [tea-supply-link: shop → supplier]
 *
 * The shop sits in the MIDDLE of a three-tier chain: it RECEIVES directives from
 * HQ (HQ orchestrates down — this demo) and SENDS orders to the supplier (shop
 * orchestrates up — tea-supply-link). Both links are cross-org; in both, the LINK
 * itself is RUNTIME peer config, never in the template.
 *
 * The HQ (org A) runs a directive-rollout workflow. One step — `rollout` —
 * dispatches a capability (`shop.apply-directive`) that lives on the franchise
 * SHOP's hub (org B). The workflow YAML names NO peer; cross-org dispatch is just
 * capability dispatch where the capability happens to live on another hub. Whether
 * the directive may LEAVE HQ is decided by the runtime OUTBOUND APPROVAL GATE (the
 * shop peer flagged `requireApprovalOutbound`): the 区域经理 approves from their
 * inbox before a chain-wide directive (here a price change) crosses to the
 * franchisee.
 *
 * The teaching point (the user's "模版和框架是分离关系"): the cross-org LINK — the
 * peer, its outbound capability allowlist, its approval policy, and WHICH / HOW
 * MANY franchise shops — is RUNTIME peer config (installPeerLink here; admin
 * 「联邦」tab in production). It is NOT in the template and NOT in the workflow.
 * Note also this differs from cafe-ops (an in-store `human:` step): here the
 * approval is the cross-ORG outbound gate, a property of the link.
 *
 * What this demo proves end to end (deterministic, no API key):
 *
 *   [A] approve — HQ drafts the directive LOCALLY, then `rollout` dispatches to
 *       the shop's capability. The run SUSPENDS at the approval gate (nothing has
 *       crossed yet). The 区域经理 approves; the directive crosses to the shop; the
 *       shop applies it against its own menu (deterministically: ¥14 → ¥15, Δ+1)
 *       and acks; the next (LOCAL) `record` step files it; done.
 *   [B] reject — an aggressive price hike; the 区域经理 rejects. The shop is NEVER
 *       contacted, the local record step never runs, the run fails closed.
 *
 * Host-free on purpose (same precedent as tea-supply-link / cafe-ops): core +
 * workflow + inbox + a ~40-line inline mirror of the host's
 * ApprovalGatedParticipant (host/src/outbound-approval.ts) and HostInboxService
 * two-step resume (host/src/inbox-service.ts), so the mechanism is visible.
 *
 * Run:  pnpm demo:tea-chain-hq
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

import { HqDeskStandin, ShopStandin } from './standins.js'

const WORKFLOWS_DIR = fileURLToPath(new URL('../workflows', import.meta.url))
const REGION_MANAGER = 'region-manager' as ParticipantId // approves outbound directives from their /me inbox
const SHOP_CAP = 'shop.apply-directive' // the one capability HQ reaches across the boundary

/** In-memory stand-in for identity.suspended_tasks — what a parked task needs to resume. */
interface ParkedRow {
  agentId: ParticipantId
  state: unknown
  taskJson: string
}

/**
 * Minimal mirror of host/src/outbound-approval.ts. Wraps the outbound peer
 * wrapper (the RemoteHubViaLink installPeerLink hands to `wrapOutbound`) so an
 * outbound directive PARKS in the 区域经理's inbox; on approval its `onResume`
 * FORWARDS to the wrapped remote (the real cross-org send), on rejection it fails
 * closed. id/capabilities delegate to the inner so the hub registers the gate
 * under the wrapper id and capability dispatch still selects it for the shop's caps.
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
      prompt: `批准把这条指令下发到加盟门店 '${this.peerLabel}'?`,
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
  console.log('\n=== Gotong case: tea-chain-hq — 连锁总部 → 加盟门店 (跨组织指令下发) ===\n')

  const tmp = mkdtempSync(join(tmpdir(), 'gotong-tea-chain-hq-'))
  const parked = new Map<string, ParkedRow>()
  const inbox = new FileInboxStore(tmp)
  inbox.ensureDirs()

  // --- 加盟门店 hub (org B, executor): owns shop.apply-directive ----------------
  const shopHub = new Hub({ storage: new InMemoryStorage() })
  await shopHub.start()
  const shop = new ShopStandin()
  shopHub.register(shop)

  // --- 连锁总部 hub (org A, orchestrator): runs the workflow, parks outbound ------
  // A real host parks suspended tasks in identity.suspended_tasks; the demo
  // records them in `parked` and wakes them by hand (resolveApproval below).
  const hqHub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, by, s) => {
      parked.set(task.id, { agentId: by, state: s.state, taskJson: JSON.stringify(task) })
    },
  })
  await hqHub.start()
  const hqDesk = new HqDeskStandin()
  hqHub.register(hqDesk) // local draft-directive + record-rollout worker

  // --- the cross-org LINK — RUNTIME peer config, NOT in any template ------------
  // The shop wrapper ADVERTISES [shop.apply-directive] (so the `rollout` step can
  // route to it) and the SAME allowlist AUTHORIZES the cross (G-M1: advertise =
  // authorize). requireApprovalOutbound is modelled by wrapping the wrapper in the
  // OutboundApprovalGate. WHICH / HOW MANY franchise shops is runtime too — this
  // demo links one; multi-shop rollout just links more peers, the workflow is unchanged.
  section('[0] 连接两个 hub (运行时 peer 链接, 不在模板里) + 载入工作流')
  const { a, b } = createInprocHubLinkPair({ aPeerId: 'shop-org', bPeerId: 'hq-org' })
  installPeerLink({
    hub: hqHub,
    link: a,
    selfHubId: 'hq-org',
    remoteCapabilities: [SHOP_CAP], // G-M1 — advertise so the `rollout` step can route here
    outboundCaps: [SHOP_CAP], // P4-M1 — the same allowlist authorizes the cross
    wrapOutbound: (inner) => new OutboundApprovalGate(inner, inbox, REGION_MANAGER, '加盟门店 #001'),
  })
  installPeerLink({ hub: shopHub, link: b, selfHubId: 'shop-org' })
  console.log(`  hq-org → shop-org linked; 门店通告能力 [${SHOP_CAP}], 出站需 ${String(REGION_MANAGER)} 审批`)

  // Load the directive-rollout workflow — parsed by the REAL parseWorkflow (the
  // same one the template importer runs), so a broken workflow YAML fails loudly.
  const def = parseWorkflow(readFileSync(join(WORKFLOWS_DIR, 'chain-directive-rollout.yaml'), 'utf8'))
  hqHub.register(new WorkflowRunner({ definition: def, hub: hqHub }))
  console.log(`  ${def.id}  (trigger: ${def.trigger.capability}, ${def.steps.length} step(s): ${def.steps.map((s) => s.id).join(' → ')})`)

  // --- [A] approve — the headline cross-org directive rollout ------------------
  section('[A] 批准: 总部调价指令跨组织下发 (起草 → 区域经理批 → 门店执行 → 本地建档)')
  const fired = await hqHub.dispatch({
    from: 'hq-ops' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    // /me would force payload[initiated_by]=the operator's own userId; we pass it directly.
    payload: { sku: '珍珠奶茶', new_price: 15, effective: '2026-06-10', note: '季度统一调价', initiated_by: 'hq-ops-li' },
    title: '门店调价下发',
  })
  if (fired.kind !== 'suspended') {
    throw new Error(`expected the run to SUSPEND at the outbound approval gate, got '${fired.kind}'`)
  }
  console.log('  工作流跑到 `rollout` 步 → 出站审批闸挂起 (指令还没离开总部)')
  // Read into a number local: guarding `shop.applied.length` directly would
  // permanently narrow it to literal 0 (TS can't see the push inside dispatch),
  // breaking the `=== 1` assertions below.
  const crossedBeforeApproval: number = shop.applied.length
  if (crossedBeforeApproval !== 0) throw new Error('nothing should have crossed to the shop yet')

  const pendingA = await inbox.listPending(REGION_MANAGER)
  if (pendingA.length !== 1 || pendingA[0]!.kind !== 'approval' || pendingA[0]!.parentKind !== 'workflow') {
    throw new Error(`expected 1 workflow-parented approval for the 区域经理, got ${pendingA.length}`)
  }
  const itemA = pendingA[0]!
  console.log(`  区域经理 /me 收件箱: 1 条待办 [${itemA.kind}] "${itemA.prompt}" (parent=${itemA.parentKind})`)

  const approveResult = await resolveApproval(hqHub, inbox, parked, itemA.itemId, { kind: 'approval', approved: true })
  const out = okOutput(approveResult, 'run after approval') as {
    ack?: { applied?: boolean; oldPrice?: number; newPrice?: number; delta?: number; shopNote?: string }
    record?: { directiveId?: string; rolledOut?: boolean; delta?: number; shopId?: string }
  }
  console.log('  区域经理批了 → 指令跨到门店 → 门店按本店菜单应用调价 → 回流给本地 `record` 步 → 工作流完成')
  console.log(`  门店回执 (回流到本地步): ${out.ack?.shopNote}`)
  console.log(`  总部本地建档: ${out.record?.directiveId} (门店 ${out.record?.shopId}, Δ¥${out.record?.delta}, rolledOut=${out.record?.rolledOut})`)

  // --- [B] reject — fail closed: the shop is never contacted --------------------
  section('[B] 拒绝: 闸前拦下激进涨价, 门店永不被联系 (fail-closed)')
  const fired2 = await hqHub.dispatch({
    from: 'hq-ops' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    payload: { sku: '珍珠奶茶', new_price: 30, effective: '2026-06-10', note: '激进翻倍涨价', initiated_by: 'hq-ops-???' },
    title: '可疑的激进调价',
  })
  if (fired2.kind !== 'suspended') throw new Error(`expected suspend, got '${fired2.kind}'`)
  const itemB = (await inbox.listPending(REGION_MANAGER))[0]!
  console.log(`  又一条出站审批挂起: "${itemB.title ?? itemB.prompt}"`)
  const rejectResult = await resolveApproval(hqHub, inbox, parked, itemB.itemId, { kind: 'approval', approved: false })
  console.log(`  区域经理拒了 → 工作流 fail-closed (result.kind=${rejectResult.kind}); 门店从未被联系`)

  // --- self-assertions (this demo doubles as a smoke test) ---------------------
  section('[verify]')
  assert(fired.kind === 'suspended', 'the cross-org `rollout` step suspended at the outbound approval gate')
  assert(itemA.parentKind === 'workflow', 'the approval item is parented to the workflow run (two-step resume)')
  assert(approveResult.kind === 'ok', 'the run resumed to completion after approval')
  assert(shop.applied.length === 1, 'the shop was contacted exactly once — only after approval')
  assert(out.ack?.applied === true, 'the franchise shop applied the directive against its own menu')
  assert(out.ack?.delta === 1, '门店 computed the delta deterministically: ¥14 → ¥15 = Δ+1')
  assert(out.record?.rolledOut === true, "the shop's ack flowed back into the local record step")
  assert(out.record?.directiveId === 'DIR-珍珠奶茶-15', 'the local record step filed a deterministic directive id')
  assert(rejectResult.kind !== 'ok', 'a rejected outbound directive fails closed')
  assert(shop.applied.length === 1, 'reject NEVER crossed the boundary (shop contact count unchanged)')
  assert((await inbox.listPending(REGION_MANAGER)).length === 0, 'both inbox items are resolved, none left pending')
  console.log('  all checks passed.')

  await Promise.all([hqHub.stop(), shopHub.stop()])
  rmSync(tmp, { recursive: true, force: true })

  section('done')
  console.log('  连锁总部的下发工作流编排加盟门店的能力, 跨组织走出站审批闸 — 链接是运行时的, 不在模板里.\n')
  process.exit(0)
}

/**
 * Resolve a parked outbound-approval item and resume — the two-step pattern from
 * HostInboxService.resolve (host/src/inbox-service.ts), hand-rolled so the
 * mechanism is visible. Identical to tea-supply-link's `resolveApproval`: the
 * child broker is the OutboundApprovalGate, whose approval resume CROSSES the hub
 * boundary instead of returning the decision.
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
  // is where the directive crosses to the shop hub.
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
