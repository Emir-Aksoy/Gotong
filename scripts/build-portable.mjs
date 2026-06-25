/**
 * Portable bundle builder (装运行时墙 — 嵌入式运行时便携包).
 *
 * The whole onboarding story dies BEFORE startup for a non-technical user at
 * three walls: 认知 / 获取 / **装运行时**. This script tears down the third
 * one. It produces a double-click folder that runs AipeHub with ZERO system
 * Node and ZERO Docker — a pinned Node binary, the compiled host, and a real
 * on-disk prod `node_modules` closure (including the prebuilt native
 * `better_sqlite3.node`) packaged side by side.
 *
 * Why a folder and not a single file
 * ----------------------------------
 * `better-sqlite3` is the ONE native addon in the runtime dep tree, and it is
 * load-bearing — the entire v4 identity layer is SQLite. Node SEA can't embed
 * a `.node`; `bun --compile` boots the web server but `better-sqlite3` can't
 * be dlopen'd out of the embedded `/$bunfs/` FS, so identity + the SQLite
 * datastore plugin silently fall away. A real Node binary resolving a real
 * on-disk `node_modules` is the only route that delivers FULL capability —
 * and `isCompiledBinary()` (services/builtin-plugins.ts) returns false under
 * real Node, so the host already takes its full-capability path here.
 *
 * How the closure is assembled
 * ----------------------------
 * `pnpm --filter @aipehub/host deploy --prod <out>/app` produces a real,
 * dereferenced prod `node_modules` — native addon + every `@aipehub/*`
 * workspace package + the dynamically-imported service plugins + the IM
 * bridges — with no bundler and no hand-curation. Nothing for a newcomer to
 * break. (tsx/vite are devDeps; the host runs `dist/main.js` under plain Node,
 * so the `.bin/tsx` deploy WARN is expected and harmless.)
 *
 * Bundle layout produced:
 *   <out>/AipeHub-<platform>-<arch>/
 *   ├── AipeHub.command        ← copied from deploy/AipeHub.command (tier-0 self-contained branch)
 *   ├── BUNDLE-INFO.txt        ← platform / node version / build stamp
 *   ├── runtime/bin/node       ← pinned Node binary (this machine's, by default)
 *   └── app/                   ← pnpm deploy --prod output (host package root)
 *       ├── dist/main.js       ← host ENTRY the launcher execs
 *       └── node_modules/      ← full prod closure incl. better-sqlite3 prebuild
 *
 * 承重 GATE (runs by default, the entire point of this script): after
 * assembly, boot the deployed host WITH THE BUNDLE'S OWN pinned node against a
 * throwaway space + random ports + AIPE_OPEN_BROWSER=0, then assert
 * `/healthz` → 200 AND the boot log shows the SQLite datastore plugin ready
 * AND identity bootstrapped AND no `bootstrap failed`. That proves the
 * deployed node_modules lets identity + native sqlite + the dynamic plugins
 * all resolve on a clean machine — not a mock, a real boot.
 *
 * Usage:
 *   node scripts/build-portable.mjs                 # build + boot proof (darwin-arm64)
 *   node scripts/build-portable.mjs --tar           # also write a .tar.gz
 *   node scripts/build-portable.mjs --skip-build    # reuse existing package dist
 *   node scripts/build-portable.mjs --no-verify     # skip the boot proof
 *   node scripts/build-portable.mjs --node /path/to/node   # pin a specific node binary
 *   node scripts/build-portable.mjs --out some/dir  # output base dir (default dist-portable)
 *
 * Platform: builds for THIS machine's platform/arch only — the native
 * better-sqlite3 prebuild can't be cross-built. Linux-x64 / mac-x64 / Windows
 * are the same script run on those machines (deferred this round).
 *
 * Exit codes: 0 = bundle built (and boot proof passed, unless --no-verify) ·
 * 1 = a step failed (build / deploy / missing artifact / boot proof).
 */

import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import {
  rmSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  existsSync,
  writeFileSync,
  mkdtempSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import http from 'node:http'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2)
function flag(name) {
  return argv.includes(name)
}
function opt(name, fallback) {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
if (flag('--help') || flag('-h')) {
  console.log(
    [
      'build-portable — assemble a double-click, zero-Node portable bundle',
      '',
      '  --out <dir>      output base dir (default: dist-portable)',
      '  --node <path>    pin a specific node binary (default: this process)',
      '  --tar            also write a .tar.gz next to the bundle',
      '  --skip-build     reuse existing package dist (skip `pnpm -r build`)',
      '  --no-verify      skip the boot proof (NOT recommended)',
      '',
      'Builds for this machine\'s platform/arch only (native addon can\'t cross-build).',
    ].join('\n'),
  )
  process.exit(0)
}

const OUT_BASE = isAbsolute(opt('--out', 'dist-portable'))
  ? opt('--out', 'dist-portable')
  : join(REPO_ROOT, opt('--out', 'dist-portable'))
const NODE_BIN = resolve(opt('--node', process.execPath))
const DO_BUILD = !flag('--skip-build')
const DO_TAR = flag('--tar')
const DO_VERIFY = !flag('--no-verify')

// --- platform label ---------------------------------------------------------
// darwin→macos so the folder name reads like a download a person recognizes.
const PLATFORM_LABEL = { darwin: 'macos', linux: 'linux', win32: 'win' }[process.platform] || process.platform
const BUNDLE_NAME = `AipeHub-${PLATFORM_LABEL}-${process.arch}`
const BUNDLE_DIR = join(OUT_BASE, BUNDLE_NAME)
const APP_DIR = join(BUNDLE_DIR, 'app')

// --- small helpers ----------------------------------------------------------
function step(msg) {
  console.log(`\n▸ ${msg}`)
}
function die(msg) {
  console.error(`\n✖ ${msg}`)
  process.exit(1)
}
function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT, ...opts })
  if (r.status !== 0) die(`command failed (exit ${r.status ?? r.signal}): ${cmd} ${args.join(' ')}`)
}
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms))
}
function dirSizeHuman(p) {
  const r = spawnSync('du', ['-sh', p], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim().split('\t')[0] : '?'
}

// --- assemble ---------------------------------------------------------------
console.log(`AipeHub portable bundle → ${BUNDLE_NAME}`)
console.log(`  repo:   ${REPO_ROOT}`)
console.log(`  node:   ${NODE_BIN} (${process.version})`)
console.log(`  out:    ${BUNDLE_DIR}`)

if (DO_BUILD) {
  step('build all packages (pnpm -r build)')
  run('pnpm', ['-r', 'build'])
} else {
  step('skip build (--skip-build) — reusing existing dist')
}

step('clean bundle dir')
rmSync(BUNDLE_DIR, { recursive: true, force: true })
mkdirSync(BUNDLE_DIR, { recursive: true })

step('deploy host prod closure (pnpm deploy --prod)')
// Absolute target removes any relative-path ambiguity in `pnpm --filter`.
run('pnpm', ['--filter', '@aipehub/host', 'deploy', '--prod', APP_DIR])

step('verify deployed artifacts')
const ENTRY = join(APP_DIR, 'dist', 'main.js')
const SQLITE_NODE = join(
  APP_DIR,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
)
if (!existsSync(ENTRY)) die(`host entry missing after deploy: ${ENTRY}`)
if (!existsSync(SQLITE_NODE))
  die(`native better-sqlite3 prebuild missing after deploy: ${SQLITE_NODE}\n  (the bundle would boot WITHOUT identity/sqlite — refusing to ship it)`)
console.log(`  ok  ${ENTRY}`)
console.log(`  ok  ${SQLITE_NODE} (${(statSync(SQLITE_NODE).size / 1024).toFixed(0)} KB native addon)`)

step('copy pinned node runtime')
const RUNTIME_BIN = join(BUNDLE_DIR, 'runtime', 'bin')
mkdirSync(RUNTIME_BIN, { recursive: true })
const BUNDLED_NODE = join(RUNTIME_BIN, 'node')
copyFileSync(NODE_BIN, BUNDLED_NODE)
chmodSync(BUNDLED_NODE, 0o755)
console.log(`  ok  ${BUNDLED_NODE}`)

step('copy launcher (deploy/AipeHub.command)')
const LAUNCHER_SRC = join(REPO_ROOT, 'deploy', 'AipeHub.command')
if (!existsSync(LAUNCHER_SRC)) die(`launcher not found: ${LAUNCHER_SRC}`)
const LAUNCHER_DST = join(BUNDLE_DIR, 'AipeHub.command')
copyFileSync(LAUNCHER_SRC, LAUNCHER_DST)
chmodSync(LAUNCHER_DST, 0o755)
console.log(`  ok  ${LAUNCHER_DST}`)

step('write BUNDLE-INFO.txt')
const gitSha = (() => {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
})()
writeFileSync(
  join(BUNDLE_DIR, 'BUNDLE-INFO.txt'),
  [
    `AipeHub portable bundle`,
    `platform:    ${PLATFORM_LABEL}-${process.arch}`,
    `node:        ${process.version}`,
    `git:         ${gitSha}`,
    `built:       ${new Date().toISOString()}`,
    `entry:       app/dist/main.js`,
    ``,
    `Double-click AipeHub.command. Data lives in ~/.aipehub (outside this folder).`,
    `Zero system Node/Docker required — the runtime ships inside runtime/bin/node.`,
    ``,
  ].join('\n'),
)
console.log(`  ok  BUNDLE-INFO.txt (git ${gitSha})`)

// --- 承重 boot proof --------------------------------------------------------
async function bootProof() {
  step('承重 boot proof — boot the bundle with its OWN node')
  const space = mkdtempSync(join(tmpdir(), 'aipe-portable-verify-'))
  const webPort = 38000 + Math.floor(Math.random() * 1500)
  const wsPort = webPort + 1
  console.log(`  space:  ${space}`)
  console.log(`  ports:  web=${webPort} ws=${wsPort}`)

  const child = spawn(BUNDLED_NODE, [ENTRY], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      AIPE_SPACE: space,
      AIPE_WEB_PORT: String(webPort),
      AIPE_WS_PORT: String(wsPort),
      AIPE_OPEN_BROWSER: '0',
      AIPE_LOG_FORMAT: 'json',
    },
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  let exited = null
  child.on('exit', (code, signal) => (exited = signal || code))

  function healthz() {
    return new Promise((res) => {
      const req = http.get({ host: '127.0.0.1', port: webPort, path: '/healthz', timeout: 1500 }, (r) => {
        r.resume()
        res(r.statusCode)
      })
      req.on('error', () => res(0))
      req.on('timeout', () => {
        req.destroy()
        res(0)
      })
    })
  }

  let status = 0
  for (let i = 0; i < 60 && status !== 200 && exited === null; i++) {
    await sleep(500)
    status = await healthz()
  }

  const cleanup = () => {
    try {
      child.kill('SIGTERM')
    } catch {}
    try {
      rmSync(space, { recursive: true, force: true })
    } catch {}
  }

  if (exited !== null && status !== 200) {
    cleanup()
    die(`host exited before listening (${exited}). Boot log tail:\n${log.slice(-2000)}`)
  }
  if (status !== 200) {
    cleanup()
    die(`/healthz never returned 200 (got ${status}). Boot log tail:\n${log.slice(-2000)}`)
  }
  console.log(`  ok  /healthz → 200`)

  // Full-capability assertions: identity bootstrapped AND the SQLite datastore
  // plugin (the dynamic, native-addon one bun can't reach) actually loaded.
  const must = ['bootstrapped owner', 'datastore:sqlite']
  const forbidden = ['bootstrap failed', 'fatal']
  const missing = must.filter((m) => !log.includes(m))
  const present = forbidden.filter((f) => log.includes(f))
  cleanup()
  if (missing.length) die(`boot log missing required signal(s): ${missing.join(', ')}\n${log.slice(-2000)}`)
  if (present.length) die(`boot log shows failure signal(s): ${present.join(', ')}\n${log.slice(-2000)}`)
  console.log(`  ok  identity bootstrapped + datastore:sqlite plugin ready (full capability)`)
}

// --- optional tarball -------------------------------------------------------
function makeTar() {
  step('tar.gz')
  const tarPath = join(OUT_BASE, `${BUNDLE_NAME}.tar.gz`)
  rmSync(tarPath, { force: true })
  run('tar', ['-czf', tarPath, '-C', OUT_BASE, BUNDLE_NAME])
  console.log(`  ok  ${tarPath} (${dirSizeHuman(tarPath)})`)
}

// --- main -------------------------------------------------------------------
;(async () => {
  if (DO_VERIFY) {
    await bootProof()
  } else {
    step('skip boot proof (--no-verify)')
  }
  if (DO_TAR) makeTar()

  console.log(`\n✓ portable bundle ready: ${BUNDLE_DIR} (${dirSizeHuman(BUNDLE_DIR)})`)
  console.log(`  double-click ${BUNDLE_NAME}/AipeHub.command — zero system Node/Docker.`)
})().catch((e) => die(String(e?.stack || e)))
