/**
 * Deterministic self-check for the consult CORE — no Hub, no LLM, no agent.
 * Asserts the pure functions (planConsult / evaluateConsensus / nextConsultStep /
 * normalizeRootCause) and the board round-trip + blind isolation. Mirrors the
 * index.ts self-asserting style (throw on mismatch). M2 stacks the full Hub +
 * mock-agent orchestration demo on top of exactly these pieces.
 *
 * Run:  pnpm demo:personal-coding-hub:consult-core
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  planConsult,
  evaluateConsensus,
  nextConsultStep,
  normalizeRootCause,
  type Diagnosis,
  type ConsultProblem,
} from './consult.js'
import {
  setupConsultBoard,
  writeDiagnosis,
  readAllDiagnoses,
  readDiagnosis,
  formatPeerDiagnoses,
} from './consult-board.js'

let checks = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`✗ ${msg}`)
  checks++
}
function eq<T>(got: T, want: T, msg: string): void {
  assert(
    JSON.stringify(got) === JSON.stringify(want),
    `${msg} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
  )
}
function section(t: string): void {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 50 - t.length))}`)
}

const PROBLEM: ConsultProblem = {
  symptom: 'auth integration test flakes intermittently',
  evidence: 'test log: timeout after 5s',
}

function main(): void {
  console.log('\n=== consult core self-check (pure functions + board) ===')
  console.log('  会诊核心: 谁上会诊台 · 怎么计票收敛 · 主持下一步 · 白板盲诊隔离\n')

  // —— planConsult ——
  section('planConsult')
  const plan = planConsult(PROBLEM, ['claude-code', 'codex', 'claude-code']) // dup dropped
  eq(plan.panel, ['claude-code', 'codex'], 'planConsult de-dups the panel')
  eq(plan.maxRounds, 2, 'planConsult default maxRounds=2 (blind + cross-examine)')
  let threw = false
  try {
    planConsult(PROBLEM, ['solo'])
  } catch {
    threw = true
  }
  assert(threw, 'planConsult throws on a panel < 2 (no cross-examination possible)')

  // —— normalizeRootCause ——
  section('normalizeRootCause')
  eq(normalizeRootCause('Missing await!'), 'missing-await', 'normalize lowercases + hyphenates')
  eq(normalizeRootCause('  null-guard  '), 'null-guard', 'normalize trims')
  assert(
    normalizeRootCause('Missing Await') === normalizeRootCause('missing-await'),
    'normalize collapses wording drift to one vote',
  )

  // —— evaluateConsensus: majority of the PANEL, root causes only ——
  section('evaluateConsensus')
  // 2 of 3 agree on a root cause (one with drifted wording) → converged
  const converge = evaluateConsensus(
    [
      { agent: 'a', rootCause: 'missing-await', level: 'root-cause' },
      { agent: 'b', rootCause: 'Missing await', level: 'root-cause' }, // same after normalize
      { agent: 'c', rootCause: 'off-by-one', level: 'root-cause' },
    ],
    3,
  )
  assert(
    converge.kind === 'converged' && converge.votes === 2 && converge.rootCause === 'missing-await',
    'converged: 2/3 on one normalized root cause',
  )

  // 1 root cause + 2 still at symptoms → NOT converged (a lone voice doesn't win the panel)
  const split = evaluateConsensus(
    [
      { agent: 'a', rootCause: 'missing-await', level: 'root-cause' },
      { agent: 'b', rootCause: 'flaky timeout', level: 'symptom' },
      { agent: 'c', rootCause: 'flaky timeout', level: 'symptom' },
    ],
    3,
  )
  assert(split.kind === 'split', 'split: 1 root cause vs 2 symptoms does NOT converge')
  if (split.kind === 'split') eq(split.symptomOnly, 2, 'split reports 2 panelists still at symptoms')

  // tie between two root causes (no strict majority) → split
  const tie = evaluateConsensus(
    [
      { agent: 'a', rootCause: 'missing-await', level: 'root-cause' },
      { agent: 'b', rootCause: 'off-by-one', level: 'root-cause' },
    ],
    2,
  )
  assert(tie.kind === 'split', 'tie 1-1 does not converge (no strict majority)')

  // —— nextConsultStep state machine ——
  section('nextConsultStep')
  const p3 = planConsult(PROBLEM, ['a', 'b', 'c']) // maxRounds 2
  eq(
    nextConsultStep(converge, 1, p3),
    { kind: 'report', rootCause: 'missing-await' },
    'converged → report the root cause back to a coder',
  )
  eq(
    nextConsultStep(split, 1, p3),
    { kind: 'another-round' },
    'split with rounds left → another cross-examination round',
  )
  assert(
    nextConsultStep(split, 2, p3).kind === 'escalate',
    'split out of rounds → escalate to a human (北极星: 人是 Participant)',
  )

  // —— board round-trip + blind isolation ——
  section('consult-board')
  const dir = mkdtempSync(join(tmpdir(), 'gotong-consult-'))
  try {
    const board = setupConsultBoard(dir)
    const dx: Diagnosis = {
      agent: 'claude-code',
      rootCause: 'missing-await',
      level: 'root-cause',
      detail: 'handler resolves before the promise settles',
    }
    writeDiagnosis(board, dx)
    writeDiagnosis(board, {
      agent: 'codex',
      rootCause: 'test timeout too low',
      level: 'symptom',
      detail: 'bumped the timeout',
    })
    eq(readDiagnosis(board, 'claude-code'), dx, 'board round-trips a diagnosis (tag + level + detail)')
    eq(
      readAllDiagnoses(board).map((d) => d.agent),
      ['claude-code', 'codex'],
      'board reads every panelist back',
    )
    const peerView = formatPeerDiagnoses(board, 'claude-code')
    assert(
      peerView.includes('codex') && !peerView.includes('claude-code'),
      'peer view shows others, never self — the blind round stays blind by construction',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  section('done')
  console.log(
    `  ✅ consult core: ${checks} checks passed — panel/tally/state-machine + board round-trip\n`,
  )
}

try {
  main()
} catch (err) {
  console.error('\n[consult-core] ✗', (err as Error).message, '\n')
  process.exit(1)
}
