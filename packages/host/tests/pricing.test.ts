/**
 * Phase 17 (Sprint 4) — model price table + cost estimator.
 *
 * Coverage:
 *   - estimateCostMicros: exact + prefix model match, input/output/cache
 *     math, derived cache rates, unknown model → unpriced, zero usage
 *   - resolveModelPrice: exact, longest-prefix wins, no match
 *   - loadPricingTable: no path / missing file → defaults; override
 *     merges over defaults; malformed JSON + bad entry → throw
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_PRICING,
  estimateCostMicros,
  loadPricingTable,
  resolveModelPrice,
} from '../src/pricing.js'

describe('pricing — estimateCostMicros', () => {
  it('multiplies tokens by per-1M rate (tokens * per1M == micros)', () => {
    // claude-opus-4: input 15 / output 75 per 1M.
    // 1000*15 + 200*75 = 15000 + 15000 = 30000 micro-USD ($0.03).
    const est = estimateCostMicros(
      { inputTokens: 1000, outputTokens: 200 },
      'claude-opus-4',
    )
    expect(est).toEqual({ costMicros: 30_000, unpriced: false })
  })

  it('derives cache-write / cache-read rates off input when omitted', () => {
    // cacheWrite = 15*1.25 = 18.75; cacheRead = 15*0.1 = 1.5.
    // 1000*15 + 200*75 + 100*18.75 + 500*1.5 = 30000 + 1875 + 750 = 32625.
    const est = estimateCostMicros(
      {
        inputTokens: 1000,
        outputTokens: 200,
        cacheCreationTokens: 100,
        cacheReadTokens: 500,
      },
      'claude-opus-4',
    )
    expect(est.costMicros).toBe(32_625)
    expect(est.unpriced).toBe(false)
  })

  it('uses an explicit cache-read rate when the model sets one', () => {
    // gpt-4o: input 2.5 / output 10 / cacheRead 1.25.
    // 1000*2.5 + 1000*10 + 1000*1.25 = 2500 + 10000 + 1250 = 13750.
    const est = estimateCostMicros(
      { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000 },
      'gpt-4o',
    )
    expect(est.costMicros).toBe(13_750)
  })

  it('resolves a dated model id via prefix match', () => {
    const est = estimateCostMicros(
      { inputTokens: 1000, outputTokens: 0 },
      'claude-opus-4-8-20260514',
    )
    expect(est.costMicros).toBe(15_000) // matched claude-opus-4
  })

  it('flags an unknown model as unpriced with zero cost', () => {
    const est = estimateCostMicros(
      { inputTokens: 9999, outputTokens: 9999 },
      'totally-made-up-model',
    )
    expect(est).toEqual({ costMicros: 0, unpriced: true })
  })

  it('returns 0 for zero / missing usage on a known model', () => {
    expect(estimateCostMicros({}, 'claude-opus-4').costMicros).toBe(0)
  })

  it('honours an injected custom table', () => {
    const table = { 'x-model': { inputPer1M: 1000, outputPer1M: 0 } }
    const est = estimateCostMicros({ inputTokens: 1000 }, 'x-model', table)
    expect(est.costMicros).toBe(1_000_000) // 1000 tokens * 1000/1M = $1
  })
})

describe('pricing — resolveModelPrice', () => {
  it('prefers an exact match', () => {
    expect(resolveModelPrice('gpt-4o')).toEqual(DEFAULT_PRICING['gpt-4o'])
  })

  it('picks the LONGEST matching prefix', () => {
    // 'gpt-4o-mini-2024' starts with both 'gpt-4o' and 'gpt-4o-mini';
    // the longer key must win.
    expect(resolveModelPrice('gpt-4o-mini-2024')).toEqual(
      DEFAULT_PRICING['gpt-4o-mini'],
    )
  })

  it('returns undefined when nothing matches', () => {
    expect(resolveModelPrice('nope')).toBeUndefined()
  })
})

describe('pricing — loadPricingTable', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'host-pricing-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the defaults when no path is given', () => {
    const t = loadPricingTable()
    expect(t['claude-opus-4']).toBeDefined()
    // A copy, not the shared singleton.
    expect(t).not.toBe(DEFAULT_PRICING)
  })

  it('returns the defaults when the file is missing', () => {
    const t = loadPricingTable(join(dir, 'does-not-exist.json'))
    expect(t['gpt-4o']).toBeDefined()
  })

  it('merges an override over the defaults', () => {
    const p = join(dir, 'pricing.json')
    writeFileSync(
      p,
      JSON.stringify({
        'claude-opus-4': { inputPer1M: 99, outputPer1M: 1 },
        'custom-model': { inputPer1M: 5, outputPer1M: 5 },
      }),
    )
    const t = loadPricingTable(p)
    expect(t['claude-opus-4']).toEqual({ inputPer1M: 99, outputPer1M: 1 }) // overridden
    expect(t['custom-model']).toEqual({ inputPer1M: 5, outputPer1M: 5 }) // added
    expect(t['gpt-4o']).toBeDefined() // untouched default survives
  })

  it('throws on malformed JSON (fail loud, never bill at wrong rate)', () => {
    const p = join(dir, 'bad.json')
    writeFileSync(p, '{ not valid json ]')
    expect(() => loadPricingTable(p)).toThrow(/not valid JSON/)
  })

  it('throws on a bad price entry', () => {
    const p = join(dir, 'bad-entry.json')
    writeFileSync(p, JSON.stringify({ 'x': { inputPer1M: 'free', outputPer1M: 1 } }))
    expect(() => loadPricingTable(p)).toThrow(/must be a non-negative number/)
  })

  it('throws when the top level is not an object', () => {
    const p = join(dir, 'arr.json')
    writeFileSync(p, JSON.stringify([1, 2, 3]))
    expect(() => loadPricingTable(p)).toThrow(/must be a JSON object/)
  })
})
