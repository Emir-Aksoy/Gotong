/**
 * P1-M1 — cross-hub workflow orchestration over a REAL WebSocket (E2E).
 *
 * `cross-hub-workflow-e2e.test.ts` proves the Stream G-M2 narrative — a workflow
 * step → outbound approval gate → cross-hub → two-step resumeParent — but over an
 * INPROC `createInprocHubLinkPair`. Every OTHER federation invariant (isolation,
 * data-class, inbound quota, KB allowlist) already has a real-ws sibling
 * (`peer-isolation-ws-e2e.test.ts`, Route B P1-M9). The workflow-ORCHESTRATION
 * layer was the one combination still validated inproc-only — the marquee
 * cross-org story had never crossed a real socket.
 *
 * This closes that gap: the SAME three scenarios, but hub A dials hub B over the
 * real `connectHubLink` / `acceptHubLinks` transport. So in the approve path the
 * task leaves hub A as a real `MESH_TASK` frame, lands on hub B's agent, and the
 * result returns as a real frame — all BEFORE the parent workflow resumes. The
 * claim under test is that the orchestration survives the wire, not just the
 * in-memory shortcut.
 *
 * Real all the way down: two real Hubs, a real `ws` WebSocketServer, the real
 * `ApprovalGatedParticipant` over a real `FileInboxStore`, a production-shaped
 * `suspendNotifier` persisting parks to a real `IdentityStore` (tmp sqlite), the
 * real `WorkflowController` → versioning → file revision/lifecycle stores, the
 * real `HostInboxService` doing the two-step resume.
 *
 * Auth is orthogonal and already proven over ws elsewhere (`peer-registry` dials
 * with `bearerAuth`; the M9 isolation gate dials bearer-free). This test dials
 * bearer-free too, to keep the workflow-orchestration dimension in focus — the
 * frames are real either way.
 *
 * No new workflow schema: the step is a plain `dispatch` whose capability happens
 * to resolve to a gated peer wrapper. Cross-hub orchestration is just capability
 * dispatch where the capability lives on a peer.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import {
  AgentParticipant,
  Hub,
  InMemoryStorage,
  installPeerLink,
  type HubLink,
  type Task,
  type TaskResult,
} from '@aipehub/core'
import { acceptHubLinks, connectHubLink } from '@aipehub/transport-ws'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'
import { FileInboxStore, NEVER_RESUME_AT } from '@aipehub/inbox'
import { workflowParticipantId } from '@aipehub/workflow'

import { WorkflowController } from '../src/workflow-controller.js'
import { HostInboxService } from '../src/inbox-service.js'
import { ApprovalGatedParticipant } from '../src/outbound-approval.js'

const APPROVER = 'owner-user'
const PEER_CAP = 'contract-review'
// hub A dials hub B with this as `expectedPeerId`; installPeerLink names the
// outbound wrapper after `link.peerId` (peer-link-install.ts), so the wrapper id
// on hub A — what `executedBy` / `peerCapabilities` see — is exactly 'orgB'.
const PEER_ID = 'orgB'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** Let post-handshake / round-trip frames settle before asserting. */
const drain = async () => {
  for (let i = 0; i < 12; i++) await delay(5)
}

const WORKFLOW_YAML = `
schema: aipehub.workflow/v1
workflow:
  id: cross-hub-flow
  name: cross-hub orchestration
  trigger: { capability: cx:start }
  steps:
    - id: review
      dispatch:
        strategy: { kind: capability, capabilities: [${PEER_CAP}] }
        payload: { doc: $trigger.payload.doc }
`

/** Receiver-side worker on hub B that records every task it's handed. */
class ProviderAgent extends AgentParticipant {
  readonly captured: Task[] = []
  protected async handleTask(task: Task): Promise<unknown> {
    this.captured.push(task)
    return { reviewed: true, doc: (task.payload as { doc?: unknown }).doc }
  }
}

describe('P1-M1 — cross-hub workflow orchestration over a real WebSocket', () => {
  let tmp: string
  let identity: IdentityStore
  let hubA: Hub // orchestrator (runs the workflow, gated) — dials out
  let hubB: Hub // provider (owns the capability) — accepts the inbound ws link
  let wss: WebSocketServer // hub B's real listening socket
  let hubBUrl: string
  let inboxStore: FileInboxStore
  let controller: WorkflowController
  let service: HostInboxService
  let provider: ProviderAgent
  // hub A's local link to hub B, and hub B's accepted links — tracked for cleanup.
  const homeLinks: HubLink[] = []
  const hubBInbound: HubLink[] = []

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-cross-hub-wf-ws-e2e-'))
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })

    // Orchestrator hub persists parks the production way (→ suspended_tasks).
    hubA = new Hub({
      storage: new InMemoryStorage(),
      suspendNotifier: (task, by, s) => {
        identity.persistSuspendedTask({
          taskId: task.id,
          agentId: by,
          hubId: 'local',
          originUserId: task.origin?.userId ?? null,
          resumeAt: s.resumeAt,
          state: s.state,
          taskJson: JSON.stringify(task),
        })
      },
    })
    hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    provider = new ProviderAgent({ id: 'b-reviewer', capabilities: [PEER_CAP] })
    hubB.register(provider)

    inboxStore = new FileInboxStore(tmp)
    inboxStore.ensureDirs()

    // hub B's real ws server. Each accepted link is the home→B edge; install the
    // plain inbound handler so tasks the peer sends re-dispatch into hub B (which
    // then routes PEER_CAP to ProviderAgent). No gate / caps on the receiving
    // side — this test's contract lives on hub A's outbound wrapper.
    wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const addr = wss.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    hubBUrl = `ws://127.0.0.1:${port}`
    acceptHubLinks({
      server: wss,
      selfId: PEER_ID,
      onLink: (link) => {
        hubBInbound.push(link)
        installPeerLink({ hub: hubB, link, selfHubId: 'orgB' })
      },
    })

    controller = new WorkflowController({
      hub: hubA,
      definitionsDir: join(tmp, 'workflows', 'definitions'),
      spaceRoot: tmp,
      // Mirror production: the host builds this off-hub view from hub A's
      // connected peers + the capabilities each wrapper advertises. Here that's
      // the PEER_ID wrapper advertising PEER_CAP once installCrossHubPeer wires
      // the link. Resolved LAZILY so it is honest before/after install, and so
      // readRun can confirm a step's persisted executedBy resolved to this peer.
      peerCapabilities: {
        peerCapabilities: () => {
          const wrapper = hubA.participants().find((p) => p.id === PEER_ID)
          return wrapper
            ? [{ peer: PEER_ID, label: 'Org B', capabilities: [...wrapper.capabilities], kind: 'peer' as const }]
            : []
        },
      },
    })
    service = new HostInboxService({ hub: hubA, store: inboxStore, identity })
  })

  afterEach(async () => {
    for (const link of homeLinks) await link.close().catch(() => {})
    homeLinks.length = 0
    for (const link of hubBInbound) await link.close().catch(() => {})
    hubBInbound.length = 0
    for (const c of wss.clients) {
      try {
        c.terminate()
      } catch {
        /* swallow */
      }
    }
    await new Promise<void>((r) => wss.close(() => r()))
    await Promise.all([hubA.stop(), hubB.stop()])
    identity.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  /**
   * Dial orchestrator hub A → provider hub B over REAL ws, then install hub A's
   * outbound edge exactly the way peer-registry does: outboundCaps both ADVERTISE
   * (G-M1 remoteCapabilities) and AUTHORIZE (P4-M1 outboundCaps). `approval`
   * toggles the Phase 18 B-M3 gate. hub B's inbound side is wired in `onLink`.
   */
  async function installCrossHubPeer(approval: boolean): Promise<void> {
    const linkAToB = await connectHubLink({ url: hubBUrl, selfId: 'orgA', expectedPeerId: PEER_ID })
    homeLinks.push(linkAToB)
    // onLink fires after the IN-side handshake resolves (a Promise.race tick).
    for (let i = 0; i < 40 && hubBInbound.length === 0; i++) await delay(10)
    expect(hubBInbound.length).toBeGreaterThan(0)

    installPeerLink({
      hub: hubA,
      link: linkAToB,
      selfHubId: 'orgA',
      remoteCapabilities: [PEER_CAP], // G-M1 — advertise so the step can route here
      outboundCaps: [PEER_CAP], // P4-M1 — the same allowlist authorizes the cross
      ...(approval
        ? {
            wrapOutbound: (inner) =>
              new ApprovalGatedParticipant({
                inner,
                store: inboxStore,
                approver: APPROVER,
                peerLabel: 'Org B',
                now: () => 100,
              }),
          }
        : {}),
    })
    await drain()
  }

  async function fireTrigger(doc: string): Promise<TaskResult> {
    return hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['cx:start'] },
      payload: { doc },
    })
  }

  it('approve → the step crosses to the peer over ws and the run completes with the cross-hub result', async () => {
    await installCrossHubPeer(true)
    const sum = await controller.importFromText(WORKFLOW_YAML)
    expect(sum.state).toBe('published')

    // Fire the trigger → run starts, dispatches the cross-hub step → gate parks
    // it on hub A, BEFORE anything touches the wire.
    const fired = await fireTrigger('NDA.txt')
    expect(fired.kind).toBe('suspended')
    expect(provider.captured).toHaveLength(0) // nothing crossed the socket yet

    // An approval item exists for the owner, with a WORKFLOW parent.
    const pending = await inboxStore.listPending(APPROVER)
    expect(pending).toHaveLength(1)
    const item = pending[0]!
    expect(item.kind).toBe('approval')
    expect(item.parentKind).toBe('workflow')
    expect(item.prompt).toContain('Org B')
    expect(item.prompt).toContain(PEER_CAP)

    // Both the gate child and the parent workflow run are parked at the
    // never-resume sentinel — the sweep is blind to them.
    const childRow = identity.getSuspendedTask(item.itemId)
    const parentRow = identity.getSuspendedTask(item.parent!.taskId)
    expect(childRow?.resumeAt).toBe(NEVER_RESUME_AT)
    expect(parentRow?.agentId).toBe(workflowParticipantId('cross-hub-flow'))
    expect(parentRow?.resumeAt).toBe(NEVER_RESUME_AT)

    // The on-disk run is running with the cross-hub step suspended, and it
    // already records WHO it went to — the peer wrapper id resolves to a
    // cross-hub confirmation the moment it parks (Stream G day-3/day-4 contract).
    const runs = await controller.listRuns({ workflowId: 'cross-hub-flow' })
    const parked = await controller.readRun(runs[0]!.runId)
    expect(parked?.status).toBe('running')
    const parkedReview = parked?.steps.find((s) => s.stepId === 'review')
    expect(parkedReview?.status).toBe('suspended')
    expect(parkedReview?.executedBy).toBe(PEER_ID)
    expect(parkedReview?.crossHub).toEqual({ peer: PEER_ID, peerLabel: 'Org B', kind: 'peer' })

    // Approve as the owner → two-step resume: the gate child crosses the REAL ws
    // (real MESH_TASK frame out, real result frame back), then the parent
    // workflow re-reads the child's result and continues.
    await service.resolve({
      itemId: item.itemId,
      userId: APPROVER,
      decision: { kind: 'approval', approved: true },
    })
    await drain() // let the round-trip + run-file write settle

    // The real cross-org send finally happened over the wire, payload intact.
    expect(provider.captured).toHaveLength(1)
    expect(provider.captured[0]!.payload).toEqual({ doc: 'NDA.txt' })

    // The run completed and the cross-hub result — carried back over ws — is the
    // review step's output.
    const done = await controller.readRun(runs[0]!.runId)
    expect(done?.status).toBe('done')
    const review = done?.steps.find((s) => s.stepId === 'review')
    expect(review?.output).toEqual({ reviewed: true, doc: 'NDA.txt' })
    expect(review?.executedBy).toBe(PEER_ID)
    expect(review?.crossHub).toEqual({ peer: PEER_ID, peerLabel: 'Org B', kind: 'peer' })

    // Parked rows cleaned up.
    expect(identity.getSuspendedTask(item.itemId)).toBeNull()
    expect(identity.getSuspendedTask(item.parent!.taskId)).toBeNull()
  })

  it('reject → the peer is NEVER called over ws and the run fails', async () => {
    await installCrossHubPeer(true)
    await controller.importFromText(WORKFLOW_YAML)
    await fireTrigger('NDA.txt')
    const item = (await inboxStore.listPending(APPROVER))[0]!

    await service.resolve({
      itemId: item.itemId,
      userId: APPROVER,
      decision: { kind: 'approval', approved: false },
    })
    await drain()

    // Nothing ever crossed the socket.
    expect(provider.captured).toHaveLength(0)
    // The denied step fails the run (default onFailure = halt).
    const runs = await controller.listRuns({ workflowId: 'cross-hub-flow' })
    const run = await controller.readRun(runs[0]!.runId)
    expect(run?.status).toBe('failed')
    const review = run?.steps.find((s) => s.stepId === 'review')
    expect(review?.status).toBe('failed')
    expect(review?.error).toMatch(/outbound_approval_denied/)
    expect(identity.getSuspendedTask(item.itemId)).toBeNull()
    expect(identity.getSuspendedTask(item.parent!.taskId)).toBeNull()
  })

  it('no approval required → the step crosses ws immediately and the run completes', async () => {
    await installCrossHubPeer(false)
    await controller.importFromText(WORKFLOW_YAML)

    // No gate → the cross-hub step resolves over the wire synchronously to the
    // run; the run never parks.
    const fired = await fireTrigger('memo.txt')
    expect(fired.kind).toBe('ok')

    // No approval item — orchestration without a human in the loop.
    expect(await inboxStore.listPending(APPROVER)).toHaveLength(0)
    // The step crossed the socket exactly once with the workflow payload.
    expect(provider.captured).toHaveLength(1)
    expect(provider.captured[0]!.payload).toEqual({ doc: 'memo.txt' })

    const runs = await controller.listRuns({ workflowId: 'cross-hub-flow' })
    const run = await controller.readRun(runs[0]!.runId)
    expect(run?.status).toBe('done')
    const review = run?.steps.find((s) => s.stepId === 'review')
    expect(review?.output).toEqual({ reviewed: true, doc: 'memo.txt' })
    expect(review?.executedBy).toBe(PEER_ID)
    expect(review?.crossHub).toEqual({ peer: PEER_ID, peerLabel: 'Org B', kind: 'peer' })
  })
})
