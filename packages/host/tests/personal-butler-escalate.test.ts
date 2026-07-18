/**
 * DUO-M2 — the reception brain's benign fire-and-forget escalate doorway.
 *
 * What must hold (docs/zh/ATONG-DUAL-BRAIN.md 边界):
 *   ① Fail-closed ownership: the OWNER-configured target must be in THIS
 *     member's roster, or the call refuses loudly with zero dispatch.
 *   ② Fire-and-forget: the tool returns the receipt IMMEDIATELY (before the
 *     expert resolves); the result is pushed back when the dispatch settles.
 *   ③ Honest delivery, kind by kind: ok → result text; failed / no_participant
 *     / suspended / cancelled → honest push-back, never silence.
 *   ④ Push is best-effort: a missing push handle or a throwing push NEVER
 *     breaks anything (result lives in the transcript); dispatch rejection is
 *     logged + pushed as a failure line, never an unhandledRejection.
 */

import { describe, it, expect } from 'vitest'

import { buildButlerEscalateToolset } from '../src/personal-butler-escalate.js'
import type { ButlerEscalateDeps } from '../src/personal-butler-escalate.js'

const silentLog = { warn: () => {}, error: () => {} }

/** Deferred so tests control WHEN the expert "finishes". */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeDeps(over: Partial<ButlerEscalateDeps> = {}): {
  deps: ButlerEscalateDeps
  dispatched: Array<Record<string, unknown>>
  pushed: Array<{ userId: string; text: string }>
} {
  const dispatched: Array<Record<string, unknown>> = []
  const pushed: Array<{ userId: string; text: string }> = []
  const deps: ButlerEscalateDeps = {
    userId: 'u1',
    escalateTo: 'expert-x',
    roster: { listOwned: async () => [{ id: 'expert-x', label: '深度专家' }, { id: 'other' }] },
    hub: {
      dispatch: async (input) => {
        dispatched.push(input as unknown as Record<string, unknown>)
        return { kind: 'ok', output: { text: '专家的完整答案' } } as never
      },
    },
    push: (userId, text) => { pushed.push({ userId, text }) },
    logger: silentLog,
    ...over,
  }
  return { deps, dispatched, pushed }
}

/** Flush the fire-and-forget promise chain (two microtask hops). */
async function settle() {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('DUO-M2 escalate_to_expert — 转派专家 benign 工具', () => {
  it('lists exactly one tool with no target argument (owner-pinned target)', () => {
    const { deps } = makeDeps()
    const ts = buildButlerEscalateToolset(deps)
    const tools = ts.listTools()
    expect(tools.map((t) => t.name)).toEqual(['escalate_to_expert'])
    // The model's only decision is escalate-or-not — no target in the schema.
    const props = (tools[0]!.inputSchema as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props)).toEqual(['task_summary'])
  })

  it('② returns the receipt IMMEDIATELY, before the expert resolves; result pushes later', async () => {
    const gate = deferred<never>()
    const pushed: Array<{ userId: string; text: string }> = []
    const dispatched: unknown[] = []
    const ts = buildButlerEscalateToolset({
      userId: 'u1',
      escalateTo: 'expert-x',
      roster: { listOwned: async () => [{ id: 'expert-x', label: '深度专家' }] },
      hub: {
        dispatch: (input) => {
          dispatched.push(input)
          return gate.promise
        },
      },
      push: (userId, text) => { pushed.push({ userId, text }) },
      logger: silentLog,
    })
    const r = await ts.callTool('escalate_to_expert', { task_summary: '写一份完整的市场分析报告' })
    // Receipt came back while the expert is STILL running.
    expect(r.isError).toBeUndefined()
    expect(JSON.stringify(r.content)).toContain('深度专家')
    expect(pushed).toHaveLength(0)
    expect(dispatched).toHaveLength(1)
    // The dispatch is attributed to the member, explicit to the pinned target.
    const d = dispatched[0] as { strategy: { kind: string; to: string }; origin: { userId: string }; payload: unknown }
    expect(d.strategy).toEqual({ kind: 'explicit', to: 'expert-x' })
    expect(d.origin.userId).toBe('u1')
    expect(d.payload).toBe('写一份完整的市场分析报告')
    // Now the expert finishes → the result is pushed to the SAME member.
    gate.resolve({ kind: 'ok', output: { text: '分析结论……' } } as never)
    await settle()
    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.userId).toBe('u1')
    expect(pushed[0]!.text).toContain('深度专家')
    expect(pushed[0]!.text).toContain('分析结论……')
  })

  it('① fail-closed: a target NOT in the member roster refuses loudly, zero dispatch', async () => {
    const { deps, dispatched } = makeDeps({
      roster: { listOwned: async () => [{ id: 'other' }] },
    })
    const ts = buildButlerEscalateToolset(deps)
    const r = await ts.callTool('escalate_to_expert', { task_summary: '一件重活' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toContain('escalateTo')
    expect(dispatched).toHaveLength(0)
  })

  it('① a broken roster read refuses (fail-closed), zero dispatch', async () => {
    const { deps, dispatched } = makeDeps({
      roster: { listOwned: async () => { throw new Error('boom') } },
    })
    const ts = buildButlerEscalateToolset(deps)
    const r = await ts.callTool('escalate_to_expert', { task_summary: '一件重活' })
    expect(r.isError).toBe(true)
    expect(dispatched).toHaveLength(0)
  })

  it('rejects an empty task_summary before touching roster or hub', async () => {
    const { deps, dispatched } = makeDeps()
    const ts = buildButlerEscalateToolset(deps)
    const r = await ts.callTool('escalate_to_expert', { task_summary: '   ' })
    expect(r.isError).toBe(true)
    expect(dispatched).toHaveLength(0)
  })

  it('③ failed / no_participant / suspended / cancelled each push an HONEST line', async () => {
    const outcomes: Array<[Record<string, unknown>, string]> = [
      [{ kind: 'failed', error: '模型超时' }, '模型超时'],
      [{ kind: 'no_participant' }, '不在线'],
      [{ kind: 'suspended' }, '/me'],
      [{ kind: 'cancelled', reason: 'deadline' }, 'deadline'],
    ]
    for (const [result, expected] of outcomes) {
      const { deps, pushed } = makeDeps({
        hub: { dispatch: async () => result as never },
      })
      const ts = buildButlerEscalateToolset(deps)
      const r = await ts.callTool('escalate_to_expert', { task_summary: '一件重活' })
      expect(r.isError).toBeUndefined() // the receipt itself succeeded
      await settle()
      expect(pushed).toHaveLength(1)
      expect(pushed[0]!.text).toContain(expected)
    }
  })

  it('④ a REJECTED dispatch logs + pushes a failure line (no unhandledRejection)', async () => {
    const { deps, pushed } = makeDeps({
      hub: { dispatch: async () => { throw new Error('wire down') } },
    })
    const ts = buildButlerEscalateToolset(deps)
    const r = await ts.callTool('escalate_to_expert', { task_summary: '一件重活' })
    expect(r.isError).toBeUndefined()
    await settle()
    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.text).toContain('没能启动')
  })

  it('④ no push handle (web-only): the receipt + dispatch still work, delivery is passive', async () => {
    const { deps, dispatched } = makeDeps({ push: undefined })
    const ts = buildButlerEscalateToolset(deps)
    const r = await ts.callTool('escalate_to_expert', { task_summary: '一件重活' })
    expect(r.isError).toBeUndefined()
    await settle()
    expect(dispatched).toHaveLength(1) // the expert ran; result lives in transcript
  })

  it('④ a THROWING push never surfaces (logged once, result remains in transcript)', async () => {
    const warns: string[] = []
    const { deps } = makeDeps({
      push: () => { throw new Error('bridge gone') },
      logger: { warn: (m) => { warns.push(m) }, error: () => {} },
    })
    const ts = buildButlerEscalateToolset(deps)
    const r = await ts.callTool('escalate_to_expert', { task_summary: '一件重活' })
    expect(r.isError).toBeUndefined()
    await settle()
    expect(warns.some((w) => w.includes('push-back failed'))).toBe(true)
  })

  it('an ok result with no readable text still pushes an honest completion line', async () => {
    const { deps, pushed } = makeDeps({
      hub: { dispatch: async () => ({ kind: 'ok', output: { blob: 1 } }) as never },
    })
    const ts = buildButlerEscalateToolset(deps)
    await ts.callTool('escalate_to_expert', { task_summary: '一件重活' })
    await settle()
    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.text).toContain('没有可读的文字结果')
  })

  it('unknown tool name refuses', async () => {
    const { deps } = makeDeps()
    const ts = buildButlerEscalateToolset(deps)
    const r = await ts.callTool('nope', {})
    expect(r.isError).toBe(true)
  })
})
