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

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

describe('EFF-M2 转派事实行 — <factDir>/<userId>.jsonl', () => {
  it('settle 后 append 一行 {at, expert, ok};ok 只认 kind===ok,失败/挂起落 false,顺序保序', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gotong-esc-fact-'))
    let nextKind: 'ok' | 'failed' | 'suspended' = 'ok'
    const { deps } = makeDeps({
      factDir: dir,
      hub: { dispatch: async () => ({ kind: nextKind, output: { text: 'x' } }) as never },
    })
    const ts = buildButlerEscalateToolset(deps)
    await ts.callTool('escalate_to_expert', { task_summary: '活一' })
    await settle()
    nextKind = 'failed'
    await ts.callTool('escalate_to_expert', { task_summary: '活二' })
    await settle()
    nextKind = 'suspended'
    await ts.callTool('escalate_to_expert', { task_summary: '活三' })
    await settle()
    const lines = (await readFile(join(dir, 'u1.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3)
    const rows = lines.map((l) => JSON.parse(l) as { at: string; expert: string; ok: boolean })
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['at', 'expert', 'ok'])
      expect(Number.isNaN(Date.parse(r.at))).toBe(false) // ISO,字典序=时序
      expect(r.expert).toBe('expert-x') // 稳定 id,非 label
    }
    expect(rows.map((r) => r.ok)).toEqual([true, false, false])
  })

  it('dispatch 自己抛(pre-flight 失败)也落一行 ok:false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gotong-esc-fact-'))
    const { deps } = makeDeps({
      factDir: dir,
      hub: { dispatch: async () => { throw new Error('pre-flight down') } },
    })
    const ts = buildButlerEscalateToolset(deps)
    const r = await ts.callTool('escalate_to_expert', { task_summary: '活' })
    expect(r.isError).toBeUndefined() // 回执照发(fire-and-forget)
    await settle()
    const rows = (await readFile(join(dir, 'u1.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    expect(rows).toEqual([expect.objectContaining({ expert: 'expert-x', ok: false })])
  })

  it('factDir 缺席 = 零 fs 触碰(转派照常,盘上什么也不出现)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gotong-esc-fact-'))
    const { deps, pushed } = makeDeps() // 没给 factDir;dir 只当观察哨
    const ts = buildButlerEscalateToolset(deps)
    await ts.callTool('escalate_to_expert', { task_summary: '活' })
    await settle()
    expect(pushed).toHaveLength(1) // 转派链完整
    expect(await readdir(dir)).toEqual([]) // 观察哨目录一个字节没多
  })

  it('append 失败 warn 绝不连累转派:factDir 位置被一个文件占着,回执/推送照常', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'gotong-esc-fact-'))
    const occupied = join(parent, 'not-a-dir')
    await writeFile(occupied, 'x', 'utf8') // mkdir(factDir) 必失败
    const warns: string[] = []
    const { deps, pushed } = makeDeps({
      factDir: occupied,
      logger: { warn: (m) => { warns.push(m) }, error: () => {} },
    })
    const ts = buildButlerEscalateToolset(deps)
    const r = await ts.callTool('escalate_to_expert', { task_summary: '活' })
    expect(r.isError).toBeUndefined()
    await settle()
    expect(pushed).toHaveLength(1) // 结果照推
    expect(warns.some((m) => m.includes('fact append failed'))).toBe(true)
  })

  it('敌意 userId 进不了路径拼接(assertSafeOwnerId 先于 join,warn 后零文件)', async () => {
    // factDir 套在沙箱里一层:若守卫被摘,`../evil.jsonl` 会穿到沙箱根 —— 在
    // 观察范围内。直接拿 mkdtemp 根当 factDir 的话,穿越目标落在共享 tmpdir,
    // 断言什么也看不见 = 假门。
    const sandbox = await mkdtemp(join(tmpdir(), 'gotong-esc-fact-'))
    const factDir = join(sandbox, 'facts')
    const { deps } = makeDeps({ factDir, userId: '../evil' })
    const ts = buildButlerEscalateToolset(deps)
    await ts.callTool('escalate_to_expert', { task_summary: '活' })
    await settle()
    expect(await readdir(sandbox)).toEqual([]) // facts 没建、evil.jsonl 没穿出来
  })
})
