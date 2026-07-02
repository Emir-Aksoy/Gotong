/**
 * butler-observe — Track A BE-M1. The resident butler's BENIGN read "eyes":
 * `list_my_runs` / `list_my_agents` / `my_usage`.
 *
 * These let a member ask their butler, in plain language, what's happening with
 * THEIR corner of the hub. The two load-bearing properties:
 *
 *   1. It reports the REAL run status / roster / usage the surfaces return — the
 *      butler can answer "我昨天那个流程跑成了吗" with the actual state, not a guess.
 *   2. NO-LEAK: the toolset only ever passes ITS OWN member's id to the scoped
 *      surfaces (runs / usage). alice's butler asks `listRunsByUser('alice')` and
 *      `aggregateForUser('alice')` — never bob's id — so per-user construction
 *      plus this invariant means one member can't read another's runs or bill.
 *
 * Deterministic: capturing fake surfaces, direct `callTool` — no LLM, no clock.
 */

import { describe, expect, it } from 'vitest'

import {
  buildButlerObserveToolset,
  type ButlerRunView,
  type ButlerRunSurface,
  type ButlerAgentSurface,
  type ButlerUsageSurface,
  type ButlerUsageRow,
} from '../src/personal-butler-observe.js'

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('')
}

// A run surface that records every (userId, opts) it was asked for, and returns
// a per-user fixture so we can prove scoping AND real-status reporting.
function fakeRuns(byUser: Record<string, ButlerRunView[]>): {
  surface: ButlerRunSurface
  calls: { userId: string; workflowId?: string }[]
} {
  const calls: { userId: string; workflowId?: string }[] = []
  return {
    calls,
    surface: {
      async listRunsByUser(userId, opts) {
        calls.push({ userId, ...(opts?.workflowId ? { workflowId: opts.workflowId } : {}) })
        const rows = byUser[userId] ?? []
        return opts?.workflowId ? rows.filter((r) => r.workflowId === opts.workflowId) : rows
      },
    },
  }
}

function fakeUsage(byUser: Record<string, ButlerUsageRow[]>): {
  surface: ButlerUsageSurface
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    surface: {
      aggregateForUser(userId) {
        calls.push(userId)
        return byUser[userId] ?? []
      },
    },
  }
}

const AGENTS: ButlerAgentSurface = {
  async listForMembers() {
    return [
      { id: 'coder', label: '编码助手', capabilities: ['chat', 'code'], online: true },
      { id: 'researcher', label: '研究助手', capabilities: ['research'], online: false },
    ]
  },
}

describe('butler-observe — list_my_runs', () => {
  it('reports the real run status and scrubbed failure reason', async () => {
    const runs = fakeRuns({
      alice: [
        { runId: 'r2', workflowId: 'daily-review', status: 'completed', startedAt: 1_700_000_000_000 },
        {
          runId: 'r1',
          workflowId: 'billing',
          status: 'failed',
          startedAt: 1_699_000_000_000,
          error: '缺少 API key',
        },
      ],
    })
    const tools = buildButlerObserveToolset({ userId: 'alice', runs: runs.surface })
    const out = textOf(await tools.callTool('list_my_runs', {}))
    // Real status surfaced in plain language, plus the failure reason.
    expect(out).toContain('已完成')
    expect(out).toContain('失败')
    expect(out).toContain('缺少 API key')
    expect(out).toContain('daily-review')
    // Scoped to alice.
    expect(runs.calls).toEqual([{ userId: 'alice' }])
  })

  it('passes an optional workflowId filter through', async () => {
    const runs = fakeRuns({
      alice: [{ runId: 'r1', workflowId: 'billing', status: 'running', startedAt: 1 }],
    })
    const tools = buildButlerObserveToolset({ userId: 'alice', runs: runs.surface })
    await tools.callTool('list_my_runs', { workflowId: 'billing' })
    expect(runs.calls).toEqual([{ userId: 'alice', workflowId: 'billing' }])
  })

  it('says so plainly when there are no runs (not an error)', async () => {
    const runs = fakeRuns({})
    const tools = buildButlerObserveToolset({ userId: 'alice', runs: runs.surface })
    const res = await tools.callTool('list_my_runs', {})
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('还没有')
  })

  it('fails closed when the run surface throws (never implies "no runs")', async () => {
    const surface: ButlerRunSurface = {
      async listRunsByUser() {
        throw new Error('db down')
      },
    }
    const tools = buildButlerObserveToolset({ userId: 'alice', runs: surface })
    const res = await tools.callTool('list_my_runs', {})
    expect(res.isError).toBe(true)
    expect(textOf(res)).not.toContain('还没有')
  })
})

describe('butler-observe — no-leak scoping', () => {
  it("each member's butler only ever asks for its OWN runs and usage", async () => {
    const runs = fakeRuns({
      alice: [{ runId: 'ra', workflowId: 'wf', status: 'completed', startedAt: 1 }],
      bob: [{ runId: 'rb', workflowId: 'wf', status: 'completed', startedAt: 2 }],
    })
    const usage = fakeUsage({
      alice: [{ key: 'gpt', calls: 3, inputTokens: 10, outputTokens: 20, costMicros: 500 }],
      bob: [{ key: 'gpt', calls: 9, inputTokens: 90, outputTokens: 90, costMicros: 9000 }],
    })
    const aliceTools = buildButlerObserveToolset({
      userId: 'alice',
      runs: runs.surface,
      usage: usage.surface,
    })
    // alice's butler reads runs + usage.
    const runOut = textOf(await aliceTools.callTool('list_my_runs', {}))
    const useOut = textOf(await aliceTools.callTool('my_usage', {}))

    // It asked ONLY for alice — bob's id never appears in any call.
    expect(runs.calls.every((c) => c.userId === 'alice')).toBe(true)
    expect(usage.calls.every((u) => u === 'alice')).toBe(true)
    // And bob's fixture data never surfaces to alice.
    expect(runOut).toContain('ra')
    expect(runOut).not.toContain('rb')
    expect(useOut).toContain('$0.0005') // alice's 500 micros, not bob's 9000
    expect(useOut).not.toContain('$0.0090')
  })
})

describe('butler-observe — list_my_agents', () => {
  it('lists the sanitized roster with online state and capabilities', async () => {
    const tools = buildButlerObserveToolset({ userId: 'alice', agents: AGENTS })
    const out = textOf(await tools.callTool('list_my_agents', {}))
    expect(out).toContain('编码助手')
    expect(out).toContain('在线')
    expect(out).toContain('研究助手')
    expect(out).toContain('离线')
    expect(out).toContain('code')
  })
})

describe('butler-observe — my_usage', () => {
  it('totals calls/tokens/cost and breaks down by model', async () => {
    const usage = fakeUsage({
      alice: [
        { key: 'gpt-4', calls: 2, inputTokens: 100, outputTokens: 200, costMicros: 3_000 },
        { key: 'gpt-3.5', calls: 5, inputTokens: 500, outputTokens: 500, costMicros: 1_000 },
      ],
    })
    const tools = buildButlerObserveToolset({ userId: 'alice', usage: usage.surface })
    const out = textOf(await tools.callTool('my_usage', {}))
    expect(out).toContain('7 次') // 2 + 5 calls
    expect(out).toContain('$0.0040') // 3000 + 1000 micros total
    expect(out).toContain('gpt-4')
    expect(out).toContain('gpt-3.5')
  })

  it('says so plainly when there is no usage yet', async () => {
    const usage = fakeUsage({})
    const tools = buildButlerObserveToolset({ userId: 'alice', usage: usage.surface })
    const res = await tools.callTool('my_usage', {})
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('还没有')
  })
})

describe('butler-observe — tool gating', () => {
  it('only offers a tool whose backing surface is wired', () => {
    // Runs-only butler.
    const runsOnly = buildButlerObserveToolset({
      userId: 'alice',
      runs: fakeRuns({}).surface,
    })
    expect(runsOnly.listTools().map((t) => t.name)).toEqual(['list_my_runs'])

    // All three wired.
    const all = buildButlerObserveToolset({
      userId: 'alice',
      runs: fakeRuns({}).surface,
      agents: AGENTS,
      usage: fakeUsage({}).surface,
    })
    expect(all.listTools().map((t) => t.name).sort()).toEqual([
      'list_my_agents',
      'list_my_runs',
      'my_usage',
    ])

    // Nothing wired → no tools offered at all.
    const none = buildButlerObserveToolset({ userId: 'alice' })
    expect(none.listTools()).toEqual([])
  })
})
