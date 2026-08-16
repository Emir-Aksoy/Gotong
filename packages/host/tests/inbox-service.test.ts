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

import { Hub, InMemoryStorage, SuspendTaskError, type Participant, type Task } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import { FileInboxStore, HumanInboxParticipant, HUMAN_CAPABILITY, NEVER_RESUME_AT } from '@gotong/inbox'

import { HostInboxService } from '../src/inbox-service.js'

describe('HostInboxService — two-step resume', () => {
  let tmp: string
  let identity: IdentityStore
  let hub: Hub
  let store: FileInboxStore
  let service: HostInboxService
  let parentResumes: Array<{ task: Task; state: unknown }>
  let parentSuspendAgain: boolean
  /** Held open by the sibling-race test to keep the first parent resume in flight. */
  let parentGate: Promise<void> | null

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
    parentGate = null
    const stubWorkflow: Participant = {
      id: 'workflow:demo',
      kind: 'agent',
      capabilities: [],
      async onTask(task) {
        return { kind: 'ok', taskId: task.id, output: null, by: 'workflow:demo', ts: 1 }
      },
      async onResume(task, state) {
        parentResumes.push({ task, state })
        if (parentGate) await parentGate
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

  it('两个兄弟人步同时批,父 run 只被 resume 一次(Codex 九轮 H1b)', async () => {
    // 并行分支的两个 human 步各自 park 自己的待批项,但 `parent.taskId` 是**同一
    // 个** run。两人同一秒各批各的:两条 resolve 各自过完自己那把 per-item 锁、
    // 各自读到同一行还在,于是同一次 parking 被 resume 两次 —— run 白白往前走两步。
    //
    // 闸是 `claimSuspendedTask` 这把 CAS。测试把第一次父 resume 卡在门里(parentGate)
    // 撑开那个窗口:没有 CAS 的话第二条一定挤进来。
    const a = await park({ assignee: 'user-a', kind: 'approval', prompt: 'a?' })
    const b = await park({ assignee: 'user-b', kind: 'approval', prompt: 'b?' })
    expect(a).not.toBe(b)
    parkParent() // 一个 run,两个兄弟项都指向它

    let release!: () => void
    parentGate = new Promise<void>((r) => {
      release = r
    })

    const both = Promise.all([
      service.resolve({ itemId: a, userId: 'user-a', decision: { kind: 'approval', approved: true } }),
      service.resolve({ itemId: b, userId: 'user-b', decision: { kind: 'approval', approved: true } }),
    ])
    // 等到窗口真的撑开了再放行:一条已经进了父 resume(卡在门里),另一条的子任务
    // 也已经 resume 完(它下一步就是 resumeParent)。**不能只数 setImmediate**——
    // 落盘是线程池 I/O,空转 20 个 tick 的真实耗时接近 0,两条都还没走到父那一步,
    // 于是「窗口没开」被误读成「闸有效」(这道门第一版就是这么假绿的)。
    const deadline = Date.now() + 3000
    while (
      Date.now() < deadline &&
      !(parentResumes.length > 0 && hub.taskResult(a) && hub.taskResult(b))
    ) {
      await new Promise((r) => setTimeout(r, 1))
    }
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    release()
    await both

    // 两个子任务都各自 resume 完了(闸只管父,不连累子)。
    expect(hub.taskResult(a)?.kind).toBe('ok')
    expect(hub.taskResult(b)?.kind).toBe('ok')
    expect((await store.get(a))!.status).toBe('resolved')
    expect((await store.get(b))!.status).toBe('resolved')
    // 而父 run 恰好一次。
    expect(parentResumes).toHaveLength(1)
    expect(identity.getSuspendedTask('wf-trigger')).toBeNull()
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

  it('records an IM decision as actorSource=im with the channel in metadata.via (IMA-M2)', async () => {
    const childId = await park({ assignee: 'user-a', kind: 'approval', prompt: 'ok?' })
    parkParent()
    await service.resolve({
      itemId: childId,
      userId: 'user-a',
      decision: { kind: 'approval', approved: true },
      via: 'im:telegram',
    })

    const rows = identity.listAuditLog({ action: 'inbox_resolve' })
    expect(rows).toHaveLength(1)
    // The enum stays closed ('im' one value); the platform detail is metadata.
    expect(rows[0]).toMatchObject({ actorSource: 'im', actorUserId: 'user-a' })
    expect(rows[0]!.metadata).toMatchObject({ itemId: childId, via: 'im:telegram' })
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

  it('转派也过代际闸:读到的那一代被换掉,Bob 拿不到她没看过的那件事(Codex 九轮)', async () => {
    // 这道门量的是 **host 传没传谓词**,不是 store 会不会执行谓词(那条在
    // `file-inbox-store.test.ts`)。把重新 park 塞进 store.delegate 调用的一瞬间,
    // 就把「读在锁外、写在锁内」那个窗口变成确定性的:host 若不传谓词,Bob 就会
    // 收到第二代。
    const alice = identity.createUser({
      email: 'alice2@team.test',
      displayName: 'Alice',
      password: 'alice-strong-password',
      role: 'member',
    })
    const bob = identity.createUser({
      email: 'bob2@team.test',
      displayName: 'Bob',
      password: 'bob-strong-password',
      role: 'member',
    })
    const childId = await park({ assignee: alice.id, kind: 'approval', prompt: '读一个文件' })

    const real = store.delegate.bind(store)
    let swapped = false
    store.delegate = async (itemId, toUserId, opts) => {
      if (!swapped) {
        swapped = true
        const cur = (await store.get(itemId))!
        // 管家在同一个 id 下重新 park 了另一个动作 —— 仍然 pending。
        await store.write({ ...cur, prompt: '往外发一封邮件', createdAt: cur.createdAt + 1 })
      }
      return real(itemId, toUserId, opts)
    }
    try {
      await expect(
        service.delegate({ itemId: childId, userId: alice.id, toEmail: 'bob2@team.test' }),
      ).rejects.toMatchObject({ code: 'stale_item' })
    } finally {
      store.delegate = real
    }

    const after = (await store.get(childId))!
    expect(after.userId).toBe(alice.id)
    expect(after.prompt).toBe('往外发一封邮件')
    expect(after.history).toBeUndefined()
    expect(identity.listAuditLog({ action: 'inbox_delegate' })).toHaveLength(0)
    expect(bob.id).not.toBe(alice.id)
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

  it('挂起行与待批项在同一刻取快照:批完之后重新 park 的那条不会被顶上去(八轮 H1)', async () => {
    // `main.ts` 的 suspendNotifier **先**写 `suspended_tasks` 行、**后**写待批项。
    // 于是「批准之后再按 itemId 查一次挂起行」查到的可能是下一代:代际闸放行的是
    // 第 N 代的那件事,真正被 resume 的是第 N+1 代 —— 闸守的东西自己被换掉了,闸就
    // 什么也没守。快照必须和被检查的那条待批项一起取。
    const childId = await park({ assignee: 'user-a', kind: 'approval', prompt: 'ok?' })
    const real = identity.getSuspendedTask.bind(identity)
    let reads = 0
    const decoy = { ...real(childId)!, taskJson: JSON.stringify({ id: 'decoy-task', from: 'x', payload: {} }) }
    ;(identity as unknown as { getSuspendedTask: (id: string) => unknown }).getSuspendedTask = (
      id,
    ) => {
      if (id !== childId) return real(id)
      reads += 1
      return reads === 1 ? real(id) : decoy // 第二次读 = 重新 park 之后的那一代
    }

    await service.resolve({
      itemId: childId,
      userId: 'user-a',
      decision: { kind: 'approval', approved: true },
    })

    // 只读一次 —— 提交之后不再回头查。
    expect(reads).toBe(1)
    // 而且真的是**人批的那条**被 resume 了,冒名那条一次都没跑。
    expect(hub.taskResult(childId)?.kind).toBe('ok')
    expect(hub.taskResult('decoy-task')).toBeUndefined()
  })

  it('决定飞行中被转派给别人 ⇒ 一个字节都不落(八轮 H2)', async () => {
    // `delegate` 单独拿锁,改的是 `userId`,item 仍然 pending,指纹涉及的字段一个
    // 没动。于是「服务层读快照 → 查归属 → 提交」这条路上,Alice 可以在自己还拥有
    // 它的时候通过归属检查,提交时它已经是 Bob 的了 —— 决定照样落在上面。归属必须
    // 钉在**锁内的那份**上。
    const bob = identity.createUser({
      email: 'bob2@team.test',
      displayName: 'Bob',
      password: 'bob-strong-password',
      role: 'member',
    })
    const childId = await park({ assignee: 'user-a', kind: 'approval', prompt: 'ok?' })

    const realGet = store.get.bind(store)
    let armed = true
    ;(store as unknown as { get: (id: string) => Promise<unknown> }).get = async (id) => {
      const snapshot = await realGet(id)
      if (armed) {
        armed = false // delegate 自己也会 get,别递归
        await service.delegate({ itemId: childId, userId: 'user-a', toEmail: 'bob2@team.test' })
      }
      return snapshot
    }

    await expect(
      service.resolve({
        itemId: childId,
        userId: 'user-a',
        decision: { kind: 'approval', approved: true },
      }),
    ).rejects.toMatchObject({ code: 'stale_item' })
    ;(store as unknown as { get: unknown }).get = realGet

    const after = (await store.get(childId))!
    expect(after.status).toBe('pending') // 没被批
    expect(after.userId).toBe(bob.id) // 现在是 Bob 的,等 Bob 自己看
    expect(after.decision).toBeUndefined()
    // 没 resume、没审计行 —— 真的一个字节都没批。
    expect(identity.getSuspendedTask(childId)).not.toBeNull()
    expect(identity.listAuditLog({ action: 'inbox_resolve' })).toHaveLength(0)
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
