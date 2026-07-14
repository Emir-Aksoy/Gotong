/**
 * LSA-M1 承重门 — the butler's benign model self-awareness eye (`list_my_llms`).
 *
 * The butler could see runs / helpers / peers (BE-M1, NET-M1) but was blind to
 * the models IT routes over. This gate pins the projection's contract:
 *
 *   1. sanitize red line — an api key / baseURL sneaked onto a row (sloppy
 *      upstream) must NEVER reach the rendered text; the projection carries only
 *      a provider-type label + model. (Structurally, the pool derives the label
 *      from ManagedAgentSpec, which HAS no apiKey field — the key is resolved
 *      separately and never enters the roster.)
 *   2. health overlay is butler-scoped — snapshot() surfaces only degraded
 *      candidates across ALL agents; the surface filters to the butler's own
 *      agentId so a flaky OTHER agent never colors the self-report;
 *   3. single-provider honesty — one candidate says "没退路", the honest hook
 *      into LSA-M3 (you can't want a fallback until you know you have none);
 *   4. absence is honest — no surface → no tool; empty roster / read failure →
 *      friendly text, never a crash.
 */

import { describe, expect, it } from 'vitest'

import {
  buildButlerLlmSurface,
  buildButlerLlmsToolset,
  type ButlerLlmChain,
  type ButlerLlmRow,
  type ButlerLlmSurface,
} from '../src/personal-butler-llms.js'

const surfaceOf = (rows: ButlerLlmRow[]): ButlerLlmSurface => ({
  listForButler: async () => rows,
})

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? '').join('\n')

describe('LSA-M1 — list_my_llms(管家模型自省)', () => {
  it('renders primary + fallbacks with per-candidate health in Chinese', async () => {
    const out = textOf(
      await buildButlerLlmsToolset({
        llms: surfaceOf([
          { index: 0, role: 'primary', label: 'anthropic', model: 'claude-x', health: 'healthy' },
          { index: 1, role: 'fallback', label: 'deepseek', model: 'deepseek-chat', health: 'degraded', errorKind: 'quota' },
          { index: 2, role: 'fallback', label: 'openai-compatible:groq.com', model: 'llama', health: 'open', errorKind: 'rate_limited' },
        ]),
      }).callTool('list_my_llms', {}),
    )

    expect(out).toContain('按路由顺序')
    expect(out).toContain('主模型:anthropic(claude-x) — 健康')
    expect(out).toContain('备用 1:deepseek(deepseek-chat)')
    expect(out).toContain('配额耗尽') // quota → 中文病名
    expect(out).toContain('备用 2:openai-compatible:groq.com(llama)')
    expect(out).toContain('暂时熔断') // open
    expect(out).toContain('被限流') // rate_limited → 中文
  })

  it('a null model renders the provider label alone (no empty parens)', async () => {
    const out = textOf(
      await buildButlerLlmsToolset({
        llms: surfaceOf([{ index: 0, role: 'primary', label: 'mock', model: null, health: 'healthy' }]),
      }).callTool('list_my_llms', {}),
    )
    expect(out).toContain('主模型:mock — 健康')
    expect(out).not.toContain('mock()')
  })

  it('single provider says so plainly — the honest hook into adding a fallback', async () => {
    const out = textOf(
      await buildButlerLlmsToolset({
        llms: surfaceOf([{ index: 0, role: 'primary', label: 'mimo', model: 'mimo-v2', health: 'healthy' }]),
      }).callTool('list_my_llms', {}),
    )
    expect(out).toContain('主模型:mimo(mimo-v2)')
    expect(out).toContain('只有 1 个模型')
    expect(out).toContain('没退路')
  })

  it('sanitize: an api key / baseURL sneaked onto a row never reaches the text', async () => {
    // A sloppy upstream could hand rows with extra fields — the renderer must
    // only read the declared shape. Cast simulates that structural leak.
    const dirty = [
      {
        index: 0,
        role: 'primary',
        label: 'anthropic',
        model: 'claude',
        health: 'healthy',
        apiKey: 'sk-secret-abc123',
        baseURL: 'https://internal-vault:8443/v1',
      } as unknown as ButlerLlmRow,
    ]
    const out = textOf(await buildButlerLlmsToolset({ llms: surfaceOf(dirty) }).callTool('list_my_llms', {}))

    expect(out).toContain('anthropic(claude)')
    expect(out).not.toContain('sk-secret-abc123')
    expect(out).not.toContain('internal-vault')
    expect(out).not.toContain('8443')
  })

  it('empty roster → honest line; surface throw → friendly error, no crash', async () => {
    const empty = textOf(await buildButlerLlmsToolset({ llms: surfaceOf([]) }).callTool('list_my_llms', {}))
    expect(empty).toContain('读不到我当前挂的模型')

    const broken = buildButlerLlmsToolset({
      llms: {
        listForButler: async () => {
          throw new Error('pool down')
        },
      },
    })
    const err = await broken.callTool('list_my_llms', {})
    expect(err.isError).toBe(true)
    expect(textOf(err)).toContain('暂时读不到')
  })

  it('unknown tool name → typed refusal', async () => {
    const r = await buildButlerLlmsToolset({ llms: surfaceOf([]) }).callTool('rm_rf', {})
    expect(r.isError).toBe(true)
  })
})

describe('LSA-M1 — buildButlerLlmSurface(host 侧拼接)', () => {
  const chain: ButlerLlmChain = {
    agentId: 'atong',
    candidates: [
      { index: 0, role: 'primary', label: 'anthropic', model: 'claude-x' },
      { index: 1, role: 'fallback', label: 'deepseek', model: 'deepseek-chat' },
    ],
  }

  it('all-healthy chain → every candidate carries the config fields + health:healthy', async () => {
    const rows = await buildButlerLlmSurface({ roster: async () => chain, health: () => [] }).listForButler()
    expect(rows).toEqual([
      { index: 0, role: 'primary', label: 'anthropic', model: 'claude-x', health: 'healthy' },
      { index: 1, role: 'fallback', label: 'deepseek', model: 'deepseek-chat', health: 'healthy' },
    ])
  })

  it('health overlay is butler-scoped — a flaky OTHER agent never colors the self-report', async () => {
    const rows = await buildButlerLlmSurface({
      roster: async () => chain,
      health: () => [
        { agentId: 'atong', index: 1, state: 'degraded' as const, errorKind: 'quota' },
        // A DIFFERENT agent's open breaker must be filtered out — it isn't the butler's.
        { agentId: 'other-agent', index: 0, state: 'open' as const, errorKind: 'auth' },
      ],
    }).listForButler()

    expect(rows[0]).toEqual({ index: 0, role: 'primary', label: 'anthropic', model: 'claude-x', health: 'healthy' })
    expect(rows[1]).toEqual({ index: 1, role: 'fallback', label: 'deepseek', model: 'deepseek-chat', health: 'degraded', errorKind: 'quota' })
  })

  it('sanitize red line is structural — a healthy row has EXACTLY the safe fields (no key/baseURL)', async () => {
    const rows = await buildButlerLlmSurface({
      roster: async () => ({ agentId: 'atong', candidates: [{ index: 0, role: 'primary', label: 'openai-compatible:api.x.com', model: 'gpt' }] }),
      health: () => [],
    }).listForButler()
    expect(Object.keys(rows[0]!).sort()).toEqual(['health', 'index', 'label', 'model', 'role'])
  })

  it('no butler-enabled row (roster null) → empty list, honestly', async () => {
    const rows = await buildButlerLlmSurface({ roster: async () => null, health: () => [] }).listForButler()
    expect(rows).toEqual([])
  })
})
