/**
 * consult.real.ts — the REAL-run 会诊: drive real claude-code + codex as a
 * diagnostic panel over a REAL repo with a REAL failing test. The moderator, the
 * board, and the consensus core are byte-for-byte the same as the offline demo
 * (consult-demo.ts / consult-orchestrate.ts) — ONLY the panelists change, from the
 * scripted mock to real CLIs reading the actual code. That is the whole point of
 * CONSULT-M4: the blind→cross-examine→converge machinery is unchanged; what's new
 * is that real agents now produce the diagnoses.
 *
 * The one extra wire vs the mock: each panelist is handed `boardCardInstruction`
 * (the prompt-agreed card format) so a real CLI writes DIAGNOSIS/<agent>.md in the
 * exact shape the moderator parses back. The mock already knows that shape, so the
 * offline demo leaves it unset.
 *
 * Seeded bug (REAL, not described): `auth.js` fires an async token load but doesn't
 * await it, so `initSession` returns with `token: null`; `auth.test.mjs` is a real
 * `node --test` that fails on it. The panel reads both and diagnoses missing-await.
 *
 * Run (CHAIN SELF-CHECK — default, no key, stub panelists, deterministic ✅/❌):
 *   pnpm demo:personal-coding-hub:consult-real
 * Run (REAL — drives claude-code + codex under their OWN logins; spends / writes):
 *   CONSULT_REAL=1 pnpm demo:personal-coding-hub:consult-real
 *
 * The chain verdict asserts the PIPELINE RAN (every panelist put a parseable card on
 * the board AND the moderator reached a terminal step) — NOT which root cause it
 * landed on (real models vary; the mock demo is where the exact convergence is
 * pinned). Mirrors index.real.ts: assert the chain ran through, not the result.
 *
 * SAFETY: throwaway git repo, dangerousCommandGate on, each CLI sandboxed to the
 * workspace (claude --permission-mode acceptEdits, codex --sandbox workspace-write).
 */

import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hub, InMemoryStorage, type TaskId } from '@gotong/core'
import { CliParticipant, dangerousCommandGate, type CliChunk } from '@gotong/cli-agent'

import { setupSharedWorkspace, initGitRepo, type SharedWorkspace } from './workspace.js'
import { setupConsultBoard, readAllDiagnoses, boardCardInstruction } from './consult-board.js'
import { planConsult, type ConsultProblem } from './consult.js'
import { runConsult } from './consult-orchestrate.js'

const CONSULT_AGENT = fileURLToPath(new URL('./consult-agent.mjs', import.meta.url))

// The two real coders we actually have are the panel. A 2-agent panel is a valid
// 会诊 (planConsult needs ≥2); convergence then means BOTH agree (votes*2 > 2). The
// mock 'auth-flaky' script reaches that in the cross-examination round.
const PANEL = ['claude-code', 'codex']
const PROBLEM_ID = 'auth-flaky'

/** A real repo with a genuine missing-await bug + a real failing test to read. */
const BUGGY_AUTH = `// auth.js — a tiny session module with a REAL bug.
export async function loadToken(userId) {
  // Pretend this hits a token service; resolves a tick later.
  return new Promise((resolve) => setTimeout(() => resolve(\`tok-\${userId}\`), 5))
}

export function initSession(userId) {
  const session = { userId, token: null }
  // BUG: the promise is fired but NOT awaited, so initSession returns while token
  // is still null. Callers occasionally read a half-initialised session.
  loadToken(userId).then((t) => {
    session.token = t
  })
  return session
}
`

const FAILING_TEST = `// auth.test.mjs — a real \`node --test\` that fails on the missing await.
import { test } from 'node:test'
import assert from 'node:assert'
import { initSession } from './auth.js'

test('initSession returns a session whose token is loaded', () => {
  const s = initSession('u1')
  // Fails: token is null because initSession did not await loadToken.
  assert.equal(s.token, 'tok-u1')
})
`

async function main(): Promise<void> {
  const real = process.env.CONSULT_REAL === '1'
  const stub = !real

  console.log('\n=== personal-coding-hub — 会诊 REAL chain test ===')
  console.log(`  panel  : ${PANEL.join(' + ')}`)
  console.log(
    `  agents : ${stub ? 'in-process stand-ins (default — set CONSULT_REAL=1 for real CLIs)' : 'claude-code + codex (各自 CLI 登录, 不注入 key)'}`,
  )

  const dir = mkdtempSync(join(tmpdir(), 'gotong-consult-real-'))
  const ws = setupSharedWorkspace(dir)
  initGitRepo(dir) // so the real CLIs don't print `fatal: not a git repository`
  // Seed the REAL bug + REAL failing test the panel reads.
  writeFileSync(join(ws.dir, 'auth.js'), BUGGY_AUTH)
  writeFileSync(join(ws.dir, 'auth.test.mjs'), FAILING_TEST)
  const board = setupConsultBoard(ws.dir)

  const problem: ConsultProblem = {
    symptom: 'auth session init test fails — initSession returns a session whose token is null',
    evidence: '`node --test auth.test.mjs` fails: expected "tok-u1", got null. Read auth.js and auth.test.mjs.',
  }
  console.log(`  bug    : auth.js initSession() — token null at return`)
  console.log(`  repo   : ${ws.dir}\n`)

  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()
  for (const id of PANEL) hub.register(makeDiagnostician(id, ws, stub))

  let chainOk = false
  try {
    const plan = planConsult(problem, PANEL)
    const result = await runConsult(hub, board, problem, plan, {
      problemId: PROBLEM_ID,
      log: (m) => console.log(m),
      // Real CLIs need the card path + format; the stub already knows it (harmless if
      // it ignores the extra lines), so passing it in both modes keeps one wire.
      cardInstruction: boardCardInstruction,
    })

    const cards = readAllDiagnoses(board)
    console.log('\n── consult board (DIAGNOSIS/*.md) ' + '─'.repeat(24))
    for (const name of existsSync(board.dir) ? readdirSync(board.dir).sort() : []) {
      if (!name.endsWith('.md')) continue
      console.log(`\n  ┌─ ${name}`)
      for (const line of readFileSync(join(board.dir, name), 'utf8').trimEnd().split('\n')) {
        console.log(`  │ ${line}`)
      }
    }

    if (result.step.kind === 'report') {
      console.log(`\n  会诊收敛 (${result.rounds} 轮) → 真实根因: ${result.step.rootCause} → 交回 coder 修`)
    } else if (result.step.kind === 'escalate') {
      console.log(`\n  会诊不收敛 (${result.rounds} 轮) → 升级给人裁决`)
    }

    // CHAIN-TEST verdict — the pipeline RAN THROUGH: every panelist put a parseable
    // card on the board AND the moderator reached a terminal step (report / escalate).
    // We do NOT assert which root cause (that's the mock demo's job).
    const terminal = result.step.kind === 'report' || result.step.kind === 'escalate'
    chainOk = cards.length >= PANEL.length && terminal
    const who = stub ? 'stand-in panel' : '真 CLI 面板'
    console.log(
      chainOk
        ? `\n  ✅ 链条跑通: ${who} → ${cards.length}/${PANEL.length} 份诊断上板 → 主持收敛/升级 → 回报`
        : `\n  ❌ 链条未跑通 (诊断 ${cards.length}/${PANEL.length}, 终态=${terminal})`,
    )
  } finally {
    await hub.stop()
    console.log(`\n  workspace kept at: ${ws.dir}`)
  }
  process.exit(chainOk ? 0 : 1)
}

/**
 * One diagnostic panelist. `stub` → the in-process mock (consult-agent.mjs, keys on
 * PROBLEM-ID, no spend). Otherwise the REAL CLI under its OWN login (we inject NO
 * key), sandboxed to the workspace, with the Claude Code nesting markers scrubbed so
 * a child `claude` driven from a Claude Code session still runs. Plain CliParticipant
 * (not SharedWorkspaceCli): a panelist writes a DIAGNOSIS card, it does NOT touch the
 * coder's PROGRESS.md.
 */
function makeDiagnostician(id: string, ws: SharedWorkspace, stub: boolean): CliParticipant {
  const spec = stub
    ? { command: process.execPath, args: [CONSULT_AGENT, '--agent', id, '--prompt', '{prompt}'] }
    : id === 'claude-code'
      ? { command: 'claude', args: ['-p', '{prompt}', '--permission-mode', 'acceptEdits'] }
      : { command: 'codex', args: ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '{prompt}'] }
  return new CliParticipant({
    id,
    capabilities: ['diagnose'],
    command: spec.command,
    args: spec.args,
    promptVia: 'arg',
    cwd: ws.dir,
    env: stub ? undefined : { CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CLAUDE_CODE_SSE_PORT: undefined },
    gate: dangerousCommandGate(),
    timeoutMs: 240_000,
    onChunk: (_taskId: TaskId, chunk: CliChunk) => process.stdout.write(`        │ ${chunk.text.replace(/\n+$/, '')}\n`),
  })
}

main().catch((err) => {
  console.error('[consult real] fatal:', err)
  process.exit(1)
})
