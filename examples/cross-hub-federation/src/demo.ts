/**
 * cross-hub-federation — the cross-hub workflow story over a REAL WebSocket.
 *
 * `cross-hub-workflow` proves the orchestration (北极星 第 2 层「跨组织协作」):
 * a workflow on org A drives a step on org B behind the outbound approval gate.
 * But it links the two hubs with an INPROC HubLink pair — same process, no socket,
 * no auth. That's the right call for showing the MECHANISM, but it dodges the part
 * a real deployment forces: the two hubs are different machines, the link is a
 * network socket, and the only thing standing between org B and any stranger is a
 * shared secret on the wire.
 *
 * This demo is the transport twin. SAME workflow, SAME outbound approval gate,
 * SAME two-step resume — but org B runs a real `ws` server and org A dials it with
 * `connectHubLink`, and BOTH sides present + verify a bearer token (`bearerAuth`).
 * The approved task crosses an actual socket; the rejected one never opens it; and
 * a peer that shows up with the WRONG token is turned away at the handshake. In
 * production the token is minted by `gotong mint-peer-token` and handed to the
 * other operator out-of-band (see docs/zh/FEDERATION-RUNBOOK.md).
 *
 * What this demo proves end to end (deterministic, no API key):
 *
 *   [A] approve — org A's workflow dispatches `review` to org B's counsel ACROSS
 *       THE WIRE. The run SUSPENDS at the approval gate (nothing has crossed yet —
 *       no frame has gone out). The owner approves from their inbox; the task
 *       finally travels the socket to org B; org B's verdict flows back over the
 *       link as the step output; the next (LOCAL) `archive` step files it; the run
 *       completes.
 *   [B] reject — same setup; the owner rejects. Org B is NEVER contacted, no frame
 *       crosses, the local archive step never runs, the run fails closed.
 *   [C] wrong token — a third hub dials org B presenting the WRONG bearer token.
 *       org B rejects it at the handshake; the dial throws and no inbound link is
 *       installed. The auth is real, not decorative.
 *
 * Host-free on purpose (same precedent as cross-hub-workflow / cafe-ops): core +
 * workflow + inbox + transport-ws + a ~40-line inline mirror of the host's
 * ApprovalGatedParticipant (host/src/outbound-approval.ts) and HostInboxService
 * two-step resume (host/src/inbox-service.ts). In production those are the real
 * host components, driven by installPeerLink's `wrapOutbound` hook + a /me inbox
 * click, over the same `connectHubLink`/`acceptHubLinks` transport used here.
 *
 * Run:  pnpm demo:cross-hub-federation
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const WORKFLOWS_DIR = fileURLToPath(new URL('../workflows', import.meta.url))
const OWNER = 'org-a-owner' as ParticipantId // approves outbound sends from their /me inbox
const PEER_CAP = 'legal.contract-review'

// In production this is minted by `gotong mint-peer-token` (256-bit base64url)
// and handed to org B's operator out-of-band; org B configures it on its peer
// record so its `acceptHubLinks` resolver verifies it. A fixed constant here keeps
// the demo deterministic — NEVER reuse a literal token like this for real.
const PEER_TOKEN = 'demo-shared-peer-bearer-token-do-not-reuse'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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
 * to the wrapped remote — which, over a real ws link, is when the first frame
 * actually crosses the socket — on rejection it fails closed. id/capabilities
 * delegate to the inner so the hub registers the gate under the wrapper id (==
 * link.peerId == 'org-b') and capability dispatch still selects it for the peer's
 * caps.
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

    // A person, not a timer, wakes this — and no frame has crossed the socket yet.
    throw new SuspendTaskError({ resumeAt: NEVER_RESUME_AT, state: { inboxItemId: item.itemId } })
  }

  async onResume(task: Task, state: unknown): Promise<TaskResult> {
    const answer = (state as { answer?: { kind?: string; approved?: boolean } }).answer
    if (answer?.kind === 'approval' && typeof answer.approved === 'boolean') {
      // Approved → the real cross-org send finally fires across the ws link.
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
  console.log('\n=== Gotong case: cross-hub-federation — 两个真 hub 过真 WebSocket 跨组织协作 ===\n')

  const tmp = mkdtempSync(join(tmpdir(), 'gotong-cross-hub-fed-'))
  const parked = new Map<string, ParkedRow>()
  const inbox = new FileInboxStore(tmp)
  inbox.ensureDirs()

  // --- org B (provider hub): owns contract-review + runs a real ws server ------
  const hubB = new Hub({ storage: new InMemoryStorage() })
  await hubB.start()
  const counsel = new CounselAgent()
  hubB.register(counsel)

  // Every accepted inbound link is gated by the bearer token (fail-closed against
  // an unconfigured or wrong-token peer) and installs hub B's plain inbound side.
  const hubBInbound: HubLink[] = []
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const addr = wss.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const hubBUrl = `ws://127.0.0.1:${port}`
  const stopAccepting = acceptHubLinks({
    server: wss,
    selfId: 'org-b',
    auth: bearerAuth({ token: PEER_TOKEN }),
    onLink: (link) => {
      hubBInbound.push(link)
      installPeerLink({ hub: hubB, link, selfHubId: 'org-b' })
    },
  })

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

  // --- dial org A → org B over a REAL ws link, presenting the bearer token ------
  // Both sides carry the same token: org A presents it, org B verifies it. The
  // peer wrapper ADVERTISES [legal.contract-review] (so the workflow step can route
  // to it) and the SAME allowlist AUTHORIZES the cross. requireApprovalOutbound is
  // modelled by wrapping the wrapper in the OutboundApprovalGate.
  section('[0] 两 hub 过真 WebSocket 握手 (bearerAuth, 双方 token 匹配) + 载入工作流')
  const linkAToB = await connectHubLink({
    url: hubBUrl,
    selfId: 'org-a',
    expectedPeerId: 'org-b',
    auth: bearerAuth({ token: PEER_TOKEN }),
  })
  for (let i = 0; i < 50 && hubBInbound.length === 0; i++) await delay(10)
  if (hubBInbound.length === 0) throw new Error('hub B never accepted the inbound link')
  installPeerLink({
    hub: hubA,
    link: linkAToB,
    selfHubId: 'org-a',
    remoteCapabilities: [PEER_CAP], // G-M1 — advertise so the step can route here
    outboundCaps: [PEER_CAP], // P4-M1 — the same allowlist authorizes the cross
    wrapOutbound: (inner) => new OutboundApprovalGate(inner, inbox, OWNER, 'Org B 法务'),
  })
  console.log(`  org-a ⇄ org-b 握手成功 over ${hubBUrl} (双方 bearer token 匹配)`)
  console.log(`  对端通告能力 [${PEER_CAP}], 出站需 ${String(OWNER)} 审批`)

  // Load the cross-hub workflow — parsed by the REAL parseWorkflow (the same one
  // the template importer runs), so a broken workflow YAML fails the demo loudly.
  const def = parseWorkflow(readFileSync(join(WORKFLOWS_DIR, 'contract-review.yaml'), 'utf8'))
  hubA.register(new WorkflowRunner({ definition: def, hub: hubA }))
  console.log(`  ${def.id}  (trigger: ${def.trigger.capability}, ${def.steps.length} step(s): ${def.steps.map((s) => s.id).join(' → ')})`)

  // --- [A] approve — the headline cross-hub orchestration OVER THE WIRE ---------
  section('[A] 批准: 工作流跨 hub 编排过真 socket (org A 工作流 → org B 法务 → 回流 → org A 归档)')
  const fired = await hubA.dispatch({
    from: 'a-legal-ops' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    payload: { doc: 'NDA-v3.pdf' },
    title: '跨组织合同审阅',
  })
  if (fired.kind !== 'suspended') {
    throw new Error(`expected the run to SUSPEND at the outbound approval gate, got '${fired.kind}'`)
  }
  console.log('  工作流跑到 `review` 步 → 出站审批闸挂起 (任务还没离开 org A, 没有任何帧上线)')
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
  console.log('  owner 批了 → 任务跨真 socket 到 org B → 法务返回裁决 → 回流给本地 `archive` 步 → 工作流完成')
  console.log(`  org B 法务裁决 (经 ws 回流到本地步): verdict=${reviewOut.verdict}`)
  console.log(`  org A 本地归档: doc=${reviewOut.archived}`)

  // --- [B] reject — fail closed: no frame ever crosses the socket ---------------
  section('[B] 拒绝: 闸前拦下, org B 永不被联系, socket 上零帧 (fail-closed)')
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

  // --- [C] wrong token — the auth is real, not decorative ----------------------
  section('[C] 错 token 被拒: 冒名 hub 拨号, org B 握手期拒掉 (auth 是真的)')
  let imposterRejected = false
  const inboundBefore = hubBInbound.length
  try {
    // A third hub shows up with the WRONG bearer token. org B's accept-side
    // resolver rejects it and closes the socket WITHOUT a failure frame
    // (anti-enumeration): the dialer only observes the close, never the reason.
    await connectHubLink({
      url: hubBUrl,
      selfId: 'org-imposter',
      expectedPeerId: 'org-b',
      auth: bearerAuth({ token: 'WRONG-token' }),
      handshakeTimeoutMs: 1500,
    })
  } catch (err) {
    imposterRejected = true
    console.log(`  冒名 hub 拨号被拒 (token 不符, 看到的只是链接被关): ${(err as Error).message}`)
  }
  await delay(30) // let any server-side teardown settle before counting inbound links

  // --- self-assertions (this demo doubles as a smoke test) ---------------------
  section('[verify]')
  assert(fired.kind === 'suspended', 'cross-hub step suspended at the outbound approval gate (no frame sent)')
  assert(itemA.parentKind === 'workflow', 'the approval item is parented to the workflow run (two-step resume)')
  assert(approveResult.kind === 'ok', 'the run resumed to completion after approval')
  assert(counsel.seen.length === 1, 'org B was contacted exactly once over the wire — only after approval')
  assert(
    (counsel.seen[0]!.payload as { doc?: string }).doc === 'NDA-v3.pdf',
    'the workflow payload reached org B intact across the real socket',
  )
  assert(reviewOut.verdict === 'changes-requested', "org B's verdict flowed back over ws into the local archive step")
  assert(registry.seen.length === 1, 'the local archive step consumed the cross-hub result')
  assert(rejectResult.kind !== 'ok', 'a rejected outbound run fails closed')
  assert(counsel.seen.length === 1, 'reject NEVER crossed the socket (org B contact count unchanged)')
  assert(registry.seen.length === 1, 'reject halted before the local archive step (archive count unchanged)')
  assert((await inbox.listPending(OWNER)).length === 0, 'both inbox items are resolved, none left pending')
  assert(imposterRejected, 'a peer presenting the WRONG bearer token is rejected at the ws handshake (auth is real)')
  assert(hubBInbound.length === inboundBefore, 'the rejected imposter never installed an inbound link on org B')
  console.log('  all checks passed.')

  // --- cleanup -----------------------------------------------------------------
  stopAccepting()
  await linkAToB.close().catch(() => {})
  for (const link of hubBInbound) await link.close().catch(() => {})
  for (const c of wss.clients) {
    try {
      c.terminate()
    } catch {
      /* swallow */
    }
  }
  await new Promise<void>((r) => wss.close(() => r()))
  await Promise.all([hubA.stop(), hubB.stop()])
  rmSync(tmp, { recursive: true, force: true })

  section('done')
  console.log('  跨组织联邦跑在真 WebSocket 上: 工作流编排跨 socket, 出站审批闸把关, 错 token 进不来.')
  console.log('  两机操作员落地见 docs/zh/FEDERATION-RUNBOOK.md.\n')
  process.exit(0)
}

/**
 * Resolve a parked outbound-approval item and resume — the two-step pattern from
 * HostInboxService.resolve (host/src/inbox-service.ts), hand-rolled so the
 * mechanism is visible. Identical to cross-hub-workflow's `resolveApproval`; the
 * only difference is invisible here: the child gate's approval resume now CROSSES
 * A REAL SOCKET (inner.onTask sends a MESH_TASK frame and awaits the response)
 * instead of an inproc call.
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
  // is where the task crosses the ws link to the peer hub.
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
