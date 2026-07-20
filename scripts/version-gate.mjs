#!/usr/bin/env node
// version-gate — 第四道 GUARD 门(`pnpm check:version`)。
//
// 断言 **lockstep 版本**:packages/ 下每一个可发布包的 version 都等于根
// package.json 的 version。一个数字描述整套 Gotong,没有第二个真相源。
//
// 为什么是 lockstep,而不是每包各升各的:
//
//   包间依赖 89 处全是 `workspace:*`,pnpm 在发布时把它改写成**精确钉版**
//   (npm 上 @gotong/core@3.1.0 的 deps 里躺着 "@gotong/protocol": "3.1.0",
//   不是 "^3.1.0")。所以改了 protocol 却不升 core,npm 上的 core 会永远
//   钉着旧 protocol —— 独立版本在这张依赖图下会退化成近似 lockstep,只是
//   多背一层仪式。既然结果一样,就直说。
//
// 这道门要防的是已经发生过的事:2026-05-20 `cut v3.1.0` 之后两个月没再
// 定版,web 攒了 327 次提交、host 220 次、identity 96 次,而 36 个包以**完全
// 相同的版本号**躺在 npm 上。版本号不再承载任何信息 —— `npm i
// @gotong/core@3.1.0` 拿到的和 clone 拿到的是两套代码。
//
// 门只管「号一致」这件能离线机器判定的事。「号该不该往前走」需要跟 npm
// 比对,属于发布前的活,在 check:publish / PUBLISH-RUNBOOK 里。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const expected = root.version

const errors = []
if (!expected || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(expected)) {
  errors.push(`根 package.json 的 version 不是合法 semver: ${JSON.stringify(expected)}`)
}

const rows = []
for (const dir of readdirSync(join(ROOT, 'packages')).sort()) {
  const file = join(ROOT, 'packages', dir, 'package.json')
  if (!existsSync(file)) continue
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  if (pkg.private === true) continue          // 暗包不发布,不参与 lockstep
  rows.push({ name: pkg.name, version: pkg.version, where: `packages/${dir}` })
}

if (rows.length === 0) errors.push('packages/ 下一个可发布包都没找到——门失去意义,先查这里')

for (const r of rows) {
  if (r.version !== expected) {
    errors.push(`${r.where} (${r.name}): ${r.version} ≠ 根版本 ${expected}`)
  }
}

if (errors.length > 0) {
  console.error('FAIL version-gate: lockstep 版本被打破。')
  for (const e of errors) console.error('  ✖ ' + e)
  console.error('')
  console.error('  改法(二选一):')
  console.error('    · 要发新版 → `node scripts/bump-version.mjs <新版本>` 一把改全部')
  console.error('    · 单个包被手改了 → 改回根版本;这个仓库不做 per-package 版本')
  console.error('  为什么:见本脚本头注 + docs/zh/VERSIONING.md')
  process.exit(1)
}

console.log(
  `PASS version-gate: ${rows.length} 个可发布包全部锁在 v${expected}(根 package.json 为唯一真相源)。`,
)
