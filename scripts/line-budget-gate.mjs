#!/usr/bin/env node
/**
 * line-budget-gate — GUARD-M2. A ratchet against assembly-layer bloat.
 *
 * 缺口 2 named the heavy files by name: `host/src/main.ts` (~3.2K 行) and the
 * web route sprawl. Nothing stopped them growing — main.ts was 3.2K when noted
 * and is larger now. This gate caps the known hot-files: each has a line budget,
 * and the build goes red if a file crosses it.
 *
 * The budget is a RATCHET, not a snapshot. It is meant to trend DOWN: when you
 * split a file, lower its budget in the same commit. Raising a budget is allowed
 * but must be a deliberate, visible edit here (and justified in the commit) —
 * that friction is the whole point. You cannot balloon main.ts silently.
 *
 * 两条 2026-07-20 体检记录，读之前先知道：
 *
 *   1. **零余量会把这道门变成注释绞肉机。** main.ts 卡在 3000/3000、me-routes
 *      卡在 2850/2850 各自二十来个提交，于是每次加一行都得先删一行注释——
 *      CLAUDE.md 明写「注释写为什么」，这道门却在拿它换行数。行数只是**膨胀
 *      的代理指标**，不是目标本身。顶到上限的正解是**拆文件**（下调预算），
 *      不是刮注释。新加的条目一律留一点余量，就是为了不再复制这个病。
 *   2. **盯的文件集会过期。** 这三条写下时，全仓最大的文件
 *      `identity/store.ts`(3295) 比 main.ts 还大，却因为不在「装配层」而一直
 *      没人管；`web/identity-routes.ts`(2686)、`host/local-agent-pool.ts`(2326)
 *      同理。名字叫装配层是历史来由，不是原则——按大小收编即可。下一档
 *      （`identity/types.ts` 2092、`core/space.ts` 1599）暂不入册：类型定义长
 *      与逻辑长不是一回事，等它们真的开始涨再说。
 *
 *   node scripts/line-budget-gate.mjs           # exit 0 within budget / 1 over
 *   node scripts/line-budget-gate.mjs --report   # print current vs budget, exit 0
 *
 * Line count matches `wc -l` (newline count), so the numbers here line up with
 * what you see in your editor / shell.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

/**
 * The hot-files the assembly layer keeps re-growing. Budget = a cap just above
 * today's size (small headroom), meant to be lowered as these get split. To add
 * lines you must either remove some elsewhere in the file or raise the cap here
 * on purpose — that visible edit is the guard.
 */
const BUDGETS = [
  { file: 'packages/host/src/main.ts', max: 2925 }, // the assembly binary — SLIM 抽 heartbeat-engine 后 2941,棘轮 3040→2980;C-M2-M4b 令牌刷新计时器 2980→2986;C-M2-M5a 出站 OAuth 连接器 CRUD surface 接线(factory construct + serveWeb opt)显式抬 2986→2990;MU-M5 记忆树 git 快照 opt-in 接线(GOTONG_BUTLER_MEMORY_GIT 解析 + sweeper gitSnapshot)显式抬 2990→2996;审计 P1 全局 unhandledRejection 兜底网(installProcessSafetyNet)防后台计时器崩宿主,显式抬 2996→3000;审计⑦-1 抽出 transcript-line.ts(describe 日志渲染器,纯函数无闭包依赖)后 2945,下调 3000→2960——按上文体检记录 1 留余量,不再零余量;审计⑦-2 抽出 butler-env.ts(GOTONG_BUTLER* 旋钮解析)后 2911,再下调 2960→2925
  { file: 'packages/web/src/server.ts', max: 2381 }, // web route assembly (types → server-types.ts); 2350→2370 C-M2-M3b 出站 OAuth connect 路由对(公开 callback + admin begin 派发),抽 blessed OIDC/SAML 派发风险更高故显式抬棘轮;2370→2381 C-M2-M5a 出站 OAuth 连接器 CRUD 路由组接线(import+re-export+ctx+HandlerCtx 字段+派发块,逻辑在 oauth-connector-admin-routes.ts 不计),同 OIDC/SAML 派发家族
  { file: 'packages/web/src/me-routes.ts', max: 2850 }, // /me route sprawl (types → me-routes-types.ts)
  // 2026-07-20 收编的三个失管大文件（见头注第 2 条）。预算 = 当时行数 + ~45 行
  // 余量：够一次正常修改落地，不够无声膨胀，也不逼人删注释换行数。
  { file: 'packages/identity/src/store.ts', max: 3340 }, // 3295 — 全仓最大;users/credentials/sessions/vault/quota/peers… 全挤在一个 store
  { file: 'packages/web/src/identity-routes.ts', max: 2730 }, // 2686 — 身份路由组,与 me-routes 同型 sprawl
  { file: 'packages/host/src/local-agent-pool.ts', max: 2370 }, // 2326 — spawn/路由/MCP 热插拔/探针都在这
]

/** Match `wc -l`: count newline characters. */
function lineCount(path) {
  const text = readFileSync(path, 'utf8')
  const m = text.match(/\n/g)
  return m ? m.length : 0
}

function main() {
  const report = process.argv.includes('--report')
  const rows = []
  const over = []

  for (const { file, max } of BUDGETS) {
    const abs = join(REPO, file)
    if (!existsSync(abs)) {
      over.push(`${file}: not found (stale entry in line-budget-gate?)`)
      continue
    }
    const lines = lineCount(abs)
    rows.push({ file, lines, max, slack: max - lines })
    if (lines > max) over.push(`${file}: ${lines} lines > budget ${max} (${lines - max} over)`)
  }

  if (report) {
    for (const r of rows) {
      const bar = r.slack < 0 ? 'OVER' : `${r.slack} slack`
      console.log(`  ${String(r.lines).padStart(5)} / ${String(r.max).padStart(5)}  ${bar.padStart(10)}  ${r.file}`)
    }
    return
  }

  if (over.length === 0) {
    const tight = rows.map((r) => `${r.file.split('/').pop()}=${r.lines}/${r.max}`).join('  ')
    console.log(`PASS line-budget-gate: ${rows.length} hot-files within budget.  ${tight}`)
    return
  }

  console.error(`FAIL line-budget-gate: ${over.length} file(s) over budget:`)
  for (const o of over) console.error(`  ✗ ${o}`)
  console.error(`\n  Trim the file, or — if the growth is genuinely warranted — raise its budget`)
  console.error(`  in scripts/line-budget-gate.mjs deliberately and say why in the commit.`)
  process.exit(1)
}

main()
