/**
 * PB-M4 — parallel-branch cross-hub attribution acceptance gate (E2E).
 *
 * THE test the PB track exists to pass: a workflow's PARALLEL step fans out to
 * two branches — one stays local, one crosses to a peer hub through the Phase 18
 * outbound approval gate — and the run records WHO ran EACH branch plus the
 * cross-hub correlation handle PER BRANCH, so the admin run-detail can attribute
 * the fan-out and pull ONE branch's transcript from the peer.
 *
 * Why a step-level `executedBy` can't cover this: the fan-out has N executors,
 * some off-hub and some not. PB-M1 added the per-branch maps
 * (`branchExecutedBy` / `branchPeerTaskIds`) mirroring the simple step's
 * day-3/day-5 fields; PB-M2 resolves them at read time into
 * `EnrichedStepRecord.branchCrossHub` and lets `fetchPeerStepTranscript` target
 * one branch. This gate proves the three recording sites end-to-end on a real
 * stack:
 *   - ok path        — the local branch (and the un-gated remote branch in the
 *                      sync scenario) stamps on first attempt,
 *   - suspend path   — a branch parked at the approval gate already shows its
 *                      destination (`branchExecutedBy` stamped while parked),
 *   - resume fold    — after approval the folded ok result carries the peer's
 *                      internal task id into `branchPeerTaskIds`.
 *
 * Everything is real: two Hubs over an inproc link pair, the real
 * ApprovalGatedParticipant over a real FileInboxStore, a production-shaped
 * suspendNotifier persisting parks to a real IdentityStore (tmp sqlite), the
 * real WorkflowController + versioning file stores, the real HostInboxService
 * two-step resume, and the real `peer.transcript` RPC over the link.
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
  type HubLink,
  type Task,
} from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import { FileInboxStore } from '@gotong/inbox'

import { WorkflowController } from '../src/workflow-controller.js'
import { HostInboxService } from '../src/inbox-service.js'
import { ApprovalGatedParticipant } from '../src/outbound-approval.js'
import { PeerTranscriptHost } from '../src/peer-transcript.js'

const APPROVER = 'owner-user'
const PEER_CAP = 'contract-review'
const LOCAL_CAP = 'local-archive'

// One parallel step, two branches: `local` resolves on this hub, `remote`
// resolves to a capability only the peer advertises. The runner emits two
// ordinary `{kind:capability}` dispatches — it has no idea one of them is
// remote; routing + the federation gates handle the boundary per branch.
const WORKFLOW_YAML = `
schema: gotong.workflow/v1
workflow:
  id: par-cross-hub-flow
  name: parallel cross-hub fan-out
  trigger: { capability: px:start }
  steps:
    - id: fan
      parallel: true
      branches:
        - id: local
          dispatch:
            strategy: { kind: capability, capabilities: [${LOCAL_CAP}] }
            payload: { doc: $trigger.payload.doc }
        - id: remote
          dispatch:
            strategy: { kind: capability, capabilities: [${PEER_CAP}] }
            payload: { doc: $trigger.payload.doc }
`

/** Local-branch worker on hub A. */
class ArchivistAgent extends AgentParticipant {
  readonly captured: Task[] = []
  protected async handleTask(task: Task): Promise<unknown> {
    this.captured.push(task)
    return { archived: true }
  }
}

/** Remote-branch worker on hub B. Running it writes hub B's own transcript. */
class ProviderAgent extends AgentParticipant {
  readonly captured: Task[] = []
  protected async handleTask(task: Task): Promise<unknown> {
    this.captured.push(task)
    return { reviewed: true, doc: (task.payload as { doc?: unknown }).doc }
  }
}

describe('PB-M4 — parallel branches: per-branch cross-hub attribution end-to-end', () => {
  let tmp: string
  let identity: IdentityStore
  let hubA: Hub // orchestrator (runs the workflow; one branch gated)
  let hubB: Hub // provider (owns the remote branch's capability + its transcript)
  let inboxStore: FileInboxStore
  let controller: WorkflowController
  let service: HostInboxService
  let archivist: ArchivistAgent
  let provider: ProviderAgent
  let linkToHubB: HubLink | null

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-par-branch-xhub-e2e-'))
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })

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

    archivist = new ArchivistAgent({ id: 'a-archivist', capabilities: [LOCAL_CAP] })
    hubA.register(archivist)
    provider = new ProviderAgent({ id: 'b-reviewer', capabilities: [PEER_CAP] })
    hubB.register(provider)

    inboxStore = new FileInboxStore(tmp)
    inboxStore.ensureDirs()
    linkToHubB = null

    controller = new WorkflowController({
      hub: hubA,
      definitionsDir: join(tmp, 'workflows', 'definitions'),
      spaceRoot: tmp,
      peerCapabilities: {
        peerCapabilities: () => {
          const wrapper = hubA.participants().find((p) => p.id === 'hubB')
          return wrapper
            ? [{ peer: 'hubB', label: 'Org B', capabilities: [...wrapper.capabilities], kind: 'peer' as const }]
            : []
        },
      },
      peerLinkResolver: (peerId) => (peerId === 'hubB' ? linkToHubB : null),
    })
    service = new HostInboxService({ hub: hubA, store: inboxStore, identity })
  })

  afterEach(async () => {
    await Promise.all([hubA.stop(), hubB.stop()])
    identity.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  /**
   * Wire hub A → hub B the peer-registry way. `approval` toggles the Phase 18
   * outbound gate on the wrapper; hub B answers `peer.transcript` over its
   * inbound link (sharing always on here — the opt-in gate has its own test in
   * cross-hub-transcript-chain-e2e and is orthogonal to branch targeting).
   */
  function installCrossHubPeer(approval: boolean): void {
    const { a, b } = createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
    installPeerLink({
      hub: hubA,
      link: a,
      selfHubId: 'orgA',
      remoteCapabilities: [PEER_CAP],
      outboundCaps: [PEER_CAP],
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
    const txHost = new PeerTranscriptHost({ hub: hubB, hubId: 'orgB' })
    installPeerLink({ hub: hubB, link: b, selfHubId: 'orgB', rpcResponder: txHost.respond })
    linkToHubB = a
  }

  async function fireTrigger(doc: string): Promise<import('@gotong/core').TaskResult> {
    return hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['px:start'] },
      payload: { doc },
    })
  }

  it('gated remote branch: parked shows its destination per branch; approve folds executor + handle; one branch transcript pulls', async () => {
    installCrossHubPeer(true)
    const sum = await controller.importFromText(WORKFLOW_YAML)
    expect(sum.state).toBe('published')

    // Fire → the local branch completes, the remote branch parks at the gate,
    // the whole run suspends on the parked branch.
    const fired = await fireTrigger('NDA.txt')
    expect(fired.kind).toBe('suspended')
    expect(archivist.captured).toHaveLength(1)
    expect(provider.captured).toHaveLength(0) // nothing crossed yet

    const runs = await controller.listRuns({ workflowId: 'par-cross-hub-flow' })
    const runId = runs[0]!.runId

    // PARKED — per-branch attribution is already honest:
    //   - the suspend-path stamp: the remote branch records the gated wrapper id
    //     even though nothing crossed, so the UI shows WHERE it is going,
    //   - the ok-path stamp: the local branch records its local agent,
    //   - enrichment flags ONLY the off-hub branch (local id absent from
    //     branchCrossHub, never a null entry), and the parallel step has NO
    //     step-level executedBy/crossHub (one value can't attribute a fan-out).
    const parked = await controller.readRun(runId)
    expect(parked?.status).toBe('running')
    const parkedFan = parked?.steps.find((s) => s.stepId === 'fan')
    expect(parkedFan?.status).toBe('suspended')
    expect(parkedFan?.branchExecutedBy).toEqual({ local: 'a-archivist', remote: 'hubB' })
    expect(parkedFan?.executedBy).toBeUndefined()
    expect(parkedFan?.crossHub).toBeUndefined()
    expect(parkedFan?.branchCrossHub).toEqual({
      remote: { peer: 'hubB', peerLabel: 'Org B', kind: 'peer' },
    })
    // No peer task exists yet — the gate parked BEFORE crossing, so the handle
    // is absent while parked and only appears once the fold sees the real result.
    expect(parkedFan?.branchPeerTaskIds?.remote).toBeUndefined()

    // Approve as the owner → two-step resume → the branch finally crosses and
    // the run folds it in and completes.
    const item = (await inboxStore.listPending(APPROVER))[0]!
    expect(item.parentKind).toBe('workflow')
    await service.resolve({
      itemId: item.itemId,
      userId: APPROVER,
      decision: { kind: 'approval', approved: true },
    })

    expect(provider.captured).toHaveLength(1)
    expect(provider.captured[0]!.payload).toEqual({ doc: 'NDA.txt' })

    const done = await controller.readRun(runId)
    expect(done?.status).toBe('done')
    const fan = done?.steps.find((s) => s.stepId === 'fan')
    expect(fan?.status).toBe('done')
    expect(fan?.output).toEqual({
      local: { archived: true },
      remote: { reviewed: true, doc: 'NDA.txt' },
    })
    // The resume fold carried the relabelled executor through AND stamped the
    // peer's internal task id — the durable handle the transcript chain pulls on.
    expect(fan?.branchExecutedBy).toEqual({ local: 'a-archivist', remote: 'hubB' })
    expect(typeof fan?.branchPeerTaskIds?.remote).toBe('string')
    expect((fan?.branchPeerTaskIds?.remote ?? '').length).toBeGreaterThan(0)
    expect(fan?.branchPeerTaskIds?.local).toBeUndefined()
    expect(fan?.branchCrossHub).toEqual({
      remote: { peer: 'hubB', peerLabel: 'Org B', kind: 'peer' },
    })

    // Pull ONE branch's transcript: the remote branch resolves its own handle
    // over the real link and hub B answers with the slice for THAT task.
    const out = (await controller.fetchPeerStepTranscript(runId, 'fan', 'remote')) as {
      ok: boolean
      slice?: { taskId: string; events: unknown[] }
    }
    expect(out.ok).toBe(true)
    expect(out.slice!.taskId).toBe(fan!.branchPeerTaskIds!.remote)
    expect(out.slice!.events.length).toBeGreaterThan(0)

    // The local branch (and a branch id that doesn't exist, and the step
    // without a branch) never crossed — all resolve to the same soft verdict.
    for (const branch of ['local', 'nope', undefined]) {
      const miss = (await controller.fetchPeerStepTranscript(runId, 'fan', branch)) as {
        ok: boolean
        code?: string
      }
      expect(miss.ok).toBe(false)
      expect(miss.code).toBe('not_cross_hub')
    }
  })

  it('un-gated remote branch: the synchronous ok path stamps executor + handle per branch on first attempt', async () => {
    installCrossHubPeer(false)
    await controller.importFromText(WORKFLOW_YAML)

    const fired = await fireTrigger('memo.txt')
    expect(fired.kind).toBe('ok') // no gate → no park, the fan-out resolves in one pass

    const runs = await controller.listRuns({ workflowId: 'par-cross-hub-flow' })
    const run = await controller.readRun(runs[0]!.runId)
    expect(run?.status).toBe('done')
    const fan = run?.steps.find((s) => s.stepId === 'fan')
    expect(fan?.branchExecutedBy).toEqual({ local: 'a-archivist', remote: 'hubB' })
    expect(typeof fan?.branchPeerTaskIds?.remote).toBe('string')
    expect(fan?.branchPeerTaskIds?.local).toBeUndefined()
    expect(fan?.branchCrossHub).toEqual({
      remote: { peer: 'hubB', peerLabel: 'Org B', kind: 'peer' },
    })
    expect(fan?.crossHub).toBeUndefined()

    const out = (await controller.fetchPeerStepTranscript(runs[0]!.runId, 'fan', 'remote')) as {
      ok: boolean
      slice?: { taskId: string }
    }
    expect(out.ok).toBe(true)
    expect(out.slice!.taskId).toBe(fan!.branchPeerTaskIds!.remote)
  })

  it('reject → the remote branch fails the run fail-closed and the peer is never called; the local branch result is preserved', async () => {
    installCrossHubPeer(true)
    await controller.importFromText(WORKFLOW_YAML)
    await fireTrigger('NDA.txt')

    const item = (await inboxStore.listPending(APPROVER))[0]!
    await service.resolve({
      itemId: item.itemId,
      userId: APPROVER,
      decision: { kind: 'approval', approved: false },
    })

    expect(provider.captured).toHaveLength(0)
    const runs = await controller.listRuns({ workflowId: 'par-cross-hub-flow' })
    const run = await controller.readRun(runs[0]!.runId)
    expect(run?.status).toBe('failed')
    const fan = run?.steps.find((s) => s.stepId === 'fan')
    expect(fan?.status).toBe('failed')
    expect(fan?.error).toMatch(/outbound_approval_denied/)
    // The branch that already succeeded keeps its output and attribution — a
    // denial of ONE branch never erases what the others did.
    expect((fan?.output as Record<string, unknown>)?.local).toEqual({ archived: true })
    expect(fan?.branchExecutedBy?.local).toBe('a-archivist')
  })
})
