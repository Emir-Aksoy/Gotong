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

import type { MemoryEntry, MemoryHandle } from '@aipehub/services-sdk'

import {
  activeProcedures,
  clusterBySimilarity,
  detectProcedureCandidates,
  isActive,
  isProcedure,
  isProcedurized,
  linksOf,
  procedureAuthoringReviewer,
  stepsOf,
  supersedesOf,
  umbrellaReviewer,
  validToOf,
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

// --- ③ Umbrella consolidation -----------------------------------------------

const NOW_U = 9_000_000

/** A `form:'procedure'` semantic entry (the umbrella sweep operates over these). */
function proc(
  id: string,
  name: string,
  steps: string[],
  ts: number,
  extraMeta: Record<string, unknown> = {},
): MemoryEntry {
  return entry(id, 'semantic', name, ts, { form: 'procedure', steps, ...extraMeta })
}

function merger(d: DraftedProcedure): ProcedureDrafter {
  return async () => d
}

describe('activeProcedures', () => {
  it('returns active procedures, excluding closed intervals and non-procedures', () => {
    const live = proc('p1', '申请加班费', ['起草', '提交'], 100)
    const closed = proc('p2', '旧加班流程', ['x'], 101, { validTo: NOW_U - 1 }) // closed before now
    const fact = entry('f1', 'semantic', '一个普通事实', 102) // not a procedure
    expect(activeProcedures([live, closed, fact], NOW_U).map((e) => e.id)).toEqual(['p1'])
  })
})

describe('umbrellaReviewer', () => {
  it('merges a redundant cluster into one master, closing + back-linking the originals', async () => {
    // p1 + p2 are the SAME skill named two ways (high name overlap) → redundant.
    // coffee is unrelated and must survive untouched.
    const mem = makeFakeMemory([
      proc('p1', '申请加班费', ['起草申请', '提交经理'], 100),
      proc('p2', '加班费申请', ['写申请', '交经理审批'], 101),
      proc('coffee', '购买咖啡机', ['选型号', '下单'], 102),
    ])
    const merge = vi.fn<ProcedureDrafter>(
      merger({ name: '加班费申请(合并)', steps: ['起草申请', '提交经理审批', '记录决定'] }),
    )

    const out = await umbrellaReviewer({ merge })({ memory: mem, episodic: [], now: NOW_U })

    expect(out.summary).toContain('merged 1')
    expect(merge).toHaveBeenCalledTimes(1)

    // The umbrella is a fresh, ACTIVE procedure with the merged steps.
    const umbrella = mem.entries.find((e) => (e.meta as { umbrella?: unknown }).umbrella === true)!
    expect(umbrella).toBeDefined()
    expect(umbrella.text).toBe('加班费申请(合并)')
    expect(stepsOf(umbrella)).toEqual(['起草申请', '提交经理审批', '记录决定'])
    expect(isActive(umbrella, NOW_U)).toBe(true)
    expect((umbrella.meta as { mergedAt?: unknown }).mergedAt).toBe(NOW_U)

    // Both originals are CLOSED (validTo=now), supersede → umbrella, link → umbrella.
    for (const id of ['p1', 'p2']) {
      const orig = mem.entries.find((e) => e.id === id)!
      expect(validToOf(orig)).toBe(NOW_U)
      expect(isActive(orig, NOW_U)).toBe(false)
      expect(supersedesOf(orig)).toBe(umbrella.id)
      expect(linksOf(orig)).toContain(umbrella.id)
      // The merge PRESERVED the original's own steps (it only closed the interval).
      expect(stepsOf(orig).length).toBeGreaterThan(0)
    }

    // The unrelated coffee skill is untouched and still active.
    const coffee = mem.entries.find((e) => e.id === 'coffee')!
    expect(validToOf(coffee)).toBeUndefined()
    expect(supersedesOf(coffee)).toBeUndefined()

    // "SQLite repoint" for free: only the umbrella + coffee remain in the active set.
    expect(activeProcedures(mem.entries, NOW_U).map((e) => e.id).sort()).toEqual(
      [umbrella.id, 'coffee'].sort(),
    )
  })

  it('converged — dissimilar skills are not merged', async () => {
    const mem = makeFakeMemory([
      proc('p1', '申请加班费', ['x'], 100),
      proc('coffee', '购买咖啡机', ['y'], 101),
    ])
    const merge = vi.fn<ProcedureDrafter>(merger({ name: 'z', steps: ['z'] }))

    const out = await umbrellaReviewer({ merge })({ memory: mem, episodic: [], now: NOW_U })

    expect(out).toEqual({})
    expect(merge).not.toHaveBeenCalled()
    expect(mem.entries.filter(isProcedure)).toHaveLength(2) // nothing merged
  })

  it('is idempotent — a second sweep over the merged set re-merges nothing', async () => {
    const mem = makeFakeMemory([
      proc('p1', '申请加班费', ['起草'], 100),
      proc('p2', '加班费申请', ['提交'], 101),
    ])
    const merge = vi.fn<ProcedureDrafter>(merger({ name: '加班费总流程', steps: ['起草', '提交', '记录'] }))
    const reviewer = umbrellaReviewer({ merge })

    const first = await reviewer({ memory: mem, episodic: [], now: NOW_U })
    expect(first.summary).toContain('merged 1')
    expect(activeProcedures(mem.entries, NOW_U)).toHaveLength(1) // just the umbrella

    // Second sweep: the lone umbrella can't form a cluster of >=2 → no-op.
    const second = await reviewer({ memory: mem, episodic: [], now: NOW_U + 1 })
    expect(second).toEqual({})
    expect(merge).toHaveBeenCalledTimes(1) // not called again
  })

  it('honors a per-user filter (no-leak: another namespace is never merged or closed)', async () => {
    const mem = makeFakeMemory([
      proc('a1', '申请加班费', ['x'], 100, { user: 'alice' }),
      proc('a2', '加班费申请', ['y'], 101, { user: 'alice' }),
      proc('b1', '申请加班费', ['z'], 102, { user: 'bob' }), // same name as a1 — would cluster if unscoped
    ])
    const merge = vi.fn<ProcedureDrafter>(merger({ name: 'alice 的加班流程', steps: ['起草', '提交'] }))

    await umbrellaReviewer({
      merge,
      filter: (e) => (e.meta as { user?: unknown }).user === 'alice',
      procedureMeta: { user: 'alice' },
    })({ memory: mem, episodic: [], now: NOW_U })

    // bob's skill is never a member: not closed, not superseded.
    const b1 = mem.entries.find((e) => e.id === 'b1')!
    expect(validToOf(b1)).toBeUndefined()
    expect(supersedesOf(b1)).toBeUndefined()
    expect(isActive(b1, NOW_U)).toBe(true)
    // alice's two were merged + closed.
    expect(validToOf(mem.entries.find((e) => e.id === 'a1')!)).toBe(NOW_U)
    expect(validToOf(mem.entries.find((e) => e.id === 'a2')!)).toBe(NOW_U)
  })

  it('refuses to merge without patchMeta (cannot retire originals → no stranded umbrella)', async () => {
    // A backend that cannot amend meta: merging would strand a duplicate ACTIVE
    // umbrella we could never retire the originals against. The reviewer must
    // bail BEFORE writing anything.
    const procs = [proc('p1', '申请加班费', ['x'], 100), proc('p2', '加班费申请', ['y'], 101)]
    let created = 0
    const stub: MemoryHandle = {
      async recall(q) {
        return procs.filter((e) => !q.kinds || q.kinds.includes(e.kind))
      },
      async remember(ne) {
        created++
        return { id: 'new', ts: 1, kind: ne.kind, text: ne.text, ...(ne.meta ? { meta: ne.meta } : {}) }
      },
      async list() {
        return procs
      },
      async forget() {},
      async clear() {},
      // no patchMeta
    }
    const merge = vi.fn<ProcedureDrafter>(merger({ name: 'z', steps: ['z'] }))

    const out = await umbrellaReviewer({ merge })({ memory: stub, episodic: [], now: NOW_U })

    expect(out).toEqual({})
    expect(created).toBe(0) // nothing written — refused before remembering an umbrella
    expect(merge).not.toHaveBeenCalled()
  })
})
