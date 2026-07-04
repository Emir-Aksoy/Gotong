/**
 * consult-flow demo — the 会诊 WIRED INTO the personal-coding-hub flow, on the two
 * triggers the user picked: an explicit "会诊" ask, and a failing test. Either one
 * convenes the panel (blind → cross-examine → converge); the real root cause then
 * flows back to a coder as a fix — and the fix targeting THAT root cause is what
 * makes the test pass. Deterministic, no API key.
 *
 * The dev agents here both CODE and DIAGNOSE — a real Claude Code / Codex does
 * both. The discriminator is the prompt: a diagnose task carries `PROBLEM-ID:`
 * (the moderator builds it), so the agent writes its card to the consult board;
 * any other task is coding, so it goes through the shared-workspace path and
 * appends to PROGRESS.md. One participant per agent → no id collision between the
 * panel and the coders (they ARE the same agents).
 *
 * The "test" is modelled deterministically: a fix passes iff it addresses the
 * ground-truth root cause. The first generic attempt does NOT → tests fail → the
 * panel is convened → it converges on the REAL cause → the fix targeting it makes
 * tests pass. That arc is the whole point: the panel found what a blind first
 * attempt missed.
 *
 * Run:  pnpm demo:personal-coding-hub:consult-flow
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, InMemoryStorage, type Task } from '@gotong/core'
import { payloadToText, dangerousCommandGate } from '@gotong/cli-agent'

import { SharedWorkspaceCli } from './shared-workspace-cli.js'
import { setupSharedWorkspace, type SharedWorkspace } from './workspace.js'
import { setupConsultBoard, readAllDiagnoses } from './consult-board.js'
import { planConsult, type ConsultProblem } from './consult.js'
import { runConsult } from './consult-orchestrate.js'
import { parseConsultRequest, planRoute } from './routing.js'

const execFileP = promisify(execFile)
const MOCK_CODER = fileURLToPath(new URL('./mock-coder.mjs', import.meta.url))
const CONSULT_AGENT = fileURLToPath(new URL('./consult-agent.mjs', import.meta.url))

// The panel = the two coders + a reviewer lens; they form a 2/3-majority 会诊.
const PANEL = ['claude-code', 'codex', 'reviewer']
const FIX_CODER = 'claude-code'

/**
 * A dev agent that both codes and diagnoses. A diagnose task (PROBLEM-ID in the
 * prompt) runs the consult-agent mock, which writes DIAGNOSIS/<agent>.md in the
 * shared cwd; any other task is the shared-workspace coder path (appends to
 * PROGRESS.md). Same participant id for both, so the panel and the coders never
 * collide — they are the same agents.
 */
class DevCli extends SharedWorkspaceCli {
  constructor(
    private readonly agentId: string,
    private readonly consultAgentPath: string,
    private readonly workdir: string,
    opts: ConstructorParameters<typeof SharedWorkspaceCli>[0],
  ) {
    super(opts)
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const prompt = payloadToText(task.payload)
    if (prompt.includes('PROBLEM-ID:')) {
      // Diagnose: the consult-agent mock writes the board card itself (cwd-relative).
      await execFileP(process.execPath, [this.consultAgentPath, '--agent', this.agentId, '--prompt', prompt], {
        cwd: this.workdir,
      })
      return { text: `${this.agentId} wrote a diagnosis` }
    }
    // Code / fix: the shared-workspace path (wraps with AGENTS.md + PROGRESS.md).
    return super.handleTask(task)
  }
}

type Trigger = 'explicit' | 'test-failure' | 'none'

interface FlowScenario {
  label: string
  goal: string
  /** Drives the mock panel's scripts (which root cause the agents converge on). */
  problemId: string
  /** The tag a fix must address for the (modelled) test to pass. */
  groundTruth: string
  expect: { trigger: Trigger; rootCause?: string }
}

const SCENARIOS: FlowScenario[] = [
  {
    label: '[A] 显式「会诊」触发 — 用户直接要求会诊',
    goal: '会诊一下:auth 集成测试为什么总是间歇性 flaky?',
    problemId: 'auth-flaky',
    groundTruth: 'missing-await',
    expect: { trigger: 'explicit', rootCause: 'missing-await' },
  },
  {
    label: '[B] 测试失败触发 — 一次实现没过测试, 自动发起会诊',
    goal: '实现 auth 会话初始化逻辑',
    problemId: 'auth-flaky',
    groundTruth: 'missing-await',
    expect: { trigger: 'test-failure', rootCause: 'missing-await' },
  },
  {
    label: '[C] 一次通过 — 不触发会诊 (触发是有选择的)',
    goal: '补上 parse() 里缺的 null-check',
    problemId: 'auth-flaky',
    groundTruth: 'null-check',
    expect: { trigger: 'none' },
  },
]

async function main(): Promise<void> {
  console.log('\n=== Gotong case: personal-coding-hub — 会诊触发 (consult, wired into the flow) ===')
  console.log('  显式「会诊」或测试失败 → 发起会诊 → 找真实根因 → 交回 coder 修 → 测试通过。\n')

  // parseConsultRequest coverage (pure, cheap) — the explicit trigger detector.
  assertParse('会诊一下这个 flaky 测试', true)
  assertParse('consult the panel on the timeout', true)
  assertParse('找根因:为什么登录偶发失败', true)
  assertParse('实现登录按钮', false)

  for (const s of SCENARIOS) await runScenario(s)

  section('done')
  console.log('  触发是有选择的:一次过的任务不打扰;真出问题(显式要求 / 测试失败)才会诊。')
  console.log('  会诊不停在症状, 收敛到真实根因再交回 coder —— 针对根因的修复让测试转绿。\n')
  process.exit(0)
}

async function runScenario(s: FlowScenario): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gotong-consult-flow-'))
  const ws = setupSharedWorkspace(dir)
  const board = setupConsultBoard(ws.dir)
  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()
  for (const id of PANEL) hub.register(makeDevAgent(id, ws))

  try {
    section(s.label)
    console.log(`  goal: ${s.goal}`)

    const req = parseConsultRequest(s.goal)
    let trigger: Trigger
    let problem: ConsultProblem | undefined

    if (req.consult) {
      trigger = 'explicit'
      console.log(`  🔔 显式「会诊」触发 — 症状: ${req.symptom}`)
      problem = { symptom: req.symptom ?? s.goal }
    } else {
      // Normal coding attempt first, then run the (modelled) tests.
      const plan = planRoute(s.goal)
      const coder = plan.agents[0] ?? FIX_CODER
      console.log(`  🧭 路由首次尝试 → ${coder}`)
      await dispatchCode(hub, coder, s.goal)
      const before = runTests(ws, s.groundTruth)
      console.log(`  🧪 跑测试 → ${before}`)
      if (before === 'pass') {
        trigger = 'none'
        console.log('  ✅ 一次通过 — 无需会诊')
      } else {
        trigger = 'test-failure'
        console.log('  🔔 测试失败触发 — 自动发起会诊找真实根因')
        problem = { symptom: `tests fail after: ${s.goal}`, evidence: 'the auth test still flakes' }
      }
    }

    let reportedRoot: string | undefined
    if (problem) {
      const plan = planConsult(problem, PANEL)
      const result = await runConsult(hub, board, problem, plan, { problemId: s.problemId, log: (m) => console.log(m) })
      if (result.step.kind === 'report') {
        reportedRoot = result.step.rootCause
        console.log(`  ✅ 会诊收敛 → 真实根因: ${reportedRoot} → 交回 ${FIX_CODER} 修`)
        await dispatchCode(hub, FIX_CODER, `Fix the root cause: ${reportedRoot} — make the auth test pass.`)
        const after = runTests(ws, s.groundTruth)
        console.log(`  🧪 修复后跑测试 → ${after}`)
        if (after !== 'pass') throw new Error(`[${s.label}] fix targeting ${reportedRoot} did not turn the test green`)
      } else {
        console.log('  ⚠ 会诊不收敛 → 升级给人裁决')
      }
    }

    // —— assertions ——
    if (trigger !== s.expect.trigger) {
      throw new Error(`[${s.label}] expected trigger ${s.expect.trigger}, got ${trigger}`)
    }
    if (s.expect.rootCause) {
      if (reportedRoot !== s.expect.rootCause) {
        throw new Error(`[${s.label}] expected root cause ${s.expect.rootCause}, got ${reportedRoot ?? '(none)'}`)
      }
    } else if (readAllDiagnoses(board).length) {
      throw new Error(`[${s.label}] expected NO consult, but the panel wrote ${readAllDiagnoses(board).length} diagnoses`)
    }
  } finally {
    await hub.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Dispatch a coding task to one coder (no PROBLEM-ID → the dev agent codes). */
async function dispatchCode(hub: Hub, coder: string, goal: string): Promise<void> {
  const r = await hub.dispatch({
    from: 'consult-flow',
    strategy: { kind: 'explicit', to: coder },
    payload: { prompt: goal },
    title: `code ${coder}`,
  })
  if (r.kind !== 'ok') throw new Error(`code dispatch to ${coder} failed: ${JSON.stringify(r)}`)
}

/**
 * The (modelled) test suite: a fix passes iff the work addresses the ground-truth
 * root cause. The first generic attempt doesn't mention it → fail; a fix targeting
 * the panel's reported root cause does → pass. Deterministic and inspectable.
 */
function runTests(ws: SharedWorkspace, groundTruth: string): 'pass' | 'fail' {
  const logFile = join(ws.dir, 'work.log')
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  return log.includes(groundTruth) ? 'pass' : 'fail'
}

function makeDevAgent(id: string, ws: SharedWorkspace): DevCli {
  return new DevCli(id, CONSULT_AGENT, ws.dir, {
    id,
    capabilities: ['code', 'diagnose'],
    command: process.execPath,
    args: [MOCK_CODER, '--agent', id, '--prompt', '{prompt}'],
    promptVia: 'arg',
    cwd: ws.dir,
    gate: dangerousCommandGate(),
  })
}

let parseChecks = 0
function assertParse(goal: string, want: boolean): void {
  const got = parseConsultRequest(goal).consult
  if (got !== want) throw new Error(`parseConsultRequest("${goal}") → ${got}, want ${want}`)
  parseChecks++
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main().catch((err) => {
  console.error('[consult-flow] fatal:', err)
  process.exit(1)
})
