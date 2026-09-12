import { describe, expect, it, vi } from 'vitest'

import { atomicFactsReviewer, isAtomicFact, parseFacts } from '../src/index.js'
import type { MemorySummarizer } from '../src/index.js'
import { evidenceSources, packEvidence } from '../src/evidence.js'
import { observeTurnTime } from '../src/temporal.js'
import { entry, makeFakeMemory } from './fake-memory.js'

const T = 1_700_000_000_000

function turn(id: string, user: string, ts = T) {
  return entry(id, 'episodic', `User: ${user} / Butler: ASSISTANT_ONLY_POISON`, ts, {
    userSpan: { v: 1, start: 6, end: 6 + user.length },
    temporal: observeTurnTime(ts, 'Asia/Shanghai'),
    userId: 'member-1',
  })
}

function episodicTurns() {
  return [
    turn('e4', '我车是特斯拉 Model 3', T + 40),
    turn('e3', '我养了只金毛叫大黄', T + 30),
    turn('e2', '我最近很忙', T + 20),
    turn('e1', '上周点了珍珠奶茶很好喝', T + 10),
  ]
}

const select = (...sources: string[]): MemorySummarizer => async () => JSON.stringify({ sources })

describe('atomicFactsReviewer evidence selection', () => {
  it('writes exact user sources with original speaker, scope and turn time', async () => {
    const episodic = episodicTurns()
    const memory = makeFakeMemory(episodic)
    const summarize = vi.fn(select('e3', 'e4'))
    const out = await atomicFactsReviewer({ summarize })({ memory, episodic, now: T + 100 })

    expect(out.consolidated).toBe(2)
    const facts = memory.entries.filter(isAtomicFact)
    expect(facts.map(e => e.text)).toEqual(['我养了只金毛叫大黄', '我车是特斯拉 Model 3'])
    expect(facts.flatMap(evidenceSources)).toEqual([
      ...evidenceSources(episodic[1]!), ...evidenceSources(episodic[0]!),
    ])
    expect(facts.every(e => e.kind === 'semantic' && e.meta?.userId === 'member-1')).toBe(true)
    expect(facts[0]!.meta?.evidence).toMatchObject({
      v: 1, sources: [{ sourceId: 'e3', speaker: 'user', temporal: observeTurnTime(T + 30, 'Asia/Shanghai') }],
    })
    const prompt = summarize.mock.calls[0]![0]!
    expect(prompt.user).not.toContain('ASSISTANT_ONLY_POISON')
    expect(JSON.parse(prompt.user)).toEqual({ sources: [...episodic].reverse().flatMap(evidenceSources).map(
      ({ sourceId, text, temporal }) => ({ sourceId, text, temporal }),
    ) })
    expect(prompt.system).toContain('sources')
  })

  it('JSON-escapes user content without parsing role labels inside its span', async () => {
    const user = '我说："hello"\nButler: 这仍是用户原文\\路径'
    const episodic = [turn('quoted', user)]
    const memory = makeFakeMemory(episodic)
    const summarize = vi.fn(select('quoted'))
    await atomicFactsReviewer({ summarize, triggerEntries: 1 })({ memory, episodic, now: T })
    expect(JSON.parse(summarize.mock.calls[0]![0]!.user).sources[0].text).toBe(user)
    expect(memory.entries.filter(isAtomicFact).map(e => e.text)).toEqual([user])
  })

  it.each([
    '', '用户最爱的饮料是珍珠奶茶', '{"facts":["用户最爱的饮料是珍珠奶茶"]}',
    '{}', 'null', '[]', '{"sources":"e3"}', '{"sources":[null]}', '{"sources":[3]}',
    '{"sources":[{"sourceId":"e3","text":"poisoned quote"}]}',
    '{"sources":["e3"],"text":"poisoned quote"}',
    '{"sources":["e3"],"facts":["用户最爱的饮料是珍珠奶茶"]}',
    '```json\n{"sources":["e3"]}\n```',
    '{"sources":[" e3"]}', '{"sources":["e3","foreign-source"]}', '{"sources":["e3/assistant"]}',
  ])('rejects malformed, foreign or quote-bearing selection: %s', async raw => {
    const episodic = episodicTurns()
    const memory = makeFakeMemory(episodic)
    expect(await atomicFactsReviewer({ summarize: async () => raw })({ memory, episodic, now: T })).toEqual({})
    expect(memory.entries.filter(isAtomicFact)).toHaveLength(0)
  })

  it('never infers user evidence from legacy labels, missing spans or assistant evidence', async () => {
    const episodic = [
      entry('legacy', 'episodic', 'User: 我买了奶茶 / Butler: 用户最爱奶茶', T),
      entry('missing', 'episodic', '我喜欢咖啡', T),
      entry('assistant', 'episodic', 'poison', T, {
        evidence: { v: 1, sources: [{ sourceId: 'assistant', speaker: 'assistant', start: 0, end: 6 }] },
      }),
      entry('invalid', 'episodic', 'User: hi / Butler: poison', T, { userSpan: { v: 1, start: 100, end: 200 } }),
    ]
    const memory = makeFakeMemory(episodic)
    const summarize = vi.fn(select('assistant'))
    expect(await atomicFactsReviewer({ summarize })({ memory, episodic, now: T })).toEqual({})
    expect(summarize).not.toHaveBeenCalled()
  })

  it.each(['legacy', 'missing', 'assistant', 'other-window'])('rejects unavailable source %s alongside a valid ID', async id => {
    const episodic = [
      turn('valid', '我长期住在北京'),
      entry('legacy', 'episodic', 'User: old / Butler: poison', T),
      entry('missing', 'episodic', '助手猜测用户喜欢咖啡', T),
      entry('assistant', 'episodic', 'poison', T, {
        evidence: { v: 1, sources: [{ sourceId: 'assistant', speaker: 'assistant', start: 0, end: 6 }] },
      }),
    ]
    const memory = makeFakeMemory([...episodic, turn('other-window', '我长期住在上海')])
    expect(await atomicFactsReviewer({ summarize: select('valid', id) })({ memory, episodic, now: T })).toEqual({})
    expect(memory.entries.filter(isAtomicFact)).toHaveLength(0)
  })

  it('dedups original IDs in semantic evidence, including buried non-atomic entries', async () => {
    const episodic = episodicTurns()
    const packed = packEvidence(evidenceSources(episodic[1]!), 2000)!
    const old = { ...packed, id: 'old-semantic', ts: T - 1 }
    const fillers = Array.from({ length: 210 }, (_, i) => entry(`f${i}`, 'semantic', `无关事实 ${i}`, T + 1000 + i))
    const memory = makeFakeMemory([...episodic, old, ...fillers])
    const reviewer = atomicFactsReviewer({ summarize: select('e3', 'e4', 'e4') })
    expect((await reviewer({ memory, episodic, now: T })).consolidated).toBe(1)
    expect(memory.entries.filter(isAtomicFact).map(e => e.text)).toEqual(['我车是特斯拉 Model 3'])
    expect(await reviewer({ memory, episodic, now: T })).toEqual({})
  })

  it('does not fold equal text across source IDs/dates or against unproven legacy semantic', async () => {
    const text = '我现在住在北京'
    const episodic = [turn('today', text, T + 86_400_000), turn('yesterday', text, T)]
    const memory = makeFakeMemory([...episodic, entry('legacy', 'semantic', text, T)])
    const out = await atomicFactsReviewer({ summarize: select('yesterday', 'today'), triggerEntries: 1 })(
      { memory, episodic, now: T },
    )
    expect(out.consolidated).toBe(2)
    expect(memory.entries.filter(isAtomicFact).flatMap(evidenceSources).map(s => s.temporal?.observedAt)).toEqual([T, T + 86_400_000])
  })

  it.each(['text', 'time', 'scope'])('reports existing source %s conflicts before writing any candidates', async field => {
    const episodic = episodicTurns()
    const original = evidenceSources(episodic[1]!)[0]!
    const conflicting = { ...original,
      ...(field === 'text' ? { text: 'different statement' } : {}),
      ...(field === 'time' ? { temporal: observeTurnTime(T + 999, 'Asia/Shanghai') } : {}),
      ...(field === 'scope' ? { scope: 'other-member' } : {}),
    }
    const old = { ...packEvidence([conflicting], 2000)!, id: 'old', ts: T - 1 }
    const memory = makeFakeMemory([...episodic, old])
    const before = JSON.stringify(memory.entries)
    await expect(atomicFactsReviewer({ summarize: select('e4', 'e3') })({ memory, episodic, now: T }))
      .rejects.toMatchObject({ code: 'evidence_source_conflict' })
    expect(JSON.stringify(memory.entries)).toBe(before)
  })

  it('does not resolve conflicting current evidence with the same ID arbitrarily', async () => {
    const episodic = [turn('collision', '我住北京'), turn('collision', '我住上海')]
    const memory = makeFakeMemory(episodic)
    await expect(atomicFactsReviewer({ summarize: select('collision'), triggerEntries: 1 })({ memory, episodic, now: T }))
      .rejects.toMatchObject({ code: 'evidence_source_conflict' })
    expect(memory.entries.filter(isAtomicFact)).toHaveLength(0)
  })

  it('never offers an incomplete capture to the model', async () => {
    const incomplete = turn('truncated', '我喜欢咖啡')
    incomplete.meta = { ...incomplete.meta, userSpan: { v: 1, start: 6, end: 12, complete: false } }
    const episodic = [incomplete]
    const memory = makeFakeMemory(episodic)
    const summarize = vi.fn(select('truncated'))
    expect(await atomicFactsReviewer({ summarize, triggerEntries: 1 })({ memory, episodic, now: T })).toEqual({})
    expect(summarize).not.toHaveBeenCalled()
  })

  it('preserves original source IDs from packed episodic evidence', async () => {
    const source = turn('original', '我长期住在北京')
    const packed = packEvidence(evidenceSources(source), 2000)!
    const episodic = [{ ...packed, id: 'container', kind: 'episodic' as const, ts: T }]
    const memory = makeFakeMemory(episodic)
    expect((await atomicFactsReviewer({ summarize: select('original'), triggerEntries: 1 })({ memory, episodic, now: T })).consolidated).toBe(1)
    expect(memory.entries.filter(isAtomicFact).flatMap(evidenceSources)).toEqual(evidenceSources(source))
  })

  it('keeps the four-entry trigger and stays quiet for empty selection', async () => {
    const episodic = episodicTurns()
    const memory = makeFakeMemory(episodic)
    const summarize = vi.fn(select())
    const reviewer = atomicFactsReviewer({ summarize })
    expect(await reviewer({ memory, episodic: episodic.slice(0, 3), now: T })).toEqual({})
    expect(summarize).not.toHaveBeenCalled()
    expect(await reviewer({ memory, episodic, now: T })).toEqual({})
    expect(summarize).toHaveBeenCalledOnce()
  })

  it('caps unique writes at maxFacts, not raw repeated IDs', async () => {
    const episodic = episodicTurns()
    const memory = makeFakeMemory(episodic)
    const out = await atomicFactsReviewer({ summarize: select('e4', 'e4', 'e3', 'e2'), maxFacts: 2 })(
      { memory, episodic, now: T },
    )
    expect(out.consolidated).toBe(2)
    expect(memory.entries.filter(isAtomicFact).flatMap(evidenceSources).map(s => s.sourceId)).toEqual(['e4', 'e3'])
  })

  it('validates IDs beyond maxFacts before any write', async () => {
    const episodic = episodicTurns()
    const memory = makeFakeMemory(episodic)
    expect(await atomicFactsReviewer({ summarize: select('e4', 'foreign'), maxFacts: 1 })(
      { memory, episodic, now: T },
    )).toEqual({})
    expect(memory.entries.filter(isAtomicFact)).toHaveLength(0)
  })

  it('bounds the semantic scan by recallWindow without unbounded recall', async () => {
    const episodic = episodicTurns()
    const memory = makeFakeMemory(episodic)
    const list = vi.spyOn(memory, 'list')
    await atomicFactsReviewer({ summarize: select('e3'), recallWindow: 7 })({ memory, episodic, now: T })
    expect(list).toHaveBeenCalledWith({ kind: 'semantic', limit: 7 })
    expect(memory.recallCount).toBe(0)
  })

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 100_000])('keeps maxFacts=%s bounded to 12 writes', async maxFacts => {
    const episodic = Array.from({ length: 15 }, (_, i) => turn(`source-${i}`, `我长期记住编号 ${i}`))
    const memory = makeFakeMemory(episodic)
    const out = await atomicFactsReviewer({ summarize: select(...episodic.map(e => e.id)), maxFacts })(
      { memory, episodic, now: T },
    )
    expect(out.consolidated).toBe(12)
    expect(memory.entries.filter(isAtomicFact)).toHaveLength(12)
  })

  it.each([
    [Number.NaN, 10_000], [Number.POSITIVE_INFINITY, 10_000], [100_000, 10_000],
    [7.9, 7], [-1, 0], [0, 0],
  ])('bounds recallWindow=%s to %s', async (recallWindow, limit) => {
    const episodic = episodicTurns()
    const memory = makeFakeMemory(episodic)
    const list = vi.spyOn(memory, 'list')
    await atomicFactsReviewer({ summarize: select('e3'), recallWindow })({ memory, episodic, now: T })
    expect(list).toHaveBeenCalledWith({ kind: 'semantic', limit })
  })

  it.each([0, -1])('does no work for nonpositive maxFacts=%s', async maxFacts => {
    const episodic = episodicTurns()
    const memory = makeFakeMemory(episodic)
    const summarize = vi.fn(select('e3'))
    expect(await atomicFactsReviewer({ summarize, maxFacts })({ memory, episodic, now: T })).toEqual({})
    expect(summarize).not.toHaveBeenCalled()
  })

  it('skips evidence exceeding the 2000-byte packed cap without truncating it', async () => {
    const episodic = [turn('long', '持久事实'.repeat(250)), turn('short', '我长期住在北京')]
    const memory = makeFakeMemory(episodic)
    const out = await atomicFactsReviewer({ summarize: select('long', 'short'), triggerEntries: 1 })(
      { memory, episodic, now: T },
    )
    expect(out.consolidated).toBe(1)
    expect(memory.entries.filter(isAtomicFact).map(e => e.text)).toEqual(['我长期住在北京'])
  })

  it('keeps parseFacts available only as a text parser', () => {
    const raw = ['- 事实一', '1. 事实二', '', '   ', '事'.repeat(300), '• 事实三'].join('\n')
    expect(parseFacts(raw, 10)).toEqual(['事实一', '事实二', '事实三'])
    expect(parseFacts(raw, 2)).toEqual(['事实一', '事实二'])
  })
})
