/**
 * butler-ask-agent — Track A BE-M4. The resident butler's benign "问我自己的助手"
 * switchboard: a one-shot dispatch to an agent THIS member owns, awaiting the reply.
 *
 * Isolated from the hub (fake roster + fake dispatch), this pins:
 *   1. NO-LEAK — the target MUST be in `listOwned(userId)`; an unowned id is
 *      refused and NEVER dispatched to. Only the member's own id reaches listOwned.
 *   2. Every `TaskResult` kind maps to an honest message (reply / parked / offline
 *      / failed / cancelled), and the two output shapes (string, `{text}`) are read.
 *   3. Fail-closed — a roster or dispatch fault reports the failure.
 *
 * Deterministic: fake surfaces, direct `callTool`, no hub, no LLM.
 */

import { describe, expect, it } from 'vitest'

import type { TaskResult } from '@aipehub/core'

import {
  buildButlerAskAgentToolset,
  type ButlerAskAgent,
  type ButlerAskRosterSource,
  type ButlerAskDispatch,
} from '../src/personal-butler-ask-agent.js'

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('')
}

function fakeRoster(byUser: Record<string, ButlerAskAgent[]>): {
  surface: ButlerAskRosterSource
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    surface: {
      async listOwned(userId) {
        calls.push(userId)
        return byUser[userId] ?? []
      },
    },
  }
}

function fakeDispatch(result: TaskResult | Error): {
  surface: ButlerAskDispatch
  calls: Array<{ from: string; to: string; userId: string; payload: unknown }>
} {
  const calls: Array<{ from: string; to: string; userId: string; payload: unknown }> = []
  return {
    calls,
    surface: {
      async dispatch(input) {
        calls.push({ from: input.from, to: input.strategy.to, userId: input.origin.userId, payload: input.payload })
        if (result instanceof Error) throw result
        return result
      },
    },
  }
}

const OWNED: Record<string, ButlerAskAgent[]> = {
  alice: [{ id: 'me.alice.researcher', label: '研究助手', online: true }],
}

function okResult(output: unknown): TaskResult {
  return { kind: 'ok', taskId: 't1', by: 'me.alice.researcher', output, ts: 0 }
}

describe('butler-ask-agent — happy path + output shapes', () => {
  it('relays a string reply back, dispatching to the owned agent as the member', async () => {
    const roster = fakeRoster(OWNED)
    const dispatch = fakeDispatch(okResult('今天是周三。'))
    const tools = buildButlerAskAgentToolset({ userId: 'alice', roster: roster.surface, hub: dispatch.surface })
    const out = textOf(await tools.callTool('ask_my_agent', { agentId: 'me.alice.researcher', message: '今天几号?' }))
    expect(out).toContain('研究助手') // labelled
    expect(out).toContain('今天是周三。')
    // Dispatched explicitly to the owned agent, attributed to the member.
    expect(dispatch.calls).toEqual([
      { from: 'alice', to: 'me.alice.researcher', userId: 'alice', payload: '今天几号?' },
    ])
  })

  it('reads the {text} object output shape', async () => {
    const dispatch = fakeDispatch(okResult({ text: '对象里的回复。' }))
    const tools = buildButlerAskAgentToolset({ userId: 'alice', roster: fakeRoster(OWNED).surface, hub: dispatch.surface })
    const out = textOf(await tools.callTool('ask_my_agent', { agentId: 'me.alice.researcher', message: 'x' }))
    expect(out).toContain('对象里的回复。')
  })

  it('says so plainly when the reply has no readable text', async () => {
    const dispatch = fakeDispatch(okResult({ blob: 1 }))
    const tools = buildButlerAskAgentToolset({ userId: 'alice', roster: fakeRoster(OWNED).surface, hub: dispatch.surface })
    const res = await tools.callTool('ask_my_agent', { agentId: 'me.alice.researcher', message: 'x' })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('没有可读的文字内容')
  })
})

describe('butler-ask-agent — non-ok result kinds', () => {
  it('reports a parked agent (suspended) without error', async () => {
    const dispatch = fakeDispatch({ kind: 'suspended', taskId: 't1', by: 'me.alice.researcher', resumeAt: 0, ts: 0 })
    const tools = buildButlerAskAgentToolset({ userId: 'alice', roster: fakeRoster(OWNED).surface, hub: dispatch.surface })
    const res = await tools.callTool('ask_my_agent', { agentId: 'me.alice.researcher', message: 'x' })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('需要进一步确认')
  })

  it('reports a failed turn as an error', async () => {
    const dispatch = fakeDispatch({ kind: 'failed', taskId: 't1', by: 'me.alice.researcher', error: '配额用完了', ts: 0 })
    const tools = buildButlerAskAgentToolset({ userId: 'alice', roster: fakeRoster(OWNED).surface, hub: dispatch.surface })
    const res = await tools.callTool('ask_my_agent', { agentId: 'me.alice.researcher', message: 'x' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('配额用完了')
  })

  it('reports an offline agent (no_participant) as an error', async () => {
    const dispatch = fakeDispatch({ kind: 'no_participant', taskId: 't1', reason: 'offline', ts: 0 })
    const tools = buildButlerAskAgentToolset({ userId: 'alice', roster: fakeRoster(OWNED).surface, hub: dispatch.surface })
    const res = await tools.callTool('ask_my_agent', { agentId: 'me.alice.researcher', message: 'x' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('不在线')
  })

  it('reports a cancelled ask as an error', async () => {
    const dispatch = fakeDispatch({ kind: 'cancelled', taskId: 't1', reason: '用户取消', ts: 0 })
    const tools = buildButlerAskAgentToolset({ userId: 'alice', roster: fakeRoster(OWNED).surface, hub: dispatch.surface })
    const res = await tools.callTool('ask_my_agent', { agentId: 'me.alice.researcher', message: 'x' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('取消')
  })
})

describe('butler-ask-agent — no-leak', () => {
  it('refuses an unowned agent and never dispatches', async () => {
    const roster = fakeRoster(OWNED)
    const dispatch = fakeDispatch(okResult('should never run'))
    const tools = buildButlerAskAgentToolset({ userId: 'alice', roster: roster.surface, hub: dispatch.surface })
    const res = await tools.callTool('ask_my_agent', { agentId: 'me.bob.secret', message: 'leak?' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('不是你的助手')
    expect(dispatch.calls).toHaveLength(0) // never reached the hub
  })

  it("only ever asks listOwned for the butler's OWN member", async () => {
    const roster = fakeRoster({
      alice: [{ id: 'me.alice.researcher' }],
      bob: [{ id: 'me.bob.researcher' }],
    })
    const dispatch = fakeDispatch(okResult('ok'))
    const tools = buildButlerAskAgentToolset({ userId: 'alice', roster: roster.surface, hub: dispatch.surface })
    await tools.callTool('ask_my_agent', { agentId: 'me.alice.researcher', message: 'x' })
    expect(roster.calls.every((u) => u === 'alice')).toBe(true)
    expect(roster.calls).not.toContain('bob')
  })
})

describe('butler-ask-agent — input guards + fail-closed', () => {
  it('refuses a missing agentId or empty message without dispatching', async () => {
    const dispatch = fakeDispatch(okResult('x'))
    const tools = buildButlerAskAgentToolset({ userId: 'alice', roster: fakeRoster(OWNED).surface, hub: dispatch.surface })
    expect((await tools.callTool('ask_my_agent', { message: 'hi' })).isError).toBe(true)
    expect((await tools.callTool('ask_my_agent', { agentId: 'me.alice.researcher', message: '   ' })).isError).toBe(true)
    expect(dispatch.calls).toHaveLength(0)
  })

  it('fails closed when the roster read throws (never dispatches on incomplete info)', async () => {
    const dispatch = fakeDispatch(okResult('x'))
    const tools = buildButlerAskAgentToolset({
      userId: 'alice',
      roster: { async listOwned() { throw new Error('db down') } },
      hub: dispatch.surface,
    })
    const res = await tools.callTool('ask_my_agent', { agentId: 'me.alice.researcher', message: 'x' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('读不到你的助手')
    expect(dispatch.calls).toHaveLength(0)
  })

  it('reports a dispatch fault as an error', async () => {
    const tools = buildButlerAskAgentToolset({
      userId: 'alice',
      roster: fakeRoster(OWNED).surface,
      hub: fakeDispatch(new Error('boom')).surface,
    })
    const res = await tools.callTool('ask_my_agent', { agentId: 'me.alice.researcher', message: 'x' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('出错')
  })
})

describe('butler-ask-agent — tool gating', () => {
  it('offers the tool only when the roster is wired', () => {
    const dispatch = fakeDispatch(okResult('x')).surface
    expect(buildButlerAskAgentToolset({ userId: 'a', roster: fakeRoster({}).surface, hub: dispatch }).listTools().map((t) => t.name)).toEqual(['ask_my_agent'])
    expect(buildButlerAskAgentToolset({ userId: 'a', hub: dispatch }).listTools()).toEqual([])
  })
})
