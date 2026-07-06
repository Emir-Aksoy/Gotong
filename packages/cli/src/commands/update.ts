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
 * Exit codes: 0 updated / already current / portable pointer · 1 usage ·
 * 2 form can't self-update (rsync deploy, unknown) · 3 git refused (dirty
 * tree or non-fast-forward) · 4 install/build failed (dist.prev restored) —
 * npm-form failures also map here.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
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
  out?: (line: string) => void
  err?: (line: string) => void
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
  if (args.length > 0) {
    err(`[gotong update] 不认识的参数: ${args.join(' ')}`)
    printHelp('update')
    return 1
  }

  const selfDir = deps.selfDir ?? dirname(fileURLToPath(import.meta.url))
  const detected = detectInstallForm(selfDir)

  if (detected.form === 'portable') {
    out('[gotong update] 便携包形态 — 包内自带 runtime,不做原地更新。')
    out('  更新 = 下载新包解压替换整个 bundle 目录;数据目录在包外,原样保留。')
    out('  下载与校验步骤见 docs/zh/PORTABLE-BUNDLE.md。')
    return 0
  }
  if (detected.form === 'npm') {
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

  // untracked-files=no: only edits to TRACKED files block the update — a
  // production checkout legitimately carries untracked strays (dist, logs,
  // data dirs); if one truly collides with an incoming file, the ff merge
  // itself refuses and we relay that.
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
