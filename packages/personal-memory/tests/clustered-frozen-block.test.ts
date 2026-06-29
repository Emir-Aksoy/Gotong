import { describe, expect, it } from 'vitest'

import { DEFAULT_TIERS, renderClusteredFrozenBlock } from '../src/index.js'
import { entry } from './fake-memory.js'

const tiered = (id: string, tier: string, text: string, ts: number, importance?: number) =>
  entry(id, 'semantic', text, ts, {
    tier,
    ...(importance !== undefined ? { importance } : {}),
  })

describe('renderClusteredFrozenBlock', () => {
  it('emits the stable markers + heading + preamble, even when empty', () => {
    const out = renderClusteredFrozenBlock([], { label: 'butler' })
    expect(out.startsWith('<!-- aipehub:memory:begin -->')).toBe(true)
    expect(out.endsWith('<!-- aipehub:memory:end -->')).toBe(true)
    expect(out).toContain('# Long-term memory — butler')
    expect(out).toContain('_(no memories yet)_')
  })

  it('groups entries into one subsection per cluster, in catalog order', () => {
    const out = renderClusteredFrozenBlock([
      tiered('m1', 'misc', 'a stray note', 100),
      tiered('c1', 'commitments', 'owes a report', 101),
      tiered('p1', 'persona', 'likes tea', 102),
    ])
    const iPersona = out.indexOf('## 画像')
    const iCommit = out.indexOf('## 承诺')
    const iMisc = out.indexOf('## 其它')
    expect(iPersona).toBeGreaterThan(-1)
    expect(iCommit).toBeGreaterThan(-1)
    expect(iMisc).toBeGreaterThan(-1)
    // catalog order: persona < commitments < misc
    expect(iPersona).toBeLessThan(iCommit)
    expect(iCommit).toBeLessThan(iMisc)
    // the entries themselves are present
    expect(out).toContain('[p1] likes tea')
    expect(out).toContain('[c1] owes a report')
  })

  it('orders within a cluster by importance first, then recency', () => {
    const out = renderClusteredFrozenBlock([
      tiered('low', 'persona', 'minor habit', 200, 2),
      tiered('pin', 'persona', 'critical allergy', 100, 5),
    ])
    // pin (importance 5) leads even though it is OLDER than the low one
    expect(out.indexOf('[pin]')).toBeLessThan(out.indexOf('[low]'))
  })

  it('folds untiered and unknown-tier entries into the default cluster (misc)', () => {
    const out = renderClusteredFrozenBlock([
      entry('plain', 'semantic', 'no tier at all', 100), // no meta
      tiered('weird', 'zzz-not-a-cluster', 'bogus tier', 101),
    ])
    // both land under 其它, and there is no bogus `## zzz` section
    const iMisc = out.indexOf('## 其它')
    expect(iMisc).toBeGreaterThan(-1)
    expect(out).not.toContain('zzz')
    expect(out).toContain('[plain] no tier at all')
    expect(out).toContain('[weird] bogus tier')
    // only one cluster present
    expect(out.match(/^## /gm)?.length).toBe(1)
  })

  it('is a pure function of the entry SET (input order does not change bytes)', () => {
    const a = tiered('p1', 'persona', 'fact one', 100, 4)
    const b = tiered('j1', 'projects', 'fact two', 101, 3)
    const c = tiered('p2', 'persona', 'fact three', 102, 5)
    const forward = renderClusteredFrozenBlock([a, b, c], { label: 'x' })
    const shuffled = renderClusteredFrozenBlock([c, a, b], { label: 'x' })
    expect(shuffled).toBe(forward)
  })

  it('splits a tight budget across clusters and notes what was dropped', () => {
    const long = (id: string, tier: string) =>
      tiered(id, tier, `${id} ${'x'.repeat(40)}`, 100 + Number(id.replace(/\D/g, '') || 0))
    const out = renderClusteredFrozenBlock(
      [
        tiered('p1', 'persona', 'short persona fact', 100),
        long('m1', 'misc'),
        long('m2', 'misc'),
        long('m3', 'misc'),
        long('m4', 'misc'),
        long('m5', 'misc'),
      ],
      { maxChars: 140 },
    )
    // persona keeps its line; the busy misc cluster drops some with a note
    expect(out).toContain('[p1] short persona fact')
    expect(out).toContain('omitted to fit the memory budget')
  })

  it('lifts procedures out of clusters into the G-M2 section (opt-in)', () => {
    const entries = [
      tiered('p1', 'persona', 'likes tea', 100, 4),
      entry('proc1', 'semantic', 'brew tea', 90, {
        tier: 'projects',
        form: 'procedure',
        steps: ['boil', 'steep'],
      }),
    ]
    // off: the procedure sits in its cluster as a plain bullet
    const off = renderClusteredFrozenBlock(entries)
    expect(off).toContain('## 项目')
    expect(off).toContain('[proc1] brew tea')
    expect(off).not.toContain('Things I know how to do')

    // on: the procedure leaves the cluster (now empty → no 项目 section) and
    // appears in the dedicated how-to section with its steps.
    const on = renderClusteredFrozenBlock(entries, { showProcedures: true })
    expect(on).toContain('## Things I know how to do')
    expect(on).toContain('- [proc1] brew tea — 1. boil; 2. steep')
    expect(on).not.toContain('## 项目') // its only member was lifted out
    const clusterPart = on.split('## Things I know how to do')[0]!
    expect(clusterPart).not.toContain('[proc1]')
    expect(on).toContain('[p1] likes tea') // a real persona fact stays
  })

  it('activeOnly (D-M2) drops a closed entry, collapsing its now-empty cluster', () => {
    const entries = [
      tiered('keep', 'persona', 'lives in Penang', 100, 4),
      entry('gone', 'semantic', 'old project', 90, {
        tier: 'projects',
        validFrom: 50,
        validTo: 80, // closed before now
      }),
    ]
    const on = renderClusteredFrozenBlock(entries, { activeOnly: true, now: 300 })
    expect(on).toContain('[keep] lives in Penang')
    expect(on).not.toContain('[gone]')
    expect(on).not.toContain('## 项目') // its only member was closed → cluster gone
    // off → the closed project still shows under its cluster
    expect(renderClusteredFrozenBlock(entries)).toContain('[gone] old project')
  })
})
