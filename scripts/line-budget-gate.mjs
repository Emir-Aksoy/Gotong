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
  { file: 'packages/host/src/main.ts', max: 2990 }, // the assembly binary — SLIM 抽 heartbeat-engine 后 2941,棘轮 3040→2980;C-M2-M4b 令牌刷新计时器 2980→2986;C-M2-M5a 出站 OAuth 连接器 CRUD surface 接线(factory construct + serveWeb opt)显式抬 2986→2990
  { file: 'packages/web/src/server.ts', max: 2381 }, // web route assembly (types → server-types.ts); 2350→2370 C-M2-M3b 出站 OAuth connect 路由对(公开 callback + admin begin 派发),抽 blessed OIDC/SAML 派发风险更高故显式抬棘轮;2370→2381 C-M2-M5a 出站 OAuth 连接器 CRUD 路由组接线(import+re-export+ctx+HandlerCtx 字段+派发块,逻辑在 oauth-connector-admin-routes.ts 不计),同 OIDC/SAML 派发家族
  { file: 'packages/web/src/me-routes.ts', max: 2850 }, // /me route sprawl (types → me-routes-types.ts)
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
