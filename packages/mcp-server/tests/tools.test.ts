/**
 * `tools.ts` is mostly Zod schemas + thin translators over `HubClient`.
 * The two non-trivial pieces of logic are `buildStrategy` (mapping the
 * MCP-facing `direct/capability/broadcast` vocabulary onto the core
 * scheduler's `explicit/capability/broadcast` shape — pre-3.1 this drift
 * silently hung every dispatch) and `windowToRange` (the `today` /
 * `7d` / `30d` / `all` preset → epoch range translator that feeds the
 * leaderboard query).
 *
 * Both are pure functions. Test them directly.
 */

import { describe, expect, it } from 'vitest'

import { buildStrategy, windowToRange } from '../src/tools.js'

describe('buildStrategy', () => {
  it("direct + recipient → { kind: 'explicit', to }", () => {
    // Regression guard for the v3.1 P1 fix. The MCP tool's outward
    // vocabulary stays `direct` (reads naturally for an LLM), but the
    // core scheduler only matches `explicit`. If this drifts again
    // every dispatch_task call will silently hang.
    expect(buildStrategy('direct', 'alice', undefined)).toEqual({
      kind: 'explicit',
      to: 'alice',
    })
  })

  it("direct without recipient throws (would be unroutable)", () => {
    expect(() => buildStrategy('direct', undefined, undefined)).toThrow(/recipient/)
    // Empty string is also bad — falsy check, no extra coverage needed.
    expect(() => buildStrategy('direct', '', undefined)).toThrow(/recipient/)
  })

  it("capability + non-empty capabilities passes through verbatim", () => {
    expect(buildStrategy('capability', undefined, ['draft', 'review'])).toEqual({
      kind: 'capability',
      capabilities: ['draft', 'review'],
    })
  })

  it("capability without capabilities throws", () => {
    expect(() => buildStrategy('capability', undefined, undefined)).toThrow(/capabilities/)
    expect(() => buildStrategy('capability', undefined, [])).toThrow(/capabilities/)
  })

  it("broadcast WITH capabilities keeps them as a filter", () => {
    expect(buildStrategy('broadcast', undefined, ['x'])).toEqual({
      kind: 'broadcast',
      capabilities: ['x'],
    })
  })

  it("broadcast WITHOUT capabilities is unfiltered (the room responds)", () => {
    expect(buildStrategy('broadcast', undefined, undefined)).toEqual({
      kind: 'broadcast',
    })
    expect(buildStrategy('broadcast', undefined, [])).toEqual({
      kind: 'broadcast',
    })
  })

  it("recipient is ignored for non-direct strategies (LLM might pass extras)", () => {
    // The MCP schema marks recipient as optional, so an LLM that
    // forgets to drop it when switching strategies shouldn't break.
    const out = buildStrategy('capability', 'bob', ['draft'])
    expect(out).toEqual({ kind: 'capability', capabilities: ['draft'] })
  })
})

describe('windowToRange', () => {
  it("'all' returns empty range so the API omits both bounds", () => {
    // The HubClient.leaderboard call short-circuits to /api/leaderboard
    // (no query string) when both `from` and `to` are absent. That's
    // how "all time" reaches the server.
    expect(windowToRange('all')).toEqual({})
  })

  it("'today' returns midnight..now (24h max span)", () => {
    const out = windowToRange('today')
    expect(out.from).toBeDefined()
    expect(out.to).toBeDefined()
    const span = (out.to ?? 0) - (out.from ?? 0)
    expect(span).toBeGreaterThanOrEqual(0)
    expect(span).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })

  it("'7d' returns a span between 7 days and 7 days + 1 minute", () => {
    const out = windowToRange('7d')
    const span = (out.to ?? 0) - (out.from ?? 0)
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    // Allow some scheduler jitter on a slow runner.
    expect(span).toBeGreaterThanOrEqual(sevenDays - 1000)
    expect(span).toBeLessThanOrEqual(sevenDays + 60_000)
  })

  it("'30d' returns a span around 30 days", () => {
    const out = windowToRange('30d')
    const span = (out.to ?? 0) - (out.from ?? 0)
    const thirtyDays = 30 * 24 * 60 * 60 * 1000
    expect(span).toBeGreaterThanOrEqual(thirtyDays - 1000)
    expect(span).toBeLessThanOrEqual(thirtyDays + 60_000)
  })

  it("'to' is approximately now (clock sanity)", () => {
    const before = Date.now()
    const out = windowToRange('today')
    const after = Date.now()
    expect(out.to).toBeGreaterThanOrEqual(before)
    expect(out.to).toBeLessThanOrEqual(after + 10)
  })
})
