/**
 * `gotong update` — KIT-M3: detect HOW this Gotong was installed, update that
 * form in place, never touch the running service (重启权在运维手里).
 *
 * Form detection walks UP from the CLI's own location (injectable for tests):
 *   - a `BUNDLE-INFO.txt` ancestor        → portable bundle: no in-place update
 *     (the runtime/node inside is part of the artifact) — point at the new
 *     download; the data dir is outside the bundle and carries over.
 *   - `pnpm-workspace.yaml` + packages/host with a `.git`
 *                                         → git checkout: fetch → `merge
 *     --ff-only` (the SAME discipline cloud-quickstart uses — local edits or
 *     a fork ABORT, never a reset), move every package's `dist` aside to
 *     `dist.prev`, `pnpm install --frozen-lockfile && pnpm build
 *     --workspace-concurrency=1` (serial build: measured 417MB peak, safe on
 *     small boxes), then drop the `.prev`s — or, on a red build, restore them
 *     so the service can keep running the OLD dist while you fix things.
 *   - same but WITHOUT `.git`             → an rsync-style deploy: the box has
 *     no history to pull; update the SOURCE checkout and re-sync (or redeploy
 *     with --clone). Refused honestly rather than guessed at.
 *   - a `node_modules` path segment       → global npm install: run
 *     `npm i -g gotong@latest` (real once PUB-M3 publishes; the failure is
 *     relayed verbatim until then).
 *
 * After a successful git update the workspace re-validates via `gotong check`
 * (a red check WARNS but does not fail the update — the code moved forward,
 * config problems are the check's story), and the restart commands are
 * PRINTED (systemd + foreground), never run.
 *
 * `--check` (perf audit B②) answers "is there a newer version" WITHOUT
 * touching anything — the on-demand half of new-version notification (the
 * opt-in background half is the host's GOTONG_UPDATE_CHECK probe):
 *   - git form: `git fetch` + rev compare against origin (asks YOUR remote,
 *     never npm; a dirty tree doesn't block a read-only check).
 *   - npm / portable / rsync forms: GET the npm registry's `latest` dist-tag
 *     for the unscoped `gotong` meta package and compare it with this CLI's
 *     own package.json version (all packages share one version). Network
 *     runs only because you asked — the default `gotong update` on these
 *     forms already talks to the same places.
 *
 * Exit codes: 0 updated / already current / portable pointer · 1 usage ·
 * 2 form can't self-update (rsync deploy, unknown) · 3 git refused (dirty
 * tree or non-fast-forward; --check: fetch failed) · 4 install/build failed
 * (dist.prev restored) — npm-form and --check-probe failures also map here ·
 * 5 --check only: a newer version exists (scriptable: `gotong update --check
 * || alert`).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { check } from './check.js'
import { printHelp } from './help.js'

export type InstallForm =
  | { form: 'git'; root: string }
  | { form: 'checkout-no-git'; root: string }
  | { form: 'portable'; root: string }
  | { form: 'npm' }
  | { form: 'unknown' }

/** Walk up from `startDir` and classify the install (see file header). */
export function detectInstallForm(startDir: string): InstallForm {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, 'BUNDLE-INFO.txt'))) return { form: 'portable', root: dir }
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'packages', 'host'))) {
      return existsSync(join(dir, '.git'))
        ? { form: 'git', root: dir }
        : { form: 'checkout-no-git', root: dir }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (resolve(startDir).split(sep).includes('node_modules')) return { form: 'npm' }
  return { form: 'unknown' }
}

/** Injectable seams: the git fixture is real, the heavyweight steps are not. */
export interface UpdateDeps {
  /** Where to start form detection (default: this module's directory). */
  selfDir?: string
  /** install+build step; return the exit code (default: real pnpm, serial build). */
  runBuild?: (root: string) => number
  /** post-update validation (default: the real `gotong check`). */
  runCheck?: () => Promise<number>
  /** the npm-form updater (default: real `npm i -g gotong@latest`). */
  runNpmInstall?: () => number
  /** --check: npm registry probe (default: GET the `gotong` dist-tags). */
  fetchLatestVersion?: () => Promise<string>
  /** --check: this install's own version (default: the CLI's package.json). */
  readSelfVersion?: () => Promise<string | null>
  out?: (line: string) => void
  err?: (line: string) => void
}

// ── --check version compare (B②) ────────────────────────────────────────────
// A deliberate small copy of the host's semver-triple helpers: the CLI stays
// dependency-tiny on purpose, and 10 lines don't justify a package edge.

/** `[major,minor,patch]` or null; prerelease/build suffixes compare by triple. */
export function parseSemverTriple(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+]|$)/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

async function fetchLatestReal(): Promise<string> {
  const res = await fetch('https://registry.npmjs.org/-/package/gotong/dist-tags', {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`registry answered ${res.status}`)
  const body = (await res.json()) as { latest?: unknown }
  if (typeof body.latest !== 'string' || !body.latest) throw new Error('no latest dist-tag')
  return body.latest
}

async function readSelfVersionReal(): Promise<string | null> {
  try {
    // here = dist/commands (built) or src/commands (vitest) — package.json is
    // two levels up either way (same trick as main.ts's --version).
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = await readFile(join(here, '..', '..', 'package.json'), 'utf8')
    const v = (JSON.parse(raw) as { version?: string }).version
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/**
 * The non-git `--check`: registry `latest` vs this install's own version.
 * Exit 0 current · 5 newer available (prints `applyHint`) · 4 no reliable
 * answer (network / unparseable — never guessed into a verdict).
 */
async function registryCheck(
  deps: UpdateDeps,
  out: (l: string) => void,
  err: (l: string) => void,
  applyHint: string,
): Promise<number> {
  let latest: string
  try {
    latest = await (deps.fetchLatestVersion ?? fetchLatestReal)()
  } catch (e) {
    err(`[gotong update] 拿不到最新版本号(${e instanceof Error ? e.message : String(e)})— 网络或 registry 问题,稍后再试。`)
    return 4
  }
  const self = await (deps.readSelfVersion ?? readSelfVersionReal)()
  const cur = self ? parseSemverTriple(self) : null
  const lat = parseSemverTriple(latest)
  if (!cur || !lat) {
    err(`[gotong update] 版本串认不出(本机 ${self ?? '未知'} / npm latest ${latest})— 无法可靠对比。`)
    return 4
  }
  // First differing position decides; local ahead of the registry (dev checkout) = current.
  const cmp = lat[0] !== cur[0] ? lat[0] - cur[0] : lat[1] !== cur[1] ? lat[1] - cur[1] : lat[2] - cur[2]
  if (cmp > 0) {
    out(`[gotong update] 有新版: ${self} → ${latest}`)
    out(`  ${applyHint}`)
    return 5
  }
  out(`[gotong update] 已是最新 (本机 ${self},npm latest ${latest})。`)
  return 0
}

function git(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() }
}

/** Every package dist dir that exists right now (the rollback set). */
function distDirs(root: string): string[] {
  const pkgs = join(root, 'packages')
  let names: string[] = []
  try {
    names = readdirSync(pkgs)
  } catch {
    return []
  }
  return names.map((n) => join(pkgs, n, 'dist')).filter((d) => existsSync(d))
}

const RESTART_HINT = [
  '重启不代跑 —— 服务还在跑旧代码,由你挑时间执行其一:',
  '  systemd:  sudo systemctl restart gotong',
  '  前台:     gotong start   (先停掉旧进程)',
]

export async function update(args: readonly string[], deps: UpdateDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => { console.log(l) })
  const err = deps.err ?? ((l: string) => { console.error(l) })
  if (args.includes('--help') || args.includes('-h')) {
    printHelp('update')
    return 0
  }
  const checkOnly = args.includes('--check')
  const stray = args.find((a) => a !== '--check')
  if (stray !== undefined) {
    err(`[gotong update] 不认识的参数: ${stray}`)
    printHelp('update')
    return 1
  }

  const selfDir = deps.selfDir ?? dirname(fileURLToPath(import.meta.url))
  const detected = detectInstallForm(selfDir)

  if (detected.form === 'portable') {
    if (checkOnly) {
      return registryCheck(deps, out, err, '便携包更新 = 下载新包解压替换整个 bundle 目录(数据在包外);见 docs/zh/PORTABLE-BUNDLE.md。')
    }
    out('[gotong update] 便携包形态 — 包内自带 runtime,不做原地更新。')
    out('  更新 = 下载新包解压替换整个 bundle 目录;数据目录在包外,原样保留。')
    out('  下载与校验步骤见 docs/zh/PORTABLE-BUNDLE.md。')
    return 0
  }
  if (detected.form === 'npm') {
    if (checkOnly) {
      return registryCheck(deps, out, err, '应用更新: gotong update(会跑 npm i -g gotong@latest)。')
    }
    out('[gotong update] 全局 npm 安装形态 — 交给 npm:')
    out('  npm i -g gotong@latest')
    const code = deps.runNpmInstall
      ? deps.runNpmInstall()
      : (spawnSync('npm', ['i', '-g', 'gotong@latest'], { stdio: 'inherit' }).status ?? 1)
    if (code !== 0) {
      err(`[gotong update] npm 安装失败 (exit ${code}) —— 输出如上,原样转达。`)
      return 4
    }
    for (const l of RESTART_HINT) out(l)
    return 0
  }
  if (detected.form === 'checkout-no-git') {
    if (checkOnly) {
      // The question "is there a newer release" is still answerable here even
      // though APPLYING one isn't (that stays the exit-2 refusal below).
      return registryCheck(deps, out, err, '这台是 rsync 副本:在源 checkout 上更新后重新同步过来。')
    }
    err('[gotong update] 这是一份没有 .git 的部署副本(rsync 形态),这台机器上没有可拉取的历史。')
    err('  更新姿势: 在源 checkout 上 gotong update(或 git pull)后重新 rsync 过来;')
    err('  或改用 cloud-quickstart.sh --clone 部署,之后就能原地 update。')
    return 2
  }
  if (detected.form === 'unknown') {
    err('[gotong update] 认不出安装形态(不在 git checkout / 便携包 / 全局 npm 任何一种里)。')
    err('  git checkout 里跑它、便携包换新包、npm 全局装用 npm i -g gotong@latest。')
    return 2
  }

  // ── git form ────────────────────────────────────────────────────────────────
  const root = detected.root
  out(`[gotong update] git checkout: ${root}`)

  if (!checkOnly) {
    // untracked-files=no: only edits to TRACKED files block the update — a
    // production checkout legitimately carries untracked strays (dist, logs,
    // data dirs); if one truly collides with an incoming file, the ff merge
    // itself refuses and we relay that. --check skips this: a read-only
    // compare has nothing to protect.
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=no'])
    if (dirty.status !== 0) {
      err(`[gotong update] git status 失败: ${dirty.stderr}`)
      return 3
    }
    if (dirty.stdout.length > 0) {
      err('[gotong update] 工作区有未提交改动 —— 不代解决(纪律与 cloud-quickstart 同:绝不覆盖你的本地编辑)。')
      err('  先 git stash / commit / checkout -- 处理干净,再重跑。改动:')
      for (const l of dirty.stdout.split('\n').slice(0, 10)) err(`    ${l}`)
      return 3
    }
  }

  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || 'main'
  const fetch = git(root, ['fetch', 'origin', branch])
  if (fetch.status !== 0) {
    err(`[gotong update] git fetch origin ${branch} 失败: ${fetch.stderr}`)
    return 3
  }
  const local = git(root, ['rev-parse', 'HEAD']).stdout
  const remote = git(root, ['rev-parse', `origin/${branch}`]).stdout
  if (local === remote) {
    out(`[gotong update] 已是最新 (${branch} @ ${local.slice(0, 7)}),什么都不用做。`)
    return 0
  }
  if (checkOnly) {
    // Count only commits WE lack; a local-ahead-only checkout (unpushed dev
    // work) is current, not behind.
    const behind = Number(git(root, ['rev-list', '--count', `HEAD..origin/${branch}`]).stdout || '0')
    if (behind === 0) {
      out(`[gotong update] 已是最新 (本地还领先 origin/${branch},没有可拉取的新 commit)。`)
      return 0
    }
    out(`[gotong update] 有新版: origin/${branch} 领先 ${behind} 个 commit (${local.slice(0, 7)} → ${remote.slice(0, 7)})。`)
    out('  应用更新: gotong update')
    return 5
  }

  const merge = git(root, ['merge', '--ff-only', `origin/${branch}`])
  if (merge.status !== 0) {
    err('[gotong update] 非快进 —— 本地分支与 origin 分叉了,不代裁决(绝不 reset/强合)。')
    err(`  ${merge.stderr}`)
    err('  看看本地多出的 commit: git log origin/' + branch + '..HEAD --oneline')
    return 3
  }
  out(`[gotong update] ${branch}: ${local.slice(0, 7)} → ${remote.slice(0, 7)} (fast-forward)`)

  // Move every existing dist aside; a red build puts them back so the running
  // service keeps a WORKING artifact while you fix the build.
  const dists = distDirs(root)
  for (const d of dists) {
    rmSync(`${d}.prev`, { recursive: true, force: true })
    renameSync(d, `${d}.prev`)
  }
  out(`[gotong update] 构建 (串行 --workspace-concurrency=1;现有 ${dists.length} 个 dist 已挪到 dist.prev)…`)

  const buildCode = deps.runBuild
    ? deps.runBuild(root)
    : (() => {
        const i = spawnSync('pnpm', ['install', '--frozen-lockfile'], { cwd: root, stdio: 'inherit' })
        if ((i.status ?? 1) !== 0) return i.status ?? 1
        const b = spawnSync('pnpm', ['build', '--workspace-concurrency=1'], { cwd: root, stdio: 'inherit' })
        return b.status ?? 1
      })()

  if (buildCode !== 0) {
    for (const d of dists) {
      rmSync(d, { recursive: true, force: true }) // whatever half-build produced
      if (existsSync(`${d}.prev`)) renameSync(`${d}.prev`, d)
    }
    err(`[gotong update] 构建失败 (exit ${buildCode}) —— 已把 ${dists.length} 个 dist.prev 还原,服务可继续跑旧产物。`)
    err('  代码已在新 commit 上;修好构建后重跑 gotong update(或 pnpm build)。')
    return 4
  }
  for (const d of dists) rmSync(`${d}.prev`, { recursive: true, force: true })
  out('[gotong update] 构建绿,dist.prev 已清。')

  // Post-update validation — advisory: the update SUCCEEDED; a red check is
  // the workspace's story and would otherwise wedge update forever-red.
  const checkCode = await (deps.runCheck ? deps.runCheck() : check([]))
  if (checkCode !== 0) {
    err(`[gotong update] gotong check 有红项 (exit ${checkCode}) —— 更新本身已完成,按 check 输出修配置。`)
  }
  for (const l of RESTART_HINT) out(l)
  return 0
}
