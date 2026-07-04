/**
 * consult demo — the full 会诊: a real Hub, three mock diagnostic agents on a
 * shared repo, and the moderator running blind diagnosis → cross-examination →
 * converge / escalate. Deterministic, no API key — but the BOARD is real (real
 * DIAGNOSIS/<agent>.md files in a real temp workspace). Each scenario asserts the
 * OUTCOME: the root cause the panel converged on, or that it escalated to a human.
 *
 * Why a panel (over a single agent reading the code):
 *   · blind round   — each agent diagnoses ALONE first, so a confident-but-wrong
 *                     first voice can't anchor the others (避免从众);
 *   · cross-examine — agents then read each other's findings and rebut, which is
 *                     how a panelist stuck on a SYMPTOM upgrades to the ROOT CAUSE;
 *   · converge      — a majority of the PANEL on one root-cause tag = report it
 *                     back to a coder; a genuine deadlock escalates to a human.
 *
 * To drive REAL diagnostic agents, swap makeDiagnostician's mock command for a
 * CLI_PRESETS coder (claude-code / codex) reading the real failing test — the
 * moderator + board + consensus logic are unchanged (that's CONSULT-M4).
 *
 * Run:  pnpm demo:personal-coding-hub:consult
 */

import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, InMemoryStorage } from '@gotong/core'
import { CliParticipant, dangerousCommandGate } from '@gotong/cli-agent'

import { setupSharedWorkspace, type SharedWorkspace } from './workspace.js'
import { setupConsultBoard } from './consult-board.js'
import { planConsult, type ConsultProblem } from './consult.js'
import { runConsult } from './consult-orchestrate.js'

const CONSULT_AGENT = fileURLToPath(new URL('./consult-agent.mjs', import.meta.url))

// The panel: the two coders (claude-code / codex) + a third reviewer lens, so the
// demo shows a 2/3 majority forming under cross-examination — more of a 会诊 than a
// 1-1 pair. The mock agents disagree by design in round 1.
const PANEL = ['claude-code', 'codex', 'reviewer']

interface Scenario {
  label: string
  problemId: string
  problem: ConsultProblem
  expect: { kind: 'report'; rootCause: string } | { kind: 'escalate' }
}

const SCENARIOS: Scenario[] = [
  {
    label: '[A] 收敛 — 盲诊分歧, 质证后收敛到真实根因',
    problemId: 'auth-flaky',
    problem: {
      symptom: 'auth integration test flakes intermittently',
      evidence: 'fails ~1 in 5 runs, no stack trace',
    },
    // claude-code sees missing-await (root); codex stops at flaky-timeout (symptom);
    // reviewer guesses race-condition (root). Under cross-examination the
    // missing-await evidence wins — codex upgrades symptom→root, reviewer changes
    // its call → 3/3 on missing-await.
    expect: { kind: 'report', rootCause: 'missing-await' },
  },
  {
    label: '[B] 不收敛 — 各执己见, 升级给人裁决',
    problemId: 'cache-bug',
    problem: {
      symptom: 'users occasionally see another tenant cached data',
      evidence: 'rare, only under load',
    },
    // Three different confident root causes, nobody convinced by the others →
    // stays split across both rounds → the moderator escalates to a human.
    expect: { kind: 'escalate' },
  },
]

async function main(): Promise<void> {
  console.log('\n=== Gotong case: personal-coding-hub — 会诊 (multi-agent consult) ===')
  console.log('  发现问题 → 一起读 → 各自盲诊 → 相互质证 → 收敛到真实根因 / 升级给人。\n')

  for (const s of SCENARIOS) await runScenario(s)

  section('done')
  console.log('  盲诊先各看各的(避免从众), 质证再碰撞(症状→根因);')
  console.log('  多数收敛就把真实根因交回 coder 修, 不收敛就升级给人裁决(真实部署写入 /me 收件箱)。\n')
  process.exit(0)
}

async function runScenario(s: Scenario): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gotong-consult-'))
  const ws = setupSharedWorkspace(dir)
  const board = setupConsultBoard(ws.dir)
  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()
  for (const id of PANEL) hub.register(makeDiagnostician(id, ws))

  try {
    section(s.label)
    console.log(`  问题: ${s.problem.symptom}`)
    const plan = planConsult(s.problem, PANEL)
    const result = await runConsult(hub, board, s.problem, plan, {
      problemId: s.problemId,
      log: (m) => console.log(m),
    })

    if (result.step.kind === 'report') {
      console.log(`  ✅ 会诊收敛 (${result.rounds} 轮) → 真实根因: ${result.step.rootCause} → 交回 coder 修`)
    } else if (result.step.kind === 'escalate') {
      console.log(`  ⚠ 会诊不收敛 (${result.rounds} 轮) → 升级给人裁决 (真实部署写入 /me 收件箱)`)
    }

    // Assert the outcome the panel reached.
    if (s.expect.kind === 'report') {
      if (result.step.kind !== 'report' || result.step.rootCause !== s.expect.rootCause) {
        throw new Error(`[${s.label}] expected report ${s.expect.rootCause}, got ${JSON.stringify(result.step)}`)
      }
    } else if (result.step.kind !== 'escalate') {
      throw new Error(`[${s.label}] expected escalate, got ${JSON.stringify(result.step)}`)
    }
  } finally {
    await hub.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A diagnostic panelist — a plain CliParticipant pointed at the shared repo. It
 * reads the problem from its prompt and writes DIAGNOSIS/<agent>.md (NOT the
 * coder's PROGRESS.md), so blind writes never collide. dangerousCommandGate is
 * house style for any spawned CLI agent; the fixed argv here never trips it.
 */
function makeDiagnostician(id: string, ws: SharedWorkspace): CliParticipant {
  return new CliParticipant({
    id,
    capabilities: ['diagnose'],
    command: process.execPath,
    args: [CONSULT_AGENT, '--agent', id, '--prompt', '{prompt}'],
    promptVia: 'arg',
    cwd: ws.dir,
    gate: dangerousCommandGate(),
    onChunk: (_taskId, chunk) => process.stdout.write(`        │ ${chunk.text.trimEnd()}\n`),
  })
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main().catch((err) => {
  console.error('[consult] fatal:', err)
  process.exit(1)
})
