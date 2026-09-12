import { describe, expect, it, vi } from 'vitest'
import { buildTurnCapture } from '../src/capture.js'
import { observeTurnTime } from '../src/temporal.js'
import { evidenceSources, packEvidence, assertEvidenceSaved } from '../src/evidence.js'
import { consolidate, type MemorySummarizer } from '../src/consolidate.js'
import { consolidateTiered, promoteCluster } from '../src/consolidate-tiered.js'
import { atomicFactsReviewer } from '../src/atomic-facts.js'
import { renderFrozenBlock } from '../src/frozen-block.js'
import { MemoryToolset } from '../src/toolset.js'
import { makeFakeMemory } from './fake-memory.js'

const temporal = observeTurnTime(Date.parse('2026-09-11T12:00:00Z'), 'Asia/Shanghai')
const user = '我上上周吃过烤肉'
function captured(id = 'original', text = user, at = 1) {
  return { ...buildTurnCapture({ userText: text, replyText: '你昨天吃过。', temporal })!, id, ts: at }
}
const range = { start: '2026-08-24', end: '2026-08-31', precision: 'week' }

describe('persisted calendar evidence', () => {
  it('captures only user phrase dates, not assistant dates or caller metadata', () => {
    const e = captured()
    expect(evidenceSources(e)[0]).toMatchObject({ calendar: { v: 1, references: [{ range }] } })
    expect(JSON.stringify(e.meta?.calendar)).not.toContain('2026-09-10')
    const forged = buildTurnCapture({ userText: '没有日期', replyText: '昨天', meta: { calendar: e.meta?.calendar } })!
    expect(forged.meta).not.toHaveProperty('calendar')
  })
  it('never adds date interpretation to old spans or old packed evidence', () => {
    const e = captured()
    delete e.meta!.calendar
    const before = JSON.stringify(e)
    expect(evidenceSources(e)[0]).not.toHaveProperty('calendar')
    const packed = packEvidence(evidenceSources(e), 4000)!
    expect(renderFrozenBlock([{ ...packed, id: 'old', ts: 20 }])).not.toContain('2026-08-24')
    expect(JSON.stringify(e)).toBe(before)
  })
  it('does not persist date ranges from unsupported composites or non-date words', () => {
    for (const text of ['去年今天吃过烤肉', '后天性心脏病']) {
      const e = captured('s', text)
      expect(e.meta).not.toHaveProperty('calendar')
      expect(evidenceSources({ ...packEvidence(evidenceSources(e), 4000)!, id: 'p', ts: 1 })[0]).not.toHaveProperty('calendar')
    }
  })
  it('carries dates unchanged through two flat compaction generations', async () => {
    const original = captured()
    const recent = captured('recent', '没有日期', 2)
    const memory = makeFakeMemory([original, recent])
    const summarize = vi.fn(async () => '昨天吃了烤肉')
    const first = await consolidate({ memory, summarize, force: true, keepRecent: 1 })
    expect(evidenceSources(first!.profile)[0]).toMatchObject({ calendar: { references: [{ range }] } })
    await memory.remember(captured('next', '别的事', 3))
    const second = await consolidate({ memory, summarize, force: true, keepRecent: 1 })
    expect(evidenceSources(second!.profile)[0]).toEqual(evidenceSources(original)[0])
    expect(summarize).not.toHaveBeenCalled()
  })
  it('retains date references through tiered promotion and atomic source selection', async () => {
    const original = captured()
    const memory = makeFakeMemory([original, captured('recent', 'other', 2)])
    const summarize = async () => 'must not be used for compaction'
    const digest = await consolidateTiered({ memory, summarize, force: true, keepRecent: 1 })
    const profile = await promoteCluster({ memory, summarize, force: true, tier: digest!.digests[0]!.tier })
    expect(evidenceSources(profile!.profile!)[0]).toMatchObject({ calendar: { references: [{ range }] } })
    const atomicMemory = makeFakeMemory([original])
    const choose = vi.fn<MemorySummarizer>(async () => '{"sources":["original"]}')
    await atomicFactsReviewer({ summarize: choose, triggerEntries: 1 })({ memory: atomicMemory, episodic: [original], now: 9000 })
    expect(JSON.parse(choose.mock.calls[0]![0]!.user).sources[0]).toHaveProperty('calendar')
    const fact = atomicMemory.entries.find(e => e.kind === 'semantic')!
    expect(evidenceSources(fact)).toEqual(evidenceSources(original))
  })
  it('renders original dates before and after consolidation, independent of current time', async () => {
    const e = captured()
    const packed = { ...packEvidence(evidenceSources(e), 4000)!, id: 'profile', ts: 5000 }
    const initial = renderFrozenBlock([e, packed])
    expect(initial).toContain('[2026-08-24, 2026-08-31)')
    expect(initial).toContain('not event claims')
    expect(renderFrozenBlock([e]).match(/turn-start:/g)).toHaveLength(1)
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2028-01-01T00:00:00Z'))
    vi.stubEnv('TZ', 'Pacific/Honolulu')
    try {
      expect(renderFrozenBlock([e, packed])).toBe(initial)
      const result = await new MemoryToolset({ memory: makeFakeMemory([e, packed]) }).callTool('recall', {})
      expect(JSON.stringify(result)).toContain('[2026-08-24, 2026-08-31)')
    } finally { spy.mockRestore(); vi.unstubAllEnvs() }
    expect(renderFrozenBlock([packed], { maxChars: 100 })).not.toContain('2026-08-24')
  })
  it('does not convert a question or negation into an event claim', () => {
    for (const text of ['我上上周吃过烤肉吗？', '我上上周没有吃烤肉', '如果上上周吃过烤肉']) {
      const e = captured('s', text)
      expect(evidenceSources(e)[0]).toMatchObject({ text, calendar: { references: [{ range }] } })
      expect(e.meta).not.toHaveProperty('eventTime')
      expect(renderFrozenBlock([e])).toContain('not event claims')
    }
  })
  it('rejects forged or lost calendar evidence and keeps over-budget sources', async () => {
    const original = captured()
    const packed = packEvidence(evidenceSources(original), 4000)!
    const saved = JSON.parse(JSON.stringify({ ...packed, id: 'saved', ts: 1 }))
    delete saved.meta.evidence.sources[0].calendar
    expect(() => assertEvidenceSaved(packed, saved)).toThrow(/originals retained/)
    const corrupt = { ...original, meta: { ...original.meta, calendar: { v: 9 } } }
    expect(evidenceSources(corrupt)).toEqual([])
    const memory = makeFakeMemory([original, captured('recent', 'other', 2)])
    expect(await consolidate({ memory, summarize: async () => 'bad', force: true, keepRecent: 1, profileHardCap: 200 })).toBeNull()
    expect(memory.entries[0]).toEqual(original)
  })
})
