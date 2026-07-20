#!/usr/bin/env node
// bump-version — lockstep 定版的唯一入口(`node scripts/bump-version.mjs 4.1.0`)。
//
// 把根 package.json 与 packages/ 下每个可发布包的 version 一起改成新版本。
// 手改单个包的版本号会被 version-gate 拦下 —— 这个脚本是那道门的对偶:
// 门说「不许不一致」,它保证「一次改全」。
//
// 刻意不做的事:
//   · 不碰 examples/(全 private,永不发布)
//   · 不碰包间依赖写法 —— 89 处 `workspace:*` 由 pnpm 在发布时改写成精确
//     钉版,手动同步 = 白写还容易漏
//   · 不 git commit、不打 tag、不发布。改完文件就结束,剩下的你自己看着办。
//     (发布流程见 docs/zh/PUBLISH-RUNBOOK.md)
//
// 用法:
//   node scripts/bump-version.mjs 4.1.0        写入
//   node scripts/bump-version.mjs 4.1.0 --dry  只打印会改什么
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER = /^\d+\.\d+\.\d+(-[\w.]+)?$/

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const next = args.find((a) => !a.startsWith('-'))

if (!next || !SEMVER.test(next)) {
  console.error('用法: node scripts/bump-version.mjs <x.y.z> [--dry]')
  console.error(next ? `  ✖ "${next}" 不是合法 semver` : '  ✖ 缺版本号')
  process.exit(2)
}

/** 只改 version 那一行,不重排字段、不动缩进 —— JSON.stringify 会把整个
 *  文件重新格式化,制造与本次改动无关的 diff 噪音。 */
function rewriteVersion(file, to) {
  const src = readFileSync(file, 'utf8')
  const re = /^(\s*"version"\s*:\s*)"[^"]*"/m
  if (!re.test(src)) return null
  const out = src.replace(re, `$1"${to}"`)
  return out === src ? null : out
}

const targets = [{ file: join(ROOT, 'package.json'), label: 'package.json (根)' }]
for (const dir of readdirSync(join(ROOT, 'packages')).sort()) {
  const file = join(ROOT, 'packages', dir, 'package.json')
  if (!existsSync(file)) continue
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  if (pkg.private === true) continue
  targets.push({ file, label: `packages/${dir}`, from: pkg.version, name: pkg.name })
}

let changed = 0
let already = 0
for (const t of targets) {
  const out = rewriteVersion(t.file, next)
  if (out === null) {
    already++
    continue
  }
  if (!dry) writeFileSync(t.file, out)
  changed++
  const from = t.from ? `${t.from} → ` : ''
  console.log(`  ${dry ? '(dry) ' : ''}${t.label.padEnd(34)} ${from}${next}`)
}

console.log('')
console.log(
  `${dry ? '[dry-run] ' : ''}${changed} 个文件${dry ? '会被改' : '已改'}` +
    (already ? `,${already} 个本来就是 v${next}` : '') +
    `,共 ${targets.length} 个(根 + ${targets.length - 1} 个可发布包)。`,
)
if (!dry) {
  console.log('')
  console.log('下一步:')
  console.log('  1. pnpm check:version   确认 lockstep 成立')
  console.log('  2. pnpm build           dist 里的版本字符串跟着走')
  console.log('  3. 提交 —— 定版单独一个 commit,别和功能改动混在一起')
}
