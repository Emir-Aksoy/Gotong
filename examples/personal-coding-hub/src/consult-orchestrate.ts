/**
 * runConsult — the MODERATOR of a 会诊, as a plain orchestration function (not an
 * LLM). It runs the blind round, tallies a verdict off the pure consult core, and
 * either reports a root cause, runs another cross-examination round, or escalates
 * to a human. Mirroring cafe-ops' inline two-step-resume, the moderator is demo
 * orchestration over `hub.dispatch` + the board + pure functions — the most
 * deterministic, most assertable shape (no LLM deciding when to stop).
 *
 * Blind round (round 1): each panelist is dispatched with NO peer context, so it
 * diagnoses independently (avoids anchoring on a confident first voice).
 * Cross-examination (rounds 2+): the moderator hands each panelist a SNAPSHOT of
 * the PREVIOUS round's peer diagnoses (peerDigest of the snapshot, not a live read
 * of the board), so the parallel writes within a round never change what a peer
 * sees mid-round. That snapshot is the whole reason the round is deterministic.
 */

import { type Hub } from '@gotong/core'

import {
  evaluateConsensus,
  nextConsultStep,
  type ConsultPlan,
  type ConsultProblem,
  type ConsultStep,
  type ConsultVerdict,
  type Diagnosis,
} from './consult.js'
import { peerDigest, readAllDiagnoses, type ConsultBoard } from './consult-board.js'

export interface ConsultRunResult {
  /** The verdict from the final round run. */
  verdict: ConsultVerdict
  /** What the moderator decided to do with that verdict (report / escalate). */
  step: ConsultStep
  /** How many rounds it took (1 = converged blind; up to plan.maxRounds). */
  rounds: number
  /** The final round's diagnoses (for reporting / assertion). */
  diagnoses: Diagnosis[]
}

export interface RunConsultOpts {
  /** Identifies the problem to the (mock or real) diagnostic agents, via the prompt. */
  problemId: string
  /** Optional progress line sink (the demo passes console.log). */
  log?: (msg: string) => void
  /**
   * Optional per-agent board-write convention appended to each diagnosis prompt.
   * Real CLIs need to be told the exact card path + format (boardCardInstruction);
   * the mock already knows the shape, so the offline demos leave this unset and the
   * prompt is byte-for-byte unchanged.
   */
  cardInstruction?: (agent: string) => string
}

/**
 * Drive a panel through blind diagnosis → cross-examination → converge / escalate.
 * Each round dispatches all panelists in parallel and tallies once they're back;
 * `nextConsultStep` (pure) decides whether to report, run another round, or
 * escalate. Stops as soon as it converges — the round cap lives in `plan.maxRounds`.
 */
export async function runConsult(
  hub: Hub,
  board: ConsultBoard,
  problem: ConsultProblem,
  plan: ConsultPlan,
  opts: RunConsultOpts,
): Promise<ConsultRunResult> {
  const log = opts.log ?? (() => {})

  for (let round = 1; ; round++) {
    const blind = round === 1
    // Snapshot the previous round BEFORE dispatching this one — every panelist in
    // a cross-examination round sees the same stable peer set regardless of write
    // order. The blind round gets no peer context at all.
    const prev = blind ? [] : readAllDiagnoses(board)
    log(`  round ${round} — ${blind ? 'blind diagnosis (no peer context)' : 'cross-examination'}`)

    await Promise.all(
      plan.panel.map((agent) =>
        dispatchDiagnosis(hub, agent, problem, round, blind, prev, opts.problemId, opts.cardInstruction),
      ),
    )

    const diagnoses = readAllDiagnoses(board)
    const verdict = evaluateConsensus(diagnoses, plan.panel.length)
    const step = nextConsultStep(verdict, round, plan)
    log(`  → ${verdictLine(verdict)}`)

    if (step.kind !== 'another-round') {
      return { verdict, step, rounds: round, diagnoses }
    }
  }
}

/** Dispatch one panelist for one round; the agent writes its card to the board. */
async function dispatchDiagnosis(
  hub: Hub,
  agent: string,
  problem: ConsultProblem,
  round: number,
  blind: boolean,
  prev: Diagnosis[],
  problemId: string,
  cardInstruction?: (agent: string) => string,
): Promise<void> {
  const prompt = [
    `PROBLEM-ID: ${problemId}`,
    `ROUND: ${round}`,
    `SYMPTOM: ${problem.symptom}`,
    problem.evidence ? `EVIDENCE: ${problem.evidence}` : '',
    blind
      ? '(blind round — diagnose independently; do NOT consult peers)'
      : `PEER DIAGNOSES:\n${peerDigest(prev, agent)}`,
    cardInstruction ? cardInstruction(agent) : '',
  ]
    .filter(Boolean)
    .join('\n')

  const r = await hub.dispatch({
    from: 'consult-moderator',
    strategy: { kind: 'explicit', to: agent },
    payload: { prompt },
    title: `consult ${agent} r${round}`,
  })
  if (r.kind !== 'ok') {
    throw new Error(`diagnosis dispatch to ${agent} (round ${round}) failed: ${JSON.stringify(r)}`)
  }
}

function verdictLine(v: ConsultVerdict): string {
  if (v.kind === 'converged') return `converged: ${v.rootCause} (${v.votes}/${v.panel})`
  const tally = v.tally.map((t) => `${t.rootCause}×${t.votes}`).join(', ') || '(no root cause yet)'
  return `split: ${tally}` + (v.symptomOnly ? `, ${v.symptomOnly} still at symptoms` : '')
}
