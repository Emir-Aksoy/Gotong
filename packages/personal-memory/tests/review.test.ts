import type { Task } from '@aipehub/core'
import type { MemoryEntry } from '@aipehub/services-sdk'
import { describe, expect, it } from 'vitest'

import {
  HEARTBEAT_OK,
  MEMORY_REVIEW_ID,
  MemoryReviewParticipant,
  composeReviewers,
  tieredReviewer,
  type MemoryReviewer,
  type ReviewContext,
} from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

/** N episodic entries, newest last. */
function episodicSeed(n: number): MemoryEntry[] {
  return Array.from({ length: n }, (_, i) => entry(`e${i}`, 'episodic', `note ${i}`, 1000 + i))
}

function heartbeatTask(): Task {
  return {
    id: 'hb',
    from: 'aipehub:heartbeat',
    strategy: { kind: 'explicit', to: MEMORY_REVIEW_ID },
    payload: { heartbeat: true },
  }
}

describe('MemoryReviewParticipant', () => {
  it('uses the default id and is capability-less (explicit-routed only)', () => {
    const p = new MemoryReviewParticipant({ memory: makeFakeMemory() })
    expect(p.id).toBe(MEMORY_REVIEW_ID)
  })

  it('stays idle (HEARTBEAT_OK) and never calls the reviewer below the threshold', async () => {
    let called = false
    const p = new MemoryReviewParticipant({
      memory: makeFakeMemory(episodicSeed(3)),
      reviewer: () => {
        called = true
        return { summary: 'should not run' }
      },
      // default minEpisodic = 8
    })
    expect(await p.review()).toBe(HEARTBEAT_OK)
    expect(called).toBe(false)
  })

  it('fires the reviewer with the recalled episodic backlog above the threshold', async () => {
    let seen: ReviewContext | undefined
    const p = new MemoryReviewParticipant({
      memory: makeFakeMemory(episodicSeed(10)),
      reviewer: (ctx) => {
        seen = ctx
        return { summary: `distilled ${ctx.episodic.length}`, consolidated: ctx.episodic.length }
      },
      now: () => 42,
    })
    expect(await p.review()).toBe('distilled 10')
    expect(seen?.episodic.length).toBe(10)
    expect(seen?.now).toBe(42)
    // Only episodic entries reach the reviewer.
    expect(seen?.episodic.every((e) => e.kind === 'episodic')).toBe(true)
  })

  it('treats an empty reviewer summary as idle (suppressed)', async () => {
    const p = new MemoryReviewParticipant({
      memory: makeFakeMemory(episodicSeed(10)),
      reviewer: () => ({}),
    })
    expect(await p.review()).toBe(HEARTBEAT_OK)
  })

  it('is idle with no reviewer wired, even over the threshold (honest M2 default)', async () => {
    const p = new MemoryReviewParticipant({ memory: makeFakeMemory(episodicSeed(20)) })
    expect(await p.review()).toBe(HEARTBEAT_OK)
  })

  it('counts only episodic toward the trigger (semantic is ignored)', async () => {
    const seed: MemoryEntry[] = [
      ...episodicSeed(3),
      ...Array.from({ length: 20 }, (_, i) => entry(`s${i}`, 'semantic', `fact ${i}`, 2000 + i)),
    ]
    let called = false
    const p = new MemoryReviewParticipant({
      memory: makeFakeMemory(seed),
      reviewer: () => {
        called = true
        return { summary: 'x' }
      },
    })
    // 3 episodic < 8 → idle, despite 20 semantic entries present.
    expect(await p.review()).toBe(HEARTBEAT_OK)
    expect(called).toBe(false)
  })

  it('scopes the trigger + reviewer input by the filter (per-user namespace)', async () => {
    const seed: MemoryEntry[] = [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `o${i}`,
        kind: 'episodic' as const,
        text: `other ${i}`,
        ts: 1000 + i,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `a${i}`,
        kind: 'episodic' as const,
        text: `alice ${i}`,
        ts: 2000 + i,
        meta: { user: 'alice' },
      })),
    ]
    let seen: ReviewContext | undefined
    const p = new MemoryReviewParticipant({
      memory: makeFakeMemory(seed),
      policy: { minEpisodic: 4 },
      filter: (e) => (e.meta as { user?: string } | undefined)?.user === 'alice',
      reviewer: (ctx) => {
        seen = ctx
        return { summary: 'curated' }
      },
    })
    expect(await p.review()).toBe('curated')
    expect(seen?.episodic.length).toBe(4)
    expect(seen?.episodic.every((e) => e.text.startsWith('alice'))).toBe(true)
  })

  it('stays idle when the filter matches too few entries', async () => {
    const seed = episodicSeed(10)
    const p = new MemoryReviewParticipant({
      memory: makeFakeMemory(seed),
      policy: { minEpisodic: 4 },
      filter: (e) => (e.meta as { user?: string } | undefined)?.user === 'bob', // none
      reviewer: () => ({ summary: 'x' }),
    })
    expect(await p.review()).toBe(HEARTBEAT_OK)
  })

  it('wires tieredReviewer as the reviewer — a tick consolidates into a cluster digest', async () => {
    const mem = makeFakeMemory(episodicSeed(10))
    const reviewer = tieredReviewer({
      summarize: async ({ system }) =>
        system.includes('JSON')
          ? JSON.stringify({ clusters: { misc: { digest: 'rolled up', importance: 3 } } })
          : 'STABLE PROFILE',
      keepRecent: 2,
      triggerEntries: 1,
    })
    const p = new MemoryReviewParticipant({ memory: mem, reviewer })

    const summary = await p.review()
    expect(summary).toMatch(/tiered/)
    // the consolidate pass wrote a misc cluster digest (level='digest')
    expect(
      mem.entries.some(
        (e) => e.kind === 'semantic' && (e.meta as { level?: string } | undefined)?.level === 'digest',
      ),
    ).toBe(true)
    // and folded the old episodic (kept 2 of 10)
    expect(mem.entries.filter((e) => e.kind === 'episodic').length).toBe(2)
  })

  it('drives a review through onTask (heartbeat dispatch path)', async () => {
    const p = new MemoryReviewParticipant({
      memory: makeFakeMemory(episodicSeed(10)),
      reviewer: () => ({ summary: 'ok-active' }),
    })
    const res = await p.onTask(heartbeatTask())
    expect(res.kind).toBe('ok')
    expect(res.kind === 'ok' && res.output).toBe('ok-active')
  })
})

describe('composeReviewers', () => {
  const ctx = (): ReviewContext => ({ memory: makeFakeMemory(), episodic: [], now: 5_000_000 })

  it('runs reviewers in order and joins their summaries', async () => {
    const order: string[] = []
    const a: MemoryReviewer = () => {
      order.push('a')
      return { summary: 'pass A' }
    }
    const b: MemoryReviewer = () => {
      order.push('b')
      return { summary: 'pass B' }
    }
    const out = await composeReviewers(a, b)(ctx())
    expect(order).toEqual(['a', 'b'])
    expect(out.summary).toBe('pass A; pass B')
  })

  it('skips empty summaries and sums consolidated counts', async () => {
    const out = await composeReviewers(
      () => ({}),
      () => ({ summary: 'did 2', consolidated: 2 }),
      () => ({ consolidated: 3 }),
    )(ctx())
    expect(out.summary).toBe('did 2')
    expect(out.consolidated).toBe(5)
  })

  it('returns {} (idle) when every reviewer is idle', async () => {
    const out = await composeReviewers(
      () => ({}),
      () => ({ summary: '   ' }),
    )(ctx())
    expect(out).toEqual({})
  })

  it('is best-effort: a throwing reviewer is surfaced, the rest still run', async () => {
    const ran: string[] = []
    const out = await composeReviewers(
      () => {
        throw new Error('semantic_overflow: too big')
      },
      () => {
        ran.push('second')
        return { summary: 'second ok' }
      },
    )(ctx())
    expect(ran).toEqual(['second']) // not starved by the first throwing
    expect(out.summary).toMatch(/review error: semantic_overflow/)
    expect(out.summary).toMatch(/second ok/)
  })
})
