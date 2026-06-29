import type { Task } from '@aipehub/core'
import type { MemoryEntry } from '@aipehub/services-sdk'
import { describe, expect, it } from 'vitest'

import {
  HEARTBEAT_OK,
  MEMORY_REVIEW_ID,
  MemoryReviewParticipant,
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
