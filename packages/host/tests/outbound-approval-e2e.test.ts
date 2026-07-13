/**
 * Phase 18 B-M3b — outbound approval gate acceptance gate (end-to-end).
 *
 * THE test the feature exists to pass: a cross-org dispatch to a peer flagged
 * `requireApprovalOutbound` does NOT reach the remote hub until a person
 * approves it from their inbox; a rejection means it NEVER reaches the remote.
 *
 * Everything is real:
 *   - two real Hubs wired over an inproc HubLink pair,
 *   - sender hub installs the wrapper via installPeerLink's `wrapOutbound`
 *     hook = the real ApprovalGatedParticipant over a real FileInboxStore,
 *   - a production-shaped suspendNotifier persisting parks to a real
 *     IdentityStore (tmp sqlite),
 *   - the real HostInboxService doing the resume.
 *
 * This is the highest-risk milestone's safety proof: the "approved → reaches
 * remote, rejected → remote never called" invariant, asserted against the live
 * stack rather than the decorator in isolation (that's outbound-approval.test).
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
} from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import { FileInboxStore, NEVER_RESUME_AT } from '@gotong/inbox'

import { ApprovalGatedParticipant } from '../src/outbound-approval.js'
import { HostInboxService } from '../src/inbox-service.js'

/** Receiver-side worker that records every task it's handed. */
class RecordingAgent extends AgentParticipant {
  readonly captured: Task[] = []
  protected async handleTask(task: Task): Promise<unknown> {
    this.captured.push(task)
    return { delivered: true }
  }
}

const APPROVER = 'owner-user'
const CAP = 'cross-task'

describe('Phase 18 B-M3b — outbound approval gate acceptance gate', () => {
  let tmp: string
  let identity: IdentityStore
  let hubA: Hub // sender (gated)
  let hubB: Hub // receiver
  let inboxStore: FileInboxStore
  let service: HostInboxService
  let recorder: RecordingAgent

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-outbound-approval-e2e-'))
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })

    // Sender hub persists parks the production way (→ suspended_tasks).
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

    recorder = new RecordingAgent({ id: 'b-worker', capabilities: [CAP] })
    hubB.register(recorder)

    inboxStore = new FileInboxStore(tmp)
    inboxStore.ensureDirs()

    // Wire the inproc pair. hubA's wrapper (id 'hubB') is decorated by the gate;
    // hubB's side is a plain inbound install. remoteCapabilities makes hubA's
    // capability dispatch select the gated edge.
    const { a, b } = createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
    installPeerLink({
      hub: hubA,
      link: a,
      remoteCapabilities: [CAP],
      outboundCaps: [CAP],
      selfHubId: 'orgA',
      wrapOutbound: (inner) =>
        new ApprovalGatedParticipant({
          inner,
          store: inboxStore,
          approver: APPROVER,
          peerLabel: 'Org B',
          now: () => 100,
        }),
    })
    installPeerLink({ hub: hubB, link: b, selfHubId: 'orgB' })

    service = new HostInboxService({ hub: hubA, store: inboxStore, identity })
  })

  afterEach(async () => {
    await Promise.all([hubA.stop(), hubB.stop()])
    identity.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  async function dispatchGated(): Promise<import('@gotong/core').TaskResult> {
    return hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: [CAP] },
      payload: { msg: 'hi' },
    })
  }

  it('parks the send as an approval item; the remote is not called yet', async () => {
    const fired = await dispatchGated()
    expect(fired.kind).toBe('suspended')
    // Nothing crossed the org boundary.
    expect(recorder.captured).toHaveLength(0)

    const pending = await inboxStore.listPending(APPROVER)
    expect(pending).toHaveLength(1)
    const item = pending[0]!
    expect(item.kind).toBe('approval')
    expect(item.parentKind).toBe('none') // direct dispatch, no workflow ancestor
    expect(item.prompt).toContain('Org B')
    expect(item.prompt).toContain(CAP)

    // Parked at the never-resume sentinel; the sweep is blind to it.
    const row = identity.getSuspendedTask(item.itemId)
    expect(row?.resumeAt).toBe(NEVER_RESUME_AT)
    expect(row?.agentId).toBe('hubB') // the gated wrapper id (= link peer id)
    const due = identity.listDueSuspendedTasks({ now: Date.now() })
    expect(due.some((d) => d.taskId === item.itemId)).toBe(false)
  })

  it('approve → the task finally reaches the remote worker', async () => {
    await dispatchGated()
    const item = (await inboxStore.listPending(APPROVER))[0]!

    await service.resolve({
      itemId: item.itemId,
      userId: APPROVER,
      decision: { kind: 'approval', approved: true },
    })

    // The real cross-org send happened with the original payload intact.
    expect(recorder.captured).toHaveLength(1)
    expect(recorder.captured[0]!.payload).toEqual({ msg: 'hi' })
    // Park cleaned up.
    expect(identity.getSuspendedTask(item.itemId)).toBeNull()
  })

  it('reject → the remote worker is NEVER called', async () => {
    await dispatchGated()
    const item = (await inboxStore.listPending(APPROVER))[0]!

    await service.resolve({
      itemId: item.itemId,
      userId: APPROVER,
      decision: { kind: 'approval', approved: false },
    })

    expect(recorder.captured).toHaveLength(0)
    // Park still cleaned up (the decision was recorded + the child resumed to a
    // terminal failed result).
    expect(identity.getSuspendedTask(item.itemId)).toBeNull()
  })

  it('approval is owner-scoped: another user cannot resolve it', async () => {
    await dispatchGated()
    const item = (await inboxStore.listPending(APPROVER))[0]!

    await expect(
      service.resolve({
        itemId: item.itemId,
        userId: 'someone-else',
        decision: { kind: 'approval', approved: true },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(recorder.captured).toHaveLength(0)
  })
})
