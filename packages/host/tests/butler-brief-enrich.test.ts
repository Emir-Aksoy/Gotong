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
import { MockLlmProvider, type LlmAgentToolset, type LlmToolCallResult, type LlmToolDefinition } from '@gotong/llm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildButlerDailyBriefToolset } from '../src/personal-butler-daily-brief.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
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
