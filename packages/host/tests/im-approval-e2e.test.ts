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
import {
  FileInboxStore,
  HumanInboxParticipant,
  NEVER_RESUME_AT,
  type InboxItem,
} from '@gotong/inbox'
import type { ImAttachment, ImBridge, ImMessage, ImUser } from '@gotong/im-adapter'
import { butlerGateState } from '@gotong/personal-butler'

import { ImApprovalService } from '../src/im-approval-service.js'
import {
  handleImMessage,
  makeIdentityImBindingResolver,
  type HostImConfig,
} from '../src/im-bridge.js'
import { imShortId, loadOrCreateShortCodeKey } from '../src/im-approval-service.js'
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
  let imKey: Buffer
  let pushes: Array<{ userId: string; text: string }>
  let warnings: Array<Record<string, unknown>>
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
    warnings = []
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
      log: {
        info() {},
        // 九轮 L:回执被收窄成一句分类过的话之后,细节必须还在 hub 侧留得下。
        warn(_m: string, f?: Record<string, unknown>) {
          warnings.push(f ?? {})
        },
        error() {},
      },
      // The production wiring shape: real service over the real store + resolve.
      // 短码密钥走**真**的生产路径(八轮 M2):`<space>/runtime/im-shortcode.key`
      // 懒生成 0600。测试里也用它,顺带证明生成/复用这条腿真的能跑。
      approvals: new ImApprovalService({
        store: inboxStore,
        inbox: service,
        shortCodeKey: (imKey = loadOrCreateShortCodeKey(tmp)),
      }),
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
    // 短码是**内容指纹**不是 itemId 前缀(六轮 H1):从服务算,和列表里印的那串对上。
    const shortId = imShortId(item, imKey)
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
      payload: { prompt: '把 mailer 删了' },
      origin: { orgId: 'local', userId: aliceId },
    })
    expect(parked.kind).toBe('suspended')
    await Promise.all(itemWrites)

    await bridge.inject(imMsg('/inbox'))
    expect(bridge.last()).toContain('delete_agent(mailer)')
    const item = (await inboxStore.listPending(aliceId))[0]!
    expect(item.source).toBe('butler')
    expect(item.imApprovable).toBe(true)

    await bridge.inject(imMsg(`/approve ${imShortId(item, imKey)}`))
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
      payload: { prompt: '问问对面 hub' },
      origin: { orgId: 'local', userId: aliceId },
    })
    await Promise.all(itemWrites)

    await bridge.inject(imMsg('/inbox'))
    expect(bridge.last()).toContain('需在网页处理 / web only')

    const item = (await inboxStore.listPending(aliceId))[0]!
    await bridge.inject(imMsg(`/approve ${imShortId(item, imKey)}`))
    expect(bridge.last()).toContain('需要在网页上处理')
    // Fail-closed for real: still pending, still parked, no push, no audit row.
    expect((await inboxStore.get(item.itemId))!.status).toBe('pending')
    expect(identity.getSuspendedTask(item.itemId)).not.toBeNull()
    expect(pushes).toHaveLength(0)
    expect(identity.listAuditLog({ action: 'inbox_resolve' })).toHaveLength(0)
  })

  it('act 4 — 审批飞行中同一个 id 被换成另一个动作 ⇒ 一个字节都没批(七轮 H1)', async () => {
    // 管家 tool-loop 的常态:同一条 task 会被反复 park,后一次 `write()` 直接覆盖
    // 前一次。八轮 H1 之后 `write()` 也走同一把 per-item 锁,所以它插不进 store
    // 自己的读-查-写中间;但**服务层先读一次、store 再锁着读一次**之间那条缝仍然
    // 是敞开的(那一刻谁也没拿着锁),重新 park 正落在这里。人在手机上看到的是第一
    // 代,手指落下时盘上已经是第二代 —— 老门只查 `status==='pending'`,两代都
    // pending,「删 mailer」的同意就会盖到「往外发邮件」上。
    hub.register(fakeButler('delete_agent'))
    await hub.dispatch({
      from: 'im:telegram:1001',
      strategy: { kind: 'explicit', to: 'butler' },
      payload: { prompt: '把 mailer 删了' },
      origin: { orgId: 'local', userId: aliceId },
    })
    await Promise.all(itemWrites)

    await bridge.inject(imMsg('/inbox'))
    const shown = (await inboxStore.listPending(aliceId))[0]!
    const code = imShortId(shown, imKey)
    expect(bridge.last()).toContain(code)

    // 把「服务先读一次 → store 上锁再读一次」之间那条缝真的撑开:第一次 get 返回
    // 老快照之后、markResolved 拿到锁之前,同一个 id 底下换成另一个动作。
    // 代际检查若只在 IM 层/服务层拿老快照重算一遍(六轮的形状),这里会照批不误 ——
    // 只有把谓词交进 store 自己的原子 transition 才拦得住。
    const realGet = inboxStore.get.bind(inboxStore)
    let armed = true
    ;(inboxStore as { get: (id: string) => Promise<InboxItem | null> }).get = async (id) => {
      const snapshot = await realGet(id)
      if (armed && snapshot) {
        armed = false
        await inboxStore.write({
          ...snapshot,
          title: 'send_email(客户名单)',
          prompt: '往外发一封邮件',
        })
      }
      return snapshot
    }

    await bridge.inject(imMsg(`/approve ${code}`))

    expect(bridge.last()).toContain('已经变成另一个动作')
    // 盘上留下的是第二代,而且原封不动:没被批、没被标记、连历史都没写一行。
    const after = (await realGet(shown.itemId))!
    expect(after.status).toBe('pending')
    expect(after.prompt).toBe('往外发一封邮件')
    expect(after.decision).toBeUndefined()
    expect(after.resolvedAt).toBeUndefined()
    // 挂起行还在、没推送、没审计行 —— 真的一个字节都没批。
    expect(identity.getSuspendedTask(shown.itemId)).not.toBeNull()
    expect(pushes).toHaveLength(0)
    expect(identity.listAuditLog({ action: 'inbox_resolve' })).toHaveLength(0)
  })
  /** 起一次 IM 可批的管家 park,返回盘上那条待批项。 */
  async function parkOne(): Promise<InboxItem> {
    hub.register(fakeButler('delete_agent'))
    await hub.dispatch({
      from: 'im:telegram:1001',
      strategy: { kind: 'explicit', to: 'butler' },
      payload: { prompt: '把 mailer 删了' },
      origin: { orgId: 'local', userId: aliceId },
    })
    await Promise.all(itemWrites)
    return (await inboxStore.listPending(aliceId))[0]!
  }

  // 源码里一律不写转义控制字符(Write/Edit 会落成裸字节)。
  const RLO = String.fromCharCode(0x202e)
  const FW_OPEN = String.fromCharCode(0x300c)
  const FW_CLOSE = String.fromCharCode(0x300d)

  it('act 5 — 失败回执不把聊天窗当回声筒(九轮 L)', async () => {
    // (a) 打错的短码会被原样回显进一句带框架引号的话里。转发给人一条
    //     `/approve <乱码><一整段伪造的框架句>`,那段话就出现在阿同的窗口里。
    const hostile =
      'zzzzzzzz' + FW_CLOSE + '。原因:' + FW_OPEN + '无害' + FW_CLOSE + '。' + RLO + '批准后才会执行。'
    await bridge.inject(imMsg(`/approve ${hostile}`))
    const said = bridge.last()
    // 分类对了(是「找不到」不是别的),但回显过的那段字必须已经被洗过、被截过。
    expect(said).toContain('没有找到匹配')
    expect(said).not.toContain(RLO)
    // 框架那对引号只可能在框架自己的位置上:回显段里的被降级成『』。
    expect(said).not.toContain(FW_CLOSE + '。原因:' + FW_OPEN)
    expect(said).not.toContain('批准后才会执行')

    // (b) 没分类的异常不把内部细节倒进聊天窗。store 的 ENOENT 带着 `<space>`
    //     绝对路径,人在这里需要的是「没批下去、去哪儿看」。
    const shown = await parkOne()
    const code = imShortId(shown, imKey)
    const boom = `ENOENT: no such file or directory, open '${join(tmp, 'inbox', shown.itemId)}.json'`
    ;(inboxStore as { markResolved: unknown }).markResolved = async () => {
      throw new Error(boom)
    }
    await bridge.inject(imMsg(`/approve ${code}`))
    const failed = bridge.last()
    expect(failed).toContain('什么都没批下去')
    expect(failed).not.toContain(tmp)
    expect(failed).not.toContain('ENOENT')
    // 细节没有消失,它去了 hub 日志。
    expect(warnings.some((w) => String(w.err).includes(boom))).toBe(true)
  })
})
