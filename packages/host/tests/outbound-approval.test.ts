/**
 * Phase 18 B-M3a — the outbound approval gate decorator, in isolation.
 *
 * Pure unit test: a fake inner participant (records onTask calls) + an
 * in-memory InboxStore. No HubLink, no scheduler, no HostInboxService — the
 * resume path is exercised by calling `onResume` directly with the same
 * `{ answer: <decision> }` state the host's resolve injects.
 *
 * What it pins:
 *   - onTask PARKS (writes a pending `approval` item keyed by task.id, throws
 *     SuspendTaskError at NEVER_RESUME_AT) and never calls the inner send.
 *   - parentKind is derived from ancestry: workflow ancestor → 'workflow'
 *     (+ parent recorded), agent ancestor → 'agent', none → 'none'.
 *   - onResume(approved) forwards to inner.onTask exactly once.
 *   - onResume(rejected) returns failed(outbound_approval_denied), inner never
 *     called.
 *   - a stray resume (no decision) re-parks instead of sending.
 *   - id + capabilities delegate to the inner wrapper.
 */

import { describe, expect, it } from 'vitest'
import { isSuspendTaskError, type Message, type Task, type TaskResult } from '@aipehub/core'
import { NEVER_RESUME_AT, type InboxItem, type InboxStore } from '@aipehub/inbox'

import {
  ApprovalGatedParticipant,
  type GatedOutboundInner,
} from '../src/outbound-approval.js'

/** Minimal in-memory InboxStore (only the methods the gate touches). */
class MemInboxStore implements InboxStore {
  readonly items = new Map<string, InboxItem>()
  ensureDirs(): void {}
  async write(item: InboxItem): Promise<void> {
    this.items.set(item.itemId, { ...item })
  }
  async get(itemId: string): Promise<InboxItem | null> {
    return this.items.get(itemId) ?? null
  }
  async listPending(userId: string): Promise<InboxItem[]> {
    return [...this.items.values()].filter((i) => i.userId === userId && i.status === 'pending')
  }
  async markResolved(): Promise<InboxItem> {
    throw new Error('not used in these tests')
  }
  async delegate(): Promise<InboxItem> {
    throw new Error('not used in these tests')
  }
}

/** Fake outbound wrapper: records the tasks it was asked to send. */
class FakeInner implements GatedOutboundInner {
  readonly sent: Task[] = []
  readonly messages: Message[] = []
  constructor(
    readonly id = 'hub_remote',
    readonly capabilities: readonly string[] = ['probe', 'chat'],
  ) {}
  async onTask(task: Task): Promise<TaskResult> {
    this.sent.push(task)
    return { kind: 'ok', taskId: task.id, by: this.id, output: { delivered: true }, ts: 1 }
  }
  async onMessage(msg: Message): Promise<void> {
    this.messages.push(msg)
  }
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    from: 'alice',
    strategy: { kind: 'capability', capabilities: ['probe'] },
    payload: { hello: 'world' },
    ts: 1,
    ...over,
  } as Task
}

function gate(opts: {
  inner?: FakeInner
  store?: MemInboxStore
  approver?: string
} = {}) {
  const inner = opts.inner ?? new FakeInner()
  const store = opts.store ?? new MemInboxStore()
  const gated = new ApprovalGatedParticipant({
    inner,
    store,
    approver: opts.approver ?? 'owner-user',
    peerLabel: 'Remote Org',
    now: () => 42,
  })
  return { inner, store, gated }
}

describe('ApprovalGatedParticipant — onTask parks instead of sending', () => {
  it('writes a pending approval item keyed by task.id and suspends forever', async () => {
    const { inner, store, gated } = gate()
    const task = makeTask()

    await expect(gated.onTask(task)).rejects.toSatisfy(isSuspendTaskError)
    // The send never happened — nothing crossed the org boundary.
    expect(inner.sent).toHaveLength(0)

    const item = store.items.get('task-1')!
    expect(item).toBeDefined()
    expect(item.itemId).toBe('task-1')
    expect(item.userId).toBe('owner-user')
    expect(item.kind).toBe('approval')
    expect(item.status).toBe('pending')
    expect(item.createdAt).toBe(42)
    expect(item.prompt).toContain('Remote Org')
    expect(item.prompt).toContain('probe')
  })

  it('parks at NEVER_RESUME_AT with the inbox item id in state', async () => {
    const { gated } = gate()
    try {
      await gated.onTask(makeTask())
      throw new Error('expected suspend')
    } catch (err) {
      expect(isSuspendTaskError(err)).toBe(true)
      if (isSuspendTaskError(err)) {
        expect(err.resumeAt).toBe(NEVER_RESUME_AT)
        expect(err.state).toEqual({ inboxItemId: 'task-1' })
      }
    }
  })
})

describe('ApprovalGatedParticipant — parentKind derived from ancestry', () => {
  it("workflow ancestor → parentKind 'workflow' + parent recorded", async () => {
    const { store, gated } = gate()
    const task = makeTask({
      ancestry: [{ taskId: 'wf-trigger', by: 'workflow:cross-org-flow' }],
    })
    await expect(gated.onTask(task)).rejects.toSatisfy(isSuspendTaskError)
    const item = store.items.get('task-1')!
    expect(item.parentKind).toBe('workflow')
    expect(item.parent).toEqual({ taskId: 'wf-trigger', by: 'workflow:cross-org-flow' })
  })

  it("agent ancestor → parentKind 'agent'", async () => {
    const { store, gated } = gate()
    const task = makeTask({ ancestry: [{ taskId: 't0', by: 'some-agent' }] })
    await expect(gated.onTask(task)).rejects.toSatisfy(isSuspendTaskError)
    expect(store.items.get('task-1')!.parentKind).toBe('agent')
  })

  it("no ancestry → parentKind 'none', no parent", async () => {
    const { store, gated } = gate()
    await expect(gated.onTask(makeTask())).rejects.toSatisfy(isSuspendTaskError)
    const item = store.items.get('task-1')!
    expect(item.parentKind).toBe('none')
    expect(item.parent).toBeUndefined()
  })
})

describe('ApprovalGatedParticipant — onResume forwards or denies', () => {
  it('approved → inner.onTask fires exactly once, returns its ok result', async () => {
    const { inner, gated } = gate()
    const task = makeTask()
    const result = await gated.onResume(task, {
      answer: { kind: 'approval', approved: true },
    })
    expect(inner.sent).toHaveLength(1)
    expect(inner.sent[0]!.id).toBe('task-1')
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(result.output).toEqual({ delivered: true })
  })

  it('rejected → failed(outbound_approval_denied), inner never called', async () => {
    const { inner, gated } = gate()
    const result = await gated.onResume(makeTask(), {
      answer: { kind: 'approval', approved: false },
    })
    expect(inner.sent).toHaveLength(0)
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toBe('outbound_approval_denied')
      expect(result.by).toBe('hub_remote')
    }
  })

  it('stray resume with no decision → re-parks (does not send)', async () => {
    const { inner, gated } = gate()
    await expect(gated.onResume(makeTask(), { nothing: true })).rejects.toSatisfy(
      isSuspendTaskError,
    )
    expect(inner.sent).toHaveLength(0)
  })
})

describe('ApprovalGatedParticipant — delegates identity to inner', () => {
  it('id and capabilities pass through so FED routing still selects the edge', () => {
    const inner = new FakeInner('hub_partner', ['translate', 'summarize'])
    const { gated } = gate({ inner })
    expect(gated.id).toBe('hub_partner')
    expect(gated.capabilities).toEqual(['translate', 'summarize'])
    expect(gated.kind).toBe('agent')
  })
})
