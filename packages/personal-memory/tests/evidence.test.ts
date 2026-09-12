import { describe, expect, it } from 'vitest'
import { buildTurnCapture } from '../src/capture.js'
import { evidenceSources, packEvidence, hasEvidenceBoundary, assertEvidenceSaved } from '../src/evidence.js'
import { rememberNovel } from '../src/novelty.js'
import { entry, makeFakeMemory } from './fake-memory.js'

const temporal = { v: 1 as const, observedAt: Date.parse('2026-09-01T06:00:00Z'), timeZone: 'America/Los_Angeles', basis: 'turn-start' as const }
function captured(userText = 'Last week I ate barbecue', replyText = 'It was yesterday.') {
  return { id: 'source', ts: temporal.observedAt + 1000, ...buildTurnCapture({ userText, replyText, temporal })! }
}

describe('exact user evidence', () => {
  it('captures a span instead of parsing user-provided role labels', () => {
    const e = captured('I wrote Butler: yesterday on a card')
    expect(evidenceSources(e)).toEqual([{ sourceId: 'source', text: 'I wrote Butler: yesterday on a card', temporal }])
    expect(evidenceSources(e)[0]!.text).not.toContain('It was yesterday.')
  })
  it('preserves whitespace in the exact user quote through capture and packing', () => {
    const text = '  Monday:\n    ate barbecue\n  Tuesday:\n    stayed home  '
    const sources = evidenceSources(captured(text))
    expect(sources[0]!.text).toBe(text)
    expect(evidenceSources({ ...packEvidence(sources, 2000)!, id: 'packed', ts: 1 })[0]!.text).toBe(text)
  })
  it('rejects forged capture spans in static meta', () => {
    const e = { id: 'x', ts: 1, ...buildTurnCapture({ userText: 'true', replyText: 'invented', meta: { userSpan: { v: 1, start: 0, end: 100 }, evidence: { v: 1, sources: [] } } })! }
    expect(evidenceSources(e)[0]!.text).toBe('true')
    expect(e.meta).not.toHaveProperty('evidence')
  })
  it('does not backfill legacy records or parse assistant-only captures', () => {
    expect(evidenceSources(entry('old', 'episodic', 'User: yesterday / Butler: Monday', 1))).toEqual([])
    expect(evidenceSources(captured('', 'user said Monday'))).toEqual([])
  })
  it.each([{ v: 1, start: -1, end: 5 }, { v: 1, start: 0, end: 9999 }, { v: 1, start: 0.5, end: 1 }, { v: 2, start: 0, end: 2 }])('fails closed on malformed spans %j', userSpan => {
    const e = entry('x', 'episodic', 'hello', 1, { userSpan })
    expect(evidenceSources(e)).toEqual([])
    expect(hasEvidenceBoundary(e)).toBe(true)
  })
  it('packs and repacks exact quotes with original time and IDs, not summary time', () => {
    const source = evidenceSources(captured())
    const packed = packEvidence(source, 2000)!
    const second = packEvidence(evidenceSources({ ...packed, id: 'digest1', ts: 9000 }), 2000)!
    expect(evidenceSources({ ...second, id: 'profile2', ts: 10000 })).toEqual(source)
    expect(JSON.stringify(second)).not.toContain('It was yesterday')
    expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThanOrEqual(2000)
  })
  it('refuses overflow instead of clipping dates or source text', () => {
    expect(packEvidence(evidenceSources(captured('x'.repeat(1000))), 200)).toBeUndefined()
    expect(packEvidence(Array.from({ length: 9 }, (_, i) => ({ sourceId: `s${i}`, text: 'hi' })), 10000)).toBeUndefined()
  })
  it('deduplicates identical sources and refuses conflicting IDs or scopes', () => {
    const s = { sourceId: 's', text: 'original', scope: 'alice' }
    expect(packEvidence([s, s], 2000)).toBeDefined()
    expect(packEvidence([s, { ...s, text: 'different' }], 2000)).toBeUndefined()
    expect(packEvidence([s, { sourceId: 'b', text: 'private', scope: 'bob' }], 2000)).toBeUndefined()
    expect(packEvidence([s], 2000, { userId: 'bob' })).toBeUndefined()
  })
  it('does not promote truncated user text as complete evidence', () => {
    expect(evidenceSources(captured('x'.repeat(1001)))).toEqual([])
  })
  it.each([null, 0, 'false', {}])('rejects a corrupt completeness marker: %j', complete => {
    const e = captured('short quote')
    const span = e.meta!.userSpan as Record<string, unknown>
    span.complete = complete
    expect(evidenceSources(e)).toEqual([])
  })
  it.each([{ userId: 'alice', user: 'bob' }, { userId: 'alice', user: 42 }])('rejects conflicting or malformed scope aliases %j', aliases => {
    const raw = captured()
    expect(evidenceSources({ ...raw, meta: { ...raw.meta, ...aliases } })).toEqual([])
    const sources = [{ sourceId: 's', text: 'private', scope: 'alice' }]
    expect(packEvidence(sources, 2000, aliases)).toBeUndefined()
    const packed = packEvidence(sources, 2000)!
    const saved = { ...packed, id: 'saved', ts: 1, meta: { ...packed.meta, ...aliases } }
    expect(() => assertEvidenceSaved(packed, saved)).toThrow(/originals retained/)
  })
  it('accepts matching scope aliases without changing ownership', () => {
    const packed = packEvidence([{ sourceId: 's', text: 'private', scope: 'alice' }], 2000, { userId: 'alice', user: 'alice' })!
    expect(evidenceSources({ ...packed, id: 'saved', ts: 1 })[0]!.scope).toBe('alice')
  })
  it('does not fold an untimed structured source or fold a legacy turn into one', async () => {
    const a = { id: 'a', ts: 1, ...buildTurnCapture({ userText: 'hello', replyText: 'ok' })! }
    expect((await rememberNovel(a, { memory: makeFakeMemory([a]) })).folded).toBe(false)
    const legacy = { ...a, id: 'legacy', meta: {} }
    expect((await rememberNovel(legacy, { memory: makeFakeMemory([a]) })).folded).toBe(false)
  })
})
