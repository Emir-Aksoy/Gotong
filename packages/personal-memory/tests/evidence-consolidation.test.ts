import { describe, expect, it } from 'vitest'
import { buildTurnCapture } from '../src/capture.js'
import { consolidate } from '../src/consolidate.js'
import { consolidateTiered, promoteCluster } from '../src/consolidate-tiered.js'
import { evidenceSources } from '../src/evidence.js'
import { renderFrozenBlock } from '../src/frozen-block.js'
import { MemoryToolset } from '../src/toolset.js'
import { reconcile } from '../src/reconcile.js'
import { packEvidence } from '../src/evidence.js'
import { entry, makeFakeMemory } from './fake-memory.js'

const time = { v: 1 as const, observedAt: Date.parse('2026-09-01T06:00:00Z'), timeZone: 'America/Los_Angeles', basis: 'turn-start' as const }
const source = (id: string, at: number, text = 'Last week I ate barbecue', userId = 'alice') => ({
  id, ts: at, ...buildTurnCapture({ userText: text, replyText: 'You ate it yesterday.', temporal: { ...time, observedAt: at }, meta: { userId } })!,
})
const summarize = async () => 'User ate barbecue yesterday and loves barbecue'

describe('source-preserving consolidation', () => {
  it('flat compaction retains dates and exact user evidence across a second generation', async () => {
    const original = source('s1', time.observedAt)
    const mem = makeFakeMemory([original, source('recent', time.observedAt + 1)])
    const first = await consolidate({ memory: mem, summarize, force: true, keepRecent: 1 })
    expect(first).not.toBeNull()
    expect(evidenceSources(first!.profile)).toEqual(evidenceSources(original))
    await mem.remember(source('new', time.observedAt + 2))
    const next = await consolidate({ memory: mem, summarize, force: true, keepRecent: 1 })
    expect(next).not.toBeNull()
    expect(evidenceSources(next!.profile).map(s => s.sourceId)).toEqual(['s1', 'new'])
    expect(next!.profile.text).not.toContain('yesterday')
    const frozen = renderFrozenBlock([next!.profile])
    expect(frozen).toContain('2026-08-31')
    expect(frozen).toContain('source')
    const recalled = await new MemoryToolset({ memory: mem }).callTool('recall', {})
    expect(JSON.stringify(recalled)).toContain('2026-08-31')
  })

  it('tiered compaction and promotion preserve sources even at low importance', async () => {
    const original = source('s1', time.observedAt)
    const mem = makeFakeMemory([original, source('recent', time.observedAt + 1)])
    const first = await consolidateTiered({ memory: mem, summarize, force: true, keepRecent: 1 })
    expect(first).not.toBeNull()
    const digest = first!.digests[0]!
    expect(evidenceSources(digest.entry)).toEqual(evidenceSources(original))
    await mem.patchMeta!(digest.entry.id, { importance: 1 })
    const promoted = await promoteCluster({ memory: mem, summarize, tier: digest.tier, force: true })
    expect(promoted?.profile).toBeTruthy()
    expect(evidenceSources(promoted!.profile!)).toEqual(evidenceSources(original))
    expect(promoted!.droppedDigests).toBe(0)
  })

  it.each(['flat', 'tiered'])('%s retains an over-cap source and an M1-only source without inventing user attribution', async mode => {
    const original = source('large', time.observedAt, 'x'.repeat(1000))
    const old = entry('m1', 'episodic', 'User: old / Butler: invented', time.observedAt + 1, { temporal: time })
    const mem = makeFakeMemory([original, old, source('recent', time.observedAt + 2)])
    if (mode === 'flat') await consolidate({ memory: mem, summarize, force: true, keepRecent: 1, profileHardCap: 200 })
    else await consolidateTiered({ memory: mem, summarize, force: true, keepRecent: 1, digestHardCap: 200 })
    expect(mem.entries).toEqual([original, old, source('recent', time.observedAt + 2)])
  })

  it('does not delete sources when saving fails or a backend returns a corrupt replacement', async () => {
    for (const corrupt of [false, true]) {
      const mem = makeFakeMemory([source('s', time.observedAt), source('recent', time.observedAt + 1)])
      const memory = { ...mem, remember: async () => { if (!corrupt) throw new Error('disk full'); return entry('bad', 'semantic', 'wrong', 1) } }
      await expect(consolidate({ memory, summarize, force: true, keepRecent: 1 })).rejects.toThrow()
      expect(mem.entries.map(e => e.id)).toEqual(['s', 'recent'])
    }
  })

  it('scopes source selection and never absorbs another user via a profile', async () => {
    const alice = source('a', time.observedAt)
    const bob = source('b', time.observedAt, 'private Bob text', 'bob')
    const mem = makeFakeMemory([alice, bob, source('recent', time.observedAt + 1)])
    const r = await consolidate({ memory: mem, summarize, force: true, keepRecent: 1, filter: e => e.meta?.userId === 'alice' })
    expect(evidenceSources(r!.profile)).toEqual(evidenceSources(alice))
    expect(mem.entries.find(e => e.id === 'b')).toEqual(bob)
  })
  it('does not let the legacy reconciler rewrite or delete exact source evidence', async () => {
    const packed = packEvidence(evidenceSources(source('s', time.observedAt)), 2000, { atomicFact: true })!
    const saved = { ...packed, id: 'fact', ts: 1 }
    const mem = makeFakeMemory([saved])
    await reconcile({ memory: mem, candidates: ['the assistant thinks it happened yesterday'], existingFilter: () => true,
      summarize: async () => JSON.stringify({ ops: [{ op: 'update', id: 'fact', text: 'yesterday' }, { op: 'delete', id: 'fact' }] }) })
    expect(mem.entries).toEqual([saved])
  })
  it('does not arbitrarily keep one of two conflicting versions of the same original source', async () => {
    const a = packEvidence([{ sourceId: 'original', text: 'Monday' }], 2000, { tier: 'misc', level: 'digest' })!
    const b = packEvidence([{ sourceId: 'original', text: 'Tuesday' }], 2000, { tier: 'misc', level: 'digest' })!
    const mem = makeFakeMemory([{ ...a, id: 'a', ts: 1 }, { ...b, id: 'b', ts: 2 }])
    const before = JSON.stringify(mem.entries)
    expect(await promoteCluster({ memory: mem, summarize, tier: 'misc', force: true })).toBeNull()
    expect(JSON.stringify(mem.entries)).toBe(before)
  })
})
