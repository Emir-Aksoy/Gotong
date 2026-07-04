import type { MemoryEntry } from '@gotong/services-sdk'
import { describe, expect, it } from 'vitest'

import {
  MemoryReviewParticipant,
  consolidate,
  consolidateReviewer,
  shouldConsolidate,
  type ConsolidateOptions,
  type MemorySummarizer,
} from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

/** N episodic entries, ascending ts so oldest-first slicing is deterministic. */
function episodicSeed(n: number, prefix = 'e'): MemoryEntry[] {
  return Array.from({ length: n }, (_, i) => entry(`${prefix}${i}`, 'episodic', `note ${i}`, 1000 + i))
}

/** A scripted summarizer that records its calls. */
function makeSummarizer(reply: string | string[]): {
  summarize: MemorySummarizer
  calls: Array<{ system: string; user: string }>
} {
  const calls: Array<{ system: string; user: string }> = []
  const replies = Array.isArray(reply) ? reply : [reply]
  let i = 0
  const summarize: MemorySummarizer = async (input) => {
    calls.push(input)
    const out = replies[Math.min(i, replies.length - 1)]!
    i++
    return out
  }
  return { summarize, calls }
}

const noop: MemorySummarizer = async () => 'unused'

describe('shouldConsolidate', () => {
  it('is false below both triggers', async () => {
    const opts: ConsolidateOptions = { memory: makeFakeMemory(episodicSeed(5)), summarize: noop }
    expect(await shouldConsolidate(opts)).toBe(false)
  })

  it('fires on the entry-count trigger', async () => {
    const opts: ConsolidateOptions = { memory: makeFakeMemory(episodicSeed(32)), summarize: noop }
    expect(await shouldConsolidate(opts)).toBe(true)
  })

  it('fires on the byte trigger even with few entries', async () => {
    const big = Array.from({ length: 3 }, (_, i) => entry(`b${i}`, 'episodic', 'x'.repeat(12_000), 1000 + i))
    expect(await shouldConsolidate({ memory: makeFakeMemory(big), summarize: noop })).toBe(true)
  })

  it('counts only filtered entries (per-user namespace)', async () => {
    const seed: MemoryEntry[] = [
      ...episodicSeed(40, 'o'),
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `a${i}`,
        kind: 'episodic' as const,
        text: `mine ${i}`,
        ts: 5000 + i,
        meta: { user: 'alice' },
      })),
    ]
    const opts: ConsolidateOptions = {
      memory: makeFakeMemory(seed),
      summarize: noop,
      filter: (e) => (e.meta as { user?: string } | undefined)?.user === 'alice',
    }
    expect(await shouldConsolidate(opts)).toBe(false) // only 5 mine < 32
  })
})

describe('consolidate', () => {
  it('returns null below the trigger when not forced (summarizer untouched)', async () => {
    const { summarize, calls } = makeSummarizer('PROFILE')
    const res = await consolidate({ memory: makeFakeMemory(episodicSeed(5)), summarize })
    expect(res).toBeNull()
    expect(calls.length).toBe(0)
  })

  it('distills the old episodic backlog into a curated semantic profile', async () => {
    const mem = makeFakeMemory(episodicSeed(12))
    const { summarize, calls } = makeSummarizer('PROFILE BODY')
    const res = await consolidate({ memory: mem, summarize, force: true, keepRecent: 8, now: () => 777 })

    expect(res).not.toBeNull()
    expect(res!.consolidatedCount).toBe(4) // 12 - keepRecent(8)
    expect(calls.length).toBe(1)

    // New profile written as semantic, marked, with the injected clock.
    const profiles = mem.entries.filter((e) => (e.meta as { profile?: unknown } | undefined)?.profile === true)
    expect(profiles.length).toBe(1)
    expect(profiles[0]!.kind).toBe('semantic')
    expect(profiles[0]!.text).toBe('PROFILE BODY')
    expect(profiles[0]!.meta).toMatchObject({ profile: true, consolidatedAt: 777 })

    // The 4 oldest episodic were folded (forgotten); 8 most-recent remain.
    expect(mem.entries.filter((e) => e.kind === 'episodic').length).toBe(8)
  })

  it('folds a prior profile forward (absorbs it) and shows it to the summarizer', async () => {
    const seed: MemoryEntry[] = [
      { id: 'p0', kind: 'semantic', text: 'OLD PROFILE', ts: 500, meta: { profile: true } },
      ...episodicSeed(12),
    ]
    const mem = makeFakeMemory(seed)
    const { summarize, calls } = makeSummarizer('MERGED PROFILE')
    const res = await consolidate({ memory: mem, summarize, force: true, keepRecent: 8 })

    expect(res!.absorbedProfiles).toBe(1)
    expect(calls[0]!.user).toContain('OLD PROFILE') // prior profile fed in as background
    // Exactly one profile remains (the new merged one); the old one is gone.
    const profiles = mem.entries.filter((e) => (e.meta as { profile?: unknown } | undefined)?.profile === true)
    expect(profiles.length).toBe(1)
    expect(profiles[0]!.text).toBe('MERGED PROFILE')
  })

  it('throws consolidate_empty when the summarizer returns nothing', async () => {
    const { summarize } = makeSummarizer('   ')
    await expect(
      consolidate({ memory: makeFakeMemory(episodicSeed(12)), summarize, force: true }),
    ).rejects.toMatchObject({ code: 'consolidate_empty' })
  })

  it('forces a compression pass and recovers when the profile overflows the cap', async () => {
    const mem = makeFakeMemory(episodicSeed(12))
    const { summarize, calls } = makeSummarizer(['x'.repeat(500), 'y'.repeat(100)])
    const res = await consolidate({
      memory: mem,
      summarize,
      force: true,
      profileHardCap: 200, // floor
    })
    expect(calls.length).toBe(2) // first over cap → one re-summarize
    expect(res!.bytes).toBe(100)
  })

  it('throws semantic_overflow when even the compressed profile is too big', async () => {
    const { summarize } = makeSummarizer(['x'.repeat(500), 'y'.repeat(400)])
    await expect(
      consolidate({
        memory: makeFakeMemory(episodicSeed(12)),
        summarize,
        force: true,
        profileHardCap: 200,
      }),
    ).rejects.toMatchObject({ code: 'semantic_overflow' })
  })

  it('only folds filtered entries; another namespace is left untouched', async () => {
    const seed: MemoryEntry[] = [
      ...episodicSeed(12, 'o'), // other user, no meta
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `a${i}`,
        kind: 'episodic' as const,
        text: `mine ${i}`,
        ts: 5000 + i,
        meta: { user: 'alice' },
      })),
    ]
    const mem = makeFakeMemory(seed)
    const { summarize } = makeSummarizer('ALICE PROFILE')
    const res = await consolidate({
      memory: mem,
      summarize,
      force: true,
      keepRecent: 8,
      filter: (e) => (e.meta as { user?: string } | undefined)?.user === 'alice',
      profileMeta: { user: 'alice' },
    })

    expect(res!.consolidatedCount).toBe(4) // 12 alice - keepRecent 8
    // All 12 other-user episodic survive untouched.
    expect(mem.entries.filter((e) => e.id.startsWith('o')).length).toBe(12)
    // The profile carries the namespace key.
    const profile = mem.entries.find((e) => (e.meta as { profile?: unknown } | undefined)?.profile === true)!
    expect(profile.meta).toMatchObject({ user: 'alice', profile: true })
  })
})

describe('consolidateReviewer (M2 ↔ M3 seam)', () => {
  it('reports a summary when a pass happens, idle when not', async () => {
    const active = consolidateReviewer({ summarize: makeSummarizer('P').summarize, keepRecent: 8 })
    const memBusy = makeFakeMemory(episodicSeed(40))
    const out = await active({ memory: memBusy, episodic: [], now: 1 })
    expect(out.consolidated).toBe(32) // 40 - keepRecent 8
    expect(out.summary).toContain('consolidated 32')

    const idle = consolidateReviewer({ summarize: noop })
    const out2 = await idle({ memory: makeFakeMemory(episodicSeed(5)), episodic: [], now: 1 })
    expect(out2).toEqual({})
  })

  it('drives a full heartbeat review → consolidation through the participant', async () => {
    const mem = makeFakeMemory(episodicSeed(40))
    const participant = new MemoryReviewParticipant({
      memory: mem,
      reviewer: consolidateReviewer({ summarize: makeSummarizer('CURATED').summarize, keepRecent: 8 }),
    })

    const reply = await participant.review()
    expect(reply).toContain('consolidated 32')

    // After the tick: one curated profile + the 8 most-recent episodic remain.
    expect(mem.entries.filter((e) => (e.meta as { profile?: unknown } | undefined)?.profile === true).length).toBe(
      1,
    )
    expect(mem.entries.filter((e) => e.kind === 'episodic').length).toBe(8)
  })
})
