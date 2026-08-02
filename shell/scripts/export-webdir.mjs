#!/usr/bin/env node
// SHELL-M5 —— 把「壳要装的那张页」从仓库现装出来,顺手当防腐门。
//
// webDir 的内容 = 渲染器三件(与 hub 同一份字节,拷贝不是分叉)+ 壳自己的三件。
// 六个静态文件一次拷贝就位;但 M4 立过的两条纪律在壳里没有测试跑者来守 ——
// 「不许把 SPA 拉回来」「页面不得含内联 <script>」—— 所以守在这里:每次导出都
// 断言,违反当场退出非零。cap sync 之前必经此门(package.json 的 sync 脚本串死)。

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHELL = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO = dirname(SHELL)
const STATIC = join(REPO, 'packages', 'web', 'static')
const WEB = join(SHELL, 'web')
const WWW = join(SHELL, 'www')

// 渲染器三件从 hub 的 static/ 原样拷贝 —— 壳是第 N 个渲染器,不是第二份实现。
// 想改渲染器,改 packages/web/static 然后重新导出;在 www/ 里改会被下次导出盖掉。
const FROM_STATIC = ['hub-target.js', 'sdui-ui.js', 'sdui-ui.css']
// 壳自己的三件(配对 + 挂载 + 壳皮)。
const FROM_SHELL = ['index.html', 'shell.js', 'shell.css']
// SPA 专属文件一个都不许进壳(M4 sdui-standalone 同一条纪律):壳里没有那个
// SPA,它们一旦出现就说明有人把「拷贝渲染器」做成了「搬走整站」。sw.js 单列一句:
// 壳没有 service worker 是设计(HTML 来自本地磁盘无需缓存,推送 M6 走原生通道),
// 不是漏装。
const FORBIDDEN = ['app.js', 'app-core.js', 'styles.css', 'sw.js', 'admin.js', 'app.html', 'manifest.webmanifest']

const errors = []

// --- 装 -------------------------------------------------------------------
rmSync(WWW, { recursive: true, force: true })
mkdirSync(WWW, { recursive: true })
for (const [from, names] of [
  [STATIC, FROM_STATIC],
  [WEB, FROM_SHELL],
]) {
  for (const name of names) {
    const src = join(from, name)
    if (!existsSync(src)) {
      errors.push(`缺源文件:${src}`)
      continue
    }
    copyFileSync(src, join(WWW, name))
  }
}

// --- 门 -------------------------------------------------------------------
const present = existsSync(WWW) ? readdirSync(WWW).sort() : []
const expected = [...FROM_STATIC, ...FROM_SHELL].sort()

for (const name of expected) {
  if (!present.includes(name)) errors.push(`www/ 缺 ${name}`)
  else if (statSync(join(WWW, name)).size === 0) errors.push(`www/${name} 是空文件`)
}
for (const name of present) {
  if (!expected.includes(name)) errors.push(`www/ 出现计划外文件 ${name} —— 名单在本脚本顶部,先想清楚再登记`)
}
for (const name of FORBIDDEN) {
  if (present.includes(name)) errors.push(`www/${name} 不许存在:SPA 文件不进壳(M4 纪律)`)
}

const read = (name) => (present.includes(name) ? readFileSync(join(WWW, name), 'utf8') : '')

// 内联 <script> 在真壳 CSP(script-src 'self')下无声不跑 —— M4 排错记①的
// 结构性防复发:凡 <script> 必须带 src。
const html = read('index.html')
for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
  if (!/\bsrc\s*=/.test(m[1])) errors.push('index.html 含内联 <script> 块 —— 壳 CSP 下它无声不跑')
}
// 页面引用的本地资源必须真的在 www/ 里 —— 设备上 404 没有 DevTools 可看。
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const ref = m[1]
  if (/^[a-z]+:/i.test(ref) || ref.startsWith('//') || ref.startsWith('#')) continue
  if (!present.includes(ref.replace(/^\.\//, ''))) errors.push(`index.html 引用了 www/ 里不存在的 ${ref}`)
}
// 加载顺序承重:hub-target 必须先于 sdui-ui 与 shell(咽喉先立,消费者后到)。
const order = ['hub-target.js', 'sdui-ui.js', 'shell.js'].map((n) => html.indexOf(`src="${n}"`))
if (order.some((i) => i < 0) || !(order[0] < order[1] && order[1] < order[2])) {
  errors.push('index.html 脚本顺序必须是 hub-target.js → sdui-ui.js → shell.js')
}
// 拷来的到底是不是那两件承重物 —— 防有人把路径指错还全绿。
if (!read('hub-target.js').includes('GotongHub')) errors.push('hub-target.js 里找不到 GotongHub —— 拷错文件了?')
const sdui = read('sdui-ui.js')
if (!sdui.includes('GotongPanel') || !sdui.includes('CLIENT_SCHEMA_VERSION')) {
  errors.push('sdui-ui.js 里找不到 GotongPanel/CLIENT_SCHEMA_VERSION —— 拷错文件了?')
}
// POLISH-M3 —— 壳 chrome 的两条不许回退:①安全区处理(刘海/圆角屏的顶栏与配对屏
// 都靠 env() 留出,丢了它顶栏会钻进状态栏区);②壳里出现的任何 @keyframes 动效
// 必须同文件带 prefers-reduced-motion 守卫(M2 渲染器同一条纪律 —— 壳没有 vitest
// 跑者,门守在这里)。
const shellCss = read('shell.css')
if (!shellCss.includes('env(safe-area-inset-top')) {
  errors.push('shell.css 丢了 env(safe-area-inset-top …) —— 安全区处理不许回退')
}
if (shellCss.includes('@keyframes') && !shellCss.includes('prefers-reduced-motion')) {
  errors.push('shell.css 有 @keyframes 却没有 prefers-reduced-motion 守卫(M2 纪律)')
}

if (errors.length) {
  console.error('export-webdir: 拒绝出货 ——')
  for (const e of errors) console.error('  ✗ ' + e)
  process.exit(1)
}
for (const name of expected) {
  console.log(`  ${name}  ${statSync(join(WWW, name)).size} bytes`)
}
console.log('export-webdir: www/ 就绪(' + expected.length + ' 个文件)')
