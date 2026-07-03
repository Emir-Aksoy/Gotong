/**
 * first-result-smoke.mjs — FUN-M2: the TTFR (time-to-first-result) 承重门.
 *
 * QUICKSTART.md step 1 makes ONE load-bearing promise: a fresh cloner runs
 * `pnpm demo` and — with NO api key and NO Docker — sees a real multi-participant
 * result in seconds. If that ever silently breaks (a core regression, a demo
 * rewrite, a build that no longer resolves), the whole onboarding funnel is a lie.
 *
 * This gate is that promise, mechanized. It spawns the EXACT command the doc tells
 * a newcomer to run (`pnpm demo` → the zero-key `hello-collab` hub), captures its
 * output, and asserts the semantic claims the QUICKSTART makes about it:
 *   - two agents AND a human joined the SAME hub (person = Participant — the North
 *     Star, not a "request-human" tool),
 *   - both agents produced results, the human received a task on the same rails,
 *   - a visible final result + approval landed,
 *   - and it all finished within a TTFR budget (catches a hang / infinite loop),
 *   - with the process exiting 0.
 *
 * Hermetic: it strips every *_API_KEY / provider var from the child's env, so a
 * green run PROVES the zero-key path — not "it worked because a key happened to be
 * set." No network, no spend.
 *
 * Run with:   pnpm check:first-result
 *             (needs a built workspace — run `pnpm build` first on a fresh clone,
 *              exactly as QUICKSTART step 1 says.)
 *
 * Exit codes: 0 = the first-result promise holds · 1 = it broke (with a report of
 *             which claim failed / whether it timed out / the child exit code).
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// The exact command QUICKSTART.md step 1 tells a newcomer to run.
const DEMO_CMD = 'pnpm'
const DEMO_ARGS = ['demo']

// TTFR budget: generous enough for a cold `tsx` + `pnpm` start on a slow CI box,
// tight enough to catch a hang or a broken demo. The demo's own scripted sleeps
// total ~1.4s; everything past that is process startup.
const BUDGET_MS = 90_000

// The load-bearing claims QUICKSTART step 1 makes, as stdout markers. Each is a
// DISTINCT promise, so a failure names exactly which part of the story broke.
const REQUIRED = [
  { re: /JOIN\s+writer .*caps=\[draft,revise\]/, claim: 'writer agent joined the hub' },
  { re: /JOIN\s+reviewer .*caps=\[review\]/, claim: 'reviewer agent joined the hub' },
  { re: /JOIN\s+alice \(human\)/, claim: 'a HUMAN joined the SAME hub as the agents (person = Participant)' },
  { re: /RESULT\s+ok by writer/, claim: 'the writer agent produced a result' },
  { re: /RESULT\s+ok by reviewer/, claim: 'the reviewer agent produced a result' },
  { re: /alice sees task "final approval"/, claim: 'the human received a task on the same rails as the agents' },
  { re: /=== final ===/, claim: 'a final result was printed' },
  { re: /approved:\s*true/, claim: 'the human approved → the first result is complete' },
]

/** Copy `env` minus anything that could hand the demo a real LLM key — so a pass
 *  proves the ZERO-KEY path, not an accidentally-keyed one. */
function stripKeys(env) {
  const clone = {}
  for (const [k, v] of Object.entries(env)) {
    if (/API_KEY|^OPENAI_|^ANTHROPIC_|^DEEPSEEK_|^AIPE_LIVE_/.test(k)) continue
    clone[k] = v
  }
  return clone
}

function runDemo() {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(DEMO_CMD, DEMO_ARGS, { cwd: repoRoot, env: stripKeys(process.env) })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    const killer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ timedOut: true, code: null, out, elapsed: Date.now() - started })
    }, BUDGET_MS)
    child.on('error', (err) => {
      clearTimeout(killer)
      resolve({ timedOut: false, code: null, spawnError: err, out, elapsed: Date.now() - started })
    })
    child.on('close', (code) => {
      clearTimeout(killer)
      resolve({ timedOut: false, code, out, elapsed: Date.now() - started })
    })
  })
}

console.log('AipeHub 首个结果自检 — TTFR 承重门 (`pnpm demo`, 零 key)\n')
const res = await runDemo()

const problems = []
if (res.spawnError) {
  problems.push(`无法启动 \`pnpm demo\`：${res.spawnError.message}（先 pnpm build?）`)
}
if (res.timedOut) {
  problems.push(`超时：${BUDGET_MS}ms 内没跑完（疑似卡住 / 死循环）`)
}
const missing = REQUIRED.filter((m) => !m.re.test(res.out))
for (const m of missing) problems.push(`缺少这一步：${m.claim}`)
// A clean demo `process.exit(0)`s; a non-zero code means it crashed even if some
// markers printed. Only assert this when the process actually returned a code.
if (!res.timedOut && !res.spawnError && res.code !== 0) {
  problems.push(`demo 退出码 ${res.code}（应为 0）`)
}

for (const m of REQUIRED) {
  const ok = m.re.test(res.out)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${m.claim}`)
}
console.log('')

if (problems.length > 0) {
  console.log(`✖ 首个结果承诺已破 — ${problems.length} 项：`)
  for (const p of problems) console.log(`   · ${p}`)
  if (res.out.trim()) {
    console.log('\n--- demo 输出(尾部)---')
    console.log(res.out.split('\n').slice(-25).join('\n'))
  }
  process.exit(1)
}

console.log(`✓ 首个结果在 ${Math.round(res.elapsed)}ms 内到达（预算 ${BUDGET_MS}ms）——零 key、零 Docker、确定性。`)
process.exit(0)
