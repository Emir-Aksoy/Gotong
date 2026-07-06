#!/usr/bin/env node
// publish-readiness-gate — PUB-M1 的会红的门(`pnpm check:publish`)。
//
// 断言「今天就能 `pnpm -r publish` 而不产生断链或半成品包」:
//
//   1. packages/* 全员发布就绪:无 private、publishConfig.access=public、
//      license、repository(url+directory 指回本仓库对应目录)、version、
//      files 含 dist(薄壳包 gotong 例外:含 bin)、声明的 bin 文件真实存在。
//   2. 内部依赖闭包完整:任何 @gotong/* 依赖(deps/peer/optional)必须是
//      workspace 里的真实包——否则 npm install 装到一半 404。
//   3. 入口可达:gotong / @gotong/cli / @gotong/host / sdk-node / services-sdk
//      必须存在(npx 故事的承重点)。
//   4. examples 保险丝:examples/* 必须全部 private——`pnpm -r publish`
//      永远不该把 45 个 demo 发上 npm。
//
// 静态检查只到这里;「装出来真能跑」由 PUB-M2 的 verdaccio 彩排门覆盖。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_URL = 'https://github.com/Emir-Aksoy/Gotong.git'
const ENTRIES = ['gotong', '@gotong/cli', '@gotong/host', '@gotong/sdk-node', '@gotong/services-sdk']

const errors = []
const byName = new Map()

for (const dir of readdirSync(join(ROOT, 'packages')).sort()) {
  const file = join(ROOT, 'packages', dir, 'package.json')
  if (!existsSync(file)) continue
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  byName.set(pkg.name, { pkg, dir })
}

for (const [name, { pkg, dir }] of byName) {
  const where = `packages/${dir}`
  if (pkg.private) errors.push(`${where}: 仍是 private——发布闭包里不许有暗包`)
  if (pkg.publishConfig?.access !== 'public')
    errors.push(`${where}: 缺 publishConfig.access=public(scoped 包默认 restricted,发布会 402)`)
  if (!pkg.license) errors.push(`${where}: 缺 license`)
  if (!pkg.version) errors.push(`${where}: 缺 version`)
  if (pkg.repository?.url !== REPO_URL)
    errors.push(`${where}: repository.url 不是 ${REPO_URL}`)
  if (pkg.repository?.directory !== where)
    errors.push(`${where}: repository.directory 应为 ${where},实为 ${pkg.repository?.directory ?? '(无)'}`)
  const files = pkg.files ?? []
  const needle = name === 'gotong' ? 'bin' : 'dist'
  if (!files.includes(needle))
    errors.push(`${where}: files 不含 ${needle}——发出去的包是空壳`)
  for (const [cmd, rel] of Object.entries(pkg.bin ?? {})) {
    if (!existsSync(join(ROOT, 'packages', dir, rel)))
      errors.push(`${where}: bin.${cmd} 指向不存在的 ${rel}`)
  }
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (dep.startsWith('@gotong/') && !byName.has(dep))
        errors.push(`${where}: ${field} 引用 ${dep},但 workspace 里没有这个包(npm install 会 404)`)
    }
  }
}

for (const entry of ENTRIES) {
  if (!byName.has(entry)) errors.push(`入口包缺失:${entry}(npx 故事的承重点)`)
}

for (const dir of readdirSync(join(ROOT, 'examples')).sort()) {
  const file = join(ROOT, 'examples', dir, 'package.json')
  if (!existsSync(file)) continue
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  if (pkg.private !== true)
    errors.push(`examples/${dir}: 不是 private——\`pnpm -r publish\` 会把 demo 发上 npm`)
}

if (errors.length) {
  console.error(`✖ publish-readiness: ${errors.length} 处不就绪\n`)
  for (const e of errors) console.error(`  ✖ ${e}`)
  process.exit(1)
}
console.log(`✓ publish-readiness: packages/* 共 ${byName.size} 包全部发布就绪,examples 保险丝在位,入口 ${ENTRIES.length}/${ENTRIES.length} 可达`)
