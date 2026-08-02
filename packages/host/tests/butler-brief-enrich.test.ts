/**
 * B2 晨报增强 — the daily brief, when the member opted in, runs a BOUNDED
 * read-only tool-use loop so it can weave in real weather / agenda / news from
 * the butler's connected connectors.
 *
 * Pins: (1) enrich OFF (or no connector) → the historical single tool-less pass,
 * the resolver is never consulted; (2) enrich ON + a live read toolset → the
 * model's tool call runs and its result reaches the final greeting; (3) a flaky
 * connector (throwing tool) degrades to an isError result, never a crash; (4) the
 * loop is hard-capped so a model that always wants tools can't spin forever;
 * (5) SKIP still means stay-silent; (6) the set_daily_brief opt-in round-trips.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Logger } from '@gotong/core'
import {
  MockLlmProvider,
  type LlmAgentToolset,
  type LlmProvider,
  type LlmRequest,
  type LlmToolCallResult,
  type LlmToolDefinition,
} from '@gotong/llm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildMePanelSurface } from '../src/me-panel-surface.js'
import { buildButlerDailyBriefToolset } from '../src/personal-butler-daily-brief.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { buildButlerPanelContentToolset } from '../src/personal-butler-panel.js'
import {
  buildButlerBriefComposer,
  readButlerProactiveConfig,
} from '../src/personal-butler-proactive.js'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

/** A minimal read-only connector toolset that records its calls. */
function fakeWeatherToolset(opts?: { throwOnCall?: boolean; onCall?: () => void }): {
  toolset: LlmAgentToolset
  calls: string[]
} {
  const calls: string[] = []
  const tool: LlmToolDefinition = {
    name: 'weather__today',
    description: 'today weather',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  }
  const toolset: LlmAgentToolset = {
    listTools: () => [tool],
    async callTool(name): Promise<LlmToolCallResult> {
      calls.push(name)
      opts?.onCall?.()
      if (opts?.throwOnCall) throw new Error('connector down')
      return { content: [{ type: 'text', text: '吉隆坡 今天 晴 32°C' }] }
    },
  }
  return { toolset, calls }
}

describe('B2 brief enrichment', () => {
  let dir: string
  const USER = 'u-brief'

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gotong-brief-'))
    // Seed ONE curated fact so the composer has something to ground the brief in
    // (an empty profile short-circuits to null before any provider call).
    const mem = openButlerMemory({ rootDir: dir, userId: USER, logger: silentLogger })
    await mem.remember({ kind: 'semantic', text: '用户住在吉隆坡' })
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('enrich OFF → plain pass, the connector resolver is never consulted', async () => {
    let resolverCalls = 0
    const compose = buildButlerBriefComposer({
      rootDir: dir,
      buildProvider: async () => new MockLlmProvider({ reply: '早上好!' }),
      logger: silentLogger,
      mcpReadTools: async () => {
        resolverCalls++
        return fakeWeatherToolset().toolset
      },
    })
    const brief = await compose(USER, { enrich: false })
    expect(brief).toBe('早上好!')
    expect(resolverCalls).toBe(0) // opted out → never even resolve connectors
  })

  it('enrich ON but no connector live → plain pass (enrichment is a bonus, not a gate)', async () => {
    const compose = buildButlerBriefComposer({
      rootDir: dir,
      buildProvider: async () => new MockLlmProvider({ reply: '早上好!' }),
      logger: silentLogger,
      mcpReadTools: async () => null, // butler not connected to anything
    })
    expect(await compose(USER, { enrich: true })).toBe('早上好!')
  })

  it('enrich ON + live connector → the tool runs and its data reaches the greeting', async () => {
    const wx = fakeWeatherToolset()
    const compose = buildButlerBriefComposer({
      rootDir: dir,
      buildProvider: async () =>
        new MockLlmProvider({
          reply: 'fallback',
          script: [
            { kind: 'tool_use', toolUses: [{ type: 'tool_use', id: 't1', name: 'weather__today', input: {} }] },
            { kind: 'text', text: '早上好!吉隆坡今天晴,32 度,注意防晒。' },
          ],
        }),
      logger: silentLogger,
      mcpReadTools: async () => wx.toolset,
    })
    const brief = await compose(USER, { enrich: true })
    expect(wx.calls).toEqual(['weather__today']) // the connector was actually called
    expect(brief).toContain('吉隆坡今天晴')
  })

  it('a throwing connector degrades to an isError result, never a crash', async () => {
    const wx = fakeWeatherToolset({ throwOnCall: true })
    const compose = buildButlerBriefComposer({
      rootDir: dir,
      buildProvider: async () =>
        new MockLlmProvider({
          reply: 'fallback',
          script: [
            { kind: 'tool_use', toolUses: [{ type: 'tool_use', id: 't1', name: 'weather__today', input: {} }] },
            { kind: 'text', text: '早上好!今天也要加油。' }, // model recovered without the data
          ],
        }),
      logger: silentLogger,
      mcpReadTools: async () => wx.toolset,
    })
    const brief = await compose(USER, { enrich: true })
    expect(wx.calls).toEqual(['weather__today'])
    expect(brief).toBe('早上好!今天也要加油。')
  })

  it('is hard-capped — a model that always wants tools stops instead of looping forever', async () => {
    const wx = fakeWeatherToolset()
    const compose = buildButlerBriefComposer({
      rootDir: dir,
      buildProvider: async () =>
        // Every scripted turn asks for the tool again; the loop must give up.
        new MockLlmProvider({
          reply: 'fallback',
          script: Array.from({ length: 8 }, (_, i) => ({
            kind: 'tool_use' as const,
            toolUses: [{ type: 'tool_use' as const, id: `t${i}`, name: 'weather__today', input: {} }],
          })),
        }),
      logger: silentLogger,
      mcpReadTools: async () => wx.toolset,
    })
    const brief = await compose(USER, { enrich: true })
    expect(brief).toBeNull() // no final text produced → stay silent, don't hang
    expect(wx.calls.length).toBe(3) // BRIEF_MAX_TOOL_ROUNDS — bounded, not 8
  })

  it('SKIP in the enriched loop still means stay-silent', async () => {
    const wx = fakeWeatherToolset()
    const compose = buildButlerBriefComposer({
      rootDir: dir,
      buildProvider: async () => new MockLlmProvider({ reply: 'fallback', script: [{ kind: 'text', text: 'SKIP' }] }),
      logger: silentLogger,
      mcpReadTools: async () => wx.toolset,
    })
    expect(await compose(USER, { enrich: true })).toBeNull()
  })
})

describe('set_daily_brief — B2 enrich opt-in', () => {
  let dir: string
  const USER = 'u-optin'
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gotong-optin-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('enrichWithConnectors round-trips into the config + confirmation', async () => {
    const ts = buildButlerDailyBriefToolset({ userId: USER, rootDir: dir, logger: silentLogger })
    const r = await ts.callTool('set_daily_brief', { enabled: true, hour: 8, enrichWithConnectors: true })
    expect((r.content[0] as { text: string }).text).toContain('天气')
    const cfg = await readButlerProactiveConfig(dir, USER)
    expect(cfg?.enrich).toBe(true)
  })

  it('defaults to no enrichment, and keeps the prior setting when omitted', async () => {
    const ts = buildButlerDailyBriefToolset({ userId: USER, rootDir: dir, logger: silentLogger })
    await ts.callTool('set_daily_brief', { enabled: true })
    expect((await readButlerProactiveConfig(dir, USER))?.enrich).toBeUndefined() // default OFF

    await ts.callTool('set_daily_brief', { enabled: true, enrichWithConnectors: true })
    await ts.callTool('set_daily_brief', { enabled: true, hour: 9 }) // omitted → keep on
    expect((await readButlerProactiveConfig(dir, USER))?.enrich).toBe(true)

    await ts.callTool('set_daily_brief', { enabled: true, enrichWithConnectors: false }) // explicit off
    expect((await readButlerProactiveConfig(dir, USER))?.enrich).toBeUndefined()
  })
})

/**
 * 晨报写面板卡小刀 — the enriched brief loop optionally carries the CONTENT-ONLY
 * panel toolset so real data the loop just fetched can land on the member's
 * panel cards. Pins: the write really lands in the real store under the pinned
 * userId; the panel variant's request shape (system addendum / 800 tokens /
 * no layout tools); absent resolver ⇒ the historical read-only request
 * byte-for-byte; a throwing or null resolver degrades to read-only; the round
 * cap with panel tools is 5.
 */
describe('brief panel-content knife', () => {
  let dir: string
  let spaceDir: string
  const USER = 'u-knife'

  /** Wrap a provider to record each request's shape (system/maxTokens/tools). */
  function capture(inner: LlmProvider): {
    provider: LlmProvider
    reqs: { system: string; maxTokens: number | undefined; toolNames: string[] }[]
  } {
    const reqs: { system: string; maxTokens: number | undefined; toolNames: string[] }[] = []
    const provider: LlmProvider = {
      name: 'capture',
      stream(req: LlmRequest) {
        reqs.push({
          system: req.system ?? '',
          maxTokens: req.maxTokens,
          toolNames: (req.tools ?? []).map((t) => t.name),
        })
        return inner.stream(req)
      },
    }
    return { provider, reqs }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gotong-brief-knife-'))
    spaceDir = await mkdtemp(join(tmpdir(), 'gotong-brief-knife-space-'))
    const mem = openButlerMemory({ rootDir: dir, userId: USER, logger: silentLogger })
    await mem.remember({ kind: 'semantic', text: '用户在家种番茄' })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(spaceDir, { recursive: true, force: true })
  })

  it('the loop can fetch then write a panel card — the write lands in the real store, pinned to this user', async () => {
    const wx = fakeWeatherToolset()
    const surface = buildMePanelSurface({ spaceDir })
    const compose = buildButlerBriefComposer({
      rootDir: dir,
      buildProvider: async () =>
        new MockLlmProvider({
          reply: 'fallback',
          script: [
            { kind: 'tool_use', toolUses: [{ type: 'tool_use', id: 't1', name: 'weather__today', input: {} }] },
            {
              kind: 'tool_use',
              toolUses: [{
                type: 'tool_use', id: 't2', name: 'write_panel_content',
                input: { fileId: 'connector.weather', markdown: '# 今日天气\n吉隆坡 晴 32°C' },
              }],
            },
            { kind: 'text', text: '早上好!吉隆坡今天晴,32 度,记得给番茄浇水。' },
          ],
        }),
      logger: silentLogger,
      mcpReadTools: async () => wx.toolset,
      panelContentTools: (userId) => buildButlerPanelContentToolset({ userId, surface }),
    })
    const brief = await compose(USER, { enrich: true })
    expect(brief).toContain('吉隆坡今天晴')
    expect(wx.calls).toEqual(['weather__today'])
    expect((await surface.readContent(USER, 'connector.weather'))?.markdown).toContain('32°C')
    expect(await surface.readContent('someone-else', 'connector.weather')).toBeNull() // userId 闭包钉死
  })

  it('panel variant request shape: system addendum + 800 tokens + content tools only, never layout', async () => {
    const wx = fakeWeatherToolset()
    const surface = buildMePanelSurface({ spaceDir })
    const cap = capture(new MockLlmProvider({ reply: '早上好!' }))
    const compose = buildButlerBriefComposer({
      rootDir: dir,
      buildProvider: async () => cap.provider,
      logger: silentLogger,
      mcpReadTools: async () => wx.toolset,
      panelContentTools: (userId) => buildButlerPanelContentToolset({ userId, surface }),
    })
    await compose(USER, { enrich: true })
    expect(cap.reqs.length).toBe(1)
    const req = cap.reqs[0]!
    expect(req.system).toContain('write_panel_content') // the panel addendum rode along
    expect(req.system).toContain('绝不编造')
    expect(req.maxTokens).toBe(800) // BRIEF_PANEL_MAX_TOKENS — a markdown card doesn't fit 300
    expect(req.toolNames).toEqual([
      'weather__today', 'list_panel_content', 'read_panel_content', 'write_panel_content',
    ])
    // 布局两件结构性不在无人值守循环里(不只是不 advertise)。
    expect(req.toolNames).not.toContain('set_panel_layout')
    expect(req.toolNames).not.toContain('get_my_panel')
  })

  it('no panelContentTools option → the historical read-only request, byte-for-byte', async () => {
    const wx = fakeWeatherToolset()
    const cap = capture(new MockLlmProvider({ reply: '早上好!' }))
    const compose = buildButlerBriefComposer({
      rootDir: dir,
      buildProvider: async () => cap.provider,
      logger: silentLogger,
      mcpReadTools: async () => wx.toolset,
    })
    await compose(USER, { enrich: true })
    const req = cap.reqs[0]!
    expect(req.system).not.toContain('write_panel_content')
    expect(req.maxTokens).toBe(300)
    expect(req.toolNames).toEqual(['weather__today'])
  })

  it('a throwing or null panel resolver degrades to the read-only loop, brief still lands', async () => {
    for (const panelContentTools of [
      () => { throw new Error('store down') },
      () => null,
    ]) {
      const wx = fakeWeatherToolset()
      const cap = capture(new MockLlmProvider({ reply: '早上好!' }))
      const compose = buildButlerBriefComposer({
        rootDir: dir,
        buildProvider: async () => cap.provider,
        logger: silentLogger,
        mcpReadTools: async () => wx.toolset,
        panelContentTools,
      })
      expect(await compose(USER, { enrich: true })).toBe('早上好!')
      const req = cap.reqs[0]!
      expect(req.maxTokens).toBe(300) // read-only variant, not the panel one
      expect(req.toolNames).toEqual(['weather__today'])
    }
  })

  it('the round cap with panel tools is 5 — bounded, then stay silent', async () => {
    const wx = fakeWeatherToolset()
    const surface = buildMePanelSurface({ spaceDir })
    const compose = buildButlerBriefComposer({
      rootDir: dir,
      buildProvider: async () =>
        new MockLlmProvider({
          reply: 'fallback',
          script: Array.from({ length: 8 }, (_, i) => ({
            kind: 'tool_use' as const,
            toolUses: [{ type: 'tool_use' as const, id: `t${i}`, name: 'weather__today', input: {} }],
          })),
        }),
      logger: silentLogger,
      mcpReadTools: async () => wx.toolset,
      panelContentTools: (userId) => buildButlerPanelContentToolset({ userId, surface }),
    })
    const brief = await compose(USER, { enrich: true })
    expect(brief).toBeNull()
    expect(wx.calls.length).toBe(5) // BRIEF_MAX_TOOL_ROUNDS_WITH_PANEL — 查+写要更多轮,但仍有界
  })
})
