#!/usr/bin/env node
/**
 * Full fresh-space E2E for a brand-new user.
 *
 *   1. Pull a real DeepSeek key out of ./.aipehub-demo programmatically
 *      (never logged — flows secret-store → secret-store).
 *   2. mkdir an empty $TMPDIR/aipehub-e2e-* space.
 *   3. Space.init → mint admin token.
 *   4. spawn host child process pointed at the empty space.
 *   5. POST /api/admin/bundles/import with templates/bundles/personal-growth.yaml
 *      + the real key (the same path the admin UI's "🎁 用内置模板" button
 *      exercises).
 *   6. POST /api/admin/dispatch capability=plan-personal-growth with a
 *      realistic 4-段自述 payload.
 *   7. Poll /api/admin/workflows/runs until the run is finished (~3.5min
 *      for 7 LLM steps).
 *   8. Verify GET /api/admin/growth-reports lists 1 report; download it
 *      and sanity-check size + section headers.
 *   9. Tear down host + delete space.
 *
 * This is the "would a brand-new user actually get a usable report?" test.
 * It consumes ONE DeepSeek call sequence (~7 steps, ~0.05 USD on flash).
 */

import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

const SPACE_DIR = join(tmpdir(), 'aipehub-e2e-' + Date.now())
const DEMO_SPACE = resolve('.aipehub-demo')
const WEB_PORT = 3631
const WS_PORT = 4631
const BUNDLE_PATH = resolve('templates/bundles/personal-growth.yaml')
const RUN_TIMEOUT_MS = 8 * 60 * 1000  // 8 min ceiling

let failures = 0
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  -- ' + detail : ''))
  if (!ok) failures++
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts)
  let body
  try { body = await r.json() } catch { body = null }
  return { status: r.status, body }
}

// ── 1. lift DeepSeek key out of demo space (never logged) ─────────────
const { Space } = await import('../packages/core/dist/index.js')
const demo = await Space.openOrInit(DEMO_SPACE, { name: 'demo' })
const deepseekKey = await demo.space.getAgentApiKey('deepseek-writer')
if (!deepseekKey || deepseekKey.length < 10) {
  console.error('FATAL: no DeepSeek key in .aipehub-demo/deepseek-writer — seed it first')
  process.exit(2)
}
console.log('lifted DeepSeek key from demo space (length ' + deepseekKey.length + ')')

// ── 2-3. fresh space + admin ──────────────────────────────────────────
mkdirSync(SPACE_DIR, { recursive: true })
console.log('fresh space: ' + SPACE_DIR)
const initRes = await Space.init(SPACE_DIR, { name: 'fresh-e2e' })
const { token } = await initRes.space.createAdmin('e2e-admin')
console.log('admin token minted (length ' + token.length + ')')

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
hostProc.stdout.on('data', (chunk) => { hostLog += chunk.toString() })
hostProc.stderr.on('data', (chunk) => { hostLog += chunk.toString() })

const startBoot = Date.now()
while (!/listening.*"url":"http:\/\/127\.0\.0\.1:/.test(hostLog)) {
  if (Date.now() - startBoot > 30_000) {
    console.log('---HOST LOG---'); console.log(hostLog)
    hostProc.kill('SIGTERM')
    throw new Error('host did not become ready in 30s')
  }
  await sleep(300)
}
console.log('host ready in ' + ((Date.now() - startBoot) / 1000).toFixed(1) + 's')

const BASE = 'http://127.0.0.1:' + WEB_PORT
const H = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }

try {
  // ── 5. import bundle with real key ──────────────────────────────────
  const yaml = readFileSync(BUNDLE_PATH, 'utf8')
  console.log('importing bundle...')
  let r = await fetchJson(BASE + '/api/admin/bundles/import', {
    method: 'POST', headers: H,
    body: JSON.stringify({ yaml, apiKey: deepseekKey }),
  })
  check('bundle import 200', r.status === 200, JSON.stringify(r.body).slice(0, 200))
  check('7 agents created', r.body?.team?.created?.length === 7)
  check('workflow registered', r.body?.workflow?.id === 'personal-growth-flow')
  check('no spawn errors', !r.body?.team?.spawnErrors?.length,
    JSON.stringify(r.body?.team?.spawnErrors))

  // give spawn a moment to settle (agent processes need to register
  // capability with the hub before dispatch can find them)
  await sleep(2000)

  // ── 6. dispatch a real workflow ─────────────────────────────────────
  // Realistic 4-段自述 payload — mid-career product manager, sleep
  // issues, side-project anxiety. Mirrors what onboarding form will
  // collect from a real user.
  const payload = {
    case_id: 'self',
    present_state:
      '34 岁,产品经理,每天工作 9-11 小时,大部分时间坐着开会和写文档。' +
      '晚上 12:30-1:30 才睡,早上 7:00 起,睡眠 5-6 小时。每周运动 0-1 次。' +
      '最近半年开始有持续低烧式焦虑——总觉得职业天花板已经到了,但又不敢动。' +
      '和妻子结婚 5 年,关系平稳但话不多,各忙各的。父母在老家,半年见一次。',
    aspirations:
      '一年内:睡眠提前到 12 点前,每周三次运动,体重从 78 降到 72;' +
      '副业(产品咨询)开第一个付费客户。三年内:转去做产品咨询或独立顾问,' +
      '工作时间能弹性些。十年内:经济上能让妻子有得选要不要工作,有时间陪父母。',
    struggles:
      '想运动想睡早,每次到点又拖。副业想了一年多,担心辞职后没收入扛不住,' +
      '现在又没时间做。和妻子的话越来越少,但不知道从哪开口。',
    focus_request:
      '接下来 12 周到底应该先动哪一件事——身体、副业、还是夫妻关系?' +
      '我感觉同时推三件事推不动。',
  }
  console.log('dispatching workflow...')
  r = await fetchJson(BASE + '/api/admin/dispatch', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      strategy: { kind: 'capability', capabilities: ['plan-personal-growth'] },
      payload,
      title: 'E2E fresh-space test',
    }),
  })
  check('dispatch 200', r.status === 200 && r.body?.ok === true,
    JSON.stringify(r.body).slice(0, 200))

  // ── 7. poll until run finishes ──────────────────────────────────────
  const startRun = Date.now()
  let lastStatus = ''
  let finalRun = null
  while (Date.now() - startRun < RUN_TIMEOUT_MS) {
    r = await fetchJson(BASE + '/api/admin/workflows/runs', { headers: H })
    const runs = r.body?.runs ?? []
    if (runs.length > 0) {
      const run = runs[0]
      if (run.status !== lastStatus) {
        console.log('  run status: ' + run.status +
          ' (step ' + (run.stepCount?.completed ?? '?') + '/' + (run.stepCount?.total ?? '?') + ')')
        lastStatus = run.status
      }
      // The workflow runner emits `done` (not `completed`) when all
      // steps land in success. `failed`/`errored` are the terminal
      // failure stamps. Anything else (running/queued/...) we keep
      // polling.
      if (run.status === 'done' || run.status === 'failed' || run.status === 'errored') {
        finalRun = run
        break
      }
    }
    // Poll cadence: 15s. Workflows take 3-8 minutes for 7 LLM steps,
    // so a tighter poll just spams the host without progress. (Pre-
    // H22 fix a 5s cadence even tripped the auth limiter.)
    await sleep(15_000)
  }
  const runSecs = ((Date.now() - startRun) / 1000).toFixed(0)
  if (!finalRun) {
    check('workflow finished within ' + RUN_TIMEOUT_MS / 1000 + 's', false,
      'last status: ' + lastStatus + ', elapsed ' + runSecs + 's')
  } else {
    check('workflow finished in ' + runSecs + 's', finalRun.status === 'done',
      'final status: ' + finalRun.status)
    // stepCount on the run summary is a scalar (the total step count
    // for the workflow definition), not an object. "all steps done"
    // is implicit in status==='done', so this assertion just sanity-
    // checks the shape.
    check('stepCount = 7', finalRun.stepCount === 7,
      'got ' + JSON.stringify(finalRun.stepCount))
  }

  // ── 8. verify report ────────────────────────────────────────────────
  r = await fetchJson(BASE + '/api/admin/growth-reports', { headers: H })
  check('GET /growth-reports 200', r.status === 200, JSON.stringify(r.body).slice(0, 200))
  const reports = r.body?.reports ?? []
  check('exactly 1 growth report', reports.length === 1,
    'got ' + reports.length)

  if (reports.length > 0) {
    const rep = reports[0]
    check('report caseId=self', rep.caseId === 'self', 'got ' + rep.caseId)
    check('report sizeBytes > 5KB', rep.sizeBytes > 5_000,
      'got ' + rep.sizeBytes + ' bytes')

    // pull the markdown and look at structure
    const downloadUrl = BASE + '/api/admin/growth-reports/download?path=' +
      encodeURIComponent(rep.path)
    const mdRes = await fetch(downloadUrl, { headers: H })
    check('download 200', mdRes.status === 200)
    const md = await mdRes.text()
    check('report > 5000 chars', md.length > 5_000, 'got ' + md.length)

    // structure: synthesist always emits ## headings for the 6 sub-sections
    // (一句话路径 / 12 周计划 / 做不到怎么办 / 权衡 / v2 种子 / 边界)
    const h2Count = (md.match(/^## /gm) || []).length
    check('≥ 5 ## headings in report', h2Count >= 5, 'got ' + h2Count)

    // 5 dimension names should appear (5 维教练 output gets included)
    const dimensions = ['身体', '心理', '目标', '资源', '关系']
    const dimsPresent = dimensions.filter((d) => md.includes(d)).length
    check('all 5 dimension names appear', dimsPresent === 5,
      'got ' + dimsPresent + '/' + 5)

    // safety: crisis hotline / 边界 mention (synthesist prompt enforces this)
    const safetyHit = /医生|心理咨询|热线|边界|急诊|不替代/.test(md)
    check('safety/boundary language present', safetyHit)

    // Regression: stringField now unwraps LlmResult envelopes. Without
    // the fix the report would carry `"stopReason":"end_turn"`,
    // `"by":"DeepSeek"`, `"usage":{...}` strings from each upstream
    // step's output, polluting the markdown. The synthesist's own text
    // never contains these markers (they're LLM-runtime metadata).
    check('report has no LLM envelope leak (stopReason)',
      !md.includes('"stopReason"'))
    check('report has no LLM envelope leak (usage)',
      !md.includes('"inputTokens"') && !md.includes('"outputTokens"'))

    console.log('\nReport sample (first 600 chars):')
    console.log('---')
    console.log(md.slice(0, 600))
    console.log('---')
  }

} finally {
  hostProc.kill('SIGTERM')
  await sleep(800)
  try { rmSync(SPACE_DIR, { recursive: true, force: true }) } catch {}
  console.log('cleaned up ' + SPACE_DIR)
}

console.log('')
if (failures === 0) {
  console.log('ALL PASS — fresh-space onboarding → report works end-to-end')
  process.exit(0)
} else {
  console.log('FAILED — ' + failures + ' assertion(s)')
  process.exit(1)
}
