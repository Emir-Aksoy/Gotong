/**
 * IMA-M3 — the IM approval loop acceptance gate (hermetic e2e).
 *
 * THE test the track exists to pass: a member living ONLY in an IM chat can
 * see what is waiting on them and answer it — `/inbox` → `/approve <id>` →
 * the parked work actually continues → the outcome comes BACK to the chat
 * (S1-M3 push-back). And the plan-b boundary holds end-to-end: an item the
 * writer did not whitelist (`ask_peer`, a cross-hub egress) is listed but
 * refuses an IM decision, pointing at the web.
 *
 * Everything is real except the wire:
 *   - a real Hub whose suspendNotifier mirrors production main.ts (persist to
 *     a real IdentityStore + the butler escalation sink via
 *     `butlerApprovalItemFor`),
 *   - the real broker (HumanInboxParticipant + FileInboxStore) for the
 *     workflow act, the real WorkflowController running a real YAML flow,
 *   - the real HostInboxService (two-step resume + 'im' audit row + the
 *     S1-M3 `onResolved` hook wired to `butlerResolvePushback`),
 *   - the real ImApprovalService as `config.approvals`,
 *   - a FakeBridge standing in for Telegram (same `ImBridge` contract).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Hub,
  InMemoryStorage,
  SuspendTaskError,
  type Participant,
  type Task,
  type TaskResult,
} from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import { FileInboxStore, HumanInboxParticipant, NEVER_RESUME_AT } from '@gotong/inbox'
import type { ImAttachment, ImBridge, ImMessage, ImUser } from '@gotong/im-adapter'
import { butlerGateState } from '@gotong/personal-butler'

import { ImApprovalService } from '../src/im-approval-service.js'
import {
  handleImMessage,
  makeIdentityImBindingResolver,
  type HostImConfig,
} from '../src/im-bridge.js'
import { HostInboxService } from '../src/inbox-service.js'
import {
  butlerApprovalItemFor,
  butlerResolvePushback,
} from '../src/personal-butler-escalation.js'
import { WorkflowController } from '../src/workflow-controller.js'

class FakeBridge implements ImBridge {
  readonly platform = 'telegram'
  readonly outbound: Array<{ to: ImUser; text: string }> = []
  private listener: ((msg: ImMessage) => void | Promise<void>) | null = null
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(to: ImUser, text: string, _o?: { attachments?: ImAttachment[] }): Promise<void> {
    this.outbound.push({ to, text })
  }
  onMessage(listener: (msg: ImMessage) => void | Promise<void>): () => void {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }
  async inject(msg: ImMessage): Promise<void> {
    if (this.listener) await this.listener(msg)
  }
  last(): string {
    const out = this.outbound.at(-1)
    if (!out) throw new Error('no outbound message')
    return out.text
  }
}

const ALICE: ImUser = { platform: 'telegram', platformUserId: '1001', displayName: 'Alice' }
const imMsg = (text: string): ImMessage => ({ from: ALICE, text, chatId: 'p:1001', ts: 1 })

/** A stand-in for the resident butler: parks on a governed tool, and on resume
 *  phrases its own outcome from the injected decision — the same contract
 *  `PersonalButlerAgent` honours (approve → did it; reject → fail-closed). */
function fakeButler(toolName: string): Participant {
  return {
    id: 'butler',
    kind: 'agent',
    capabilities: ['butler:chat'],
    async onTask(): Promise<TaskResult> {
      throw new SuspendTaskError({
        resumeAt: NEVER_RESUME_AT,
        state: butlerGateState({
          messages: [{ role: 'user', content: '删除 mailer' }],
          pending: {
            toolUses: [{ type: 'tool_use', id: 'g1', name: toolName, input: {} }],
            approvedId: 'g1',
            verdicts: { g1: { decision: 'approve', reason: 'governed' } },
            approval: { toolName, title: `${toolName}(mailer)`, reason: '危险动作' },
          },
        }),
      })
    },
    async onResume(task: Task, state: unknown): Promise<TaskResult> {
      const s = state as { answer?: { approved?: boolean } }
      const ok = s.answer?.approved === true
      return {
        kind: 'ok',
        taskId: task.id,
        by: 'butler',
        ts: 1,
        output: { text: ok ? '好了,mailer 已经删掉了。' : '好的,那我先不动它。' },
      }
    },
  }
}

describe('IMA-M3 — IM approval loop (hermetic e2e)', () => {
  let tmp: string
  let identity: IdentityStore
  let hub: Hub
  let inboxStore: FileInboxStore
  let service: HostInboxService
  let bridge: FakeBridge
  let config: HostImConfig
  let aliceId: string
  let pushes: Array<{ userId: string; text: string }>
  let itemWrites: Promise<void>[]

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-im-approval-e2e-'))
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
    inboxStore = new FileInboxStore(tmp)
    inboxStore.ensureDirs()
    itemWrites = []
    // Production main.ts's suspendNotifier, mirrored: persist EVERY park, and
    // shape a butler governed park into a /me approval item (null for a
    // human-step broker park — that one writes its own item).
    hub = new Hub({
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
        const approver = task.origin?.userId
        if (approver) {
          const item = butlerApprovalItemFor(task, by, s.state, { approver })
          if (item) itemWrites.push(inboxStore.write(item))
        }
      },
    })
    await hub.start()
    hub.register(new HumanInboxParticipant({ store: inboxStore }))

    pushes = []
    service = new HostInboxService({
      hub,
      store: inboxStore,
      identity,
      // S1-M3 — production wires this to the bridges' pushToMember; here we
      // capture, proving an IM-made decision STILL triggers the push-back.
      onResolved: ({ item, childResult }) => {
        const text = butlerResolvePushback(item, childResult)
        if (text) pushes.push({ userId: item.userId, text })
      },
    })

    const alice = identity.createUser({ email: 'alice@example.com', displayName: 'Alice' })
    aliceId = alice.id
    const code = identity.issueImBindingCode({ userId: alice.id }).code

    bridge = new FakeBridge()
    config = {
      hub,
      resolver: makeIdentityImBindingResolver(identity),
      freeTextCapability: 'chat',
      onUnbind: async () => ({ removed: false }),
      log: { info() {}, warn() {}, error() {} },
      // The production wiring shape: real service over the real store + resolve.
      approvals: new ImApprovalService({ store: inboxStore, inbox: service }),
    }
    bridge.onMessage((m) => handleImMessage(bridge, m, config))
    await bridge.inject(imMsg(`/bind ${code}`))
  })

  afterEach(async () => {
    await hub.stop()
    identity.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('act 1 — a workflow human step is approved from the chat and the run finishes', async () => {
    const markerSaw: Array<Record<string, unknown>> = []
    hub.register({
      id: 'marker',
      kind: 'agent',
      capabilities: ['mark'],
      async onTask(task) {
        markerSaw.push(task.payload as Record<string, unknown>)
        return { kind: 'ok', taskId: task.id, output: 'marked', by: 'marker', ts: 1 }
      },
    } satisfies Participant)
    const controller = new WorkflowController({
      hub,
      definitionsDir: join(tmp, 'workflows', 'definitions'),
      spaceRoot: tmp,
    })
    await controller.importFromText(`
schema: gotong.workflow/v1
workflow:
  id: ima-e2e
  name: ima-e2e
  trigger: { capability: ima:start }
  steps:
    - id: gate
      human:
        assignee: $trigger.payload.approver
        kind: approval
        prompt: 批准这个方案吗?
    - id: tail
      dispatch:
        strategy: { kind: capability, capabilities: [mark] }
        payload: { approved: $gate.output.approved }
`)
    const fired = await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['ima:start'] },
      payload: { approver: aliceId },
    })
    expect(fired.kind).toBe('suspended')

    // The chat shows the parked item with its short id…
    await bridge.inject(imMsg('/inbox'))
    const item = (await inboxStore.listPending(aliceId))[0]!
    const shortId = item.itemId.slice(0, 8)
    expect(bridge.last()).toContain(`[${shortId}]`)
    expect(bridge.last()).toContain('批准这个方案吗?')
    expect(bridge.last()).not.toContain('web only') // human step IS IM-approvable

    // …and /approve resolves it: run done, decision flowed downstream.
    await bridge.inject(imMsg(`/approve ${shortId}`))
    expect(bridge.last()).toContain('✓ 已批准 / Approved')
    expect(markerSaw).toContainEqual({ approved: true })
    const runs = await controller.listRuns({ workflowId: 'ima-e2e' })
    expect((await controller.readRun(runs[0]!.runId))?.status).toBe('done')

    // The audit row says WHERE the decision was made.
    const rows = identity.listAuditLog({ action: 'inbox_resolve' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actorSource: 'im', actorUserId: aliceId })
    expect(rows[0]!.metadata).toMatchObject({ via: 'im:telegram' })
  })

  it('act 2 — a butler governed park approves from the chat and the outcome pushes back', async () => {
    hub.register(fakeButler('delete_agent')) // hub-internal → IM-approvable
    const parked = await hub.dispatch({
      from: 'im:telegram:1001',
      strategy: { kind: 'explicit', to: 'butler' },
      payload: { text: '把 mailer 删了' },
      origin: { orgId: 'local', userId: aliceId },
    })
    expect(parked.kind).toBe('suspended')
    await Promise.all(itemWrites)

    await bridge.inject(imMsg('/inbox'))
    expect(bridge.last()).toContain('delete_agent(mailer)')
    const item = (await inboxStore.listPending(aliceId))[0]!
    expect(item.source).toBe('butler')
    expect(item.imApprovable).toBe(true)

    await bridge.inject(imMsg(`/approve ${item.itemId.slice(0, 8)}`))
    expect(bridge.last()).toContain('✓ 已批准 / Approved')
    // S1-M3 — the butler's OWN closing line came back for this member.
    expect(pushes).toEqual([{ userId: aliceId, text: '好了,mailer 已经删掉了。' }])
    // The parked row is gone — the loop is closed, nothing left dangling.
    expect(identity.getSuspendedTask(item.itemId)).toBeNull()
  })

  it('act 3 — an ask_peer park is listed but refuses an IM decision (web only)', async () => {
    hub.register(fakeButler('ask_peer')) // cross-hub egress → NOT whitelisted
    await hub.dispatch({
      from: 'im:telegram:1001',
      strategy: { kind: 'explicit', to: 'butler' },
      payload: { text: '问问对面 hub' },
      origin: { orgId: 'local', userId: aliceId },
    })
    await Promise.all(itemWrites)

    await bridge.inject(imMsg('/inbox'))
    expect(bridge.last()).toContain('需在网页处理 / web only')

    const item = (await inboxStore.listPending(aliceId))[0]!
    await bridge.inject(imMsg(`/approve ${item.itemId.slice(0, 8)}`))
    expect(bridge.last()).toContain('需要在网页上处理')
    // Fail-closed for real: still pending, still parked, no push, no audit row.
    expect((await inboxStore.get(item.itemId))!.status).toBe('pending')
    expect(identity.getSuspendedTask(item.itemId)).not.toBeNull()
    expect(pushes).toHaveLength(0)
    expect(identity.listAuditLog({ action: 'inbox_resolve' })).toHaveLength(0)
  })
})
