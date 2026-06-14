/**
 * consult — the PURE core of multi-agent 会诊 (case consultation): when a coding
 * problem surfaces, several diagnostic agents read the SAME code, each forms an
 * INDEPENDENT diagnosis, then they cross-examine and converge on the REAL root
 * cause — not a surface symptom. This file is the assertable core: who sits on
 * the panel, how a round's diagnoses tally into a verdict, and what the moderator
 * does next (report a root cause / run another round / escalate to a human).
 *
 * Why a structured TAG, not free text: a root cause is prose, but consensus needs
 * something to count. Each diagnosis carries a canonical `rootCause` tag (e.g.
 * "missing-await") alongside free-text `detail`. Votes tally on the normalized
 * tag, so the demo asserts convergence without a real LLM, and a real diagnostic
 * agent only has to emit the tag in a prompt-agreed format.
 *
 * Why `level` (symptom vs root-cause): the whole point of 会诊 is to get PAST the
 * symptom ("the test fails") to the root cause ("the handler returns before the
 * promise resolves"). A diagnosis that stops at a symptom does NOT get a vote —
 * convergence is only ever on root causes. An agent that reported a symptom in
 * the blind round can UPGRADE to a root cause after cross-examination; that
 * upgrade is exactly the value a panel adds over a single agent.
 *
 * Everything here is a pure function — no Hub, no LLM, no disk — so the routing
 * of a consult is inspectable and the demo asserts it directly. (Mirrors the
 * pure-function discipline of routing.ts.)
 */

/** The problem put to the panel — a surfaced symptom plus whatever evidence we have. */
export interface ConsultProblem {
  /** The visible symptom that triggered the consult (a failing test, a crash). */
  symptom: string
  /** Optional evidence the panel reads (test output, stack trace, the diff). */
  evidence?: string
}

/** Is this diagnosis a root cause, or did the agent stop at a surface symptom? */
export type DiagnosisLevel = 'symptom' | 'root-cause'

/** One agent's diagnosis of the problem. */
export interface Diagnosis {
  /** Which diagnostic agent produced this. */
  agent: string
  /**
   * The canonical root-cause TAG votes tally on (e.g. "missing-await").
   * Normalized before comparison so "Missing await" and "missing-await" agree.
   */
  rootCause: string
  /** Root cause vs surface symptom — only root causes count toward consensus. */
  level: DiagnosisLevel
  /** Free-text explanation / evidence the agent gives for its call. */
  detail?: string
}

/** The plan for a consult: who is on the panel and the round ceiling. */
export interface ConsultPlan {
  /** The diagnostic agents on the panel, in a stable de-duplicated order. */
  panel: string[]
  /**
   * Max rounds before the moderator stops (1 blind round + cross-examination
   * rounds). Default 2 (one blind, one cross-examination) keeps cost bounded;
   * convergence stops earlier.
   */
  maxRounds: number
}

/** One tally line in a verdict: a root-cause tag and how many agents voted it. */
export interface VoteTally {
  rootCause: string
  votes: number
}

/** The verdict after a round: converged on a root cause, or split. */
export type ConsultVerdict =
  | {
      kind: 'converged'
      /** The root cause a strict majority of the panel pointed at. */
      rootCause: string
      /** How many agents voted the winning root cause. */
      votes: number
      /** Panel size the majority was measured against. */
      panel: number
    }
  | {
      kind: 'split'
      /** Every root cause that got a vote, highest first. */
      tally: VoteTally[]
      /** Panel members still stuck at a symptom (no root-cause vote). */
      symptomOnly: number
      panel: number
    }

/** What the moderator does after a verdict. */
export type ConsultStep =
  | { kind: 'report'; rootCause: string } // converged → hand the root cause back to a coder
  | { kind: 'another-round' } // split, rounds left → cross-examine again
  | { kind: 'escalate'; tally: VoteTally[] } // split, out of rounds → a human decides

const DEFAULT_MAX_ROUNDS = 2

/**
 * Normalize a root-cause tag for comparison: lowercase, trim, collapse runs of
 * non-alphanumerics to a single hyphen. So "Missing await!" and "missing-await"
 * tally as the same vote — tolerant of the small wording drift real agents emit.
 */
export function normalizeRootCause(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Plan a consult: seat the panel and set the round ceiling. A panel needs at
 * least two agents — a one-agent "consult" is just that agent's opinion, no
 * cross-examination possible — so we throw if asked to seat fewer.
 */
export function planConsult(
  _problem: ConsultProblem,
  panel: string[],
  opts: { maxRounds?: number } = {},
): ConsultPlan {
  const seated = [...new Set(panel)] // de-dup, keep first-seen order
  if (seated.length < 2) {
    throw new Error(`a consult needs at least 2 diagnostic agents, got ${seated.length}`)
  }
  return { panel: seated, maxRounds: Math.max(1, opts.maxRounds ?? DEFAULT_MAX_ROUNDS) }
}

/**
 * Tally a round's diagnoses into a verdict. ONLY root-cause-level diagnoses vote
 * (a symptom is not a candidate root cause). Convergence = a strict majority of
 * the PANEL (not of the votes cast) points at one normalized tag — so 2 of 3
 * agreeing converges, but 1 of 3 (with two still at symptoms) does not.
 * Measuring against panel size, not votes cast, keeps a lone confident voice
 * from "winning" while everyone else is still unsure.
 */
export function evaluateConsensus(diagnoses: Diagnosis[], panelSize: number): ConsultVerdict {
  const roots = diagnoses.filter((d) => d.level === 'root-cause')

  // Tally votes by normalized tag, remembering a display label per tag.
  const byTag = new Map<string, { label: string; votes: number }>()
  for (const d of roots) {
    const key = normalizeRootCause(d.rootCause)
    if (!key) continue
    const cur = byTag.get(key) ?? { label: d.rootCause, votes: 0 }
    cur.votes += 1
    byTag.set(key, cur)
  }

  const tally: VoteTally[] = [...byTag.values()]
    .map((v) => ({ rootCause: v.label, votes: v.votes }))
    .sort((a, b) => b.votes - a.votes)

  const top = tally[0]
  if (top && top.votes * 2 > panelSize) {
    return { kind: 'converged', rootCause: top.rootCause, votes: top.votes, panel: panelSize }
  }
  // Panel members that cast no root-cause vote are still stuck at a symptom.
  const votedRoots = roots.filter((d) => normalizeRootCause(d.rootCause)).length
  return { kind: 'split', tally, symptomOnly: Math.max(0, panelSize - votedRoots), panel: panelSize }
}

/**
 * Decide what the moderator does after a verdict. Converged → report the root
 * cause back to a coder. Split with rounds left → cross-examine again. Split and
 * out of rounds → escalate to a human (北极星: a person is a Participant; the
 * panel doesn't get to keep burning rounds forever).
 *
 * `round` is 1-based: round 1 is the blind round, rounds 2..maxRounds are
 * cross-examination.
 */
export function nextConsultStep(
  verdict: ConsultVerdict,
  round: number,
  plan: ConsultPlan,
): ConsultStep {
  if (verdict.kind === 'converged') return { kind: 'report', rootCause: verdict.rootCause }
  if (round < plan.maxRounds) return { kind: 'another-round' }
  return { kind: 'escalate', tally: verdict.tally }
}
