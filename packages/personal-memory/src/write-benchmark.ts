/**
 * Write-side memory benchmark (M-EVAL M1) — the ruler, not the model.
 *
 * Two deterministic graders, mirroring `benchmark.ts` (they live in src/ so
 * the real-model runner imports the SAME code the CI gate runs — scripted and
 * real deciders share one path, so there is nothing to drift):
 *
 *   - `scoreCloseDecisions`  ① bitemporal close correctness. A case is
 *     {store before, new episodic candidates, golden postconditions}; the
 *     harness seeds an empty store, drives the REAL `reconcile()` in
 *     bitemporal mode, and grades the FINAL STORE STATE only — never the ops
 *     JSON. UPDATE and DELETE+ADD both reach "old fact closed, new fact
 *     active", so judging op shapes would mark a style difference as an
 *     error. The `supersedes` back-link is UPDATE-only, so it is reported as
 *     a bonus rate and never folded into the main score.
 *   - `scoreSelfContainment`  ② self-containment of atomic facts: a fact
 *     counts only if it names the category, names the concrete value, and
 *     does not open with a dangling pronoun. Pure string checks — no model
 *     ever judges a model (LoCoMo's judge accepted 63% of deliberately wrong
 *     answers; a ratchet floor over a non-deterministic grader means nothing).
 *
 * ③ forget/projection sync is deliberately NOT scored: it is already a binary
 * gate (`packages/host/tests/butler-obsidian-wiring.test.ts`), and a
 * percentage over a structurally pinned property is fake precision. The
 * scorecard carries a fixed line citing that gate instead
 * (`FORGET_PROJECTION_SYNC_LINE`).
 *
 * Boundaries (docs/zh/MEMORY-WRITE-EVAL.md §四): zero LLM on any hot path,
 * zero keys in CI, deterministic graders only, no new knobs, and the prompts
 * under test (`DEFAULT_RECONCILE_SYSTEM` / `DEFAULT_ATOMIC_FACTS_SYSTEM`)
 * are never touched by the ruler. No wall clock anywhere in this file —
 * `WRITE_BENCH_NOW` is the only "now", so a score is byte-stable across runs.
 */
import type { MemoryEntry, MemoryHandle } from '@gotong/services-sdk'
import { reconcile, type ReconcileOp } from './reconcile.js'
import type { MemorySummarizer } from './consolidate.js'
import {
  META_VALID_TO,
  isActive,
  isClosed,
  supersedesOf,
  validFromOf,
  type MemoryValidityWriter,
} from './bitemporal.js'

// ─── ① bitemporal close correctness ────────────────────────────────────────

export type CloseCategory = 'update' | 'delete' | 'add' | 'noop'

export interface CloseSeed {
  readonly id: string
  readonly text: string
}

/** Golden postconditions on the FINAL store — never on the ops the decider emitted. */
export interface CloseExpectation {
  /** Seed ids that must end CLOSED: `validTo` stamped, inactive at `now`. */
  readonly closed?: readonly string[]
  /** Text fragments that must appear in some ACTIVE entry carrying a `validFrom`. */
  readonly activeContains?: readonly string[]
  /** Bystander seed ids that must survive byte-identical and still active. */
  readonly untouched?: readonly string[]
  /** noop-only: the store must not have grown. */
  readonly noNewEntries?: boolean
}

export interface CloseCase {
  readonly name: string
  readonly category: CloseCategory
  readonly seed: readonly CloseSeed[]
  readonly candidates: readonly string[]
  readonly expect: CloseExpectation
  /**
   * The golden op list a SCRIPTED decider replays in the pipeline gate. The
   * grader never reads it; it exists only so a test can prove the ruler
   * awards full marks to a correct decider and less to a wrong one.
   */
  readonly oracleOps: readonly ReconcileOp[]
  /**
   * Bonus, outside the main score: an active entry containing `textFragment`
   * should point back at `oldId` via `supersedes`. UPDATE-only by
   * construction (DELETE+ADD cannot carry it), hence not a correctness check.
   */
  readonly supersedesBonus?: { readonly textFragment: string; readonly oldId: string }
  readonly note?: string
}

/** Bitemporal close needs an in-place meta patch; the optional method is required here. */
export type WriteBenchMemory = MemoryHandle & { patchMeta: NonNullable<MemoryHandle['patchMeta']> }
/** Must return an EMPTY store — the harness owns seeding (so ids are honored and checked). */
export type WriteBenchMemoryFactory = (c: CloseCase) => WriteBenchMemory | Promise<WriteBenchMemory>
/** The decider under test: scripted oracle in CI, a real model behind the same `MemorySummarizer` seam in the real run. */
export type WriteBenchDeciderFactory = (c: CloseCase) => MemorySummarizer

export interface CloseCheck {
  readonly name: string
  readonly ok: boolean
}

export interface CloseCaseScore {
  readonly name: string
  readonly category: CloseCategory
  /** Fraction of postcondition checks met, 0..1. */
  readonly score: number
  readonly checks: readonly CloseCheck[]
  /** Present only when the case declares `supersedesBonus`. */
  readonly supersedesBonus?: boolean
}

export interface CloseBenchResult {
  readonly now: number
  /** Mean of per-case scores. */
  readonly closeScore: number
  readonly perCase: readonly CloseCaseScore[]
  readonly byCategory: Record<string, { score: number; n: number }>
  /** Fraction of bonus-carrying cases whose new fact links back; null when no case carries a bonus. */
  readonly supersedesRate: number | null
}

export interface CloseBenchOptions {
  readonly cases: readonly CloseCase[]
  readonly makeMemory: WriteBenchMemoryFactory
  readonly makeDecider: WriteBenchDeciderFactory
  /** Fixed instant used for every validity stamp and every activity check. */
  readonly now?: number
}

/** Fixed clock for the ruler (an instant in 2023-11). Never a wall clock. */
export const WRITE_BENCH_NOW = 1_700_003_600_000

const BENCH_KIND = 'semantic' as const
const LIST_LIMIT = 200

export async function scoreCloseDecisions(opts: CloseBenchOptions): Promise<CloseBenchResult> {
  if (opts.cases.length === 0) throw new Error('scoreCloseDecisions: no cases')
  const now = opts.now ?? WRITE_BENCH_NOW
  const perCase: CloseCaseScore[] = []
  for (const c of opts.cases) {
    const memory = await opts.makeMemory(c)
    const preexisting = await memory.list({ kind: BENCH_KIND, limit: 1 })
    if (preexisting.length > 0) {
      throw new Error(`scoreCloseDecisions: makeMemory must return an EMPTY store (case ${c.name})`)
    }
    for (const s of c.seed) {
      const stored = await memory.remember({ id: s.id, kind: BENCH_KIND, text: s.text })
      if (stored.id !== s.id) {
        throw new Error(
          `scoreCloseDecisions: backend did not honor caller-supplied id ${s.id} (case ${c.name})`,
        )
      }
    }
    const closeEntry: MemoryValidityWriter = async (e, validTo) => {
      await memory.patchMeta(e.id, { [META_VALID_TO]: validTo })
    }
    await reconcile({
      memory,
      summarize: opts.makeDecider(c),
      candidates: [...c.candidates],
      kind: BENCH_KIND,
      bitemporal: true,
      closeEntry,
      now: () => now,
    })
    const after = await memory.list({ kind: BENCH_KIND, limit: LIST_LIMIT })
    perCase.push(gradeCase(c, after, now))
  }
  const closeScore = perCase.reduce((acc, s) => acc + s.score, 0) / perCase.length
  const byCategory: Record<string, { score: number; n: number }> = {}
  for (const s of perCase) {
    const g = (byCategory[s.category] ??= { score: 0, n: 0 })
    g.score += s.score
    g.n += 1
  }
  for (const g of Object.values(byCategory)) g.score /= g.n
  const bonusCases = perCase.filter((s) => s.supersedesBonus !== undefined)
  const supersedesRate =
    bonusCases.length === 0
      ? null
      : bonusCases.filter((s) => s.supersedesBonus === true).length / bonusCases.length
  return { now, closeScore, perCase, byCategory, supersedesRate }
}

function gradeCase(c: CloseCase, after: readonly MemoryEntry[], now: number): CloseCaseScore {
  const byId = new Map(after.map((e) => [e.id, e] as const))
  const seedText = new Map(c.seed.map((s) => [s.id, s.text] as const))
  const checks: CloseCheck[] = []
  for (const id of c.expect.closed ?? []) {
    const e = byId.get(id)
    checks.push({ name: `closed:${id}`, ok: e !== undefined && isClosed(e) && !isActive(e, now) })
  }
  for (const frag of c.expect.activeContains ?? []) {
    checks.push({
      name: `new-active:${frag}`,
      ok: after.some((e) => e.text.includes(frag) && isActive(e, now) && validFromOf(e) !== undefined),
    })
  }
  for (const id of c.expect.untouched ?? []) {
    const e = byId.get(id)
    checks.push({
      name: `untouched:${id}`,
      ok: e !== undefined && e.text === seedText.get(id) && isActive(e, now),
    })
  }
  if (c.expect.noNewEntries) {
    checks.push({ name: 'no-new-entries', ok: after.length === c.seed.length })
  }
  if (checks.length === 0) throw new Error(`scoreCloseDecisions: case ${c.name} declares no checks`)
  const score = checks.filter((k) => k.ok).length / checks.length
  const base = { name: c.name, category: c.category, score, checks }
  if (!c.supersedesBonus) return base
  const { textFragment, oldId } = c.supersedesBonus
  const supersedesBonus = after.some(
    (e) => e.text.includes(textFragment) && isActive(e, now) && supersedesOf(e) === oldId,
  )
  return { ...base, supersedesBonus }
}

// ─── ② self-containment ────────────────────────────────────────────────────

export interface ContainmentSpec {
  /** Category words; any one must appear (case-insensitive substring). */
  readonly categoryTerms: readonly string[]
  /** Concrete values; any one must appear (case-insensitive substring). */
  readonly valueTerms: readonly string[]
}

export interface ContainmentVerdict {
  readonly selfContained: boolean
  readonly hasCategory: boolean
  readonly hasValue: boolean
  readonly danglingPronoun: boolean
}

export interface ContainmentFactCase {
  readonly name: string
  readonly fact: string
  readonly spec: ContainmentSpec
}

export interface ContainmentBenchResult {
  readonly rate: number
  readonly perFact: readonly {
    readonly name: string
    readonly fact: string
    readonly verdict: ContainmentVerdict
  }[]
}

/**
 * Deliberately narrow: 该/其/此 are left out (「其实…」 would false-positive), and
 * only the LEADING code point / word is inspected. A fact that names its
 * subject and then says 「它叫小白」 is fine; one that opens with 「它」 has no
 * subject at all. Known coarse edge: a time phrase in the lead (「这周…」) is
 * flagged — the subject should lead, so it stays flagged on purpose.
 */
const ZH_DANGLING_LEAD: ReadonlySet<string> = new Set(['他', '她', '它', '这', '那'])
const EN_DANGLING_RE = /^(?:he|she|it|they|his|her|its|their|this|that|these|those)\b/i

export function hasDanglingPronounLead(fact: string): boolean {
  const t = fact.trim()
  if (t.length === 0) return false
  const first = [...t][0]
  if (first !== undefined && ZH_DANGLING_LEAD.has(first)) return true
  return EN_DANGLING_RE.test(t)
}

export function gradeSelfContainment(fact: string, spec: ContainmentSpec): ContainmentVerdict {
  if (spec.categoryTerms.length === 0 || spec.valueTerms.length === 0) {
    throw new Error('gradeSelfContainment: spec needs at least one category term and one value term')
  }
  const hay = fact.toLowerCase()
  const hit = (terms: readonly string[]) => terms.some((t) => t.length > 0 && hay.includes(t.toLowerCase()))
  const hasCategory = hit(spec.categoryTerms)
  const hasValue = hit(spec.valueTerms)
  const danglingPronoun = hasDanglingPronounLead(fact)
  return { selfContained: hasCategory && hasValue && !danglingPronoun, hasCategory, hasValue, danglingPronoun }
}

export function scoreSelfContainment(facts: readonly ContainmentFactCase[]): ContainmentBenchResult {
  if (facts.length === 0) throw new Error('scoreSelfContainment: no facts')
  const perFact = facts.map((f) => ({ name: f.name, fact: f.fact, verdict: gradeSelfContainment(f.fact, f.spec) }))
  const rate = perFact.filter((p) => p.verdict.selfContained).length / perFact.length
  return { rate, perFact }
}

// ─── report ────────────────────────────────────────────────────────────────

/** ③ is a binary gate elsewhere; the scorecard cites it rather than inventing a percentage. */
export const FORGET_PROJECTION_SYNC_LINE =
  '  · 遗忘-投影同步   不计分 — 二值门 packages/host/tests/butler-obsidian-wiring.test.ts' +
  '(6h 重投逐字节同 / forgetAll 清投影留 tasks.md / 单条 forget 重投 / 无 provider 仍投)'

export function formatWriteBenchResult(
  label: string,
  r: { readonly close?: CloseBenchResult; readonly containment?: ContainmentBenchResult },
): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const lines: string[] = [`【${label}】写侧记忆评测`]
  if (r.close) {
    lines.push(`  · ${'close 正确率'.padEnd(13)} ${pct(r.close.closeScore)} (${r.close.perCase.length} 例)`)
    for (const [cat, g] of Object.entries(r.close.byCategory).sort()) {
      lines.push(`    - ${cat.padEnd(8)} ${pct(g.score)} (${g.n} 例)`)
    }
    const bonus = r.close.supersedesRate === null ? '(无回链案例)' : pct(r.close.supersedesRate)
    lines.push(`  · ${'supersedes 回链'.padEnd(13)} ${bonus} — 加分项,不进主分`)
  }
  if (r.containment) {
    lines.push(`  · ${'自包含率'.padEnd(13)} ${pct(r.containment.rate)} (${r.containment.perFact.length} 条)`)
  }
  lines.push(FORGET_PROJECTION_SYNC_LINE)
  return lines.join('\n')
}
