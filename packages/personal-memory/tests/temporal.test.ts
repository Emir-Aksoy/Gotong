import { describe, expect, it, vi, afterEach } from 'vitest'
import { buildTurnCapture } from '../src/capture.js'
import { renderFrozenBlock, renderClusteredFrozenBlock } from '../src/frozen-block.js'
import { rememberNovel } from '../src/novelty.js'
import { MemoryToolset } from '../src/toolset.js'
import { observeTurnTime, temporalOf, formatTurnTime } from '../src/temporal.js'
import { entry, makeFakeMemory } from './fake-memory.js'

const at = Date.parse('2026-09-11T06:59:59Z')
const anchor = { v: 1 as const, observedAt: at, timeZone: 'America/Los_Angeles', basis: 'turn-start' as const }
const timed = (id = 'a', observedAt = at) => entry(id, 'episodic', 'User: today I ate barbecue', at + 60_000, {
  temporal: { ...anchor, observedAt },
})

afterEach(() => vi.restoreAllMocks())

describe('forward-only turn time', () => {
  it('uses the server zone by default and freezes it into the new record', () => {
    const actual = observeTurnTime(at)
    expect(actual.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(actual.observedAt).toBe(at)
    expect(observeTurnTime(at, 'invalid-zone').timeZone).toBe('UTC')
  })

  it('records UTC explicitly when the server cannot resolve its zone', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () { throw new Error('Intl unavailable') })
    expect(observeTurnTime(at).timeZone).toBe('UTC')
  })

  it('preserves the UTC fallback through capture, novelty and rendering without Intl', async () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () { throw new Error('Intl unavailable') })
    const memory = makeFakeMemory()
    for (const observedAt of [at, at + 86400_000]) {
      const captured = buildTurnCapture({ userText: 'today I ate barbecue', replyText: 'ok', temporal: observeTurnTime(observedAt) })!
      expect(captured.meta?.temporal).toMatchObject({ observedAt, timeZone: 'UTC' })
      expect((await rememberNovel(captured, { memory })).folded).toBe(false)
    }
    const rendered = renderFrozenBlock(memory.entries)
    expect(rendered).toContain('2026-09-11 06:59:59 UTC')
    expect(rendered).toContain('2026-09-12 06:59:59 UTC')
  })

  it('renders the stored zone across midnight and DST, not the current server date', () => {
    expect(formatTurnTime(anchor)).toBe('turn-start: 2026-09-10 23:59:59 America/Los_Angeles; event-time: unspecified')
    expect(formatTurnTime({ ...anchor, observedAt: at + 1000 })).toContain('2026-09-11 00:00:00')
    expect(formatTurnTime({ ...anchor, observedAt: Date.parse('2026-03-08T10:00:00Z') })).toContain('2026-03-08 03:00:00')
  })

  it.each([null, {}, { ...anchor, v: 2 }, { ...anchor, observedAt: NaN },
    { ...anchor, observedAt: 1e20 }, { ...anchor, timeZone: 'not/a-zone' },
    { ...anchor, basis: 'event' }])('rejects malformed metadata %j without inventing dates', (temporal) => {
    expect(temporalOf({ meta: { temporal } })).toBeUndefined()
  })

  it('adds only a caller-supplied local anchor and rejects extra-meta spoofing', () => {
    const input = { userText: 'today I ate barbecue', replyText: 'ok', meta: { temporal: { ...anchor, observedAt: 0 }, owner: 'alice' } }
    expect(buildTurnCapture({ ...input, temporal: anchor })!.meta).toMatchObject({ temporal: anchor, owner: 'alice' })
    expect(buildTurnCapture(input)!.meta).not.toHaveProperty('temporal')
    expect(buildTurnCapture({ userText: 'hi', replyText: 'ok' })!.meta).toEqual({ turn: true, userSpan: { v: 1, start: 6, end: 8 } })
  })

  it('makes identical words spoken on different dates distinguishable in frozen context', () => {
    const a = renderFrozenBlock([timed()])
    const b = renderFrozenBlock([timed('a', at + 7 * 86400_000)])
    expect(a).not.toBe(b)
    expect(a).toContain('2026-09-10 23:59:59 America/Los_Angeles')
    expect(a).toContain('event-time: unspecified')
    expect(renderFrozenBlock([entry('old', 'episodic', 'old words', at)])).toContain('[old] old words')
  })

  it('omits oversized timed evidence whole rather than stripping dates or exceeding body caps', () => {
    for (const render of [renderFrozenBlock, renderClusteredFrozenBlock]) {
      expect(render([timed()], { maxChars: 30 })).not.toContain('barbecue')
      const full = render([timed()], { maxChars: 500 })
      expect(full).toContain('barbecue')
      expect(full.split('\n').filter(l => l.startsWith('- ')).join('\n').length).toBeLessThanOrEqual(500)
    }
  })

  it('never folds a timed turn into another occurrence or a legacy record', async () => {
    for (const prior of [timed(), entry('old', 'episodic', timed().text, at)]) {
      const mem = makeFakeMemory([prior])
      const result = await rememberNovel(timed('new', at + 86400_000), { memory: mem })
      expect(result.folded).toBe(false)
      expect(mem.entries).toHaveLength(2)
    }
  })

  it('never lets an untimed turn erase a timed occurrence, while preserving legacy folding', async () => {
    const legacy = entry('old', 'episodic', timed().text, at)
    const mem = makeFakeMemory([timed()])
    expect((await rememberNovel(legacy, { memory: mem })).folded).toBe(false)
    expect((await rememberNovel(legacy, { memory: makeFakeMemory([legacy]) })).folded).toBe(true)
  })

  it('labels write time separately from observed turn time in recall', async () => {
    const tool = new MemoryToolset({ memory: makeFakeMemory([timed()]) })
    const result = await tool.callTool('recall', {})
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('recorded: 2026-09-11T07:00:59.000Z')
    expect(text).toContain('turn-start: 2026-09-10 23:59:59 America/Los_Angeles')
    expect(text).toContain('event-time: unspecified')
  })
})
