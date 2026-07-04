/**
 * Unit tests for `butlerApprovalItemFor` — the butler-park → /me-approval bridge.
 * The production wiring (real Hub + suspendNotifier + resolve) is exercised by
 * personal-butler-e2e.test.ts; here we pin the pure shaping in isolation.
 */

import { describe, expect, it } from 'vitest'

import { butlerGateState } from '@gotong/personal-butler'

import { butlerApprovalItemFor } from '../src/personal-butler-escalation.js'

const APPROVER = 'alice'

function governedState() {
  return butlerGateState({
    messages: [{ role: 'user', content: 'delete the mailer agent' }],
    pending: {
      toolUses: [{ type: 'tool_use', id: 'g1', name: 'delete_agent', input: { handle: 'mailer' } }],
      approval: {
        toolName: 'delete_agent',
        title: 'delete_agent(mailer)',
        reason: '危险动作——会永久删除一个 agent',
      },
    },
  })
}

function task(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    from: 'user:alice',
    strategy: { kind: 'explicit', to: 'butler' },
    payload: 'x',
    createdAt: 1000,
    origin: { orgId: 'local', userId: 'alice' },
    ...extra,
  } as never
}

describe('butlerApprovalItemFor', () => {
  it('shapes an approval item from a governed park', () => {
    const item = butlerApprovalItemFor(task('t1'), 'butler', governedState(), {
      approver: APPROVER,
      now: () => 4242,
    })
    expect(item).not.toBeNull()
    expect(item!.itemId).toBe('t1')
    expect(item!.userId).toBe(APPROVER)
    expect(item!.kind).toBe('approval')
    expect(item!.status).toBe('pending')
    expect(item!.createdAt).toBe(4242)
    // The prompt names the butler, the action title, and the reason.
    expect(item!.prompt).toContain('butler')
    expect(item!.prompt).toContain('delete_agent(mailer)')
    expect(item!.prompt).toContain('危险动作')
    // Direct dispatch (no ancestry) → no parent to resume.
    expect(item!.parentKind).toBe('none')
    expect(item!.parent).toBeUndefined()
  })

  it('returns null for a butler park with no pending approval (non-governed suspend)', () => {
    const noPending = butlerGateState({ messages: [{ role: 'user', content: 'hi' }] })
    expect(butlerApprovalItemFor(task('t2'), 'butler', noPending, { approver: APPROVER })).toBeNull()
  })

  it('returns null for state that is not a butler gate state', () => {
    for (const s of [null, undefined, 'x', 42, { foo: 1 }, { v: 999, messages: [] }]) {
      expect(butlerApprovalItemFor(task('t3'), 'butler', s, { approver: APPROVER })).toBeNull()
    }
  })

  it('returns null when no approver is given (cannot route an approval)', () => {
    expect(butlerApprovalItemFor(task('t4'), 'butler', governedState(), { approver: '' })).toBeNull()
  })

  it('derives parentKind=workflow + parent from a workflow ancestry tail', () => {
    const ancestry = [{ taskId: 'run-1', by: 'workflow:cafe-ops' }]
    const item = butlerApprovalItemFor(task('t5', { ancestry }), 'butler', governedState(), {
      approver: APPROVER,
    })
    expect(item!.parentKind).toBe('workflow')
    expect(item!.parent).toEqual({ taskId: 'run-1', by: 'workflow:cafe-ops' })
  })

  it('derives parentKind=agent from a non-workflow ancestry tail', () => {
    const ancestry = [{ taskId: 'p-1', by: 'orchestrator' }]
    const item = butlerApprovalItemFor(task('t6', { ancestry }), 'butler', governedState(), {
      approver: APPROVER,
    })
    expect(item!.parentKind).toBe('agent')
    expect(item!.parent).toEqual({ taskId: 'p-1', by: 'orchestrator' })
  })

  it('carries the task title when present', () => {
    const item = butlerApprovalItemFor(task('t7', { title: '删除 mailer' }), 'butler', governedState(), {
      approver: APPROVER,
    })
    expect(item!.title).toBe('删除 mailer')
  })
})
