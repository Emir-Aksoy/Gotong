import { describe, expect, it } from 'vitest'
import type { MemoryEntry } from '@gotong/services-sdk'
import { buildTurnCapture } from '../src/capture.js'
import { evidenceSources, packEvidence } from '../src/evidence.js'
import { prepareEvidenceCorrection, type EvidenceCorrectionOptions } from '../src/correction.js'

const time = { v: 1 as const, observedAt: Date.parse('2026-09-01T06:00:00Z'), timeZone: 'America/Los_Angeles', basis: 'turn-start' as const }
const newTime = { ...time, observedAt: Date.parse('2026-09-11T06:00:00Z') }
const oldText = 'I ate barbecue yesterday'
function raw(id = 'old', text = oldText): MemoryEntry {
  return { ...buildTurnCapture({ userText: text, replyText: 'The assistant repeated a wrong date', temporal: time, meta: { userId: 'alice' } })!, id, ts: time.observedAt }
}
function packed(id: string, records: MemoryEntry[], extra: Record<string, unknown> = {}): MemoryEntry {
  return { ...packEvidence(records.flatMap(evidenceSources), 10000, extra)!, id, ts: time.observedAt + 1000 }
}
function options(patch: Partial<EvidenceCorrectionOptions> = {}): EvidenceCorrectionOptions {
  return { userId: 'alice', target: { quote: oldText }, replacement: {
    sourceId: 'correction-turn', text: 'I ate barbecue on 2026-08-29', temporal: newTime,
  }, maxEntryBytes: 4096, ...patch }
}

describe('source-based correction planning (no I/O or authorization)', () => {
  it('replaces a uniquely identified user source without retaining old text or assistant output', () => {
    const input = [raw()]
    const before = JSON.stringify(input)
    const plan = prepareEvidenceCorrection(input, options())
    expect(plan.status).toBe('ready')
    if (plan.status !== 'ready') throw new Error('expected ready')
    expect(plan.remove).toEqual([{ id: 'old', kind: 'episodic' }])
    expect(plan.rewrite).toEqual([])
    expect(plan.untraced).toEqual([])
    expect(plan.replacement.kind).toBe('semantic')
    expect(evidenceSources({ ...plan.replacement, id: 'saved', ts: 123 })).toEqual([{
      sourceId: 'correction-turn', text: options().replacement.text, temporal: newTime, scope: 'alice',
      calendar: { v: 1, references: [{ start: 18, end: 28, range: { start: '2026-08-29', end: '2026-08-30', precision: 'day' } }], overflow: false },
    }])
    expect(JSON.stringify(plan)).not.toContain(oldText)
    expect(JSON.stringify(plan)).not.toContain('wrong date')
    expect(plan.replacement.meta).not.toHaveProperty('supersedes')
    expect(plan.replacement.meta).not.toHaveProperty('validTo')
    expect(JSON.stringify(input)).toBe(before)
  })

  it('recognizes copies of one source across several generations, including when raw source is gone', () => {
    const source = raw()
    const first = packed('digest', [source])
    const second = packed('profile', [first])
    const plan = prepareEvidenceCorrection([first, second], options())
    expect(plan.status).toBe('ready')
    if (plan.status !== 'ready') throw new Error('expected ready')
    expect(plan.remove).toEqual([{ id: 'digest', kind: 'semantic' }, { id: 'profile', kind: 'semantic' }])
    expect(plan.rewrite).toEqual([])
  })

  it('preserves unrelated source quotes and times in shared containers but drops stale derived metadata', () => {
    const other = raw('other', '上周我买了咖啡')
    const mixed = packed('digest', [raw(), other], { level: 'profile', summary: oldText, steps: [oldText], verified: true })
    const untouched = packed('unrelated', [other])
    const plan = prepareEvidenceCorrection([raw(), mixed, untouched], options())
    expect(plan.status).toBe('ready')
    if (plan.status !== 'ready') throw new Error('expected ready')
    expect(plan.remove).toEqual([{ id: 'old', kind: 'episodic' }])
    expect(plan.rewrite).toHaveLength(1)
    expect(plan.rewrite[0]).toMatchObject({ id: 'digest', kind: 'semantic', ts: mixed.ts })
    expect(evidenceSources(plan.rewrite[0]!)).toEqual(evidenceSources(other))
    expect(Object.keys(plan.rewrite[0]!.meta!).sort()).toEqual(['evidence', 'userId'])
    expect(JSON.stringify(plan)).not.toContain(oldText)
    expect(mixed.meta!.summary).toBe(oldText)
  })

  it('requests disambiguation for identical statements from different original turns', () => {
    expect(prepareEvidenceCorrection([raw('one'), raw('two')], options())).toEqual({ status: 'ambiguous', sourceIds: ['one', 'two'] })
  })

  it('allows an exact source ID to disambiguate, still requiring exact old quote', () => {
    const plan = prepareEvidenceCorrection([raw('one'), raw('two')], options({ target: { quote: oldText, sourceId: 'two' } }))
    expect(plan.status).toBe('ready')
    if (plan.status !== 'ready') throw new Error('expected ready')
    expect(plan.remove).toEqual([{ id: 'two', kind: 'episodic' }])
    expect(prepareEvidenceCorrection([raw('one')], options({ target: { quote: 'different', sourceId: 'one' } }))).toEqual({ status: 'not_found', sourceIds: [] })
  })

  it.each(['I ate barbecue last week', ' I ate barbecue yesterday', 'barbecue', 'i ate barbecue yesterday'])('does not guess by similarity or normalize the user quote: %s', quote => {
    expect(prepareEvidenceCorrection([raw()], options({ target: { quote } }))).toEqual({ status: 'not_found', sourceIds: [] })
  })

  it('does not infer provenance for legacy records, and exposes them for the future executor to account for', () => {
    const legacy: MemoryEntry = { id: 'legacy', kind: 'semantic', text: oldText, ts: 1 }
    expect(prepareEvidenceCorrection([legacy], options())).toEqual({ status: 'not_found', sourceIds: [] })
    const plan = prepareEvidenceCorrection([raw(), legacy], options())
    expect(plan.status).toBe('ready')
    if (plan.status !== 'ready') throw new Error('expected ready')
    expect(plan.untraced).toEqual([{ id: 'legacy', kind: 'semantic' }])
    expect(plan.remove).not.toContainEqual({ id: 'legacy', kind: 'semantic' })
  })

  it('reports a valid timed assistant-only capture as untraced instead of broken evidence', () => {
    const assistant = { ...buildTurnCapture({ userText: '', replyText: 'Assistant note', temporal: time })!, id: 'assistant', ts: 1 }
    const plan = prepareEvidenceCorrection([raw(), assistant], options())
    expect(plan.status).toBe('ready')
    if (plan.status !== 'ready') throw new Error('expected ready')
    expect(plan.untraced).toEqual([{ id: 'assistant', kind: 'episodic' }])
  })

  it.each([{ temporal: { ...time, timeZone: 'invalid' } }, { userSpan: { v: 1, start: 0, end: 4 } }, { calendar: null }])('rejects competing raw markers on a packed container: %j', extra => {
    const mixed = packed('mixed-representation', [raw()])
    Object.assign(mixed.meta!, extra)
    expect(() => prepareEvidenceCorrection([raw(), mixed], options())).toThrowError(expect.objectContaining({ code: 'correction_invalid' }))
  })

  it('rejects corrupt time on an otherwise untraced record', () => {
    const invalid = { id: 'bad', kind: 'episodic' as const, text: 'untraced', ts: 1, meta: { temporal: null } }
    expect(() => prepareEvidenceCorrection([raw(), invalid], options())).toThrowError(expect.objectContaining({ code: 'correction_invalid' }))
  })

  it('preserves the storage kind of a rebuilt container', () => {
    const mixed = { ...packed('mixed', [raw(), raw('other', 'unrelated')]), kind: 'working' as const }
    const plan = prepareEvidenceCorrection([mixed], options())
    expect(plan.status).toBe('ready')
    if (plan.status !== 'ready') throw new Error('expected ready')
    expect(plan.rewrite[0]!.kind).toBe('working')
  })

  it.each(['text', 'time', 'scope'] as const)('rejects source conflicts in %s before producing any plan', variation => {
    const s = evidenceSources(raw())[0]!
    const conflicting = { ...packed('other-copy', [raw()]), ...(variation === 'text' ? { text: 'A completely different statement' } : {}) }
    if (variation === 'time') {
      const envelope = conflicting.meta!.evidence as { sources: Record<string, unknown>[] }
      envelope.sources[0]!.temporal = newTime
    }
    if (variation === 'scope') conflicting.meta!.userId = 'bob'
    expect(s.sourceId).toBe('old')
    expect(() => prepareEvidenceCorrection([raw(), conflicting], options())).toThrow()
  })

  it('rejects valid but conflicting source payloads', () => {
    const changed = packEvidence([{ ...evidenceSources(raw())[0]!, text: 'A different valid quote' }], 4096)!
    expect(() => prepareEvidenceCorrection([raw(), { ...changed, id: 'copy', ts: 2 }], options())).toThrowError(expect.objectContaining({ code: 'evidence_source_conflict' }))
  })

  it.each([{ userId: 'bob' }, { userId: 'alice', user: 'bob' }, { user: 42 }])('rejects mismatched or corrupt owner metadata: %j', meta => {
    const e = { ...raw(), meta: { ...raw().meta, ...meta } }
    expect(() => prepareEvidenceCorrection([e], options())).toThrowError(expect.objectContaining({ code: 'correction_invalid' }))
  })

  it('allows untagged evidence only within the caller-supplied owner namespace', () => {
    const e = raw()
    delete e.meta!.userId
    expect(prepareEvidenceCorrection([e], options()).status).toBe('ready')
  })

  it('does not accept a truncated or corrupt evidence container as a complete scan', () => {
    const bad = raw('bad')
    bad.meta!.userSpan = { v: 1, start: 6, end: 12, complete: false }
    expect(() => prepareEvidenceCorrection([raw(), bad], options())).toThrowError(expect.objectContaining({ code: 'correction_invalid' }))
  })

  it.each([null, 0, 'false', {}])('rejects a corrupt completeness marker before proposing a delete: %j', complete => {
    const e = raw()
    const span = e.meta!.userSpan as Record<string, unknown>
    span.complete = complete
    expect(() => prepareEvidenceCorrection([e], options())).toThrowError(expect.objectContaining({ code: 'correction_invalid' }))
  })

  it('rejects duplicate container identities rather than overwriting by traversal order', () => {
    expect(() => prepareEvidenceCorrection([raw(), raw()], options())).toThrowError(expect.objectContaining({ code: 'correction_invalid' }))
    expect(() => prepareEvidenceCorrection([raw(), packed('old', [raw()])], options())).toThrowError(expect.objectContaining({ code: 'correction_invalid' }))
  })

  it.each(['old', 'digest'])('requires a fresh replacement source ID, not an existing source or container: %s', sourceId => {
    const opts = options()
    opts.replacement.sourceId = sourceId
    expect(() => prepareEvidenceCorrection([packed('digest', [raw()])], opts)).toThrowError(expect.objectContaining({ code: 'correction_invalid' }))
  })

  it('uses the correction turn clock for new relative words without reanchoring retained sources', () => {
    const other = raw('other', '上周我喝了咖啡')
    const opts = options()
    opts.replacement.text = '上上周我吃了烤肉'
    const plan = prepareEvidenceCorrection([packed('mixed', [raw(), other])], opts)
    expect(plan.status).toBe('ready')
    if (plan.status !== 'ready') throw new Error('expected ready')
    expect(evidenceSources({ ...plan.replacement, id: 'new', ts: 0 })[0]!.calendar!.references[0]!.range).toEqual({ start: '2026-08-24', end: '2026-08-31', precision: 'week' })
    expect(evidenceSources(plan.rewrite[0]!)).toEqual(evidenceSources(other))
  })

  it.each([undefined, { ...newTime, timeZone: 'Not/AZone' }, { ...newTime, observedAt: NaN }])('requires a valid new turn time: %j', temporal => {
    const opts = options()
    opts.replacement.temporal = temporal as typeof newTime
    expect(() => prepareEvidenceCorrection([raw()], opts)).toThrowError(expect.objectContaining({ code: 'correction_invalid' }))
  })

  it.each([0, NaN, Infinity, -1, 1.5, 10])('rejects invalid or insufficient packing budgets without dropping sources: %s', maxEntryBytes => {
    expect(() => prepareEvidenceCorrection([raw()], options({ maxEntryBytes }))).toThrow()
  })

  it('refuses an oversized retained quote rather than partially deleting a shared container', () => {
    const other = raw('other', 'x'.repeat(900))
    expect(() => prepareEvidenceCorrection([packed('mixed', [raw(), other])], options({ maxEntryBytes: 700 }))).toThrowError(expect.objectContaining({ code: 'semantic_overflow' }))
  })

  it('budgets the full rewritten record including its retained ID and timestamp', () => {
    const other = raw('other', 'coffee')
    const mixed = packed('x'.repeat(200), [raw(), other])
    const full = { ...packEvidence(evidenceSources(other), 4096)!, id: mixed.id, kind: mixed.kind, ts: mixed.ts }
    const bytes = Buffer.byteLength(JSON.stringify(full), 'utf8')
    const plan = prepareEvidenceCorrection([mixed], options({ maxEntryBytes: bytes }))
    expect(plan.status).toBe('ready')
    if (plan.status !== 'ready') throw new Error('expected ready')
    expect(plan.rewrite).toEqual([full])
    expect(() => prepareEvidenceCorrection([mixed], options({ maxEntryBytes: bytes - 1 }))).toThrowError(expect.objectContaining({ code: 'semantic_overflow' }))
  })

  it('does not leak source text into validation errors', () => {
    const e = raw()
    e.meta!.userSpan = null
    try { prepareEvidenceCorrection([e], options()); throw new Error('expected refusal') }
    catch (error) {
      expect((error as Error).message).not.toContain(oldText)
      expect(error).toMatchObject({ code: 'correction_invalid' })
    }
  })
})
