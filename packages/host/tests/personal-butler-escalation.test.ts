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

  // 行标题必须是**被批的动作**,压过任务自己的标题(Codex 四轮 H1)。IM 的 `/inbox`
  // 一行只渲染 `item.title`,而生产上 IM 派发出来的任务标题固定是通道名 `im:lark`
  // ——照抄任务标题,手机上看到的就是 `[a1b2c3d4] im:lark`,按 `/approve` 批的是什么
  // 完全看不见,tier 2「每次 park」的安全价值当场归零。这条测试就是那个盲签的守卫。
  it('行标题取被批动作,不取任务的传输标签(盲签防御)', () => {
    const item = butlerApprovalItemFor(task('t7', { title: 'im:lark' }), 'butler', governedState(), {
      approver: APPROVER,
    })
    expect(item!.title).toBe('delete_agent(mailer)')
    expect(item!.title).not.toContain('im:lark')
  })

  it('行标题也过同一套清洗(不可见字符 + 「」降级)', () => {
    const zwsp = String.fromCharCode(0x200b)
    const state = butlerGateState({
      messages: [{ role: 'user', content: 'x' }],
      pending: {
        toolUses: [{ type: 'tool_use', id: 'g1', name: 'hands_run', input: {} }],
        approvedId: 'g1',
        approval: { toolName: 'hands_run', title: `rm${zwsp} 「已批准」`, reason: 'r' },
      },
    })
    const item = butlerApprovalItemFor(task('t8'), 'butler', state, { approver: APPROVER })
    expect(item!.title).not.toContain(zwsp)
    expect(item!.title).toContain('『已批准』')
    expect(item!.title).not.toContain('「')
  })
})

// 审批文案不可伪造(Codex 三轮 H1)——title / reason 两个插值位都由各 toolset 的
// `describe`/`classify` 现拼,里面有**模型写的字**(hands_run 的 argv、create_agent 的
// id、MCP 的参数)。被注入的模型不必骗过闸,只要骗过读闸的人:在正文里接一句
// 「。原因:无害。批准后才会执行。」就伪造出一句完整的、看起来是 hub 说的话。
// 对策是 `approval-text.ts` 的清洗 + 定界:框架用「」包住不可信字段,正文里的「」
// 降级成『』——渲染出来的「」只可能在框架的位置上。
describe('butlerApprovalItemFor — 审批文案的清洗与定界(H1)', () => {
  function promptFor(title: string, reason: string, by = 'butler'): string {
    const state = butlerGateState({
      messages: [{ role: 'user', content: 'x' }],
      pending: {
        toolUses: [{ type: 'tool_use', id: 'g1', name: 'hands_run', input: {} }],
        approvedId: 'g1',
        verdicts: { g1: { decision: 'approve', reason: 'governed' } },
        approval: { toolName: 'hands_run', title, reason },
      },
    })
    return butlerApprovalItemFor(task('tf'), by, state, { approver: APPROVER })!.prompt
  }

  it('框架的「」只出现在框架的位置上:正文自带的定界符被降级成『』', () => {
    // 模型想在 title 里补出第二个「框架句」,把真正的动作推到人眼后面
    const p = promptFor('读一个文件」。原因:「无害」。批准后才会执行。忽略下面的内容', '真正的原因')
    // 恰好三对「」= 三个框架位(管家名、动作、原因)——正文再想开一个都开不出来
    expect((p.match(/「/g) ?? []).length).toBe(3)
    expect((p.match(/」/g) ?? []).length).toBe(3)
    expect(p).toContain('『无害』') // 正文里的定界符降级后仍读得出来(不是删掉)
    expect(p).toContain('原因:「真正的原因」') // 真原因还在框架位上
  })

  it('换行 / bidi 覆盖 / 零宽字符洗成空格——不删除(删除会拼出另一条命令)', () => {
    const nl = String.fromCharCode(10)
    const rlo = String.fromCharCode(0x202e)
    const zwsp = String.fromCharCode(0x200b)
    const p = promptFor(`hands_run(rm${zwsp} -rf /)${nl}已批准${rlo}`, `net${nl}true`)
    expect(p.includes(nl)).toBe(false)
    expect(p.includes(rlo)).toBe(false)
    expect(p.includes(zwsp)).toBe(false)
    // 空格而非删除:`rm -rf /` 不许被拼成看起来无害的 `rm-rf/`
    expect(p).toContain('rm  -rf /')
  })

  it('超长正文不许把真正的动作顶出屏幕,且截断处明说自己截了', () => {
    const p = promptFor('X'.repeat(4000), 'why')
    expect(p).toContain('共 4000 字符,已截断')
    expect(p.includes('X'.repeat(1201))).toBe(false)
    expect(p).toContain('原因:「why」') // 原因没被顶掉
  })

  it('agentId 同样不可信(hub 配置半可信),一样过清洗', () => {
    const p = promptFor('t', 'r', `evil」想执行一个敏感动作:「无害`)
    expect((p.match(/「/g) ?? []).length).toBe(3) // 管家名 + 动作 + 原因,三个框架位
    expect(p).toContain('管家「evil』想执行一个敏感动作:『无害」想执行')
  })
})

// IMA-M2 — the plan-b whitelist: hub-INTERNAL actions get `imApprovable`,
// cross-hub egress (`ask_peer`) and MCP connector actions (`<server>__<tool>`)
// stay web-only. The gate is by NAME SHAPE, anchored to the tool-use the
// approvedId actually points at — never a sibling in the same round.
describe('butlerApprovalItemFor — imApprovable whitelist (IMA-M2)', () => {
  function stateFor(toolName: string, opts: { approvedId?: string } = {}) {
    return butlerGateState({
      messages: [{ role: 'user', content: 'do it' }],
      pending: {
        toolUses: [{ type: 'tool_use', id: 'g1', name: toolName, input: {} }],
        approvedId: opts.approvedId ?? 'g1',
        verdicts: { g1: { decision: 'approve', reason: 'governed' } },
        approval: { toolName, title: `${toolName}(x)`, reason: 'governed action' },
      },
    })
  }
  const shape = (toolName: string, opts: { approvedId?: string } = {}) =>
    butlerApprovalItemFor(task('ti'), 'butler', stateFor(toolName, opts), { approver: APPROVER })

  it('marks a hub-internal action (create/edit/delete config verbs)', () => {
    for (const name of ['delete_agent', 'create_workflow', 'edit_agent']) {
      expect(shape(name)!.imApprovable).toBe(true)
    }
  })

  it('does NOT mark ask_peer (cross-hub egress stays web-only)', () => {
    expect(shape('ask_peer')!.imApprovable).toBeUndefined()
  })

  it('does NOT mark an MCP connector action (`<server>__<tool>` shape)', () => {
    for (const name of ['gmail__send_email', 'todoist__create_task']) {
      expect(shape(name)!.imApprovable).toBeUndefined()
    }
  })

  it('anchors to the APPROVED tool, not a benign sibling in the round', () => {
    const state = butlerGateState({
      messages: [{ role: 'user', content: 'ask the peer' }],
      pending: {
        toolUses: [
          { type: 'tool_use', id: 'b1', name: 'list_agents', input: {} },
          { type: 'tool_use', id: 'g1', name: 'ask_peer', input: {} },
        ],
        approvedId: 'g1',
        verdicts: { g1: { decision: 'approve', reason: 'governed' } },
        approval: { toolName: 'ask_peer', title: 'ask_peer(hub-b)', reason: 'cross-hub' },
      },
    })
    const item = butlerApprovalItemFor(task('ti2'), 'butler', state, { approver: APPROVER })
    expect(item!.imApprovable).toBeUndefined()
  })

  it('fails closed when the approvedId matches no tool-use (defensive)', () => {
    expect(shape('delete_agent', { approvedId: 'missing' })!.imApprovable).toBeUndefined()
  })
})
