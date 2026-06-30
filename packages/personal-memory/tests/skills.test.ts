/**
 * Tests for skill self-authoring (MR3-M1).
 *
 * Three things:
 *   1. `clusterBySimilarity` — deterministic single-link star clustering: groups
 *      mutually-similar entries, honors `minSize`, consumes members.
 *   2. `detectProcedureCandidates` — finds recurring (>= minOccurrences) episodic
 *      patterns, excludes already-procedurized ones (idempotent).
 *   3. `procedureAuthoringReviewer` — detects + drafts (fake aux model) + writes a
 *      `form:'procedure'` entry + stamps the sources `procedurized`; skips unusable
 *      drafts; a converged history authors nothing; honors a per-user filter.
 */

import { describe, expect, it, vi } from 'vitest'

import type { MemoryEntry } from '@aipehub/services-sdk'

import {
  clusterBySimilarity,
  detectProcedureCandidates,
  isProcedure,
  isProcedurized,
  procedureAuthoringReviewer,
  stepsOf,
  type DraftedProcedure,
  type ProcedureDrafter,
} from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

// Three near-identical episodes of the SAME procedure (overtime claim): high term
// overlap → they cluster. The coffee note shares no bigrams → it never joins.
const claim1 = entry('c1', 'episodic', '起草加班费申请提交经理审批', 1001)
const claim2 = entry('c2', 'episodic', '起草加班费申请提交经理审批通过', 1002)
const claim3 = entry('c3', 'episodic', '起草加班费申请提交经理审批完成', 1003)
const coffee = entry('cf', 'episodic', '购买办公室新咖啡机', 1004)

describe('clusterBySimilarity', () => {
  it('groups mutually-similar entries and excludes the dissimilar one', () => {
    const clusters = clusterBySimilarity([claim1, claim2, claim3, coffee], { minSize: 3 })
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.map((e) => e.id).sort()).toEqual(['c1', 'c2', 'c3'])
  })

  it('emits nothing when no cluster reaches minSize', () => {
    // A lone pair can't reach minSize 3.
    expect(clusterBySimilarity([claim1, claim2, coffee], { minSize: 3 })).toEqual([])
  })

  it('consumes members so they cannot seed or join a second cluster', () => {
    // Two distinct recurring patterns, each a pair; minSize 2 → two clusters,
    // disjoint membership.
    const a1 = entry('a1', 'episodic', '预订会议室准备投影', 1)
    const a2 = entry('a2', 'episodic', '预订会议室准备投影仪', 2)
    const clusters = clusterBySimilarity([claim1, claim2, a1, a2], { minSize: 2 })
    expect(clusters).toHaveLength(2)
    const flat = clusters.flat().map((e) => e.id)
    expect(new Set(flat).size).toBe(flat.length) // no entry in two clusters
  })

  it('is deterministic — same input → same clusters', () => {
    const a = clusterBySimilarity([claim1, claim2, claim3, coffee], { minSize: 3 })
    const b = clusterBySimilarity([claim1, claim2, claim3, coffee], { minSize: 3 })
    expect(a.map((c) => c.map((e) => e.id))).toEqual(b.map((c) => c.map((e) => e.id)))
  })
})

describe('detectProcedureCandidates', () => {
  it('proposes a candidate for a >= minOccurrences recurring pattern', () => {
    const cands = detectProcedureCandidates([claim1, claim2, claim3, coffee], { minOccurrences: 3 })
    expect(cands).toHaveLength(1)
    expect(cands[0]!.members.map((e) => e.id).sort()).toEqual(['c1', 'c2', 'c3'])
    expect(cands[0]!.signature).toMatch(/^[0-9a-z]+$/) // a stable base36 label
  })

  it('excludes already-procedurized episodes (idempotent)', () => {
    const done = { ...claim1, meta: { procedurized: 'proc-1' } }
    expect(isProcedurized(done)).toBe(true)
    // With c1 out, only c2+c3 remain — a pair, below minOccurrences 3 → no candidate.
    const cands = detectProcedureCandidates([done, claim2, claim3], { minOccurrences: 3 })
    expect(cands).toEqual([])
  })

  it('a single-occurrence history proposes nothing', () => {
    expect(detectProcedureCandidates([claim1, coffee], { minOccurrences: 3 })).toEqual([])
  })
})

describe('procedureAuthoringReviewer', () => {
  const NOW = 5_000_000

  function drafter(d: DraftedProcedure): ProcedureDrafter {
    return async () => d
  }

  it('authors a skill from a recurring pattern and stamps the sources', async () => {
    const mem = makeFakeMemory([claim1, claim2, claim3, coffee])
    const draft = vi.fn<ProcedureDrafter>(
      drafter({ name: '申请加班费', steps: ['起草申请', '提交经理审批', '记录决定'] }),
    )
    const reviewer = procedureAuthoringReviewer({ draft, minOccurrences: 3 })

    const out = await reviewer({ memory: mem, episodic: [claim1, claim2, claim3, coffee], now: NOW })

    expect(out.summary).toContain('authored 1')
    expect(draft).toHaveBeenCalledTimes(1)
    // A new procedure entry was written with the drafted name + steps.
    const procs = mem.entries.filter(isProcedure)
    expect(procs).toHaveLength(1)
    expect(procs[0]!.text).toBe('申请加班费')
    expect(stepsOf(procs[0]!)).toEqual(['起草申请', '提交经理审批', '记录决定'])
    expect((procs[0]!.meta as { authored?: unknown }).authored).toBe(true)
    expect((procs[0]!.meta as { authoredAt?: unknown }).authoredAt).toBe(NOW)
    // The 3 sources are stamped procedurized → next sweep skips them.
    const procId = procs[0]!.id
    for (const id of ['c1', 'c2', 'c3']) {
      const src = mem.entries.find((e) => e.id === id)!
      expect((src.meta as { procedurized?: unknown }).procedurized).toBe(procId)
    }
    // The unrelated coffee note is untouched.
    expect(isProcedurized(mem.entries.find((e) => e.id === 'cf')!)).toBe(false)
  })

  it('is idempotent — a second sweep over the now-procedurized history authors nothing', async () => {
    const mem = makeFakeMemory([claim1, claim2, claim3])
    const draft = drafter({ name: '申请加班费', steps: ['起草', '提交', '记录'] })
    const reviewer = procedureAuthoringReviewer({ draft, minOccurrences: 3 })

    const first = await reviewer({ memory: mem, episodic: [claim1, claim2, claim3], now: NOW })
    expect(first.summary).toContain('authored 1')

    // Re-run with the (now stamped) episodes — nothing new to author.
    const stamped = mem.entries.filter((e) => e.kind === 'episodic')
    const second = await reviewer({ memory: mem, episodic: stamped, now: NOW })
    expect(second).toEqual({})
    expect(mem.entries.filter(isProcedure)).toHaveLength(1) // still exactly one skill
  })

  it('skips an unusable draft (empty name or no steps) — writes no empty skill', async () => {
    const mem = makeFakeMemory([claim1, claim2, claim3])
    const reviewer = procedureAuthoringReviewer({
      draft: drafter({ name: '  ', steps: [] }),
      minOccurrences: 3,
    })
    const out = await reviewer({ memory: mem, episodic: [claim1, claim2, claim3], now: NOW })
    expect(out).toEqual({}) // nothing authored
    expect(mem.entries.filter(isProcedure)).toHaveLength(0)
  })

  it('honors a per-user filter (no-leak: another namespace is never authored from)', async () => {
    const mine1 = entry('m1', 'episodic', '起草加班费申请提交经理审批', 1, { user: 'alice' })
    const mine2 = entry('m2', 'episodic', '起草加班费申请提交经理审批通过', 2, { user: 'alice' })
    const mine3 = entry('m3', 'episodic', '起草加班费申请提交经理审批完成', 3, { user: 'alice' })
    const theirs = entry('t1', 'episodic', '起草加班费申请提交经理审批', 4, { user: 'bob' })
    const mem = makeFakeMemory([mine1, mine2, mine3, theirs])
    const reviewer = procedureAuthoringReviewer({
      draft: drafter({ name: 'alice 的加班流程', steps: ['起草', '提交', '记录'] }),
      minOccurrences: 3,
      filter: (e) => (e.meta as { user?: unknown } | undefined)?.user === 'alice',
    })

    await reviewer({ memory: mem, episodic: [mine1, mine2, mine3, theirs], now: NOW })

    // bob's episode is never a source — not stamped, not folded into alice's skill.
    expect(isProcedurized(mem.entries.find((e) => e.id === 't1')!)).toBe(false)
    expect(mem.entries.filter(isProcedure)).toHaveLength(1)
  })

  it('an empty episodic pool is a no-op', async () => {
    const mem = makeFakeMemory([])
    const reviewer = procedureAuthoringReviewer({ draft: drafter({ name: 'x', steps: ['y'] }) })
    expect(await reviewer({ memory: mem, episodic: [], now: NOW })).toEqual({})
  })
})
