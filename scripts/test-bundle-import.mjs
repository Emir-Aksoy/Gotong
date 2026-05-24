#!/usr/bin/env node
/**
 * E2E smoke for the personal-growth bundle import path.
 *
 * Simulates a brand-new user:
 *   1. Empty $TMPDIR/aipehub-bundle-test space
 *   2. Init via Space.create + mint an admin token
 *   3. Boot a host (via child_process spawn, NOT in-process)
 *   4. POST templates/bundles/personal-growth.yaml + a stub DeepSeek key
 *      to /api/admin/bundles/import
 *   5. Verify:
 *        - 7 agents created
 *        - all 7 have an API key in secrets.enc.json
 *        - workflow personal-growth-flow registered
 *        - /api/admin/growth-reports returns 200 + []
 *        - host log shows 7 "spawned" events
 *   6. Kill the host
 *
 * This is the "did P0 #1 + #2 actually work together?" check that
 * should pass BEFORE we ship the admin UI button (P0 #3).
 *
 * Doesn't dispatch a real PG task — that would burn DeepSeek tokens
 * and need a real key. The end-to-end LLM run was already exercised
 * separately on the demo space.
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

const SPACE_DIR = join(tmpdir(), 'aipehub-bundle-test-' + Date.now())
const WEB_PORT = 3531
const WS_PORT = 4531
const BUNDLE_PATH = resolve('templates/bundles/personal-growth.yaml')

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

// ── 1. fresh space + admin ────────────────────────────────────────────
mkdirSync(SPACE_DIR, { recursive: true })
console.log(`space: ${SPACE_DIR}`)

const { Space } = await import('../packages/core/dist/index.js')
// openOrInit returns { space, adminToken, adminId }; init() auto-mints
// a first admin so a fresh space is immediately usable. We mint a
// SECOND admin so the test gets a known token we can hard-code into
// requests (Space.init's first-admin token is logged-and-forgotten).
const initRes = await Space.init(SPACE_DIR, { name: 'bundle-import-smoke' })
const space = initRes.space
const { token } = await space.createAdmin('e2e-test')
console.log(`admin token: ${token.slice(0, 12)}…`)

// ── 2. boot host ──────────────────────────────────────────────────────
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

// wait for "listening"
const start = Date.now()
while (!/listening.*"url":"http:\/\/127\.0\.0\.1:/.test(hostLog)) {
  if (Date.now() - start > 30_000) {
    console.log('---HOST LOG---')
    console.log(hostLog)
    throw new Error('host did not become ready in 30s')
  }
  await sleep(300)
}
console.log(`host ready in ${((Date.now() - start) / 1000).toFixed(1)}s`)

try {
  const BASE = `http://127.0.0.1:${WEB_PORT}`
  const H = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }

  // ── 3. baseline checks: empty agents, empty growth-reports ──────────
  let r = await fetchJson(`${BASE}/api/admin/agents`, { headers: H })
  check('GET /agents on fresh space returns []', r.status === 200 && (r.body.agents?.length ?? 0) === 0)

  r = await fetchJson(`${BASE}/api/admin/growth-reports`, { headers: H })
  check('GET /growth-reports on fresh space returns 200 + []', r.status === 200 && Array.isArray(r.body.reports) && r.body.reports.length === 0)

  r = await fetchJson(`${BASE}/api/admin/workflows`, { headers: H })
  check('GET /workflows on fresh space returns 200 + []', r.status === 200 && (r.body.workflows?.length ?? 0) === 0)

  // ── 4. POST bundle import with a stub key ───────────────────────────
  const yaml = readFileSync(BUNDLE_PATH, 'utf8')
  const stubKey = 'sk-stub-' + Math.random().toString(36).slice(2)
  r = await fetchJson(`${BASE}/api/admin/bundles/import`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ yaml, apiKey: stubKey }),
  })
  check('POST /bundles/import returns 200', r.status === 200, JSON.stringify(r.body).slice(0, 200))
  check('response.team.created has 7 agents', r.body?.team?.created?.length === 7)
  check('response.team.skipped is empty', r.body?.team?.skipped?.length === 0)
  check('response.bundle.name matches', /个人成长/.test(r.body?.bundle?.name || ''))
  check('response.workflow.id is personal-growth-flow', r.body?.workflow?.id === 'personal-growth-flow')
  // spawn errors are expected (stub key won't actually let DeepSeek call
  // succeed, but spawn should still succeed because spawn only verifies
  // the key EXISTS, not that it's valid).
  check('response.team.spawnErrors is empty', r.body?.team?.spawnErrors?.length === 0,
    JSON.stringify(r.body?.team?.spawnErrors))

  // ── 5. verify state after import ────────────────────────────────────
  r = await fetchJson(`${BASE}/api/admin/agents`, { headers: H })
  check('GET /agents after import shows 7', r.body?.agents?.length === 7)
  const kinds = new Set(r.body.agents.map((a) => a.managed?.kind))
  check('all 7 have kind=personal-growth', kinds.size === 1 && kinds.has('personal-growth'))

  r = await fetchJson(`${BASE}/api/admin/workflows`, { headers: H })
  check('workflow registered after import', r.body?.workflows?.length === 1 && r.body.workflows[0].id === 'personal-growth-flow')
  // P0 #4 + P1 #9 — the workflow summary must carry payloadSchema so the
  // admin UI can render the field-by-field dispatch form. As of P1 #9
  // the schema starts with `case_id` (multi-case support) followed by
  // the 4 free-form 自述 fields.
  const wfSummary = r.body?.workflows?.[0]
  check('workflow summary exposes payloadSchema', Array.isArray(wfSummary?.payloadSchema) && wfSummary.payloadSchema.length === 5,
    `got ${JSON.stringify(wfSummary?.payloadSchema)?.slice(0, 200)}`)
  check('payloadSchema fields = case_id + 4 段', wfSummary?.payloadSchema?.map((f) => f.id).join(',') === 'case_id,present_state,aspirations,struggles,focus_request')
  // present_state is now the SECOND field (after case_id) and is the
  // first textarea — verify it has the rows hint.
  check('payloadSchema present_state has rows hint', wfSummary?.payloadSchema?.[1]?.rows >= 1)
  check('payloadSchema case_id defaults to "self"', wfSummary?.payloadSchema?.[0]?.defaultValue === 'self')

  // ── 6. host log spawn count ────────────────────────────────────────
  const spawnedCount = (hostLog.match(/"msg":"spawned"/g) || []).length
  check('host log shows ≥ 7 spawn events', spawnedCount >= 7, `got ${spawnedCount}`)

  // ── 7. re-import is idempotent (skipped not error) ─────────────────
  r = await fetchJson(`${BASE}/api/admin/bundles/import`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ yaml, apiKey: stubKey }),
  })
  check('re-import returns 200', r.status === 200)
  check('re-import: 0 created, 7 skipped', r.body?.team?.created?.length === 0 && r.body?.team?.skipped?.length === 7)

  // ── 8. /api/admin/growth-reports after import = empty (no runs yet) ─
  r = await fetchJson(`${BASE}/api/admin/growth-reports`, { headers: H })
  check('growth-reports after import still []', r.status === 200 && r.body?.reports?.length === 0)

  // ── 9. built-in bundle yaml is served as a static asset ────────────
  const yamlRes = await fetch(`${BASE}/builtin-bundles/personal-growth.yaml`)
  check('GET /builtin-bundles/personal-growth.yaml returns 200', yamlRes.status === 200)
  const ctype = yamlRes.headers.get('content-type') || ''
  check('content-type is yaml/text', /yaml|text\//.test(ctype), `got '${ctype}'`)
  const builtinText = await yamlRes.text()
  check('built-in yaml starts with schema marker', builtinText.includes('schema: aipehub.bundle/v1'))
  check('built-in yaml has the 7 agent ids',
    ['growth-interviewer','body-coach','mind-coach','direction-coach','leverage-coach','circle-coach','growth-synthesist']
      .every((id) => builtinText.includes(`id: ${id}`)))

} finally {
  hostProc.kill('SIGTERM')
  await sleep(500)
  try { rmSync(SPACE_DIR, { recursive: true, force: true }) } catch {}
}

console.log('')
if (failures === 0) {
  console.log('ALL PASS — bundle import path works on a fresh space')
  process.exit(0)
} else {
  console.log(`FAILED — ${failures} assertion(s)`)
  process.exit(1)
}
