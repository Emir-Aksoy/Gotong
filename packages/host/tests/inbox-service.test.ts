/**
 * Phase 16 M5 — HostInboxService two-step resume.
 *
 * Real Hub (InMemoryStorage) + real IdentityStore (tmp sqlite) + real broker
 * (HumanInboxParticipant + FileInboxStore) + a production-shaped suspendNotifier
 * that persists parked tasks to the store. The "parent workflow" is a stub that
 * records each onResume (and can re-suspend) — the real runner's output
 * propagation is the M7 E2E's job. Here we pin the orchestration: child strictly
 * before parent, both rows removed on completion, the markResolved race guard,
 * and the parent row kept on re-suspend.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, InMemoryStorage, SuspendTaskError, type Participant, type Task } from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'
import { FileInboxStore, HumanInboxParticipant, HUMAN_CAPABILITY, NEVER_RESUME_AT } from '@aipehub/inbox'

import { HostInboxService } from '../src/inbox-service.js'

describe('HostInboxService — two-step resume', () => {
  let tmp: string
  let identity: IdentityStore
  let hub: Hub
  let store: FileInboxStore
  let service: HostInboxService
  let parentResumes: Array<{ task: Task; state: unknown }>
  let parentSuspendAgain: boolean

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-inbox-svc-'))
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
    hub = new Hub({
      storage: new InMemoryStorage(),
      // Production-shaped: persist parked tasks to the real store so resolve()
      // can getSuspendedTask them out of band (just like the host wiring).
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
    await hub.start()

    store = new FileInboxStore(tmp)
    store.ensureDirs()
    hub.register(new HumanInboxParticipant({ store }))

    // Stub "workflow" parent — never dispatched-to, only resumed.
    parentResumes = []
    parentSuspendAgain = false
    const stubWorkflow: Participant = {
      id: 'workflow:demo',
      kind: 'agent',
      capabilities: [],
      async onTask(task) {
        return { kind: 'ok', taskId: task.id, output: null, by: 'workflow:demo', ts: 1 }
      },
      async onResume(task, state) {
        parentResumes.push({ task, state })
        if (parentSuspendAgain) throw new SuspendTaskError({ resumeAt: NEVER_RESUME_AT, state })
        return { kind: 'ok', taskId: task.id, output: 'parent-resumed', by: 'workflow:demo', ts: 1 }
      },
    }
    hub.register(stubWorkflow)

    service = new HostInboxService({ hub, store, identity })
  })

  afterEach(async () => {
    await hub.stop()
    identity.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  /** Dispatch a human task to the broker (parking it) and return its child id. */
  async function park(
    payload: Record<string, unknown>,
    ancestry: { taskId: string; by: string }[] = [{ taskId: 'wf-trigger', by: 'workflow:demo' }],
  ): Promise<string> {
    const fired = await hub.dispatch({
      from: 'workflow:demo',
      strategy: { kind: 'capability', capabilities: [HUMAN_CAPABILITY] },
      payload,
      ancestry,
    })
    expect(fired.kind).toBe('suspended')
    const [item] = await store.listPending(payload.assignee as string)
    if (!item) throw new Error('expected a pending inbox item')
    return item.itemId
  }

  /** Persist a parent workflow row, as if the runner had suspended. */
  function parkParent(taskId = 'wf-trigger'): void {
    identity.persistSuspendedTask({
      taskId,
      agentId: 'workflow:demo',
      hubId: 'local',
      originUserId: null,
      resumeAt: NEVER_RESUME_AT,
      state: { kind: 'workflow_step_suspended', runState: { runId: 'r1' } },
      taskJson: JSON.stringify({ id: taskId, from: 'admin', payload: {} }),
    })
  }

  it('resumes child then parent, removes both rows, decision is the child output', async () => {
    const childId = await park({ assignee: 'user-a', kind: 'approval', prompt: 'ok?' })
    parkParent()
    expect(identity.getSuspendedTask(childId)).toBeTruthy()

    await service.resolve({
      itemId: childId,
      userId: 'user-a',
      decision: { kind: 'approval', approved: true },
    })

    const childResult = hub.taskResult(childId)
    expect(childResult?.kind).toBe('ok')
    expect(childResult?.kind === 'ok' && childResult.output).toEqual({
      kind: 'approval',
      approved: true,
    })
    expect(identity.getSuspendedTask(childId)).toBeNull()
    expect(identity.getSuspendedTask('wf-trigger')).toBeNull()
    expect(parentResumes).toHaveLength(1)
    expect(parentResumes[0]!.state).toMatchObject({ kind: 'workflow_step_suspended' })
    expect((await store.get(childId))!.status).toBe('resolved')
  })

  it('writes an inbox_resolve audit row + item history on resolve (inbox-gov M1)', async () => {
    const childId = await park({ assignee: 'user-a', kind: 'approval', prompt: 'ok?' })
    parkParent()
    await service.resolve({
      itemId: childId,
      userId: 'user-a',
      decision: { kind: 'approval', approved: true, comment: 'lgtm' },
    })

    // The generic audit query surfaces it by action — no inbox-specific route.
    const rows = identity.listAuditLog({ action: 'inbox_resolve' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      action: 'inbox_resolve',
      actorUserId: 'user-a',
      actorSource: 'v4-session',
      success: true,
    })
    expect(rows[0]!.metadata).toEqual({
      itemId: childId,
      kind: 'approval',
      parentKind: 'workflow',
      outcome: 'approved',
    })

    // The item carries its own action trail (the comment becomes the note).
    const item = await store.get(childId)
    expect(item!.history).toEqual([
      { type: 'resolved', actor: 'user-a', note: 'lgtm', at: expect.any(Number) },
    ])
  })

  it('audit outcome reflects the decision; edit free-text never enters metadata', async () => {
    // Rejected approval → outcome 'rejected'.
    const rej = await park({ assignee: 'user-a', kind: 'approval', prompt: 'ok?' })
    await service.resolve({
      itemId: rej,
      userId: 'user-a',
      decision: { kind: 'approval', approved: false },
    })
    // Edit → outcome 'edited', the free text is NOT copied into the audit blob.
    const ed = await park({ assignee: 'user-b', kind: 'edit', prompt: 'fix' }, [
      { taskId: 'agent-task', by: 'some-agent' },
    ])
    await service.resolve({
      itemId: ed,
      userId: 'user-b',
      decision: { kind: 'edit', value: 'a long secret correction the audit must not store' },
    })

    const rows = identity.listAuditLog({ action: 'inbox_resolve' })
    const byItem = new Map(rows.map((r) => [r.metadata?.itemId, r.metadata?.outcome]))
    expect(byItem.get(rej)).toBe('rejected')
    expect(byItem.get(ed)).toBe('edited')
    const edRow = rows.find((r) => r.metadata?.itemId === ed)
    expect(JSON.stringify(edRow!.metadata)).not.toContain('secret correction')
  })

  it('resolves with "request changes" — outcome changes_requested, decision flows to output (inbox-gov M3)', async () => {
    const childId = await park({ assignee: 'user-a', kind: 'approval', prompt: 'ok?' })
    parkParent()
    const decision = {
      kind: 'approval',
      approved: false,
      changesRequested: true,
      comment: 'fix section 3',
    }
    await service.resolve({ itemId: childId, userId: 'user-a', decision })

    // The child task's ok output IS the validated decision, so a workflow
    // `when: $gate.output.changesRequested == true` can loop back to a revise step.
    const childResult = hub.taskResult(childId)
    expect(childResult?.kind === 'ok' && childResult.output).toEqual(decision)
    // Audited as a distinct outcome (not 'rejected').
    const rows = identity.listAuditLog({ action: 'inbox_resolve' })
    expect(rows.find((r) => r.metadata?.itemId === childId)?.metadata?.outcome).toBe(
      'changes_requested',
    )
  })

  it('rejects an incoherent / unsubstantiated request-changes decision (inbox-gov M3)', async () => {
    const a = await park({ assignee: 'user-a', kind: 'approval', prompt: 'ok?' })
    // approve + request-changes at once is incoherent
    await expect(
      service.resolve({
        itemId: a,
        userId: 'user-a',
        decision: { kind: 'approval', approved: true, changesRequested: true, comment: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_decision' })
    // request-changes with no comment gives the revise step nothing to act on
    await expect(
      service.resolve({
        itemId: a,
        userId: 'user-a',
        decision: { kind: 'approval', approved: false, changesRequested: true },
      }),
    ).rejects.toMatchObject({ code: 'invalid_decision' })
    // Item untouched — a rejected decision never flips it out of pending.
    expect((await store.get(a))!.status).toBe('pending')
  })

  it('delegates a pending item to another user by email + audits it (inbox-gov M2)', async () => {
    const bob = identity.createUser({
      email: 'bob@team.test',
      displayName: 'Bob',
      password: 'bob-strong-password',
      role: 'member',
    })
    const childId = await park({ assignee: 'user-a', kind: 'approval', prompt: 'ok?' })

    await service.delegate({
      itemId: childId,
      userId: 'user-a',
      toEmail: 'bob@team.test',
      note: 'you own this now',
    })

    const item = await store.get(childId)
    expect(item!.status).toBe('pending') // still pending — a handoff, not a resolve
    expect(item!.userId).toBe(bob.id) // reassigned to the resolved target id
    expect(item!.history).toEqual([
      { type: 'delegated', actor: 'user-a', to: bob.id, note: 'you own this now', at: expect.any(Number) },
    ])
    // The new assignee sees it; the old one no longer does.
    expect((await store.listPending(bob.id)).map((i) => i.itemId)).toEqual([childId])
    expect(await store.listPending('user-a')).toEqual([])
    // …and the recipient's PUBLIC view carries the handoff context (the note),
    // but never the delegator's user id.
    const view = await service.listPending(bob.id)
    expect(view).toHaveLength(1)
    expect(view[0]!.handoffNote).toBe('you own this now')
    expect(JSON.stringify(view[0])).not.toContain('user-a')

    const rows = identity.listAuditLog({ action: 'inbox_delegate' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actorUserId: 'user-a', success: true })
    // The handoff REASON stays in the item history, not the audit blob.
    expect(rows[0]!.metadata).toEqual({
      itemId: childId,
      kind: 'approval',
      from: 'user-a',
      to: bob.id,
      hasNote: true,
    })
  })

  it('delegate rejects unknown email, self-target, and a non-owner — item untouched', async () => {
    const alice = identity.createUser({
      email: 'alice@team.test',
      displayName: 'Alice',
      password: 'alice-strong-password',
      role: 'member',
    })
    const childId = await park({ assignee: alice.id, kind: 'approval', prompt: 'ok?' })

    await expect(
      service.delegate({ itemId: childId, userId: alice.id, toEmail: 'ghost@team.test' }),
    ).rejects.toMatchObject({ code: 'invalid_target' })
    await expect(
      service.delegate({ itemId: childId, userId: alice.id, toEmail: 'alice@team.test' }),
    ).rejects.toMatchObject({ code: 'invalid_target' })
    await expect(
      service.delegate({ itemId: childId, userId: 'someone-else', toEmail: 'alice@team.test' }),
    ).rejects.toMatchObject({ code: 'forbidden' })

    // No partial mutation, no stray audit rows on any failure.
    expect((await store.get(childId))!.userId).toBe(alice.id)
    expect(identity.listAuditLog({ action: 'inbox_delegate' })).toHaveLength(0)
  })

  it('a second resolve is rejected (already_resolved) without a second resume', async () => {
    const childId = await park({ assignee: 'user-a', kind: 'approval', prompt: 'ok?' })
    parkParent()
    await service.resolve({
      itemId: childId,
      userId: 'user-a',
      decision: { kind: 'approval', approved: true },
    })
    expect(parentResumes).toHaveLength(1)

    await expect(
      service.resolve({
        itemId: childId,
        userId: 'user-a',
        decision: { kind: 'approval', approved: false },
      }),
    ).rejects.toMatchObject({ code: 'already_resolved' })
    expect(parentResumes).toHaveLength(1)
  })

  it('keeps the parent row when the workflow re-suspends on another human step', async () => {
    const childId = await park({ assignee: 'user-a', kind: 'approval', prompt: 'ok?' })
    parkParent()
    parentSuspendAgain = true

    await service.resolve({
      itemId: childId,
      userId: 'user-a',
      decision: { kind: 'approval', approved: true },
    })

    expect(identity.getSuspendedTask(childId)).toBeNull()
    expect(identity.getSuspendedTask('wf-trigger')).toBeTruthy()
  })

  it('rejects a non-owner (forbidden) and an unknown item (not_found)', async () => {
    const childId = await park({ assignee: 'user-a', kind: 'approval', prompt: 'ok?' })
    await expect(
      service.resolve({
        itemId: childId,
        userId: 'user-b',
        decision: { kind: 'approval', approved: true },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      service.resolve({
        itemId: 'ghost',
        userId: 'user-a',
        decision: { kind: 'approval', approved: true },
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects a decision whose kind mismatches the item (invalid_decision)', async () => {
    const childId = await park({ assignee: 'user-a', kind: 'approval', prompt: 'ok?' })
    await expect(
      service.resolve({
        itemId: childId,
        userId: 'user-a',
        decision: { kind: 'choice', value: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_decision' })
    expect((await store.get(childId))!.status).toBe('pending')
  })

  it('with an agent (non-workflow) parent, resumes only the child', async () => {
    const childId = await park({ assignee: 'user-a', kind: 'edit', prompt: 'fix' }, [
      { taskId: 'agent-task', by: 'some-agent' },
    ])
    expect((await store.get(childId))!.parentKind).toBe('agent')

    await service.resolve({
      itemId: childId,
      userId: 'user-a',
      decision: { kind: 'edit', value: 'fixed' },
    })

    expect(hub.taskResult(childId)?.kind).toBe('ok')
    expect(parentResumes).toHaveLength(0)
  })
})
