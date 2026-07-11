import { isSuspendTaskError, SuspendTaskError, type Task } from '@gotong/core'
import { describe, expect, it } from 'vitest'

import { NEVER_RESUME_AT } from '../src/constants.js'
import {
  HumanInboxParticipant,
  parseHumanPayload,
} from '../src/human-inbox-participant.js'
import { InboxError, type InboxDecision, type InboxItem, type InboxStore } from '../src/types.js'

/** In-memory InboxStore so the broker test stays pure (no filesystem). */
class MemStore implements InboxStore {
  readonly items = new Map<string, InboxItem>()
  ensureDirs(): void {}
  async write(item: InboxItem): Promise<void> {
    this.items.set(item.itemId, JSON.parse(JSON.stringify(item)) as InboxItem)
  }
  async get(itemId: string): Promise<InboxItem | null> {
    return this.items.get(itemId) ?? null
  }
  async listPending(userId: string): Promise<InboxItem[]> {
    return [...this.items.values()].filter((i) => i.userId === userId && i.status === 'pending')
  }
  async markResolved(itemId: string, decision: InboxDecision, now = 0): Promise<InboxItem> {
    const it = this.items.get(itemId)
    if (!it) throw new InboxError('not_found', 'x')
    if (it.status !== 'pending') throw new InboxError('already_resolved', 'x')
    const r: InboxItem = { ...it, status: 'resolved', decision, resolvedAt: now }
    this.items.set(itemId, r)
    return r
  }
  async delegate(
    itemId: string,
    toUserId: string,
    opts: { actor: string; note?: string; now?: number },
  ): Promise<InboxItem> {
    const it = this.items.get(itemId)
    if (!it) throw new InboxError('not_found', 'x')
    if (it.status !== 'pending') throw new InboxError('already_resolved', 'x')
    const r: InboxItem = { ...it, userId: toUserId }
    this.items.set(itemId, r)
    void opts
    return r
  }
}

function makeTask(over: {
  id?: string
  payload: unknown
  ancestry?: { taskId: string; by: string }[]
}): Task {
  return {
    id: over.id ?? 'task-1',
    from: 'workflow:demo',
    payload: over.payload,
    ...(over.ancestry ? { ancestry: over.ancestry } : {}),
  } as unknown as Task
}

const goodPayload = {
  assignee: 'user-a',
  kind: 'approval',
  prompt: 'Approve the plan?',
}

describe('HumanInboxParticipant.handleTask', () => {
  it('writes a pending item then suspends with the FAR-FUTURE resumeAt', async () => {
    const store = new MemStore()
    const broker = new HumanInboxParticipant({ store, now: () => 1234 })
    const task = makeTask({
      id: 'child-1',
      payload: goodPayload,
      ancestry: [{ taskId: 'wf-trigger', by: 'workflow:demo' }],
    })

    let suspend: unknown
    try {
      await broker.onTask(task)
      throw new Error('expected onTask to suspend')
    } catch (err) {
      suspend = err
    }
    expect(isSuspendTaskError(suspend)).toBe(true)
    expect((suspend as SuspendTaskError).resumeAt).toBe(NEVER_RESUME_AT)

    const item = await store.get('child-1')
    expect(item).toMatchObject({
      itemId: 'child-1',
      userId: 'user-a',
      kind: 'approval',
      prompt: 'Approve the plan?',
      parent: { taskId: 'wf-trigger', by: 'workflow:demo' },
      parentKind: 'workflow',
      // IMA-M1 — a human step is addressed to exactly this person, so it is
      // answerable from their bound IM chat too (whitelist flag, set at write).
      imApprovable: true,
      status: 'pending',
      createdAt: 1234,
    })
  })

  it('classifies parentKind from the last ancestry node', async () => {
    const store = new MemStore()
    const broker = new HumanInboxParticipant({ store })

    const cases: Array<[{ taskId: string; by: string }[] | undefined, string]> = [
      [[{ taskId: 't', by: 'workflow:x' }], 'workflow'],
      [[{ taskId: 't', by: 'some-agent' }], 'agent'],
      [undefined, 'none'],
    ]
    for (let i = 0; i < cases.length; i++) {
      const [ancestry, expected] = cases[i]!
      const id = `c-${i}`
      const task = makeTask({ id, payload: goodPayload, ...(ancestry ? { ancestry } : {}) })
      await broker.onTask(task).catch(() => {})
      expect((await store.get(id))!.parentKind).toBe(expected)
    }
  })

  it('fails (does not suspend) on a malformed payload — no item written', async () => {
    const store = new MemStore()
    const broker = new HumanInboxParticipant({ store })
    const task = makeTask({ id: 'bad', payload: { kind: 'approval', prompt: 'x' } }) // missing assignee

    const res = await broker.onTask(task)
    expect(res.kind).toBe('failed')
    expect(res.kind === 'failed' && res.error).toContain('assignee')
    expect(await store.get('bad')).toBeNull()
  })
})

describe('HumanInboxParticipant.handleResume', () => {
  it('returns the injected answer as the ok output', async () => {
    const broker = new HumanInboxParticipant({ store: new MemStore() })
    const decision: InboxDecision = { kind: 'approval', approved: true, comment: 'lgtm' }
    const res = await broker.onResume(makeTask({ payload: {} }), { answer: decision })
    expect(res.kind).toBe('ok')
    expect(res.kind === 'ok' && res.output).toEqual(decision)
  })

  it('re-suspends when the resume state carries no answer', async () => {
    const broker = new HumanInboxParticipant({ store: new MemStore() })
    let thrown: unknown
    try {
      await broker.onResume(makeTask({ payload: {} }), { inboxItemId: 'child-1' })
      throw new Error('expected re-suspend')
    } catch (err) {
      thrown = err
    }
    expect(isSuspendTaskError(thrown)).toBe(true)
  })
})

describe('parseHumanPayload', () => {
  it('accepts a minimal approval payload', () => {
    expect(parseHumanPayload(goodPayload)).toEqual({
      assignee: 'user-a',
      kind: 'approval',
      prompt: 'Approve the plan?',
    })
  })

  it('requires non-empty options for kind=choice, and accepts string shorthand', () => {
    expect(() =>
      parseHumanPayload({ assignee: 'u', kind: 'choice', prompt: 'Pick' }),
    ).toThrowError(InboxError)
    const parsed = parseHumanPayload({
      assignee: 'u',
      kind: 'choice',
      prompt: 'Pick',
      options: ['yes', { value: 'no', label: 'No way' }],
    })
    expect(parsed.options).toEqual([{ value: 'yes' }, { value: 'no', label: 'No way' }])
  })

  it('rejects a bad kind and an empty prompt', () => {
    expect(() => parseHumanPayload({ assignee: 'u', kind: 'nope', prompt: 'x' })).toThrowError(
      InboxError,
    )
    expect(() => parseHumanPayload({ assignee: 'u', kind: 'edit', prompt: '' })).toThrowError(
      InboxError,
    )
  })
})
