/**
 * P1-M3 — cross-hub workflow survives a link bounce + redial (E2E).
 *
 * M1 proves the cross-hub workflow + outbound-approval narrative over a real
 * WebSocket. M3 adds the operational dimension a real network forces and an
 * inproc link structurally cannot: the socket DROPS while a workflow is parked on
 * the outbound approval, the peer is REDIALED, and only then does the approver
 * say yes.
 *
 * The claim under test: the park lives in identity (suspended_tasks) + the inbox,
 * NOT on the link. So bouncing the link loses nothing; a redial under the same
 * peer id installs a fresh outbound wrapper under that id (the gate delegates its
 * id to inner.id == link.peerId == 'orgB'), and the approval's two-step resume
 * routes to that fresh gate — sending the task across the FRESH socket. This is
 * exactly how peer-registry behaves on its reconcile tick (uninstall the dead
 * edge, re-dialOne under the same peer id); here we drive it by hand to pin the
 * end-to-end property.
 *
 * Everything is real: two real Hubs, a real ws WebSocketServer, the real
 * ApprovalGatedParticipant over a real FileInboxStore, a production-shaped
 * suspendNotifier → real IdentityStore (tmp sqlite), the real WorkflowController
 * + HostInboxService two-step resume.
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
  type InstalledPeerLink,
  type Task,
  type TaskResult,
} from '@aipehub/core'
import { acceptHubLinks, connectHubLink } from '@aipehub/transport-ws'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'
import { FileInboxStore, NEVER_RESUME_AT } from '@aipehub/inbox'

import { WorkflowController } from '../src/workflow-controller.js'
import { HostInboxService } from '../src/inbox-service.js'
import { ApprovalGatedParticipant } from '../src/outbound-approval.js'

const APPROVER = 'owner-user'
const PEER_CAP = 'contract-review'
const PEER_ID = 'orgB'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
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

class ProviderAgent extends AgentParticipant {
  readonly captured: Task[] = []
  protected async handleTask(task: Task): Promise<unknown> {
    this.captured.push(task)
    return { reviewed: true, doc: (task.payload as { doc?: unknown }).doc }
  }
}

describe('P1-M3 — cross-hub workflow survives a link bounce + redial', () => {
  let tmp: string
  let identity: IdentityStore
  let hubA: Hub
  let hubB: Hub
  let wss: WebSocketServer
  let hubBUrl: string
  let inboxStore: FileInboxStore
  let controller: WorkflowController
  let service: HostInboxService
  let provider: ProviderAgent
  const homeLinks: HubLink[] = []
  const hubBInbound: HubLink[] = []
  // hub B's side install handles — uninstalling one unregisters the 'orgA'
  // wrapper AND closes the inbound link (mirrors what peer-registry does when an
  // inbound-accepted link dies; without it the redial's onLink collides on the
  // duplicate 'orgA' id and the accept side tears the fresh connection down).
  const hubBInstalls: InstalledPeerLink[] = []

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-cross-hub-redial-e2e-'))
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

    provider = new ProviderAgent({ id: 'b-reviewer', capabilities: [PEER_CAP] })
    hubB.register(provider)

    inboxStore = new FileInboxStore(tmp)
    inboxStore.ensureDirs()

    // Each accepted link auto-installs hub B's plain inbound side. A redial yields
    // a SECOND accepted link, installed the same way; the first becomes a no-op
    // once closed.
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
        hubBInstalls.push(installPeerLink({ hub: hubB, link, selfHubId: 'orgB' }))
      },
    })

    controller = new WorkflowController({
      hub: hubA,
      definitionsDir: join(tmp, 'workflows', 'definitions'),
      spaceRoot: tmp,
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

  /** Dial hub A → hub B over real ws and install the gated outbound edge. */
  async function dialAndInstall(): Promise<{ install: InstalledPeerLink; link: HubLink }> {
    const before = hubBInbound.length
    const link = await connectHubLink({ url: hubBUrl, selfId: 'orgA', expectedPeerId: PEER_ID })
    homeLinks.push(link)
    for (let i = 0; i < 40 && hubBInbound.length === before; i++) await delay(10)
    expect(hubBInbound.length).toBeGreaterThan(before)
    const install = installPeerLink({
      hub: hubA,
      link,
      selfHubId: 'orgA',
      remoteCapabilities: [PEER_CAP],
      outboundCaps: [PEER_CAP],
      wrapOutbound: (inner) =>
        new ApprovalGatedParticipant({
          inner,
          store: inboxStore,
          approver: APPROVER,
          peerLabel: 'Org B',
          now: () => 100,
        }),
    })
    await drain()
    return { install, link }
  }

  async function fireTrigger(doc: string): Promise<TaskResult> {
    return hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['cx:start'] },
      payload: { doc },
    })
  }

  it('park outlives a socket bounce; redial under the same peer id completes the run on approval', async () => {
    const peer1 = await dialAndInstall()
    const sum = await controller.importFromText(WORKFLOW_YAML)
    expect(sum.state).toBe('published')

    // Fire → the gate parks the step on hub A (in identity), before any wire use.
    const fired = await fireTrigger('NDA.txt')
    expect(fired.kind).toBe('suspended')
    expect(provider.captured).toHaveLength(0)

    const item = (await inboxStore.listPending(APPROVER))[0]!
    expect(item.parentKind).toBe('workflow')
    expect(identity.getSuspendedTask(item.itemId)?.resumeAt).toBe(NEVER_RESUME_AT)
    expect(identity.getSuspendedTask(item.parent!.taskId)?.resumeAt).toBe(NEVER_RESUME_AT)

    // ── BOUNCE: uninstall hub A's edge (unregisters the 'orgB' wrapper + closes
    //    the socket) and drop hub B's accepted link. This is a real disconnect.
    //    Wait until hub B's server has fully torn down the old connection before
    //    redialing — production redials only after the dead link is observed
    //    closed, so the accept side never sees two live edges for one peer. ──
    await peer1.install.uninstall()
    await hubBInstalls[0]!.uninstall() // unregisters hub B's 'orgA' wrapper + closes its link
    for (let i = 0; i < 80 && wss.clients.size > 0; i++) await delay(10)
    expect(wss.clients.size).toBe(0)
    await drain()
    // The 'orgB' wrapper is gone from hub A while disconnected...
    expect(hubA.participants().some((p) => p.id === PEER_ID)).toBe(false)
    // ...but the park + the inbox item are untouched by the bounce — they live in
    // identity + the inbox, not on the link.
    expect(identity.getSuspendedTask(item.itemId)?.resumeAt).toBe(NEVER_RESUME_AT)
    expect(identity.getSuspendedTask(item.parent!.taskId)?.resumeAt).toBe(NEVER_RESUME_AT)
    expect(await inboxStore.listPending(APPROVER)).toHaveLength(1)

    // ── REDIAL: a fresh socket, a fresh gate registered under the SAME id. ──
    await dialAndInstall()
    expect(hubA.participants().some((p) => p.id === PEER_ID)).toBe(true)

    // Approve → the two-step resume routes the parked child to the FRESH gate,
    // which sends across the FRESH socket; the parent workflow then continues.
    await service.resolve({
      itemId: item.itemId,
      userId: APPROVER,
      decision: { kind: 'approval', approved: true },
    })
    await drain()

    // The send finally crossed — over the redialed socket — with the payload intact.
    expect(provider.captured).toHaveLength(1)
    expect(provider.captured[0]!.payload).toEqual({ doc: 'NDA.txt' })

    const runs = await controller.listRuns({ workflowId: 'cross-hub-flow' })
    const done = await controller.readRun(runs[0]!.runId)
    expect(done?.status).toBe('done')
    const review = done?.steps.find((s) => s.stepId === 'review')
    expect(review?.output).toEqual({ reviewed: true, doc: 'NDA.txt' })
    expect(review?.executedBy).toBe(PEER_ID)

    // Parked rows cleaned up after the resume.
    expect(identity.getSuspendedTask(item.itemId)).toBeNull()
    expect(identity.getSuspendedTask(item.parent!.taskId)).toBeNull()
  })
})
