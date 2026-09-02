/**
 * M-EVAL M1 — the write-side ruler is judged before its numbers count.
 *
 * CI tier (`pnpm check:memory-write`, zero keys, zero network): this file locks
 * the RULER, not the model —
 *   ② calibration: hand-labelled facts must grade exactly as labelled;
 *   ① pipeline: a scripted oracle through the REAL `reconcile()` scores full
 *      marks, DELETE+ADD scores the same as UPDATE, and three deliberately
 *      wrong deciders land below the ceiling (mutation testing built into the
 *      gate), with per-check pins so a neutered check cannot hide inside an
 *      aggregate that happens to stay under the ceiling;
 *   hygiene: fixtures cannot make a check trivially true.
 *
 * FLOORS: never lower a floor (or raise a ceiling) to make it pass.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import type { MemoryHandle } from '@gotong/services-sdk'
import {
  scoreCloseDecisions,
  scoreSelfContainment,
  gradeSelfContainment,
  hasDanglingPronounLead,
  formatWriteBenchResult,
  WRITE_BENCH_NOW,
  FORGET_PROJECTION_SYNC_LINE,
  type CloseCase,
  type CloseCaseScore,
  type ReconcileOp,
  type WriteBenchDeciderFactory,
  type WriteBenchMemory,
} from '../src/index.js'
import { makeFakeMemory } from './fake-memory.js'
import { CLOSE_CASES, CONTAINMENT_FACTS } from './fixtures/write-cases.js'

// Ratchet floors — never lower a floor to make it pass; raise only.
const ORACLE_CLOSE_FLOOR = 1
const WRONG_DECIDER_CEILING = 0.75
const CONTAINMENT_CALIBRATION_RATE = 7 / 17

function asWriteBench(m: MemoryHandle): WriteBenchMemory {
  if (typeof m.patchMeta !== 'function') throw new Error('fake memory must expose patchMeta')
  return m as WriteBenchMemory
}
const makeMemory = () => asWriteBench(makeFakeMemory())

// Deciders are `MemorySummarizer`s that ignore the prompt and answer ops JSON —
// the same seam a real model answers through in the real-model tier.
const scripted = (ops: readonly ReconcileOp[]) => async () => JSON.stringify({ ops })
const oracleDecider: WriteBenchDeciderFactory = (c) => scripted(c.oracleOps)
const deleteAddDecider: WriteBenchDeciderFactory = (c) =>
  scripted(
    c.oracleOps.flatMap((op): ReconcileOp[] =>
      op.op === 'update' ? [{ op: 'delete', id: op.id }, { op: 'add', text: op.text }] : [op],
    ),
  )
// Wrong deciders are DERIVED from the case, never hand-written per case, so a
// new fixture cannot be quietly excused from them.
const lazyNoopDecider: WriteBenchDeciderFactory = () => scripted([{ op: 'noop' }])
const vandalDecider: WriteBenchDeciderFactory = (c) =>
  scripted(c.seed.length === 0 ? [{ op: 'noop' }] : c.seed.map((s): ReconcileOp => ({ op: 'delete', id: s.id })))
const wrongTargetDecider: WriteBenchDeciderFactory = (c) => {
  const victim = c.expect.untouched?.[0]
  const text = c.candidates[0]
  return scripted(victim !== undefined && text !== undefined ? [{ op: 'update', id: victim, text }] : [{ op: 'noop' }])
}

const run = (makeDecider: WriteBenchDeciderFactory) =>
  scoreCloseDecisions({ cases: CLOSE_CASES, makeMemory, makeDecider })
const checkMap = (s: CloseCaseScore) => Object.fromEntries(s.checks.map((k) => [k.name, k.ok]))
const byName = (name: string) => {
  const f = CONTAINMENT_FACTS.find((x) => x.name === name)
  if (!f) throw new Error(`no containment fixture ${name}`)
  return f
}

describe('② 判分器校准 — 判分器自己先被判过', () => {
  it.each(CONTAINMENT_FACTS.map((f) => [f.name, f] as const))('%s grades as hand-labelled', (_name, f) => {
    const v = gradeSelfContainment(f.fact, f.spec)
    expect(v.selfContained, `${f.fact} — ${f.why}`).toBe(f.selfContained)
  })

  it('pronoun-only-wrong facts carry category AND value; the dangling lead is the sole failure', () => {
    for (const name of ['they-badminton-en', 'his-drink-en', 'she-pet-zh']) {
      const f = byName(name)
      const v = gradeSelfContainment(f.fact, f.spec)
      expect(v.hasCategory, name).toBe(true)
      expect(v.hasValue, name).toBe(true)
      expect(v.danglingPronoun, name).toBe(true)
    }
  })

  it('value-only-wrong: category and subject present, no concrete value, no pronoun', () => {
    const v = gradeSelfContainment(byName('no-value-zh').fact, byName('no-value-zh').spec)
    expect(v).toEqual({ selfContained: false, hasCategory: true, hasValue: false, danglingPronoun: false })
  })

  it('dangling pronoun is start-position only, trimmed, case-insensitive, and narrow', () => {
    expect(hasDanglingPronounLead('用户养了一只猫,它叫小白')).toBe(false)
    expect(hasDanglingPronounLead('它叫小白')).toBe(true)
    expect(hasDanglingPronounLead('  她 住在槟城')).toBe(true)
    expect(hasDanglingPronounLead('THEY meet on Wednesdays')).toBe(true)
    expect(hasDanglingPronounLead('Their dog is called Sunny')).toBe(true)
    expect(hasDanglingPronounLead('The user drinks tea')).toBe(false)
    expect(hasDanglingPronounLead('Theyre')).toBe(false)
    expect(hasDanglingPronounLead('其实用户住在槟城')).toBe(false)
    expect(hasDanglingPronounLead('')).toBe(false)
    expect(hasDanglingPronounLead('   ')).toBe(false)
  })

  it('aggregate rate equals the hand-label count exactly', () => {
    const r = scoreSelfContainment(CONTAINMENT_FACTS)
    expect(r.perFact.length).toBe(17)
    expect(r.rate).toBe(CONTAINMENT_CALIBRATION_RATE)
  })

  it('an empty term list or an empty fact set is a fixture bug, not a silent zero', () => {
    expect(() => gradeSelfContainment('x', { categoryTerms: [], valueTerms: ['x'] })).toThrow(/category term/)
    expect(() => gradeSelfContainment('x', { categoryTerms: ['x'], valueTerms: [] })).toThrow(/value term/)
    expect(() => scoreSelfContainment([])).toThrow(/no facts/)
  })
})

describe('① 管道贯通 — 真 reconcile 驱动,判店况不判 ops', () => {
  it('scripted oracle scores full marks and every UPDATE case carries the supersedes back-link', async () => {
    const r = await run(oracleDecider)
    expect(r.now).toBe(WRITE_BENCH_NOW)
    expect(r.closeScore).toBe(ORACLE_CLOSE_FLOOR)
    expect(r.supersedesRate).toBe(1)
    for (const s of r.perCase) expect(s.score, s.name).toBe(1)
    expect(Object.keys(r.byCategory).sort()).toEqual(['add', 'delete', 'noop', 'update'])
    for (const g of Object.values(r.byCategory)) expect(g.score).toBe(1)
    expect(r.perCase.length).toBe(CLOSE_CASES.length)
  })

  it('DELETE+ADD reaches the same store state as UPDATE: full marks, zero back-links (§3.2 equivalence)', async () => {
    const r = await run(deleteAddDecider)
    expect(r.closeScore).toBe(1)
    expect(r.supersedesRate).toBe(0)
  })

  it.each([
    ['lazy noop', lazyNoopDecider],
    ['vandal delete-all', vandalDecider],
    ['wrong target', wrongTargetDecider],
  ] as const)('deliberately wrong decider "%s" lands below the ceiling but above zero', async (_name, d) => {
    const r = await run(d)
    expect(r.closeScore).toBeLessThan(WRONG_DECIDER_CEILING)
    expect(r.closeScore).toBeGreaterThan(0)
  })

  it('per-check pins on move-city-zh: each wrong decider fails exactly the checks its mistake predicts', async () => {
    const only = CLOSE_CASES.filter((c) => c.name === 'move-city-zh')
    expect(only.length).toBe(1)
    const pick = async (d: WriteBenchDeciderFactory) => {
      const r = await scoreCloseDecisions({ cases: only, makeMemory, makeDecider: d })
      const s = r.perCase[0]
      if (!s) throw new Error('no per-case score')
      return s
    }
    const lazy = await pick(lazyNoopDecider)
    expect(checkMap(lazy)).toEqual({ 'closed:s1': false, 'new-active:槟城': false, 'untouched:s2': true })
    expect(lazy.score).toBe(1 / 3)
    expect(lazy.supersedesBonus).toBe(false)

    const vandal = await pick(vandalDecider)
    expect(checkMap(vandal)).toEqual({ 'closed:s1': true, 'new-active:槟城': false, 'untouched:s2': false })

    const wrong = await pick(wrongTargetDecider)
    expect(checkMap(wrong)).toEqual({ 'closed:s1': false, 'new-active:槟城': true, 'untouched:s2': false })

    const oracle = await pick(oracleDecider)
    expect(checkMap(oracle)).toEqual({ 'closed:s1': true, 'new-active:槟城': true, 'untouched:s2': true })
    expect(oracle.supersedesBonus).toBe(true)
  })

  it('refuses a pre-seeded store, a backend that renames ids, and an empty case list', async () => {
    const only = CLOSE_CASES.filter((c) => c.name === 'move-city-zh')
    const preSeeded = () => asWriteBench(makeFakeMemory([{ id: 'pre', kind: 'semantic', text: 'pre', ts: 1 }]))
    await expect(
      scoreCloseDecisions({ cases: only, makeMemory: preSeeded, makeDecider: oracleDecider }),
    ).rejects.toThrow(/EMPTY store/)

    const renaming = () => {
      const m = asWriteBench(makeFakeMemory())
      const orig = m.remember.bind(m)
      const remember: WriteBenchMemory['remember'] = async (e) => {
        const { id: _dropped, ...rest } = e
        return orig(rest)
      }
      return Object.assign(m, { remember })
    }
    await expect(
      scoreCloseDecisions({ cases: only, makeMemory: renaming, makeDecider: oracleDecider }),
    ).rejects.toThrow(/honor caller-supplied id/)

    await expect(scoreCloseDecisions({ cases: [], makeMemory, makeDecider: oracleDecider })).rejects.toThrow(/no cases/)
  })

  it('supersedesRate is null when no case carries a bonus (never folded into closeScore)', async () => {
    const stripped: CloseCase[] = CLOSE_CASES.map(({ supersedesBonus: _b, ...rest }) => rest)
    const r = await scoreCloseDecisions({ cases: stripped, makeMemory, makeDecider: oracleDecider })
    expect(r.supersedesRate).toBeNull()
    expect(r.closeScore).toBe(1)
    for (const s of r.perCase) expect(s.supersedesBonus).toBeUndefined()
  })
})

describe('夹具卫生 — 判分器判的必须是真话', () => {
  it('activeContains fragments never appear in any seed text', () => {
    for (const c of CLOSE_CASES) {
      for (const frag of c.expect.activeContains ?? []) {
        for (const s of c.seed) {
          expect(s.text.includes(frag), `${c.name}: fragment "${frag}" already in seed ${s.id}`).toBe(false)
        }
      }
    }
  })

  it('closed/untouched ids are seed ids, every case declares a check, oracleOps non-empty, noNewEntries only on noop', () => {
    for (const c of CLOSE_CASES) {
      const ids = new Set(c.seed.map((s) => s.id))
      for (const id of [...(c.expect.closed ?? []), ...(c.expect.untouched ?? [])]) {
        expect(ids.has(id), `${c.name}: ${id} is not a seed id`).toBe(true)
      }
      const checks =
        (c.expect.closed?.length ?? 0) +
        (c.expect.activeContains?.length ?? 0) +
        (c.expect.untouched?.length ?? 0) +
        (c.expect.noNewEntries ? 1 : 0)
      expect(checks, `${c.name} declares no check`).toBeGreaterThan(0)
      expect(c.oracleOps.length, `${c.name} has no oracle ops`).toBeGreaterThan(0)
      if (c.expect.noNewEntries) expect(c.category, `${c.name}: noNewEntries is noop-only`).toBe('noop')
      if (c.supersedesBonus) expect(c.category, `${c.name}: supersedes bonus is update-only`).toBe('update')
      expect(new Set(c.seed.map((s) => s.id)).size, `${c.name}: duplicate seed ids`).toBe(c.seed.length)
    }
    expect(new Set(CLOSE_CASES.map((c) => c.name)).size).toBe(CLOSE_CASES.length)
    expect(new Set(CONTAINMENT_FACTS.map((f) => f.name)).size).toBe(CONTAINMENT_FACTS.length)
    expect(new Set(CLOSE_CASES.map((c) => c.category))).toEqual(new Set(['update', 'delete', 'add', 'noop']))
  })

  it('the ruler itself reads no wall clock (source-level)', () => {
    const src = readFileSync(new URL('../src/write-benchmark.ts', import.meta.url), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('Date.now')
    expect(code).not.toContain('new Date(')
    expect(code).toContain('WRITE_BENCH_NOW')
  })
})

describe('报告', () => {
  it('formats both rulers plus the fixed ③ citation line', async () => {
    const close = await run(oracleDecider)
    const containment = scoreSelfContainment(CONTAINMENT_FACTS)
    const out = formatWriteBenchResult('scripted', { close, containment })
    expect(out.startsWith('【scripted】')).toBe(true)
    expect(out).toContain('100.0%')
    expect(out).toContain('41.2%')
    expect(out).toContain('supersedes 回链')
    expect(out).toContain(FORGET_PROJECTION_SYNC_LINE)
    expect(FORGET_PROJECTION_SYNC_LINE).toContain('butler-obsidian-wiring.test.ts')
    expect(FORGET_PROJECTION_SYNC_LINE).toContain('不计分')
    const noBonus = formatWriteBenchResult('x', { close: { ...close, supersedesRate: null } })
    expect(noBonus).toContain('(无回链案例)')
    expect(formatWriteBenchResult('y', {})).toContain(FORGET_PROJECTION_SYNC_LINE)
  })

  it('the ③ citation points at a gate that exists on disk', () => {
    const gate = new URL('../../host/tests/butler-obsidian-wiring.test.ts', import.meta.url)
    expect(existsSync(gate)).toBe(true)
    expect(readFileSync(gate, 'utf8')).toContain('forgetAll')
  })
})
