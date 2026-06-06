/**
 * v5 Stream G-M2 — cross-hub workflow orchestration acceptance gate (E2E).
 *
 * THE test the stream exists to pass: a real workflow on hub A dispatches a
 * step to a CAPABILITY that lives on a peer hub B, gated by the Phase 18
 * outbound approval gate. The run parks on the approval, a person approves it
 * from their inbox, the task finally crosses the org boundary, and the peer's
 * result flows back as that step's output and completes the run.
 *
 * This is the combination no prior test covered:
 *   - outbound-approval-e2e.test.ts proved the gate for a DIRECT admin dispatch
 *     (parentKind='none') — never a workflow parent.
 *   - inbox-e2e.test.ts proved a workflow `human:` step's two-step resume — but
 *     the broker returns the decision, it does not cross a hub boundary.
 *   G-M2 is both at once: a workflow step → gated peer → cross-hub → two-step
 *   resumeParent. It only works because G-M1 makes the peer wrapper advertise
 *   the capability so the step can route to it in the first place.
 *
 * Everything is real:
 *   - two real Hubs over an inproc HubLink pair,
 *   - hub A installs the peer wrapper via installPeerLink's `wrapOutbound` hook
 *     = the real ApprovalGatedParticipant over a real FileInboxStore,
 *   - a production-shaped suspendNotifier persisting parks to a real
 *     IdentityStore (tmp sqlite),
 *   - the real WorkflowController → versioning → file revision/lifecycle stores,
 *   - the real HostInboxService doing the two-step resume.
 *
 * No new workflow schema: the step is a plain `dispatch` whose capability
 * happens to resolve to a gated peer wrapper. Cross-hub orchestration is just
 * capability dispatch where the capability lives on a peer.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AgentParticipant,
  Hub,
  InMemoryStorage,
  createInprocHubLinkPair,
  installPeerLink,
  type Task,
} from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'
import { FileInboxStore, NEVER_RESUME_AT } from '@aipehub/inbox'
import { workflowParticipantId } from '@aipehub/workflow'

import { WorkflowController } from '../src/workflow-controller.js'
import { HostInboxService } from '../src/inbox-service.js'
import { ApprovalGatedParticipant } from '../src/outbound-approval.js'

const APPROVER = 'owner-user'
const PEER_CAP = 'contract-review'

// A plain dispatch step whose capability lives on a peer. The runner emits an
// ordinary `{kind:capability}` dispatch — it has no idea the capability is
// remote; the hub's routing + the federation gates handle the boundary.
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

describe('v5 Stream G-M2 — cross-hub workflow orchestration via the outbound approval gate', () => {
  let tmp: string
  let identity: IdentityStore
  let hubA: Hub // orchestrator (runs the workflow, gated)
  let hubB: Hub // provider (owns the capability)
  let inboxStore: FileInboxStore
  let controller: WorkflowController
  let service: HostInboxService
  let provider: ProviderAgent

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-cross-hub-wf-e2e-'))
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

    controller = new WorkflowController({
      hub: hubA,
      definitionsDir: join(tmp, 'workflows', 'definitions'),
      spaceRoot: tmp,
      // Stream G day-3 — mirror production: the host builds this off-hub view
      // from hub A's connected peers + the capabilities each wrapper advertises.
      // Here that's the 'hubB' wrapper advertising PEER_CAP once
      // installCrossHubPeer wires the link. Resolved LAZILY (a closure) so it is
      // honest before/after the peer is installed, and so readRun can confirm a
      // step's persisted executedBy resolved to this peer.
      peerCapabilities: {
        peerCapabilities: () => {
          const wrapper = hubA.participants().find((p) => p.id === 'hubB')
          return wrapper
            ? [{ peer: 'hubB', label: 'Org B', capabilities: [...wrapper.capabilities], kind: 'peer' as const }]
            : []
        },
      },
    })
    service = new HostInboxService({ hub: hubA, store: inboxStore, identity })
  })

  afterEach(async () => {
    await Promise.all([hubA.stop(), hubB.stop()])
    identity.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  /**
   * Wire orchestrator hubA → provider hubB over an inproc pair, exactly the way
   * peer-registry does: outboundCaps both ADVERTISE (G-M1 remoteCapabilities) and
   * AUTHORIZE (P4-M1 outboundCaps). `approval` toggles the Phase 18 B-M3 gate.
   */
  function installCrossHubPeer(approval: boolean): void {
    const { a, b } = createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
    installPeerLink({
      hub: hubA,
      link: a,
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
    installPeerLink({ hub: hubB, link: b, selfHubId: 'orgB' })
  }

  async function fireTrigger(doc: string): Promise<import('@aipehub/core').TaskResult> {
    return hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['cx:start'] },
      payload: { doc },
    })
  }

  it('approve → the workflow step crosses to the peer and the run completes with the cross-hub result', async () => {
    installCrossHubPeer(true)
    const sum = await controller.importFromText(WORKFLOW_YAML)
    expect(sum.state).toBe('published')

    // Fire the trigger → run starts, dispatches the cross-hub step → gate parks.
    const fired = await fireTrigger('NDA.txt')
    expect(fired.kind).toBe('suspended')
    // Nothing crossed the org boundary yet.
    expect(provider.captured).toHaveLength(0)

    // An approval item exists for the owner, with a WORKFLOW parent (the runner
    // dispatched it, so ancestry's last `by` is `workflow:cross-hub-flow`).
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
    const due = identity.listDueSuspendedTasks({ now: Date.now() })
    expect(due.some((d) => d.taskId === item.itemId)).toBe(false)
    expect(due.some((d) => d.taskId === item.parent!.taskId)).toBe(false)

    // The on-disk run is running with the cross-hub step suspended.
    const runs = await controller.listRuns({ workflowId: 'cross-hub-flow' })
    const parked = await controller.readRun(runs[0]!.runId)
    expect(parked?.status).toBe('running')
    const parkedReview = parked?.steps.find((s) => s.stepId === 'review')
    expect(parkedReview?.status).toBe('suspended')
    // Stream G day-3 — even while parked at the gate the step already records WHO
    // it went to: the persisted executedBy is the peer wrapper id, and readRun
    // resolves that to a cross-hub CONFIRMATION. So "this step left for Org B" is
    // visible from the moment it parks, not only after it completes.
    expect(parkedReview?.executedBy).toBe('hubB')
    expect(parkedReview?.crossHub).toEqual({ peer: 'hubB', peerLabel: 'Org B', kind: 'peer' })

    // Approve as the owner → the two-step resume runs (child gate crosses, then
    // the parent workflow re-reads the child's result and continues).
    await service.resolve({
      itemId: item.itemId,
      userId: APPROVER,
      decision: { kind: 'approval', approved: true },
    })

    // The real cross-org send finally happened, with the workflow payload intact.
    expect(provider.captured).toHaveLength(1)
    expect(provider.captured[0]!.payload).toEqual({ doc: 'NDA.txt' })

    // The run completed and the cross-hub result is the review step's output.
    const done = await controller.readRun(runs[0]!.runId)
    expect(done?.status).toBe('done')
    const review = done?.steps.find((s) => s.stepId === 'review')
    expect(review?.output).toEqual({ reviewed: true, doc: 'NDA.txt' })
    // Stream G day-3 — the completed step persists the executor (the peer wrapper
    // id, carried over from the suspend) and readRun confirms the cross-hub hop.
    expect(review?.executedBy).toBe('hubB')
    expect(review?.crossHub).toEqual({ peer: 'hubB', peerLabel: 'Org B', kind: 'peer' })

    // Parked rows cleaned up.
    expect(identity.getSuspendedTask(item.itemId)).toBeNull()
    expect(identity.getSuspendedTask(item.parent!.taskId)).toBeNull()
  })

  it('reject → the peer is NEVER called and the run fails', async () => {
    installCrossHubPeer(true)
    await controller.importFromText(WORKFLOW_YAML)
    await fireTrigger('NDA.txt')
    const item = (await inboxStore.listPending(APPROVER))[0]!

    await service.resolve({
      itemId: item.itemId,
      userId: APPROVER,
      decision: { kind: 'approval', approved: false },
    })

    // Nothing ever crossed the boundary.
    expect(provider.captured).toHaveLength(0)
    // The denied step fails the run (default onFailure = halt).
    const runs = await controller.listRuns({ workflowId: 'cross-hub-flow' })
    const run = await controller.readRun(runs[0]!.runId)
    expect(run?.status).toBe('failed')
    const review = run?.steps.find((s) => s.stepId === 'review')
    expect(review?.status).toBe('failed')
    expect(review?.error).toMatch(/outbound_approval_denied/)
    // Both parked rows cleaned up (child resumed to a terminal failed result).
    expect(identity.getSuspendedTask(item.itemId)).toBeNull()
    expect(identity.getSuspendedTask(item.parent!.taskId)).toBeNull()
  })

  it('no approval required → the workflow step crosses immediately and the run completes', async () => {
    installCrossHubPeer(false)
    await controller.importFromText(WORKFLOW_YAML)

    // No gate → the cross-hub step resolves synchronously; the run never parks.
    const fired = await fireTrigger('memo.txt')
    expect(fired.kind).toBe('ok')

    // No approval item was written — orchestration without a human in the loop.
    expect(await inboxStore.listPending(APPROVER)).toHaveLength(0)
    // The step crossed exactly once with the workflow payload.
    expect(provider.captured).toHaveLength(1)
    expect(provider.captured[0]!.payload).toEqual({ doc: 'memo.txt' })

    const runs = await controller.listRuns({ workflowId: 'cross-hub-flow' })
    const run = await controller.readRun(runs[0]!.runId)
    expect(run?.status).toBe('done')
    const review = run?.steps.find((s) => s.stepId === 'review')
    expect(review?.output).toEqual({ reviewed: true, doc: 'memo.txt' })
    // Stream G day-3 — a synchronous (un-gated) cross-hub step still records the
    // peer wrapper as its executor, and readRun confirms the hop. Same persisted
    // executedBy as the gated path, just set on the ok branch instead of suspend.
    expect(review?.executedBy).toBe('hubB')
    expect(review?.crossHub).toEqual({ peer: 'hubB', peerLabel: 'Org B', kind: 'peer' })
  })
})
