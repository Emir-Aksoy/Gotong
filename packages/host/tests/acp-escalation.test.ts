/**
 * acp-escalation unit — the pure park→inbox-item bridge.
 *
 * `acpApprovalItemFor` is the one place the host shapes an ACP permission park
 * into an `approval` InboxItem. It must (a) return null for ANY non-ACP park (so
 * the global suspendNotifier can call it for every suspend without double-writing
 * the broker / approval-gate items), and (b) derive parentKind from ancestry so a
 * workflow-dispatched ACP task gets the two-step recovery.
 */

import { describe, it, expect } from 'vitest'

import type { Task } from '@aipehub/core'
import { acpParkState } from '@aipehub/acp-agent'

import { acpApprovalItemFor } from '../src/acp-escalation.js'

/** Minimal Task factory — only the fields the helper reads. */
function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    from: 'human',
    strategy: { kind: 'capability', capabilities: ['code'] },
    payload: {},
    createdAt: 1,
    ...over,
  } as unknown as Task
}

describe('acpApprovalItemFor', () => {
  const opts = { approver: 'owner-user', now: () => 42 }

  it('returns null for any non-ACP park state', () => {
    // broker / approval-gate parks carry `{ inboxItemId }` — NOT ours.
    expect(acpApprovalItemFor(task(), 'acp', { inboxItemId: 'x' }, opts)).toBeNull()
    expect(acpApprovalItemFor(task(), 'acp', null, opts)).toBeNull()
    expect(acpApprovalItemFor(task(), 'acp', undefined, opts)).toBeNull()
    // a checkpoint-shaped state of a different kind is still skipped.
    expect(
      acpApprovalItemFor(task(), 'acp', { v: 1, kind: 'other', permissionToken: 'p', tool: {} }, opts),
    ).toBeNull()
  })

  it('builds an approval item for an ACP permission park (itemId = task id)', () => {
    const state = acpParkState({
      permissionToken: 'acp-perm-1',
      reason: 'matched destructive pattern /rm -rf/',
      tool: { kind: 'execute', title: 'rm -rf build' },
    })
    const item = acpApprovalItemFor(task(), 'acp-coder', state, opts)
    expect(item).toMatchObject({
      itemId: 't1',
      userId: 'owner-user',
      kind: 'approval',
      parentKind: 'none',
      status: 'pending',
      createdAt: 42,
    })
    // The prompt names WHICH agent and WHAT action, so the approver can judge.
    expect(item!.prompt).toContain('acp-coder')
    expect(item!.prompt).toContain('rm -rf build')
  })

  it('falls back to the tool kind when no title is given', () => {
    const state = acpParkState({
      permissionToken: 'p',
      reason: 'r',
      tool: { kind: 'delete', title: undefined },
    })
    expect(acpApprovalItemFor(task(), 'a', state, opts)!.prompt).toContain('delete')
  })

  it('derives parentKind=workflow from a workflow ancestor (two-step recovery)', () => {
    const state = acpParkState({ permissionToken: 'p', reason: 'r', tool: { kind: 'execute', title: 'x' } })
    const item = acpApprovalItemFor(
      task({ ancestry: [{ taskId: 'wf-trigger', by: 'workflow:flow-1' }] } as Partial<Task>),
      'acp',
      state,
      opts,
    )
    expect(item!.parentKind).toBe('workflow')
    expect(item!.parent).toEqual({ taskId: 'wf-trigger', by: 'workflow:flow-1' })
  })

  it('derives parentKind=agent from a non-workflow ancestor', () => {
    const state = acpParkState({ permissionToken: 'p', reason: 'r', tool: { kind: 'execute', title: 'x' } })
    const item = acpApprovalItemFor(
      task({ ancestry: [{ taskId: 'parent-t', by: 'some-agent' }] } as Partial<Task>),
      'acp',
      state,
      opts,
    )
    expect(item!.parentKind).toBe('agent')
  })
})
