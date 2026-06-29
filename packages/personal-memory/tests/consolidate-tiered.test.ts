/**
 * Tiered (clustered, importance-graded) consolidation — decision ③ "两者结合".
 *
 * Deterministic fakes only: the summarizer returns the routing JSON (or a
 * profile text on the promote call, branched by whether the system prompt asks
 * for JSON), so the orchestration is provable without an LLM.
 */

import { describe, expect, it } from 'vitest'

import {
  consolidateTiered,
  importanceOf,
  isClusterProfile,
  isDigest,
  levelOf,
  promoteCluster,
  tierOf,
  tieredReviewer,
  type MemorySummarizer,
} from '../src/index.js'
import { entry, makeFakeMemory, type FakeMemory } from './fake-memory.js'

const digestMeta = (tier: string, importance: number): Record<string, unknown> => ({
  tier,
  level: 'digest',
  importance,
})

/** Always returns the given routing JSON (the consolidateTiered path). */
function jsonRouter(clusters: Record<string, { digest: string; importance: number }>): MemorySummarizer {
  return async () => JSON.stringify({ clusters })
}

/** Routing call (system mentions JSON) → routing JSON; promote call → profile text. */
function smartSummarizer(
  clusters: Record<string, { digest: string; importance: number }>,
  profileText = 'STABLE CLUSTER PROFILE',
): MemorySummarizer {
  return async ({ system }) => (system.includes('JSON') ? JSON.stringify({ clusters }) : profileText)
}

const semanticDigests = (mem: FakeMemory) =>
  mem.entries.filter((e) => e.kind === 'semantic' && isDigest(e))
const clusterProfiles = (mem: FakeMemory) =>
  mem.entries.filter((e) => e.kind === 'semantic' && isClusterProfile(e))
const episodicOf = (mem: FakeMemory) => mem.entries.filter((e) => e.kind === 'episodic')

describe('consolidateTiered', () => {
  it('routes episodic into per-cluster digests, folds the old ones, keeps recent verbatim', async () => {
    const seed = Array.from({ length: 12 }, (_, i) => entry(`e${i}`, 'episodic', `turn ${i}`, 100 + i))
    const mem = makeFakeMemory(seed)

    const res = await consolidateTiered({
      memory: mem,
      summarize: jsonRouter({
        persona: { digest: 'likes tea', importance: 4 },
        projects: { digest: 'building aipehub', importance: 5 },
      }),
      keepRecent: 8,
      force: true,
    })

    expect(res).not.toBeNull()
    expect(res!.routedByFallback).toBe(false)
    expect(res!.consolidatedCount).toBe(4) // 12 − 8 kept

    const digests = semanticDigests(mem)
    expect(digests.length).toBe(2)
    const persona = digests.find((d) => tierOf(d, 'misc') === 'persona')!
    expect(levelOf(persona)).toBe('digest')
    expect(importanceOf(persona)).toBe(4)
    expect(persona.text).toContain('likes tea')

    // digests are NOT cluster profiles
    expect(clusterProfiles(mem).length).toBe(0)
    // 12 − 4 folded = 8 episodic remain
    expect(episodicOf(mem).length).toBe(8)
  })

  it('falls back to deterministic keyword routing when the router response is unusable', async () => {
    const mem = makeFakeMemory([
      entry('a', 'episodic', '我答应明天交报告', 100), // 承诺 keyword 答应 → commitments
      entry('b', 'episodic', '随便聊聊', 101), // → misc default
      entry('c', 'episodic', 'kept', 102),
    ])

    const res = await consolidateTiered({
      memory: mem,
      summarize: async () => 'sorry I cannot do that',
      keepRecent: 1,
      force: true,
    })

    expect(res).not.toBeNull()
    expect(res!.routedByFallback).toBe(true)
    const tiers = semanticDigests(mem)
      .map((d) => tierOf(d, 'misc'))
      .sort()
    expect(tiers).toContain('commitments')
    expect(tiers).toContain('misc')
    expect(episodicOf(mem).length).toBe(1) // only the kept-recent one; nothing lost
  })

  it('survives a throwing summarizer via the fallback (no episodic lost)', async () => {
    const mem = makeFakeMemory([
      entry('a', 'episodic', '项目进度更新', 100), // 项目 keyword → projects
      entry('b', 'episodic', '闲聊', 101),
      entry('c', 'episodic', 'latest', 102),
    ])
    const res = await consolidateTiered({
      memory: mem,
      summarize: async () => {
        throw new Error('network down')
      },
      keepRecent: 1,
      force: true,
    })
    expect(res!.routedByFallback).toBe(true)
    expect(semanticDigests(mem).length).toBeGreaterThanOrEqual(1)
    expect(episodicOf(mem).length).toBe(1)
  })
})

describe('promoteCluster', () => {
  it('folds high-importance digests into a stable profile, dropping trivial ones', async () => {
    const mem = makeFakeMemory([
      entry('d1', 'semantic', 'fact A', 100, digestMeta('persona', 5)),
      entry('d2', 'semantic', 'fact B', 101, digestMeta('persona', 3)),
      entry('d3', 'semantic', 'fact C', 102, digestMeta('persona', 4)),
      entry('t1', 'semantic', 'trivial X', 103, digestMeta('persona', 1)),
      entry('t2', 'semantic', 'trivial Y', 104, digestMeta('persona', 1)),
      entry('p1', 'semantic', 'other cluster', 105, digestMeta('projects', 5)), // untouched
    ])

    const res = await promoteCluster({
      memory: mem,
      summarize: async () => 'PERSONA PROFILE',
      tier: 'persona',
    })

    expect(res).not.toBeNull()
    expect(res!.foldedDigests).toBe(3) // importance 5,3,4
    expect(res!.droppedDigests).toBe(2) // importance 1,1
    const profile = res!.profile!
    expect(profile).not.toBeNull()
    expect(levelOf(profile)).toBe('profile')
    expect((profile.meta as { profile?: boolean }).profile).toBe(true)
    expect(tierOf(profile, 'misc')).toBe('persona')
    expect(importanceOf(profile)).toBe(5) // max of kept
    expect(profile.text).toBe('PERSONA PROFILE')

    // persona digests all gone; the projects digest is untouched
    const personaDigests = semanticDigests(mem).filter((d) => tierOf(d, 'misc') === 'persona')
    expect(personaDigests.length).toBe(0)
    expect(semanticDigests(mem).filter((d) => tierOf(d, 'misc') === 'projects').length).toBe(1)
  })

  it('drops trivial-only digests with no prior profile and writes no profile', async () => {
    const mem = makeFakeMemory([
      entry('t1', 'semantic', 'x', 100, digestMeta('misc', 1)),
      entry('t2', 'semantic', 'y', 101, digestMeta('misc', 1)),
      entry('t3', 'semantic', 'z', 102, digestMeta('misc', 1)),
      entry('t4', 'semantic', 'w', 103, digestMeta('misc', 1)),
    ])
    const res = await promoteCluster({
      memory: mem,
      summarize: async () => 'should not be written',
      tier: 'misc',
    })
    expect(res!.profile).toBeNull()
    expect(res!.droppedDigests).toBe(4)
    expect(res!.foldedDigests).toBe(0)
    expect(clusterProfiles(mem).length).toBe(0)
    expect(semanticDigests(mem).length).toBe(0)
  })

  it('returns null below the digest-count threshold (not forced)', async () => {
    const mem = makeFakeMemory([
      entry('d1', 'semantic', 'a', 100, digestMeta('persona', 5)),
      entry('d2', 'semantic', 'b', 101, digestMeta('persona', 5)),
    ])
    const res = await promoteCluster({ memory: mem, summarize: async () => 'x', tier: 'persona' })
    expect(res).toBeNull()
    expect(semanticDigests(mem).length).toBe(2) // untouched
  })
})

describe('tieredReviewer', () => {
  it('consolidates then promotes a cluster that crossed the threshold, in one tick', async () => {
    const mem = makeFakeMemory([
      entry('d1', 'semantic', 'a', 50, digestMeta('persona', 5)),
      entry('d2', 'semantic', 'b', 51, digestMeta('persona', 4)),
      entry('d3', 'semantic', 'c', 52, digestMeta('persona', 3)),
      entry('d4', 'semantic', 'd', 53, digestMeta('persona', 3)),
      entry('e1', 'episodic', 'new persona fact', 100),
      entry('e2', 'episodic', 'another turn', 101),
    ])

    const reviewer = tieredReviewer({
      summarize: smartSummarizer({ persona: { digest: 'a fresh fact', importance: 4 } }),
      keepRecent: 1, // fold 1 episodic → a 5th persona digest
      triggerEntries: 1, // ensure consolidate fires
    })

    const outcome = await reviewer({ memory: mem, episodic: [], now: 9000 })
    expect(outcome.summary).toMatch(/tiered/)
    expect(outcome.summary).toMatch(/promoted 1 cluster/)

    // persona collapsed to a single stable profile, no digests left
    expect(clusterProfiles(mem).filter((p) => tierOf(p, 'misc') === 'persona').length).toBe(1)
    expect(semanticDigests(mem).filter((d) => tierOf(d, 'misc') === 'persona').length).toBe(0)
  })

  it('is idle (returns {}) when there is nothing to consolidate or promote', async () => {
    const mem = makeFakeMemory([entry('e1', 'episodic', 'one turn', 100)])
    const reviewer = tieredReviewer({ summarize: smartSummarizer({}) })
    const outcome = await reviewer({ memory: mem, episodic: [], now: 9000 })
    expect(outcome.summary).toBeUndefined()
  })
})
