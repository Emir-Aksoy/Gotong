/**
 * KIT-M3 — `gotong update` acceptance: a REAL git fixture (local bare remote
 * + working clone shaped like the monorepo root), with the heavyweight steps
 * (pnpm install/build, gotong check, npm -g) injected.
 *
 * Pinned, per the plan's acceptance line:
 *   - fast-forward update walks: fetch → merge --ff-only → dist.prev dance →
 *     build → restart hint printed, exit 0; second run says already-current
 *     WITHOUT building.
 *   - non-ff (diverged local commit) and a dirty tree are REFUSED (exit 3),
 *     HEAD untouched — never a reset, same discipline as cloud-quickstart.
 *   - a red build restores dist.prev byte-for-byte (exit 4) so the running
 *     service keeps a working artifact.
 *   - form detection: portable pointer (exit 0), rsync/no-git (2), unknown
 *     (2), npm (delegates to npm i -g), red check stays advisory (exit 0).
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { detectInstallForm, update, type UpdateDeps } from '../src/commands/update.js'

const cleanups: string[] = []
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(d)
  return d
}

function sh(cwd: string, cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`)
}

const GIT_ID = ['-c', 'user.email=t@t', '-c', 'user.name=t']

/** bare remote + working clone that LOOKS like the monorepo root. */
function mkRepo(): { bare: string; clone: string; distMarker: string } {
  const base = tmp('gotong-update-')
  const bare = join(base, 'origin.git')
  const seed = join(base, 'seed')
  const clone = join(base, 'clone')
  sh(base, 'git', ['init', '--bare', '-b', 'main', bare])
  sh(base, 'git', ['init', '-b', 'main', seed])
  writeFileSync(join(seed, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
  mkdirSync(join(seed, 'packages', 'host'), { recursive: true })
  writeFileSync(join(seed, 'packages', 'host', 'README.md'), 'host\n')
  sh(seed, 'git', ['add', '-A'])
  sh(seed, 'git', [...GIT_ID, 'commit', '-m', 'seed'])
  sh(seed, 'git', ['push', bare, 'main'])
  sh(base, 'git', ['clone', bare, clone])
  // dist is a BUILD artifact — present on disk, never tracked.
  const distMarker = join(clone, 'packages', 'pkg-a', 'dist', 'marker.txt')
  mkdirSync(join(clone, 'packages', 'pkg-a', 'dist'), { recursive: true })
  writeFileSync(distMarker, 'old')
  return { bare, clone, distMarker }
}

/** Push one more commit to the bare remote (from a scratch clone). */
function pushRemoteCommit(bare: string, file = 'NEWS.md'): void {
  const work = tmp('gotong-update-push-')
  sh(work, 'git', ['clone', bare, join(work, 'w')])
  writeFileSync(join(work, 'w', file), `${Math.random()}\n`)
  sh(join(work, 'w'), 'git', ['add', '-A'])
  sh(join(work, 'w'), 'git', [...GIT_ID, 'commit', '-m', 'remote change'])
  sh(join(work, 'w'), 'git', ['push', 'origin', 'main'])
}

function head(repo: string): string {
  return spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
}

interface TestDeps extends UpdateDeps {
  outArr: string[]
  errArr: string[]
}

function deps(clone: string, over: Partial<UpdateDeps> = {}): TestDeps {
  const outArr: string[] = []
  const errArr: string[] = []
  return {
    selfDir: join(clone, 'packages', 'host'), // any dir inside the checkout
    runBuild: () => 0,
    runCheck: async () => 0,
    out: (l) => outArr.push(l),
    err: (l) => errArr.push(l),
    ...over,
    outArr,
    errArr,
  }
}

describe('detectInstallForm', () => {
  it('classifies portable / git / checkout-no-git / npm / unknown', () => {
    const p = tmp('gotong-form-')
    // portable: BUNDLE-INFO.txt ancestor wins
    mkdirSync(join(p, 'bundle', 'app', 'deep'), { recursive: true })
    writeFileSync(join(p, 'bundle', 'BUNDLE-INFO.txt'), 'stamp')
    expect(detectInstallForm(join(p, 'bundle', 'app', 'deep'))).toEqual({
      form: 'portable',
      root: join(p, 'bundle'),
    })
    // checkout without .git → rsync deploy
    mkdirSync(join(p, 'deploy', 'packages', 'host'), { recursive: true })
    writeFileSync(join(p, 'deploy', 'pnpm-workspace.yaml'), '')
    expect(detectInstallForm(join(p, 'deploy', 'packages', 'host'))).toEqual({
      form: 'checkout-no-git',
      root: join(p, 'deploy'),
    })
    // npm: a node_modules path segment, no workspace above
    mkdirSync(join(p, 'node_modules', 'gotong', 'dist'), { recursive: true })
    expect(detectInstallForm(join(p, 'node_modules', 'gotong', 'dist'))).toEqual({ form: 'npm' })
    // unknown
    mkdirSync(join(p, 'nothing'), { recursive: true })
    expect(detectInstallForm(join(p, 'nothing'))).toEqual({ form: 'unknown' })
    // git: the real fixture
    const { clone } = mkRepo()
    expect(detectInstallForm(join(clone, 'packages', 'host'))).toEqual({ form: 'git', root: clone })
  })
})

describe('gotong update — git form', () => {
  it('fast-forwards, rebuilds (dist.prev dance), prints restart hint; second run is already-current without building', async () => {
    const { bare, clone, distMarker } = mkRepo()
    pushRemoteCommit(bare)
    const remoteHead = (() => {
      const w = tmp('gotong-update-check-')
      sh(w, 'git', ['clone', bare, join(w, 'w')])
      return head(join(w, 'w'))
    })()

    let built = 0
    const d = deps(clone, {
      runBuild: () => {
        built++
        mkdirSync(join(clone, 'packages', 'pkg-a', 'dist'), { recursive: true })
        writeFileSync(distMarker, 'new') // the rebuild recreates dist
        return 0
      },
    })
    const code = await update([], d)
    expect(code).toBe(0)
    expect(head(clone)).toBe(remoteHead)
    expect(built).toBe(1)
    expect(readFileSync(distMarker, 'utf8')).toBe('new')
    expect(existsSync(`${join(clone, 'packages', 'pkg-a', 'dist')}.prev`)).toBe(false)
    const text = d.outArr.join('\n')
    expect(text).toContain('fast-forward')
    expect(text).toContain('systemctl restart gotong')

    // already current: no second build
    const d2 = deps(clone, { runBuild: () => { built++; return 0 } })
    expect(await update([], d2)).toBe(0)
    expect(built).toBe(1)
    expect(d2.outArr.join('\n')).toContain('已是最新')
  })

  it('refuses a non-fast-forward (diverged local commit) — exit 3, HEAD untouched', async () => {
    const { bare, clone } = mkRepo()
    writeFileSync(join(clone, 'LOCAL.md'), 'local work\n')
    sh(clone, 'git', ['add', '-A'])
    sh(clone, 'git', [...GIT_ID, 'commit', '-m', 'local divergence'])
    pushRemoteCommit(bare)
    const before = head(clone)
    const d = deps(clone)
    expect(await update([], d)).toBe(3)
    expect(head(clone)).toBe(before)
    expect(d.errArr.join('\n')).toContain('非快进')
  })

  it('refuses a dirty tree — exit 3, nothing pulled', async () => {
    const { bare, clone } = mkRepo()
    pushRemoteCommit(bare)
    writeFileSync(join(clone, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n# edited\n")
    const before = head(clone)
    const d = deps(clone)
    expect(await update([], d)).toBe(3)
    expect(head(clone)).toBe(before)
    expect(d.errArr.join('\n')).toContain('未提交改动')
  })

  it('a red build restores dist.prev byte-for-byte — exit 4', async () => {
    const { bare, clone, distMarker } = mkRepo()
    pushRemoteCommit(bare)
    const d = deps(clone, {
      runBuild: () => {
        mkdirSync(join(clone, 'packages', 'pkg-a', 'dist'), { recursive: true })
        writeFileSync(distMarker, 'half-built') // simulate a partial build
        return 1
      },
    })
    expect(await update([], d)).toBe(4)
    expect(readFileSync(distMarker, 'utf8')).toBe('old')
    expect(existsSync(`${join(clone, 'packages', 'pkg-a', 'dist')}.prev`)).toBe(false)
    // the CODE moved forward (that's honest — only the artifact rolled back)
    expect(d.errArr.join('\n')).toContain('dist.prev 还原')
  })

  it('a red gotong check is advisory: warns but the update still exits 0', async () => {
    const { bare, clone } = mkRepo()
    pushRemoteCommit(bare)
    const d = deps(clone, { runCheck: async () => 1 })
    expect(await update([], d)).toBe(0)
    expect(d.errArr.join('\n')).toContain('check 有红项')
  })
})

describe('gotong update — other forms', () => {
  it('portable → pointer, exit 0; rsync deploy → exit 2; unknown → exit 2', async () => {
    const p = tmp('gotong-form2-')
    mkdirSync(join(p, 'bundle', 'app'), { recursive: true })
    writeFileSync(join(p, 'bundle', 'BUNDLE-INFO.txt'), 'stamp')
    const d1 = deps('', { selfDir: join(p, 'bundle', 'app') })
    expect(await update([], d1)).toBe(0)
    expect(d1.outArr.join('\n')).toContain('便携包')

    mkdirSync(join(p, 'deploy', 'packages', 'host'), { recursive: true })
    writeFileSync(join(p, 'deploy', 'pnpm-workspace.yaml'), '')
    const d2 = deps('', { selfDir: join(p, 'deploy') })
    expect(await update([], d2)).toBe(2)
    expect(d2.errArr.join('\n')).toContain('rsync')

    mkdirSync(join(p, 'lonely'), { recursive: true })
    const d3 = deps('', { selfDir: join(p, 'lonely') })
    expect(await update([], d3)).toBe(2)
  })

  it('npm form delegates to npm i -g; failure relays as exit 4', async () => {
    const p = tmp('gotong-form3-')
    mkdirSync(join(p, 'node_modules', 'gotong'), { recursive: true })
    let calls = 0
    const ok = deps('', { selfDir: join(p, 'node_modules', 'gotong'), runNpmInstall: () => { calls++; return 0 } })
    expect(await update([], ok)).toBe(0)
    expect(calls).toBe(1)
    expect(ok.outArr.join('\n')).toContain('npm i -g gotong@latest')

    const bad = deps('', { selfDir: join(p, 'node_modules', 'gotong'), runNpmInstall: () => 7 })
    expect(await update([], bad)).toBe(4)
  })

  it('usage: unknown args → exit 1', async () => {
    const d = deps('', { selfDir: tmp('gotong-form4-') })
    expect(await update(['--nope'], d)).toBe(1)
  })
})
