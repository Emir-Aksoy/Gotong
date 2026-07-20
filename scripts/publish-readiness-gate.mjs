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
//   5. 依赖声明**反方向**完整:src/ 里 import 到的每个 @gotong/* 都必须出现在
//      deps/peer/optional 里。第 2 条查的是「声明了的存不存在」,这条查的是
//      「用了的有没有声明」——两者是不同方向,少了这条,写在 devDependencies
//      里的运行时依赖能一路绿灯发上 npm,然后在消费者那里 ERR_MODULE_NOT_FOUND。
//      monorepo 里察觉不到:pnpm 不管声明在哪个块都把 workspace 包摊平了,而
//      本仓库是唯一的消费者。(2026-07-20 首次接入时逮到 host→cli、web→workflow
//      两处运行时幽灵依赖,均已存在于发布过的包里。)
//
// 静态检查只到这里;「装出来真能跑」由 PUB-M2 的 verdaccio 彩排门覆盖。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
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
  const scripts = pkg.scripts ?? {}
  if (scripts.build && !scripts.prepack)
    errors.push(`${where}: 有 build 却缺 prepack——publish 会打包当时磁盘上的陈旧 dist`)
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

/**
 * 把注释与模板字面量替换成等长空白(保留换行与字节偏移,所以报出的行号仍对得上
 * 真实文件)。
 *
 * 普通 '…' / "…" 字符串**刻意不动**——要找的模块名本来就住在引号里。模板字面量
 * 则必须抹掉,因为它的内容是数据不是代码:`gotong new ts-agent` 生成的脚手架源码
 * 里就有一行 `from '@gotong/sdk-node'`,那是 CLI 写给用户的字符串,不是 CLI 自己
 * 的 import。字符串虽不抹,但仍要**跟踪**(跳过而不改写),否则字符串里的反引号或
 * `//` 会把扫描器带进错误状态。
 */
function blankNonCode(src) {
  const out = [...src]
  const n = src.length
  let i = 0
  const wipe = (k) => { if (src[k] !== '\n') out[k] = ' ' }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { wipe(i); i++ }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2 }
      continue
    }
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++ }
      continue
    }
    if (c === '`') {
      out[i] = ' '; i++
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { wipe(i); i++; if (i < n) wipe(i); i++; continue }
        wipe(i); i++
      }
      if (i < n) { out[i] = ' '; i++ }
      continue
    }
    if (c === "'" || c === '"') {
      i++
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { i += 2; continue }
        i++
      }
      i++
      continue
    }
    i++
  }
  return out.join('')
}

function sourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir).sort()) {
    const f = join(dir, e)
    if (statSync(f).isDirectory()) sourceFiles(f, out)
    else if (/\.(ts|mts|js|mjs)$/.test(e) && !e.endsWith('.d.ts')) out.push(f)
  }
  return out
}

// `from '…'` 覆盖 import 与 re-export 两种。中间那段要能跨行(多行 import 很常见),
// 但**不能跨过另一条 import/export**——本仓库不写分号,只用 `[^;]*?` 的话匹配会从上
// 一条 import 的关键字起头一路吃到下一条的 `from`,报错行号指向隔壁语句;更糟的是若
// 上一条恰好是 `import type`,`type` 会被捕获,把一条会让消费者崩溃的运行时依赖误判
// 成温和的「仅类型」。负向先行断言把每次匹配锁在单条语句内。
const FROM_RE =
  /(?:import|export)\s+(type\s+)?(?:(?!\bimport\b|\bexport\b)[^;])*?from\s*['"](@gotong\/[a-z0-9-]+)['"]/g
// 裸副作用 import + 动态 import(),都是运行时。
const BARE_RE = /import\s*[('"]\s*['"]?(@gotong\/[a-z0-9-]+)['"]/g

for (const [name, { pkg, dir }] of byName) {
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ])
  // dep → 首次出现处;运行时用法一旦出现就压过仅类型(前者更严重)。
  const undeclared = new Map()
  for (const file of sourceFiles(join(ROOT, 'packages', dir, 'src'))) {
    const code = blankNonCode(readFileSync(file, 'utf8'))
    const at = (idx) => `${relative(ROOT, file)}:${code.slice(0, idx).split('\n').length}`
    for (const m of code.matchAll(FROM_RE)) {
      const dep = m[2]
      if (declared.has(dep) || dep === name) continue
      const prev = undeclared.get(dep)
      if (!prev) undeclared.set(dep, { typeOnly: !!m[1], at: at(m.index) })
      else if (!m[1] && prev.typeOnly) undeclared.set(dep, { typeOnly: false, at: at(m.index) })
    }
    for (const m of code.matchAll(BARE_RE)) {
      const dep = m[1]
      if (declared.has(dep) || dep === name) continue
      undeclared.set(dep, { typeOnly: false, at: at(m.index) })
    }
  }
  for (const [dep, { typeOnly, at }] of undeclared) {
    errors.push(
      typeOnly
        ? `packages/${dir}: ${at} 以 \`import type\` 用了 ${dep},但没声明——运行时虽被擦除,类型却会泄进发布的 .d.ts,消费者不开 skipLibCheck 就 TS2307`
        : `packages/${dir}: ${at} 运行时 import 了 ${dep},但只在 devDependencies 或压根没声明——消费者装不到它,ERR_MODULE_NOT_FOUND`,
    )
  }
}

if (errors.length) {
  console.error(`✖ publish-readiness: ${errors.length} 处不就绪\n`)
  for (const e of errors) console.error(`  ✖ ${e}`)
  process.exit(1)
}
console.log(`✓ publish-readiness: packages/* 共 ${byName.size} 包全部发布就绪,examples 保险丝在位,入口 ${ENTRIES.length}/${ENTRIES.length} 可达`)
