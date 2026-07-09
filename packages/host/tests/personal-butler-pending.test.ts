/**
 * A1 待办审批提醒 — the zero-LLM card that makes the butler aware of parked
 * `/me` approvals the member hasn't acted on.
 *
 * Pins: (1) the card counts + lists (title over prompt, kind labels, overflow
 * summed, long text trimmed); (2) the probe self-gates — null when the inbox
 * isn't wired, null on an empty inbox, null + warn on a read fault (advisory);
 * (3) it scopes the read to THIS member's userId.
 */

import { describe, expect, it } from 'vitest'

import {
  buildButlerPendingProbe,
  buildPendingCard,
  type ButlerPendingItem,
  type ButlerPendingSource,
} from '../src/personal-butler-pending.js'

const fakeTask = { id: 't-1' } as never

function items(...xs: ButlerPendingItem[]): ButlerPendingItem[] {
  return xs
}

describe('buildPendingCard', () => {
  it('leads with the count and points at /me', () => {
    const card = buildPendingCard(items({ kind: 'approval', title: '删除 mailer' }))
    expect(card).toContain('还有 1 件事在等他本人确认')
    expect(card).toContain('/me 收件箱')
    expect(card).toContain('[待批准] 删除 mailer')
  })

  it('labels each human-step kind and prefers title over prompt', () => {
    const card = buildPendingCard(
      items(
        { kind: 'approval', title: '批一笔支出', prompt: 'ignored when title present' },
        { kind: 'choice', prompt: '选 A 还是 B' },
        { kind: 'edit', title: '改文案' },
      ),
    )
    expect(card).toContain('[待批准] 批一笔支出')
    expect(card).toContain('[待选择] 选 A 还是 B')
    expect(card).toContain('[待修改] 改文案')
  })

  it('lists at most maxListed and sums the overflow', () => {
    const many = items(
      { kind: 'approval', title: 'a' },
      { kind: 'approval', title: 'b' },
      { kind: 'approval', title: 'c' },
      { kind: 'approval', title: 'd' },
      { kind: 'approval', title: 'e' },
    )
    const card = buildPendingCard(many, 3)
    expect(card).toContain('还有 5 件事在等他本人确认')
    expect(card).toContain('1. [待批准] a')
    expect(card).toContain('3. [待批准] c')
    expect(card).not.toContain('4. [待批准] d')
    expect(card).toContain('（还有 2 件未列出）')
  })

  it('trims a long body to keep the tail compact', () => {
    const long = 'x'.repeat(100)
    const card = buildPendingCard(items({ kind: 'approval', prompt: long }))
    expect(card).toContain('…')
    expect(card).not.toContain(long)
  })
})

describe('buildButlerPendingProbe — self-gating advisory', () => {
  it('null when the inbox source is not wired (no identity)', async () => {
    const probe = buildButlerPendingProbe({ userId: 'u1', pending: () => undefined })
    expect(await probe()).toBeNull()
  })

  it('null on an empty inbox — prompt stays byte-identical', async () => {
    const source: ButlerPendingSource = { async listPending() { return [] } }
    const probe = buildButlerPendingProbe({ userId: 'u1', pending: () => source })
    expect(await probe()).toBeNull()
  })

  it('injects a card scoped to THIS member', async () => {
    const seen: string[] = []
    const source: ButlerPendingSource = {
      async listPending(userId) {
        seen.push(userId)
        return [{ kind: 'approval', title: '删除 mailer' }]
      },
    }
    const probe = buildButlerPendingProbe({ userId: 'alice', pending: () => source })
    const card = await probe()
    expect(seen).toEqual(['alice']) // read scoped to the member
    expect(card).toContain('[待批准] 删除 mailer')
  })

  it('null + warn on a read fault (a sick inbox never takes chat down)', async () => {
    const warns: unknown[][] = []
    const source: ButlerPendingSource = {
      async listPending() {
        throw new Error('db locked')
      },
    }
    const probe = buildButlerPendingProbe({
      userId: 'u1',
      pending: () => source,
      logger: { warn: (...a: unknown[]) => warns.push(a) },
    })
    expect(await probe()).toBeNull()
    expect(warns.length).toBe(1)
  })
})

// The probe accepts a no-arg call (composeContextProbes passes a task, but the
// probe ignores it) — assert the signature stays task-tolerant.
describe('probe signature', () => {
  it('tolerates being called with a task arg', async () => {
    const source: ButlerPendingSource = {
      async listPending() {
        return [{ kind: 'approval', title: 't' }]
      },
    }
    const probe = buildButlerPendingProbe({ userId: 'u1', pending: () => source }) as (
      task?: unknown,
    ) => Promise<string | null>
    expect(await probe(fakeTask)).toContain('[待批准] t')
  })
})
