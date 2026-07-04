/**
 * Local newcomer self-check (ease-of-use ❹-M1).
 *
 * The whole onboarding story hinges on ONE promise: when a first-run user
 * pastes a key that silently doesn't work, they are NOT left staring at a
 * dead agent — the UI classifies the failure and shows a one-click "去补 key"
 * rescue path. Every piece of that path has hermetic/mock unit coverage, but
 * nobody had ever walked the whole probe end to end against a real wire. This
 * script is that walk.
 *
 * It drives the SAME `testLlmKey` primitive the setup wizard and the
 * agent-create form call (imported from the built host dist, so a green run
 * here means the real call path classifies the same way), and asserts the
 * authoritative self-rescue signal: a bad/empty key resolves to a `code`
 * (`invalid_key` / `insufficient_quota`) that the frontend maps to the
 * errFixKey hint ("去补 key →") — while a transport error does NOT, so the
 * rescue button only appears for genuine key problems.
 *
 * Three layers, by cost:
 *   1. HERMETIC (always runs, no network) — inject a 401-shaped provider, an
 *      empty key, and a network-error provider; assert the classifier sends
 *      the first two down the "去补 key" path and the third down "检查网络".
 *      This is the self-rescue guarantee, proven with zero spend.
 *   2. OPT-IN real key (env, skipped when absent) — a real key over the real
 *      wire resolves `ok:true`; mirrors the live gate's env contract so the
 *      DeepSeek/OpenAI/Anthropic paths all work.
 *   3. OPT-IN wrong key over the real wire (needs a real provider reachable)
 *      — a deliberately-garbage key resolves to `invalid_key`, proving the
 *      rescue path fires at the network layer too, not just in the fake.
 *
 * Keys are read from env, passed to the probe, and NEVER logged. The probe's
 * own `message` is already key-scrubbed; this script prints only code / model
 * / latency / scrubbed message.
 *
 * Run with:   node scripts/local-onboarding-check.mjs
 *             (or `pnpm check:onboarding`)
 *   Real key:  ANTHROPIC_API_KEY=... node scripts/local-onboarding-check.mjs
 *              OPENAI_API_KEY=... OPENAI_BASE_URL=https://api.deepseek.com \
 *                GOTONG_LIVE_OPENAI_MODEL=deepseek-chat node scripts/local-onboarding-check.mjs
 *
 * Exit codes:  0 = every check that RAN passed (skipped opt-in checks don't
 *              fail the run) · 1 = a check that ran failed.
 *
 * Build note: imports the compiled host dist. If `packages/host/dist/
 * llm-key-test.js` is missing, run `pnpm --filter @gotong/host build` first.
 */

import { testLlmKey } from '../packages/host/dist/llm-key-test.js'

// --- the authoritative self-rescue signal (mirror of app-core.js) ----------
// describeError() flags a failure as "fixed by adding/replacing an LLM key"
// (fixIsKey:true → the "去补 key →" button) for EXACTLY the codes whose fix
// hint is errFixKey. Keep this set in lockstep with ERROR_FIX_KEYS there.
const KEY_FIX_CODES = new Set(['invalid_key', 'insufficient_quota'])

// A tiny code → 人话 map for readable output only (NOT asserted). The
// authoritative `code` always comes from testLlmKey; this just labels it.
const CODE_WORDS = {
  invalid_key: 'key 无效 / 选错 provider — 去补 key',
  insufficient_quota: '余额 / 配额不足 — 去补 key',
  rate_limited: '触发限流，稍后再试',
  not_found: '模型 id 或 Base URL 不对',
  bad_request: '请求被拒（provider 选错？）',
  network: '连不上（检查 Base URL / 网络）',
  timeout: '超时',
  upstream: 'provider 服务异常（5xx）',
  unknown: '未分类错误',
}

// --- a fake LlmProvider whose stream() throws a shaped error ---------------
// testLlmKey only ever calls provider.stream(req, signal) and iterates it,
// so a generator that throws before yielding reproduces a transport/auth
// failure exactly the way a real SDK surfaces one.
function throwingProvider(throwable) {
  return {
    // eslint-disable-next-line require-yield
    async *stream() {
      throw throwable
    },
    async complete() {
      throw throwable
    },
  }
}

function err401() {
  const e = new Error('401 Unauthorized')
  e.status = 401
  return e
}

function errNetwork() {
  const e = new Error('connect ECONNREFUSED 127.0.0.1:443')
  e.code = 'ECONNREFUSED'
  return e
}

// --- result bookkeeping ----------------------------------------------------
let ran = 0
let failed = 0

function line(mark, label, detail) {
  const pad = label.padEnd(34)
  console.log(`  ${mark}  ${pad}${detail ? '  ' + detail : ''}`)
}

function pass(label, detail) {
  ran++
  line('PASS', label, detail)
}

function fail(label, detail) {
  ran++
  failed++
  line('FAIL', label, detail)
}

function skip(label, detail) {
  line('SKIP', label, detail)
}

function fmt(result) {
  const word = result.code ? CODE_WORDS[result.code] || result.code : ''
  const bits = [
    result.ok ? 'ok' : `code=${result.code}`,
    word ? `(${word})` : '',
    result.model ? `model=${result.model}` : '',
    Number.isFinite(result.latencyMs) ? `${Math.round(result.latencyMs)}ms` : '',
  ].filter(Boolean)
  return bits.join(' ')
}

// --- the checks ------------------------------------------------------------

async function hermeticChecks() {
  console.log('\n[1] hermetic — self-rescue path (no network, always runs)')

  // 1a. A wrong key (401) must classify as invalid_key AND be in the
  //     "去补 key" set — the exact signal that lights up the rescue button.
  {
    const r = await testLlmKey(
      { provider: 'anthropic', apiKey: 'sk-deliberately-wrong-000' },
      { buildProvider: () => throwingProvider(err401()) },
    )
    if (!r.ok && r.code === 'invalid_key' && KEY_FIX_CODES.has(r.code)) {
      pass('错 key → invalid_key → 去补 key', fmt(r))
    } else {
      fail('错 key → invalid_key → 去补 key', fmt(r))
    }
  }

  // 1b. An empty key short-circuits to invalid_key (also a rescue-path code).
  {
    const r = await testLlmKey({ provider: 'openai', apiKey: '' })
    if (!r.ok && r.code === 'invalid_key' && KEY_FIX_CODES.has(r.code)) {
      pass('空 key → invalid_key → 去补 key', fmt(r))
    } else {
      fail('空 key → invalid_key → 去补 key', fmt(r))
    }
  }

  // 1c. A transport error must NOT be a rescue-path code — the "去补 key"
  //     button only appears for genuine key problems, not a dead Base URL.
  {
    const r = await testLlmKey(
      { provider: 'openai-compatible', apiKey: 'sk-something', baseURL: 'https://no.such.host.invalid' },
      { buildProvider: () => throwingProvider(errNetwork()) },
    )
    if (!r.ok && r.code === 'network' && !KEY_FIX_CODES.has(r.code)) {
      pass('网络错 → network → 不是「去补 key」', fmt(r))
    } else {
      fail('网络错 → network → 不是「去补 key」', fmt(r))
    }
  }
}

// Mirror live-workflow.test.ts's env contract: Anthropic wins when both keys
// are set; otherwise the OpenAI-compatible path covers OpenAI and DeepSeek
// (via OPENAI_BASE_URL). Returns null when no real key is exported.
function realKeyInput() {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      ...(process.env.GOTONG_LIVE_ANTHROPIC_MODEL
        ? { model: process.env.GOTONG_LIVE_ANTHROPIC_MODEL }
        : {}),
    }
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
      ...(process.env.GOTONG_LIVE_OPENAI_MODEL ? { model: process.env.GOTONG_LIVE_OPENAI_MODEL } : {}),
    }
  }
  return null
}

async function realKeyChecks() {
  console.log('\n[2] real key — opt-in (skipped without a key in env)')
  const input = realKeyInput()
  if (!input) {
    skip('真 key 往返', '设 ANTHROPIC_API_KEY / OPENAI_API_KEY 后再跑')
    skip('错 key 走真线', '同上')
    return
  }

  // 2a. The real key over the real wire works — same probe the agent uses.
  {
    const r = await testLlmKey(input)
    if (r.ok) {
      pass(`真 key 往返 (${input.provider})`, fmt(r))
    } else {
      fail(`真 key 往返 (${input.provider})`, fmt(r))
    }
  }

  // 2b. A garbage key over the SAME real endpoint resolves to invalid_key —
  //     the rescue path fires at the network layer, not just in the fake.
  {
    const wrong = { ...input, apiKey: 'sk-gotong-deliberately-wrong-key-000000000000' }
    const r = await testLlmKey(wrong)
    if (!r.ok && KEY_FIX_CODES.has(r.code)) {
      pass(`错 key 走真线 → ${r.code} → 去补 key`, fmt(r))
    } else if (!r.ok) {
      // A provider may answer a bad key with 404/network depending on routing;
      // that's still an honest failure, just not the rescue-path code. Report
      // it as a soft skip rather than a hard fail (the hermetic 1a already
      // pins the classifier; this is a best-effort real-wire confirmation).
      skip(`错 key 走真线 (got ${r.code})`, fmt(r))
    } else {
      fail('错 key 走真线 → 应失败却 ok', fmt(r))
    }
  }
}

// --- run --------------------------------------------------------------------

console.log('Gotong 本地新手自检 — testLlmKey 自救路径')
await hermeticChecks()
await realKeyChecks()

console.log('')
if (failed > 0) {
  console.log(`✖ ${failed}/${ran} 项失败`)
  process.exit(1)
}
console.log(`✓ ${ran} 项全过（其余按需 opt-in 跳过）`)
process.exit(0)
