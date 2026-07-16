/**
 * NET-M2 承重门(单测)— the governed `ask_peer` gate's brain.
 *
 * Pins the three contracts that make the doorway honest BEFORE the two-hub
 * e2e proves the wire:
 *
 *   1. only a CURATED edge is askable (G-M1 advertise=authorize; cross-hub is
 *      capability-addressed, the two-hub e2e proved explicit dies far-side):
 *      null → refuse with curation guidance / [] → refuse 锁死 / whitelist →
 *      capability with unambiguity pre-flight — every refusal actionable;
 *   2. classify refuses nonsense BEFORE parking (unknown peer / empty message /
 *      locked edge / ambiguous cap never waste a member approval), and a valid
 *      ask is always `approve` — never a silent inline `allow` for an outbound;
 *   3. execute re-resolves posture (approval may land minutes later): a changed
 *      edge yields an honest "情况变了", zero dispatches on stale assumptions;
 *      dispatch carries NO origin (the wrapper must stamp the true hub id) and
 *      every TaskResult kind maps to an honest line.
 */

import { describe, expect, it } from 'vitest'

import type { TaskResult } from '@gotong/core'

import {
  buildButlerAskPeerToolset,
  resolveAskPeerRoute,
  type ButlerAskPeerHub,
} from '../src/personal-butler-ask-peer.js'
import type { ButlerPeerRow, ButlerPeerSurface } from '../src/personal-butler-peers.js'

const row = (peerId: string, outboundCaps: string[] | null, label: string | null = null): ButlerPeerRow => ({
  peerId,
  label,
  connected: true,
  lastSeenAt: null,
  outboundCaps,
  trustTier: null,
  pinned: false,
})

const surfaceOf = (rows: ButlerPeerRow[]): ButlerPeerSurface => ({ listForButler: async () => rows })

/** A recording hub: scripted dispatch result + a static local participant set. */
class FakeHub implements ButlerAskPeerHub {
  readonly dispatches: Array<Record<string, unknown>> = []
  result: TaskResult = { kind: 'ok', taskId: 't', by: 'hub-x', output: { text: '好的' }, ts: 1 } as TaskResult
  locals: Array<{ id: string; capabilities: readonly string[] }> = []
  async dispatch(input: {
    from: string
    strategy: { kind: 'capability'; capabilities: string[] }
    payload: unknown
    title: string
  }): Promise<TaskResult> {
    this.dispatches.push({ ...input })
    return this.result
  }
  participants(): Array<{ id: string; capabilities: readonly string[] }> {
    return this.locals
  }
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? '').join('\n')

describe('NET-M2 — resolveAskPeerRoute(派发阶梯纯函数)', () => {
  const none = new Set<string>()

  it('unknown peer → refuse listing the real roster', () => {
    const r = resolveAskPeerRoute({ peerId: 'hub-ghost', capability: null, roster: [row('hub-a', null)], localCaps: none })
    expect(r).toMatchObject({ ok: false })
    if (!r.ok) expect(r.reason).toContain('hub-a')
  })

  it('null edge (未策展) → refuse with curation guidance — never a fake route', () => {
    // ACL 层 null=send-all,但 wrapper 广告为空:capability 派发选不中这条边,
    // explicit 过线后对端也路由不了(两 hub e2e 证过)。唯一诚实答案是拒 + 指路。
    const r = resolveAskPeerRoute({ peerId: 'hub-a', capability: null, roster: [row('hub-a', null)], localCaps: none })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('策展')
  })

  it('locked edge [] → refuse', () => {
    const r = resolveAskPeerRoute({ peerId: 'hub-a', capability: null, roster: [row('hub-a', [])], localCaps: none })
    expect(r).toMatchObject({ ok: false })
    if (!r.ok) expect(r.reason).toContain('锁死')
  })

  it('whitelist sole cap → capability route, auto-picked', () => {
    const r = resolveAskPeerRoute({ peerId: 'hub-a', capability: null, roster: [row('hub-a', ['dad-chat'])], localCaps: none })
    expect(r).toMatchObject({ ok: true, capability: 'dad-chat' })
  })

  it('whitelist multi caps without arg → refuse listing options; with valid arg → route; off-list arg → refuse', () => {
    const roster = [row('hub-a', ['research', 'translate'])]
    const noArg = resolveAskPeerRoute({ peerId: 'hub-a', capability: null, roster, localCaps: none })
    expect(noArg.ok).toBe(false)
    if (!noArg.ok) expect(noArg.reason).toContain('research、translate')

    const good = resolveAskPeerRoute({ peerId: 'hub-a', capability: 'translate', roster, localCaps: none })
    expect(good).toMatchObject({ ok: true, capability: 'translate' })

    const bad = resolveAskPeerRoute({ peerId: 'hub-a', capability: 'hack', roster, localCaps: none })
    expect(bad.ok).toBe(false)
  })

  it('cap also served locally → refuse (routing would land local, never cross)', () => {
    const r = resolveAskPeerRoute({
      peerId: 'hub-a',
      capability: null,
      roster: [row('hub-a', ['chat'])],
      localCaps: new Set(['chat']),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('本地也有人服务')
  })

  it('cap advertised by two edges → refuse (cannot deterministically target)', () => {
    const r = resolveAskPeerRoute({
      peerId: 'hub-a',
      capability: null,
      roster: [row('hub-a', ['research']), row('hub-b', ['research'])],
      localCaps: none,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('多条边')
  })
})

describe('NET-M2 — ask_peer classify(park 前的服务端权威分级)', () => {
  const build = (rows: ButlerPeerRow[], hub = new FakeHub()) =>
    buildButlerAskPeerToolset({ userId: 'u1', peers: surfaceOf(rows), hub })

  it('valid ask on a curated edge → approve(出网必须成员点头,绝无 inline allow)', async () => {
    const v = await build([row('hub-dad', ['dad-chat'], '爸爸的 hub')]).classify('ask_peer', {
      peerId: 'hub-dad',
      message: '今晚有空吗?',
    })
    expect(v.decision).toBe('approve')
    if (v.decision === 'approve') expect(v.reason).toContain('爸爸的 hub')
  })

  it('unknown peer / empty message / uncurated edge / locked edge → refuse BEFORE parking', async () => {
    const toolset = build([row('hub-dad', ['dad-chat']), row('hub-legacy', null), row('hub-locked', [])])
    expect((await toolset.classify('ask_peer', { peerId: 'hub-x', message: 'hi' })).decision).toBe('refuse')
    expect((await toolset.classify('ask_peer', { peerId: 'hub-dad', message: '  ' })).decision).toBe('refuse')
    expect((await toolset.classify('ask_peer', { peerId: 'hub-legacy', message: 'hi' })).decision).toBe('refuse')
    expect((await toolset.classify('ask_peer', { peerId: 'hub-locked', message: 'hi' })).decision).toBe('refuse')
  })

  it('roster read failure → refuse honestly, never approve blind', async () => {
    const toolset = buildButlerAskPeerToolset({
      userId: 'u1',
      peers: { listForButler: async () => { throw new Error('down') } },
      hub: new FakeHub(),
    })
    const v = await toolset.classify('ask_peer', { peerId: 'hub-dad', message: 'hi' })
    expect(v.decision).toBe('refuse')
  })

  it('describe names the peer AND the line the member would be approving', () => {
    const d = build([]).describe('ask_peer', { peerId: 'hub-dad', message: '今晚有空吗?一起吃饭?' })
    expect(d).toContain('hub-dad')
    expect(d).toContain('今晚有空吗')
  })
})

describe('NET-M2 — ask_peer execute(批准后:重解析 + 无 origin 派发 + 诚实文案)', () => {
  it('curated edge: capability dispatch, from=member, NO origin field', async () => {
    const hub = new FakeHub()
    hub.result = { kind: 'ok', taskId: 't', by: 'hub-dad', output: { text: '有空,来吃饭' }, ts: 1 } as TaskResult
    const toolset = buildButlerAskPeerToolset({ userId: 'u1', peers: surfaceOf([row('hub-dad', ['dad-chat'], '爸爸的 hub')]), hub })

    const out = await toolset.callTool('ask_peer', { peerId: 'hub-dad', message: '今晚有空吗?' })

    expect(hub.dispatches).toHaveLength(1)
    const d = hub.dispatches[0]!
    expect(d.strategy).toEqual({ kind: 'capability', capabilities: ['dad-chat'] })
    expect(d.from).toBe('u1')
    expect('origin' in d).toBe(false) // wrapper 必须盖真章,这里绝不预盖
    expect(textOf(out)).toContain('有空,来吃饭')
  })

  it('posture changed between approve and execute → honest "情况变了", zero dispatch', async () => {
    const hub = new FakeHub()
    // classify 时是策展好的白名单边;execute 时管理员把边锁死了。
    let caps: string[] | null = ['dad-chat']
    const peers: ButlerPeerSurface = { listForButler: async () => [row('hub-dad', caps)] }
    const toolset = buildButlerAskPeerToolset({ userId: 'u1', peers, hub })
    expect((await toolset.classify('ask_peer', { peerId: 'hub-dad', message: 'hi' })).decision).toBe('approve')

    caps = [] // the admin locked the edge while the approval sat in /me
    const out = await toolset.callTool('ask_peer', { peerId: 'hub-dad', message: 'hi' })

    expect(out.isError).toBe(true)
    expect(textOf(out)).toContain('情况变了')
    expect(hub.dispatches).toHaveLength(0) // 绝不按旧快照盲发
  })

  it('result kinds map to honest lines: suspended / no_participant / capability_denied / owner denied / failed / cancelled', async () => {
    const hub = new FakeHub()
    const toolset = buildButlerAskPeerToolset({ userId: 'u1', peers: surfaceOf([row('hub-dad', ['dad-chat'])]), hub })
    const call = () => toolset.callTool('ask_peer', { peerId: 'hub-dad', message: 'hi' })

    hub.result = { kind: 'suspended', taskId: 't', by: 'hub-dad', resumeAt: 9, ts: 1 } as unknown as TaskResult
    expect(textOf(await call())).toContain('还需要 hub 管理员再批一道') // 双闸顺序讲诚实

    hub.result = { kind: 'no_participant', taskId: 't', ts: 1 } as unknown as TaskResult
    expect(textOf(await call())).toContain('不在线')

    hub.result = { kind: 'failed', taskId: 't', by: 'hub-dad', error: 'outbound_capability_denied:chat', ts: 1 } as TaskResult
    expect(textOf(await call())).toContain('不允许发这类请求')

    hub.result = { kind: 'failed', taskId: 't', by: 'hub-dad', error: 'outbound_approval_denied', ts: 1 } as TaskResult
    expect(textOf(await call())).toContain('管理员拒绝')

    hub.result = { kind: 'failed', taskId: 't', by: 'hub-dad', error: 'boom', ts: 1 } as TaskResult
    expect(textOf(await call())).toContain('没能完成')

    hub.result = { kind: 'cancelled', taskId: 't', reason: 'shutdown', ts: 1 } as unknown as TaskResult
    expect(textOf(await call())).toContain('取消')
  })

  it('governs/listTools: exactly the one disjoint tool', () => {
    const toolset = buildButlerAskPeerToolset({ userId: 'u1', peers: surfaceOf([]), hub: new FakeHub() })
    expect(toolset.governs('ask_peer')).toBe(true)
    expect(toolset.governs('create_workflow')).toBe(false)
    expect(toolset.listTools().map((t) => t.name)).toEqual(['ask_peer'])
  })
})
