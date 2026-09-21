import { describe, expect, it } from 'vitest'
import type { Task } from '@gotong/core'
import { buildMemoryNet, crossStoreRecall, renderNetSheet } from '../src/memory-net.js'
import { buildMemorySheetProbe } from '../src/memory-sheet-probe.js'

describe('evidence-first automatic recall', () => {
  it('retains the original observed date and deduplicates copies of the same evidence', async () => {
    const text = 'I ate barbecue two weeks ago'
    const original = { id: 'digest', kind: 'semantic' as const, text, ts: Date.parse('2026-09-20T00:00:00Z'),
      meta: { evidence: { v: 1, sources: [{ sourceId: 'turn-1', speaker: 'user', start: 0, end: text.length,
        temporal: { v: 1, observedAt: Date.parse('2026-09-12T10:00:00Z'), timeZone: 'UTC', basis: 'turn-start' } }] } } }
    const net = await buildMemoryNet({ userId: 'u', entries: [original, { ...original, id: 'profile' }] })
    const sheet = renderNetSheet(net, ['memory:digest', 'memory:profile'])
    expect(sheet).toContain('turn-start: 2026-09-12 10:00:00 UTC')
    expect(sheet).toContain('event-time: unspecified')
    expect(sheet.match(/source "turn-1"/g)).toHaveLength(1)
  })
  it('retains original source time instead of presenting consolidation time as the event', async () => {
    const text = 'I ate barbecue two weeks ago'
    const net = await buildMemoryNet({ userId: 'u', entries: [{
      id: 'digest', kind: 'semantic', text, ts: Date.parse('2026-09-20T00:00:00Z'),
      meta: { evidence: { v: 1, sources: [{ sourceId: 'original', speaker: 'user', start: 0, end: text.length }] } },
    }] })
    const sheet = renderNetSheet(net, ['memory:digest'])
    expect(sheet).toContain('source "original"')
    expect(sheet).toContain('turn-time: unknown')
    expect(sheet).toContain('memory:digest')
    expect(sheet).not.toContain('[2026-09-20 memory]')
  })

  it('filters expired seeds before top-k so they cannot starve valid evidence', async () => {
    const net = await buildMemoryNet({ userId: 'u', entries: [
      { id: 'a', kind: 'semantic', text: 'barbecue', ts: 1, meta: { validTo: 2 } },
      { id: 'b', kind: 'semantic', text: 'barbecue', ts: 1 },
    ] })
    expect(await crossStoreRecall(net, 'barbecue', { now: 100, seedK: 1, k: 1 })).toEqual(['memory:b'])
  })

  it('defaults the production probe to current validity', async () => {
    const net = await buildMemoryNet({ userId: 'u', entries: [
      { id: 'old', kind: 'semantic', text: 'barbecue', ts: 1, meta: { validTo: 2 } },
    ] })
    const probe = buildMemorySheetProbe({ net: async () => net })
    expect(await probe({ payload: 'barbecue' } as Task)).toBeNull()
  })
})
