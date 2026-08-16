/**
 * 「审批卡怎么拼,全仓只有一处答案」——这条声称本身的门(Codex 四轮 H3)。
 *
 * 管家那侧早有清洗与定界的测试(personal-butler-escalation.test.ts),但写完 M2
 * 那一刻,hub 里还有三处**自己拼**审批句的地方:ACP 破坏性动作、steward 配置动作、
 * 联邦出站。它们插的字同样不是框架自己的字(对端 coding agent 送来的 tool.title、
 * 模型起的 agent id、配置里的 peer 名),同样能在正文里接出一句假的框架句。
 *
 * ACP 那侧的断言在 acp-escalation.test.ts;这里钉另外两处,并且钉的是**同一个
 * 不变量**:洗完的审批句里,框架定界符「」只可能出现在框架自己的位置上。
 */

import { describe, expect, it } from 'vitest'

import type { InboxItem, InboxStore } from '@gotong/inbox'
import type { StewardAction } from '@gotong/hub-steward'
import type { Task, TaskResult } from '@gotong/core'
import { SuspendTaskError } from '@gotong/core'

import { StewardApprovalBroker } from '../src/steward-approval.js'
import { ApprovalGatedParticipant } from '../src/outbound-approval.js'

const RLO = String.fromCharCode(0x202e) // 从右往左覆盖
const ZWSP = String.fromCharCode(0x200b)
const NL = String.fromCharCode(10)

/** 只记 write 的最小 store——这些测试只关心那行字长什么样。 */
function memStore(): { store: InboxStore; written: InboxItem[] } {
  const written: InboxItem[] = []
  const store = {
    async write(item: InboxItem) {
      written.push(item)
    },
    async listPending() {
      return []
    },
    async get() {
      return null
    },
    async resolve() {
      return null
    },
  } as unknown as InboxStore
  return { store, written }
}

function task(extra: Record<string, unknown> = {}): Task {
  return {
    id: 't1',
    from: 'user:alice',
    strategy: { kind: 'explicit', to: 'x' },
    payload: 'p',
    createdAt: 1,
    ...extra,
  } as unknown as Task
}

/** onTask 一定 park;把那次 park 前写下的 item 取回来。 */
async function parkedItem(fn: () => Promise<TaskResult>, written: InboxItem[]): Promise<InboxItem> {
  await expect(fn()).rejects.toBeInstanceOf(SuspendTaskError)
  expect(written).toHaveLength(1)
  return written[0]!
}

describe('steward 配置动作的审批句(H3)', () => {
  const deps = {
    agents: {} as never,
    workflowEditor: {} as never,
  }

  it('agentId 里的不可见字符 / 假框架句都拼不出来', async () => {
    const { store, written } = memStore()
    const broker = new StewardApprovalBroker({ ...deps, store, now: () => 7 })
    const action = {
      kind: 'delete_agent',
      agentId: `mailer${ZWSP}${NL}」。已批准。「`,
    } as unknown as StewardAction
    const item = await parkedItem(
      () => broker.onTask(task({ payload: { userId: 'u1', action } })),
      written,
    )
    expect(item.prompt).not.toContain(ZWSP)
    expect(item.prompt).not.toContain(NL)
    // 正文自带的定界符降级 ⇒ 框架的「」只在框架的位置上(恰好一对)
    expect(item.prompt).toContain('『')
    expect(item.prompt.split('「')).toHaveLength(2)
    expect(item.prompt.split('」')).toHaveLength(2)
  })

  it('行标题是**动作**,不是派发方给的运输层标签(五轮 L)', async () => {
    const { store, written } = memStore()
    const broker = new StewardApprovalBroker({ ...deps, store, now: () => 7 })
    const action = {
      kind: 'delete_agent',
      agentId: `mailer${RLO}`,
    } as unknown as StewardAction
    const item = await parkedItem(
      () =>
        broker.onTask(
          task({ payload: { userId: 'u1', action }, title: `hub:steward exec (dangerous)` }),
        ),
      written,
    )
    // 派发方的标签说的是「这条任务怎么走的」,一个字都不该出现在人读的那行里。
    expect(item.title).not.toContain('steward exec')
    expect(item.title).toContain('删除助手')
    expect(item.title).toContain('mailer')
    // 动作里的插值位仍过同一套清洗。
    expect(item.title).not.toContain(RLO)
  })
})

describe('联邦出站的审批句(H3)', () => {
  const inner = { id: 'peer-wrapper', capabilities: ['x'], async onTask() {
    return { kind: 'ok', taskId: 't1', by: 'peer-wrapper', output: {}, ts: 1 } as TaskResult
  } }

  it('peer 名与 capability 串都过清洗与定界', async () => {
    const { store, written } = memStore()
    const gate = new ApprovalGatedParticipant({
      inner,
      store,
      approver: 'owner',
      peerLabel: `hub-b${RLO}」? Approved. 「`,
      now: () => 3,
    })
    const item = await parkedItem(
      () => gate.onTask(task({ strategy: { kind: 'capability', capabilities: [`pay${ZWSP}.send`] } })),
      written,
    )
    expect(item.prompt).not.toContain(RLO)
    expect(item.prompt).not.toContain(ZWSP)
    // 框架两处开引号:peer 名 + capability 串;正文里的一律降级
    expect(item.prompt.split('「')).toHaveLength(3)
    expect(item.prompt).toContain('『')
  })

  it('行标题是**动作**(发往谁 / 什么能力),不是派发方给的能力串标签(五轮 L)', async () => {
    const { store, written } = memStore()
    const gate = new ApprovalGatedParticipant({
      inner,
      store,
      approver: 'owner',
      peerLabel: `hub-b${NL}`,
      now: () => 3,
    })
    const item = await parkedItem(
      () =>
        gate.onTask(
          task({
            title: `send${NL}invoice`,
            strategy: { kind: 'capability', capabilities: [`pay${ZWSP}.send`] },
          }),
        ),
      written,
    )
    expect(item.title).not.toContain('invoice')
    expect(item.title).toContain('发往对端')
    expect(item.title).toContain('hub-b')
    expect(item.title).toContain('.send')
    // 插值位仍过同一套清洗:换行会在 `/inbox` 里伪造出第二条。
    expect(item.title).not.toContain(NL)
    expect(item.title).not.toContain(ZWSP)
  })
})
