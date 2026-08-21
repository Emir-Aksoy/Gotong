#!/usr/bin/env node
// 效果回路 M1 — golden-run × 模型档矩阵 runner (docs/zh/EFFECT-LOOP.md §3.1)。
//
// 干什么: 对「档位表 × 模板包」逐格跑 —— 每格起一台全新真 host (fresh space),
// 导入模板包, 把包里每个托管 agent 换刀到该档 (export → buildPutBody → PUT,
// 走 LSA-M6 的全字段 echo 纪律), 然后逐条跑包自带的黄金验收 (acceptance[]),
// 汇成一张「用例 × 档位 → green/red」矩阵报告 (JSON + Markdown)。
//
// 量的不是「哪个模型强」, 是「骨架在每一档补位补得够不够」: 曲线平 = 骨架把
// 档位差扛住了; 曲线陡 = 补位件还有活可干。数字只与自己比, 不搬绝对分对外排名。
//
// 用法:
//   node scripts/effect-matrix.mjs --tiers <tiers.json> [--packs a.yaml,b.yaml] [--out <dir>] [--keep]
//   node scripts/effect-matrix.mjs --check     # CI 门: mock 档 × 冒烟包, 零 key 零网络
//
// tiers.json 一档一行:
//   [{ "tier": "mock",  "provider": "mock" },
//    { "tier": "weak",  "provider": "openai-compatible", "baseURL": "https://…/v1",
//      "model": "xxx", "providerLabel": "Xxx", "apiKeyEnv": "XXX_API_KEY" }]
//
// 纪律 (docs/zh/EFFECT-LOOP.md §五):
//   - key 值永不进档位表/报告 —— 档位表只写 apiKeyEnv 变量名, runner 从当前
//     进程 env 透传给 host, 报告里零 key 字节。
//   - 真档烧真 token = 用户门; CI 只跑 --check (mock 档)。
//   - 换刀在 spec 级 (验收派发结构性收不进 payload.model, 这是对的 —— 验收量的
//     是这台 hub 现在这套配置的真相)。
//
// 前置: pnpm build (要 host/core/identity/cli 的 dist)。

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOST_MAIN = join(ROOT, 'packages/host/dist/main.js')
const SMOKE_PACK = join(ROOT, 'scripts/fixtures/effect-matrix-smoke.template.yaml')

const procs = new Set()
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL') } catch { /* gone */ } } })
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

// ── 小件 ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pollUntil(fn, timeoutMs, everyMs, what) {
  const start = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - start > timeoutMs) throw new Error('超时: ' + what)
    await sleep(everyMs)
  }
}

/** 向内核要一个空闲端口 (listen 0 → 读回 → close)。 */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => res(port))
    })
    srv.on('error', rej)
  })
}

async function fetchJson(url, init = {}) {
  const r = await fetch(url, init)
  let body = null
  try { body = await r.json() } catch { body = null }
  return { status: r.status, ok: r.ok, body }
}

const H = (token, json = false) => ({
  Authorization: 'Bearer ' + token,
  ...(json ? { 'Content-Type': 'application/json' } : {}),
})

// ── 一格 = 一台全新 host (XHT initSpace 同款: 起 host 前直接开 identity 播 owner) ──

async function initSpace(space, label) {
  const { Space } = await import(join(ROOT, 'packages/core/dist/index.js'))
  const { openIdentityStore } = await import(join(ROOT, 'packages/identity/dist/index.js'))
  mkdirSync(space, { recursive: true })
  const res = await Space.init(space, { name: label })
  if (!res.adminToken) await res.space.createAdmin('effect-matrix-admin')
  const identity = openIdentityStore({ dbPath: join(space, 'identity.sqlite') })
  try {
    const owner = identity.createUser({ email: `owner@${label}.local`, role: 'owner' })
    return identity.issueApiKey({ userId: owner.id, label: 'effect-matrix' }).key
  } finally {
    identity.close?.()
  }
}

function spawnHost(space, webPort, wsPort) {
  const proc = spawn('node', [HOST_MAIN], {
    env: {
      ...process.env, // tier.apiKeyEnv 指到的变量从这里透传进 host
      GOTONG_SPACE: space,
      GOTONG_HOST: '127.0.0.1',
      GOTONG_WEB_PORT: String(webPort),
      GOTONG_WS_PORT: String(wsPort),
      GOTONG_ASSISTANT_PROVIDER: 'n', // workflow-assist 走 mock, 免 key
      GOTONG_OPEN_BROWSER: 'never',
      GOTONG_DEFAULT_LANG: 'zh',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logbuf = ''
  proc.stdout.on('data', (c) => { logbuf += c.toString() })
  proc.stderr.on('data', (c) => { logbuf += c.toString() })
  procs.add(proc)
  return { proc, getLog: () => logbuf }
}

function killHost(host) {
  return new Promise((r) => {
    if (host.proc.exitCode !== null || host.proc.signalCode !== null) { procs.delete(host.proc); return r() }
    host.proc.once('exit', () => { procs.delete(host.proc); r() })
    host.proc.kill('SIGTERM')
    setTimeout(() => { try { host.proc.kill('SIGKILL') } catch { /* gone */ } }, 3000)
  })
}

// ── 换刀: export → buildPutBody (cli 真件, 不复刻 echo 纪律) → PUT ───────────

async function swapAgentToTier(base, token, agentId, tier) {
  const { buildPutBody } = await import(join(ROOT, 'packages/cli/dist/commands/model.js'))
  const exp = await fetchJson(`${base}/api/admin/agents/${encodeURIComponent(agentId)}/export`, { headers: H(token) })
  if (!exp.ok) throw new Error(`export ${agentId} 失败: HTTP ${exp.status}`)
  const exported = exp.body?.agent ?? {} // export 路由包一层 { agent: spec }
  // CLI 同款守卫: PUT 契约无条件重建成 kind:'llm', 换非 llm 行会把它静默降级。
  if (typeof exported.kind === 'string' && exported.kind !== 'llm') {
    console.log(`  [skip] ${agentId} 是 kind=${exported.kind}, 不换刀`)
    return false
  }
  const sel = {
    provider: tier.provider,
    ...(tier.baseURL !== undefined ? { baseURL: tier.baseURL } : {}),
    ...(tier.providerLabel !== undefined ? { providerLabel: tier.providerLabel } : {}),
    ...(tier.model !== undefined ? { model: tier.model } : {}),
  }
  const { body } = buildPutBody(exported, sel)
  // buildPutBody 只会「掉」apiKeyEnv (端点变了旧绑定必须解除); 档位自己的
  // env 绑定在它之后补上 —— MR-M6 排他语义: 设了就只认这个变量名。
  if (tier.apiKeyEnv !== undefined) body.apiKeyEnv = tier.apiKeyEnv
  else delete body.apiKeyEnv
  const put = await fetchJson(`${base}/api/admin/agents/${encodeURIComponent(agentId)}`, {
    method: 'PUT', headers: H(token, true), body: JSON.stringify(body),
  })
  if (!put.ok) {
    const msg = typeof put.body?.error === 'string' ? put.body.error : `HTTP ${put.status}`
    throw new Error(`PUT ${agentId} 失败: ${msg}`)
  }
  return true
}

// ── 跑一格: (tier, pack) → { pack, tier, cases[] } ──────────────────────────

async function runCell(tier, packPath, opts) {
  const label = `${tier.tier}·${basename(packPath)}`
  const space = mkdtempSync(join(tmpdir(), 'gotong-effect-'))
  const [webPort, wsPort] = [await freePort(), await freePort()]
  const base = `http://127.0.0.1:${webPort}`
  const token = await initSpace(space, 'effect-matrix')
  const host = spawnHost(space, webPort, wsPort)
  const startedAt = Date.now()
  try {
    await pollUntil(async () => {
      const r = await fetchJson(`${base}/api/federation/self`, { headers: H(token) }).catch(() => null)
      return r?.status === 200
    }, 60_000, 500, label + ' host 未就绪')

    // ① 导入模板包 (画廊按钮同一条路, 解析拒绝在这里响亮死)
    const yaml = readFileSync(packPath, 'utf8')
    const imp = await fetchJson(`${base}/api/admin/templates/import`, {
      method: 'POST', headers: H(token, true), body: JSON.stringify({ template: yaml }),
    })
    if (!imp.ok) {
      const msg = typeof imp.body?.error === 'string' ? imp.body.error : `HTTP ${imp.status}`
      throw new Error(`导入 ${basename(packPath)} 被拒: ${msg}`)
    }
    const pack = imp.body?.template?.name ?? basename(packPath)
    const created = Array.isArray(imp.body?.team?.created) ? imp.body.team.created : []
    const managedIds = created.filter((r) => r && r.managed && typeof r.id === 'string').map((r) => r.id)

    // ② 换刀: 包里每个托管 llm agent 都换到本档 (PUT 立即重启生效)
    let swapped = 0
    for (const id of managedIds) { if (await swapAgentToTier(base, token, id, tier)) swapped++ }
    if (opts.onSwapped) await opts.onSwapped({ base, token, managedIds })

    // ③ 逐条跑黄金验收 (路由收 caseId; 逐条驱动 = 每次 HTTP 只等一个 120s 用例)
    const declared = imp.body?.postInstallChecklist?.acceptanceCases
    const caseIds = (Array.isArray(declared) ? declared : [])
      .map((c) => (typeof c?.id === 'string' ? c.id : null))
      .filter(Boolean)
    const cases = []
    if (caseIds.length === 0) {
      // 包没带用例 id 投影就整包一次跑 (慢档大包可能顶 HTTP 超时, 报告如实记)
      const run = await fetchJson(`${base}/api/admin/templates/acceptance/${encodeURIComponent(pack)}/run`, {
        method: 'POST', headers: H(token, true), body: JSON.stringify({}),
      })
      for (const r of run.body?.report?.results ?? []) cases.push(projectCase(r))
    } else {
      for (const caseId of caseIds) {
        const run = await fetchJson(`${base}/api/admin/templates/acceptance/${encodeURIComponent(pack)}/run`, {
          method: 'POST', headers: H(token, true), body: JSON.stringify({ caseId }),
        })
        if (!run.ok) {
          const msg = typeof run.body?.error === 'string' ? run.body.error : `HTTP ${run.status}`
          cases.push({ caseId, verdict: 'red', reason: 'run_http_error', message: msg })
          continue
        }
        for (const r of run.body?.report?.results ?? []) cases.push(projectCase(r))
      }
    }
    return { tier: tier.tier, pack, packPath, agentsSwapped: swapped, durationMs: Date.now() - startedAt, cases }
  } finally {
    await killHost(host)
    if (!opts.keep) { try { rmSync(space, { recursive: true, force: true }) } catch { /* best-effort */ } }
    else console.log(`  [keep] ${label} space 保留在 ${space}`)
  }
}

/** 只收窄到报告要的字段 —— 报告里永不出现输出正文/key 字节。 */
function projectCase(r) {
  return {
    caseId: r?.caseId ?? '?',
    verdict: r?.verdict === 'green' ? 'green' : 'red',
    ...(r?.reason ? { reason: r.reason } : {}),
    ...(r?.message ? { message: String(r.message).slice(0, 200) } : {}),
    ...(Array.isArray(r?.violations) && r.violations.length > 0
      ? { violations: r.violations.map((v) => ({ kind: v?.kind ?? '?', message: String(v?.message ?? '').slice(0, 200) })) }
      : {}),
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────────

function renderMarkdown(cells, tiers) {
  const lines = ['# 效果矩阵报告', '', `生成于 ${new Date().toISOString()} · 数字只与自己比, 不作对外排名。`, '']
  const packs = [...new Set(cells.map((c) => c.pack))]
  for (const pack of packs) {
    const packCells = cells.filter((c) => c.pack === pack)
    const caseIds = [...new Set(packCells.flatMap((c) => c.cases.map((x) => x.caseId)))]
    lines.push(`## ${pack}`, '', `| 用例 | ${tiers.map((t) => t.tier).join(' | ')} |`, `|---|${tiers.map(() => '---').join('|')}|`)
    for (const caseId of caseIds) {
      const row = tiers.map((t) => {
        const cell = packCells.find((c) => c.tier === t.tier)
        const cs = cell?.cases.find((x) => x.caseId === caseId)
        if (!cs) return '(没跑)'
        return cs.verdict === 'green' ? 'green' : `red(${cs.reason ?? cs.violations?.[0]?.kind ?? '?'})`
      })
      lines.push(`| ${caseId} | ${row.join(' | ')} |`)
    }
    lines.push('')
    // 每档可用率 = green / total (本包)
    const rate = tiers.map((t) => {
      const cell = packCells.find((c) => c.tier === t.tier)
      if (!cell || cell.cases.length === 0) return `${t.tier}: -`
      const g = cell.cases.filter((x) => x.verdict === 'green').length
      return `${t.tier}: ${g}/${cell.cases.length}`
    })
    lines.push(`可用率: ${rate.join(' · ')}`, '')
  }
  return lines.join('\n')
}

// ── 入口 ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { tiers: null, packs: [], out: null, keep: false, check: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') flags.check = true
    else if (a === '--keep') flags.keep = true
    else if (a === '--tiers') flags.tiers = argv[++i]
    else if (a === '--packs') flags.packs = String(argv[++i] ?? '').split(',').filter(Boolean)
    else if (a === '--out') flags.out = argv[++i]
    else { console.error('未知参数: ' + a); process.exit(2) }
  }
  return flags
}

async function main() {
  process.exitCode = 1 // 挂死/漏断言不得静默绿 (DIST 教训)
  if (!existsSync(HOST_MAIN)) {
    console.error('缺 packages/host/dist/main.js —— 先 pnpm build')
    process.exit(2)
  }
  const flags = parseArgs(process.argv.slice(2))

  let tiers, packs
  if (flags.check) {
    tiers = [{ tier: 'mock', provider: 'mock' }]
    packs = [SMOKE_PACK]
  } else {
    if (!flags.tiers) { console.error('缺 --tiers <tiers.json> (或用 --check 跑 CI 门)'); process.exit(2) }
    tiers = JSON.parse(readFileSync(flags.tiers, 'utf8'))
    if (!Array.isArray(tiers) || tiers.length === 0) { console.error('档位表必须是非空数组'); process.exit(2) }
    for (const t of tiers) {
      if (typeof t?.tier !== 'string' || typeof t?.provider !== 'string') {
        console.error('每档至少要 { tier, provider }: ' + JSON.stringify(t)); process.exit(2)
      }
      if (t.apiKey !== undefined) { console.error(`档位表不收 key 值 (档 ${t.tier} 带了 apiKey) —— 用 apiKeyEnv 写变量名`); process.exit(2) }
      if (t.apiKeyEnv && !process.env[t.apiKeyEnv]) {
        console.error(`档 ${t.tier} 指定 apiKeyEnv=${t.apiKeyEnv} 但当前 env 没有这个变量 —— 先 export 再跑`); process.exit(2)
      }
    }
    packs = flags.packs.length > 0 ? flags.packs : [SMOKE_PACK]
  }

  const outDir = flags.out ?? mkdtempSync(join(tmpdir(), 'gotong-effect-report-'))
  mkdirSync(outDir, { recursive: true })

  const cells = []
  let swapProof = null
  for (const tier of tiers) {
    for (const packPath of packs) {
      console.log(`[effect-matrix] 跑格: ${tier.tier} × ${basename(packPath)}`)
      const cell = await runCell(tier, packPath, {
        keep: flags.keep,
        // --check: 换刀后立刻 export 复核, 把「刀真的换了」变成断言而不是推论
        onSwapped: flags.check
          ? async ({ base, token, managedIds }) => {
              const id = managedIds[0]
              const exp = await fetchJson(`${base}/api/admin/agents/${encodeURIComponent(id)}/export`, { headers: H(token) })
              swapProof = exp.body?.agent?.provider ?? null
            }
          : undefined,
      })
      cells.push(cell)
      for (const c of cell.cases) console.log(`  ${c.verdict === 'green' ? 'green' : 'red '} ${c.caseId}${c.reason ? ` (${c.reason})` : ''}`)
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = join(outDir, `effect-matrix-${stamp}.json`)
  const mdPath = join(outDir, `effect-matrix-${stamp}.md`)
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), tiers, cells }, null, 2))
  writeFileSync(mdPath, renderMarkdown(cells, tiers))
  console.log(`[effect-matrix] 报告: ${jsonPath}`)
  console.log(`[effect-matrix] 报告: ${mdPath}`)

  if (flags.check) {
    // CI 门断言: runner 机制完整 —— 绿路径真绿(=换刀成功), 红路径如实红。
    const fails = []
    const cell = cells[0]
    const byId = new Map((cell?.cases ?? []).map((c) => [c.caseId, c]))
    if (swapProof !== 'mock') fails.push(`换刀后 export.provider 应为 mock, 实为 ${JSON.stringify(swapProof)}`)
    if (byId.get('green-mock-echo')?.verdict !== 'green') fails.push('green-mock-echo 应绿 (换刀或派发链断了): ' + JSON.stringify(byId.get('green-mock-echo')))
    const red = byId.get('red-never-said')
    if (red?.verdict !== 'red') fails.push('red-never-said 应红 (红路径被粉饰): ' + JSON.stringify(red))
    else if (!(red.violations ?? []).some((v) => v.kind === 'missing_phrase')) fails.push('red-never-said 的违规应含 missing_phrase: ' + JSON.stringify(red))
    if (cell?.agentsSwapped !== 1) fails.push(`冒烟包应换刀恰好 1 个 agent, 实为 ${cell?.agentsSwapped}`)
    if (!existsSync(jsonPath) || !existsSync(mdPath)) fails.push('报告文件没写出来')
    if (fails.length > 0) {
      for (const f of fails) console.error('[check] FAIL: ' + f)
      process.exit(1)
    }
    console.log('[check] PASS: 换刀可证 + 绿真绿 + 红真红 + 报告落盘')
  }
  process.exitCode = 0
}

main().catch((e) => {
  console.error('[effect-matrix] ' + (e instanceof Error ? e.stack ?? e.message : String(e)))
  process.exit(1)
})
