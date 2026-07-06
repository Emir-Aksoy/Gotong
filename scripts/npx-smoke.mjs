#!/usr/bin/env node
// npx-smoke — PUB-M2 的彩排门(`pnpm check:npx-smoke`)。
//
// 在本地 verdaccio 上把「真发布 → 真安装 → 真启动」整条链走一遍,不碰
// 真 npm。任何漏发的包 / 断掉的内部依赖 / prepack 失败 / bin 断链 /
// dist 缺文件 / 启动即死,都在这里现形,而不是在用户的 `npx gotong` 里。
//
// 步骤(全程临时目录,跑完即删):
//   1. 起 verdaccio(随机端口,@gotong/* 与 gotong 只进本地,其余上游代理
//      到真 npm——外部依赖 ws/better-sqlite3 等要能装回来);
//   2. `pnpm -r publish` 全量发到本地 registry(prepack 自建,私有包
//      root/examples 由 pnpm 自动跳过);
//   3. 逐包 GET 核验:发布清单 = packages/* 里全部非 private 包;
//   4. 干净目录 `npx -y gotong --version` 断言 CLI 版本(npm cache 在
//      稳定目录跨次复用,_npx 已装闭包逐次驱逐——解析永远走本轮 verdaccio);
//   5. `npx -y gotong start` 剥掉一切 key(环境白名单)起完整 host,
//      轮询 /healthz 到 ok(TTFR 姿态同 first-result-smoke)。
//
// 预算:首跑要过 verdaccio 代理冷拉全部外部依赖(马来西亚网络实测可超
// 10 分钟,npx 步预算给 20 分钟);cache 热后走本地字节,分钟级。
// 这是按需跑的彩排门,不进 check:guards。
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const t0 = Date.now()
const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`
const say = (m) => console.log(`[npx-smoke ${elapsed()}] ${m}`)

const procs = []
let tmp = ''
function cleanup() {
  for (const p of procs) {
    // detached:true 让子进程自成进程组,负 pid 连锅端——pnpm exec / npx 都是
    // 包装进程,只杀 p.pid 会把底下真正的 verdaccio / host node 留成孤儿
    // (孤儿还攥着 stdio 管道,连本脚本自己都退不出去)。
    try { process.kill(-p.pid, 'SIGKILL') } catch { /* already gone */ }
    try { p.kill('SIGKILL') } catch { /* already gone */ }
  }
  if (tmp && tmp.startsWith(tmpdir())) { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } }
}
function fail(msg, ...logFiles) {
  console.error(`✖ npx-smoke: ${msg}`)
  for (const logFile of logFiles) {
    if (logFile && existsSync(logFile)) {
      const lines = readFileSync(logFile, 'utf8').split('\n')
      console.error(`--- ${logFile} 末 40 行 ---`)
      console.error(lines.slice(-40).join('\n'))
    }
  }
  cleanup()
  process.exit(1)
}
process.on('SIGINT', () => { cleanup(); process.exit(130) })

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer()
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address()
    srv.close(() => resolve(port))
  })
  srv.on('error', reject)
})

async function pollHttp(url, expect, budgetMs, what) {
  const deadline = Date.now() + budgetMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const body = (await res.text()).trim()
        if (!expect || body.includes(expect)) return body
        lastErr = `body=${body.slice(0, 80)}`
      } else lastErr = `http ${res.status}`
    } catch (e) { lastErr = e?.cause?.code ?? e.message }
    await new Promise((r) => setTimeout(r, 500))
  }
  fail(`${what} 超预算 ${budgetMs / 1000}s 未就绪(最后一次:${lastErr})`)
}

// ---- 发布清单:packages/* 全部非 private 包 -------------------------------
const expected = []
for (const dir of readdirSync(join(ROOT, 'packages')).sort()) {
  const f = join(ROOT, 'packages', dir, 'package.json')
  if (!existsSync(f)) continue
  const pkg = JSON.parse(readFileSync(f, 'utf8'))
  if (!pkg.private) expected.push({ name: pkg.name, version: pkg.version })
}
const cliVersion = expected.find((p) => p.name === '@gotong/cli')?.version
say(`发布清单 ${expected.length} 包(cli v${cliVersion})`)

// ---- 1) verdaccio --------------------------------------------------------
tmp = mkdtempSync(join(tmpdir(), 'gotong-npx-smoke-'))
const vPort = await freePort()
const reg = `http://127.0.0.1:${vPort}/`
const vLog = join(tmp, 'verdaccio.log')
writeFileSync(join(tmp, 'verdaccio.yaml'), [
  `storage: ${join(tmp, 'storage')}`,
  'auth:',
  '  htpasswd:',
  `    file: ${join(tmp, 'htpasswd')}`,
  'uplinks:',
  '  npmjs:',
  '    url: https://registry.npmjs.org/',
  // 熔断器实质关掉:verdaccio 默认 max_fails=2,上游两次抖动就熔断 5 分钟,
  // 期间一切代理请求 1-2ms 秒答 404;npm 对 404 不重试,冷装当场死。
  // 抖动网络上拉几百个 packument,默认值等于必炸。
  '    max_fails: 9999',
  '    fail_timeout: 1s',
  '    timeout: 60s',
  '    maxage: 30m',
  'packages:',
  // @gotong/* 与 gotong 只认本地发布,绝不上游代理——漏发就该 404,不该被真 npm 兜住。
  "  '@gotong/*': { access: $all, publish: $all }",
  "  'gotong': { access: $all, publish: $all }",
  "  '**': { access: $all, proxy: npmjs }",
  'max_body_size: 64mb',
  'log: { type: stdout, level: warn }',
].join('\n'))
const verdaccio = spawn('pnpm', ['exec', 'verdaccio', '--config', join(tmp, 'verdaccio.yaml'), '--listen', `127.0.0.1:${vPort}`], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
procs.push(verdaccio)
verdaccio.stdout.on('data', (d) => appendFileSync(vLog, d))
verdaccio.stderr.on('data', (d) => appendFileSync(vLog, d))
await pollHttp(`${reg}-/ping`, '', 60_000, 'verdaccio 起动')
say(`verdaccio 就绪 ${reg}`)

// ---- 2) 全量发布 ----------------------------------------------------------
// 假 token 让 npm 客户端闭嘴;verdaccio 侧 publish:$all 收匿名。
const npmrc = join(tmp, 'npmrc')
writeFileSync(npmrc, [
  `registry=${reg}`,
  `//127.0.0.1:${vPort}/:_authToken=gotong-rehearsal-not-a-secret`,
  'fetch-retries=5',
  'fetch-retry-maxtimeout=60000',
].join('\n') + '\n')
say('pnpm -r publish(prepack 自建,可能要几分钟)…')
const pubLog = join(tmp, 'publish.log')
try {
  execFileSync('pnpm', ['-r', 'publish', '--registry', reg, '--no-git-checks'], {
    cwd: ROOT,
    env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60_000,
  })
} catch (e) {
  writeFileSync(pubLog, `${e.stdout ?? ''}\n${e.stderr ?? ''}`)
  fail('pnpm -r publish 失败', pubLog, vLog)
}
say('发布完成')

// ---- 3) 逐包核验 ----------------------------------------------------------
const missing = []
for (const { name, version } of expected) {
  const res = await fetch(reg + name.replace('/', '%2f'))
  if (!res.ok) { missing.push(`${name}(http ${res.status})`); continue }
  const doc = await res.json()
  if (!doc.versions?.[version]) missing.push(`${name}@${version}(registry 里只有 ${Object.keys(doc.versions ?? {}).join(',') || '空'})`)
}
if (missing.length) fail(`发布清单缺口 ${missing.length}/${expected.length}:\n  ${missing.join('\n  ')}`)
say(`逐包核验 ${expected.length}/${expected.length} ✓`)

// ---- 4) 干净目录 npx --version --------------------------------------------
// 环境白名单 = 剥掉一切 key/token:用户的 npx 没有我们的环境,彩排也不许有。
const appDir = join(tmp, 'app')
mkdirSync(appDir)
// npm cache 放稳定目录跨次复用,不随本次 tmp 陪葬:packument 解析与
// @gotong tarball 永远走本轮 verdaccio(端口随机=缓存键必失效;重发布
// integrity 必变),缓存只省外部依赖的 tarball 字节——门的判别力不变,
// 省的是每跑一次门就重付一次的十几分钟外网冷拉。
// 但 _npx 里已装好的闭包必须逐次驱逐:npx 按「spec→版本」复用旧安装,
// @gotong 版本号不变、字节已变的重发布会被它拿上一轮的陈货糊弄过门。
const npmCache = join(tmpdir(), 'gotong-npx-smoke-npm-cache')
rmSync(join(npmCache, '_npx'), { recursive: true, force: true })
const cleanEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,           // node-gyp / 预编译工具链要它
  TMPDIR: tmp,
  CI: '1',
  NPM_CONFIG_USERCONFIG: npmrc,     // registry 指向 verdaccio
  npm_config_cache: npmCache,
}
say('npx -y gotong --version(首跑冷装完整闭包最慢;cache 热后分钟级)…')
const npxLog = join(tmp, 'npx.log')
let ver = ''
try {
  ver = execFileSync('npx', ['-y', 'gotong', '--version'], {
    cwd: appDir, env: cleanEnv, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024,
  }).trim()
} catch (e) {
  writeFileSync(npxLog, `${e.stdout ?? ''}\n${e.stderr ?? ''}`)
  fail('npx gotong --version 失败(装不回来/bin 断链)', npxLog, vLog)
}
if (ver.split('\n').pop() !== cliVersion) fail(`--version 打出「${ver}」,期望 ${cliVersion}`)
say(`npx 安装+版本 ✓(${ver})`)

// ---- 5) npx gotong start → healthz ---------------------------------------
const webPort = await freePort()
const wsPort = await freePort()
const hostLog = join(tmp, 'host.log')
const host = spawn('npx', ['-y', 'gotong', 'start'], {
  cwd: appDir,
  env: {
    ...cleanEnv,
    GOTONG_SPACE: join(tmp, 'space'),
    GOTONG_HOST: '127.0.0.1',
    GOTONG_WEB_PORT: String(webPort),
    GOTONG_WS_PORT: String(wsPort),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
procs.push(host)
host.stdout.on('data', (d) => appendFileSync(hostLog, d))
host.stderr.on('data', (d) => appendFileSync(hostLog, d))
host.on('exit', (code) => { if (code !== null && code !== 0) fail(`host 提前退出 code=${code}`, hostLog) })
await pollHttp(`http://127.0.0.1:${webPort}/healthz`, 'ok', 180_000, 'npx gotong start → healthz')
say(`host healthz ok(web:${webPort})`)
try { process.kill(-host.pid, 'SIGTERM') } catch { host.kill('SIGTERM') }
await new Promise((r) => { host.on('close', r); setTimeout(r, 5000) })

cleanup()
console.log(`✓ npx-smoke: ${expected.length} 包发布→核验→npx 冷装→--version=${cliVersion}→host healthz ok,全链 ${elapsed()}`)
