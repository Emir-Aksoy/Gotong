#!/usr/bin/env node
/**
 * Full HITL E2E for the personal-growth interviewer.
 *
 *   1. Lift real DeepSeek key from .aipehub-demo (programmatic, no log).
 *   2. mkdir fresh space, Space.init, mint admin token.
 *   3. spawn host child process.
 *   4. POST /api/admin/bundles/import (7 agents + workflow + key).
 *   5. Dispatch the workflow with DELIBERATELY MINIMAL user input —
 *      the kind of single-sentence reply the interviewer should NOT
 *      have enough info to portrait on. Expectation: the interviewer
 *      emits `<NEED_INPUT>{...}</NEED_INPUT>` → the agent's HITL hook
 *      dispatches an admin task → /api/admin/state shows that task
 *      with payload.kind === 'agent-question'.
 *   6. Submit answers via POST /api/tasks/<id>/complete (the same
 *      endpoint the admin UI uses).
 *   7. Verify workflow continues past the portrait step (interviewer
 *      re-runs LLM with merged answers).
 *   8. Tear down.
 *
 * The most important assertion: the agent-question task exists with
 * the right shape. The downstream "workflow completes successfully
 * after answers" is a bonus — the unblocking path is the critical
 * piece this test pins.
 *
 * Cost: ~2-3 DeepSeek calls (first round + maybe synthesist). We
 * abort the workflow once the portrait completes to avoid running
 * the full 7-step chain twice.
 */

import { mkdirSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'

const SPACE_DIR = join(tmpdir(), 'aipehub-hitl-' + Date.now())
const DEMO_SPACE = resolve('.aipehub-demo')
const WEB_PORT = 3731
const WS_PORT = 4731
const BUNDLE_PATH = resolve('templates/bundles/personal-growth.yaml')

let failures = 0
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  -- ' + detail : ''))
  if (!ok) failures++
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts)
  let body
  try { body = await r.json() } catch { body = null }
  return { status: r.status, body }
}

// ── 1. lift DeepSeek key ───────────────────────────────────────────────
const { Space } = await import('../packages/core/dist/index.js')
const demo = await Space.openOrInit(DEMO_SPACE, { name: 'demo' })
const deepseekKey = await demo.space.getAgentApiKey('deepseek-writer')
if (!deepseekKey || deepseekKey.length < 10) {
  console.error('FATAL: no DeepSeek key in .aipehub-demo')
  process.exit(2)
}

// ── 2-3. fresh space + admin ──────────────────────────────────────────
mkdirSync(SPACE_DIR, { recursive: true })
const init = await Space.init(SPACE_DIR, { name: 'hitl-e2e' })
// Space.createAdmin returns { admin: AdminRecord, token }. The admin
// record's `id` is the canonical ParticipantId used by the Hub —
// `$trigger.from` will resolve to exactly this string.
const { admin, token } = await init.space.createAdmin('hitl-admin')
const adminId = admin.id
console.log('fresh space: ' + SPACE_DIR)
console.log('admin id: ' + adminId)

// ── 4. boot host ──────────────────────────────────────────────────────
const hostProc = spawn(
  'pnpm',
  ['exec', 'tsx', 'src/main.ts'],
  {
    cwd: resolve('packages/host'),
    env: {
      ...process.env,
      AIPE_SPACE: SPACE_DIR,
      AIPE_WEB_PORT: String(WEB_PORT),
      AIPE_WS_PORT: String(WS_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let hostLog = ''
hostProc.stdout.on('data', (c) => { hostLog += c.toString() })
hostProc.stderr.on('data', (c) => { hostLog += c.toString() })

const t0 = Date.now()
while (!/listening.*"url":"http:\/\/127\.0\.0\.1:/.test(hostLog)) {
  if (Date.now() - t0 > 30_000) {
    console.log('---HOST LOG---'); console.log(hostLog)
    hostProc.kill('SIGTERM')
    throw new Error('host did not become ready in 30s')
  }
  await sleep(300)
}
console.log('host ready in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's')

const BASE = 'http://127.0.0.1:' + WEB_PORT
const H = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }

try {
  // ── 5. import bundle ──────────────────────────────────────────────
  const yaml = readFileSync(BUNDLE_PATH, 'utf8')
  let r = await fetchJson(BASE + '/api/admin/bundles/import', {
    method: 'POST', headers: H,
    body: JSON.stringify({ yaml, apiKey: deepseekKey }),
  })
  check('bundle import 200', r.status === 200,
    JSON.stringify(r.body).slice(0, 200))
  check('7 agents created', r.body?.team?.created?.length === 7)
  await sleep(1500)

  // ── 6. dispatch with DELIBERATELY MINIMAL user input ──────────────
  // Each field is single-sentence / vague. The interviewer SHOULD
  // emit a NEED_INPUT block because there's no age, no daily shape,
  // no relationship context, no concrete event.
  const minimalPayload = {
    case_id: 'self',
    present_state: '挺累的,最近半年都这样。',
    aspirations: '想活得更轻松一点。',
    struggles: '总是拖延。',
    focus_request: '帮我看看。',
  }
  r = await fetchJson(BASE + '/api/admin/dispatch', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      strategy: { kind: 'capability', capabilities: ['plan-personal-growth'] },
      payload: minimalPayload,
      title: 'HITL E2E minimal input',
    }),
  })
  check('dispatch 200', r.status === 200 && r.body?.ok === true,
    JSON.stringify(r.body).slice(0, 200))
  console.log('  workflow dispatched — polling for agent-question task...')

  // ── 7. poll for the agent-question task ───────────────────────────
  // Up to 60s — first LLM call (interviewer) usually returns in
  // 15-30s on DeepSeek flash with this short input.
  let questionTask = null
  const pollStart = Date.now()
  while (Date.now() - pollStart < 60_000) {
    const sres = await fetchJson(BASE + '/api/state', { headers: H })
    const tasks = sres.body?.tasks || []
    const aq = tasks.find(
      (v) =>
        v.status === 'pending' &&
        v.task?.payload &&
        typeof v.task.payload === 'object' &&
        v.task.payload.kind === 'agent-question',
    )
    if (aq) { questionTask = aq; break }
    await sleep(3000)
  }
  const elapsed1 = ((Date.now() - pollStart) / 1000).toFixed(0)
  check('agent-question task surfaced within 60s', questionTask !== null,
    'elapsed ' + elapsed1 + 's')
  if (!questionTask) {
    // Dump the last 3 KB of host log to help diagnose what happened
    // and let the test fall through to its tear-down. (Top-level
    // module — can't `return` here; the remaining checks would just
    // throw on questionTask.task accesses, so we early-skip them.)
    console.log('---HOST LOG TAIL---')
    console.log(hostLog.slice(-3000))
  } else {
  const payload = questionTask.task.payload
  check('payload.kind == agent-question', payload.kind === 'agent-question')
  check('payload.fromAgent is growth-interviewer',
    payload.fromAgent === 'growth-interviewer',
    'got ' + payload.fromAgent)
  check('payload.questions is non-empty array',
    Array.isArray(payload.questions) && payload.questions.length > 0,
    'got ' + JSON.stringify(payload.questions)?.slice(0, 100))
  check('payload.questions ≤ 3 (hard cap)',
    payload.questions.length <= 3,
    'got ' + payload.questions.length)
  for (const q of payload.questions) {
    check(`question '${q.id}' has id+label+type`,
      typeof q.id === 'string' && q.id.length > 0 &&
      typeof q.label === 'string' && q.label.length > 0 &&
      typeof q.type === 'string',
      JSON.stringify(q).slice(0, 120))
  }
  check('task title mentions interviewer',
    typeof questionTask.task.title === 'string' &&
    /访谈|问|了解/.test(questionTask.task.title),
    'got ' + questionTask.task.title)
  check('task assigned to triggering admin',
    questionTask.task.strategy.kind === 'explicit' &&
    questionTask.task.strategy.to === adminId,
    JSON.stringify(questionTask.task.strategy))

  // ── 8. submit answers — same endpoint the admin UI uses ───────────
  const answers = {}
  for (const q of payload.questions) {
    // Synthesize plausible answers for whatever the interviewer
    // asked. These shouldn't be tied to specific question IDs (the
    // LLM picks IDs freely), so we give a generic detailed reply
    // for each.
    answers[q.id] = `(模拟回答) 34 岁产品经理,每天 10 小时工作,1 点睡 7 点起。和妻子住在城市,半年见父母一次。`
  }
  r = await fetchJson(BASE + '/api/tasks/' + encodeURIComponent(questionTask.id) + '/complete', {
    method: 'POST', headers: H,
    body: JSON.stringify({ output: { answers } }),
  })
  check('POST /complete returns 200', r.status === 200 && r.body?.ok === true,
    JSON.stringify(r.body).slice(0, 200))

  // ── 9. verify the interviewer re-runs (workflow advances) ─────────
  // After the human task completes, the agent's nested-dispatch
  // resolves with the answers; the agent calls LLM again with the
  // Q&A block; the portrait step finishes; workflow moves to step 2
  // (body coach). Poll the per-run detail endpoint — `steps[]`
  // gives us authoritative "portrait done? next step started?"
  // signal without grepping host stderr.
  let runIdMatch = null
  const summary0 = await fetchJson(BASE + '/api/admin/workflows/runs', { headers: H })
  runIdMatch = summary0.body?.runs?.[0]?.runId
  let portraitDone = false
  const pollStart2 = Date.now()
  while (runIdMatch && Date.now() - pollStart2 < 120_000) {
    const rr = await fetchJson(
      BASE + '/api/admin/workflows/runs/' + encodeURIComponent(runIdMatch),
      { headers: H },
    )
    const steps = rr.body?.run?.steps || rr.body?.steps || []
    const portrait = steps.find((s) => s.stepId === 'portrait')
    if (portrait && portrait.status === 'done') {
      portraitDone = true
      break
    }
    if (rr.body?.run?.status === 'done' || rr.body?.status === 'done') {
      portraitDone = true
      break
    }
    await sleep(3000)
  }
  const elapsed2 = ((Date.now() - pollStart2) / 1000).toFixed(0)
  check('portrait step finished after HITL answer (workflow advanced)',
    portraitDone, 'elapsed ' + elapsed2 + 's, runId=' + runIdMatch)

  // ── 10. verify the host log shows the interviewer's second round ─
  check('host log shows "second-round completed with human input"',
    /interviewer second-round completed/.test(hostLog),
    hostLog.match(/interviewer.*second/)?.[0])
  } // end else
} finally {
  hostProc.kill('SIGTERM')
  await sleep(800)
  try { rmSync(SPACE_DIR, { recursive: true, force: true }) } catch {}
  console.log('cleaned up ' + SPACE_DIR)
}

console.log('')
if (failures === 0) {
  console.log('ALL PASS — HITL: interviewer pauses → admin answers → workflow advances')
  process.exit(0)
} else {
  console.log('FAILED — ' + failures + ' assertion(s)')
  process.exit(1)
}
