/**
 * MU-M5 承重门 — `snapshotMemoryTree`: the lightweight, best-effort git snapshot
 * of the butler's memory tree.
 *
 * Two layers of coverage:
 *   1. Injected-`GitRunner` unit tests — pin the state machine + the "never
 *      throws, honest outcome" contract without needing a real git binary:
 *      init-then-commit, skip-init-when-repo-exists, clean→nothing, and every
 *      failure path (init/add/commit non-zero, git-missing) → 'skipped'.
 *   2. Real-git integration — proves the produced repo behaves: it commits,
 *      no-ops on an unchanged tree, commits again on a change, and honors the
 *      transient-temp `.gitignore`. Skipped only if no `git` on PATH.
 */

import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@gotong/core'

import {
  execFileGitRunner,
  snapshotMemoryTree,
  type GitResult,
  type GitRunner,
} from '../src/butler-memory-git.js'

/** A logger that swallows everything but records `warn` calls (skip paths log warn). */
function capturingLogger(): { logger: Logger; warns: unknown[][] } {
  const warns: unknown[][] = []
  const logger: Logger = {
    trace() {}, debug() {}, info() {},
    warn(...a: unknown[]) { warns.push(a) },
    error() {}, fatal() {},
    child() { return logger },
  }
  return { logger, warns }
}

/** The git subcommand = the first arg that isn't a `-c key=val` override pair. */
function subOf(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') { i++; continue }
    return args[i] ?? ''
  }
  return ''
}

/**
 * A scripted `GitRunner`: maps a subcommand → a canned {@link GitResult} (or an
 * Error to simulate a spawn failure). Records the subcommands + full argv seen.
 * An unset subcommand defaults to a clean success (`code 0`, empty output) — so
 * `status` unset ⇒ "nothing changed".
 */
function scriptedRunner(script: Partial<Record<string, GitResult | Error>>): {
  git: GitRunner
  subs: string[]
  argv: string[][]
} {
  const subs: string[] = []
  const argv: string[][] = []
  const OK: GitResult = { code: 0, stdout: '', stderr: '' }
  const git: GitRunner = async (args) => {
    argv.push([...args])
    const sub = subOf(args)
    subs.push(sub)
    const r = script[sub] ?? OK
    if (r instanceof Error) throw r
    return r
  }
  return { git, subs, argv }
}

describe('snapshotMemoryTree — best-effort git snapshot (injected runner)', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gotong-memgit-unit-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('no repo yet → inits, writes .gitignore, stages, commits', async () => {
    const { git, subs } = scriptedRunner({ status: { code: 0, stdout: ' M memory.jsonl\n', stderr: '' } })
    const { logger } = capturingLogger()
    const out = await snapshotMemoryTree({ dir, logger, git, now: () => 0 })
    expect(out).toBe('committed')
    expect(subs).toEqual(['init', 'add', 'status', 'commit'])
    // .gitignore is written on first init (transient write-temps never staged).
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('*.tmp\n*.lock\n')
  })

  it('already a repo (.git present) → skips init, does not rewrite .gitignore', async () => {
    await mkdir(join(dir, '.git'))
    const { git, subs } = scriptedRunner({ status: { code: 0, stdout: 'A  x\n', stderr: '' } })
    const { logger } = capturingLogger()
    const out = await snapshotMemoryTree({ dir, logger, git })
    expect(out).toBe('committed')
    expect(subs).toEqual(['add', 'status', 'commit']) // no 'init'
    await expect(readFile(join(dir, '.gitignore'), 'utf8')).rejects.toThrow()
  })

  it('already a repo via a .git FILE (gitlink: linked worktree / submodule) → skips init (audit P3)', async () => {
    // A linked worktree / submodule stores `.git` as a FILE (`gitdir: <path>`),
    // not a directory. Detecting only the directory form would re-`git init` over
    // an existing repo; the file form must count as "already a repo".
    await writeFile(join(dir, '.git'), 'gitdir: /somewhere/.git/worktrees/mem\n', 'utf8')
    const { git, subs } = scriptedRunner({ status: { code: 0, stdout: ' M x\n', stderr: '' } })
    const { logger } = capturingLogger()
    const out = await snapshotMemoryTree({ dir, logger, git })
    expect(out).toBe('committed')
    expect(subs).toEqual(['add', 'status', 'commit']) // no 'init' — the gitlink was recognized
  })

  it('nothing changed (clean status) → "nothing", never commits', async () => {
    await mkdir(join(dir, '.git'))
    const { git, subs } = scriptedRunner({}) // status defaults to clean ''
    const { logger } = capturingLogger()
    const out = await snapshotMemoryTree({ dir, logger, git })
    expect(out).toBe('nothing')
    expect(subs).toEqual(['add', 'status'])
  })

  it('init fails (non-zero) → "skipped", warns once, never stages', async () => {
    const { git, subs } = scriptedRunner({ init: { code: 128, stdout: '', stderr: 'fatal: could not create work tree' } })
    const { logger, warns } = capturingLogger()
    const out = await snapshotMemoryTree({ dir, logger, git })
    expect(out).toBe('skipped')
    expect(subs).toEqual(['init'])
    expect(warns.length).toBe(1)
  })

  it('git binary missing (runner throws ENOENT) → "skipped", swallowed', async () => {
    const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    const { git } = scriptedRunner({ init: enoent })
    const { logger, warns } = capturingLogger()
    const out = await snapshotMemoryTree({ dir, logger, git })
    expect(out).toBe('skipped')
    expect(warns.length).toBe(1)
  })

  it('add fails → "skipped" before status/commit', async () => {
    await mkdir(join(dir, '.git'))
    const { git, subs } = scriptedRunner({ add: { code: 1, stdout: '', stderr: 'index.lock exists' } })
    const { logger } = capturingLogger()
    const out = await snapshotMemoryTree({ dir, logger, git })
    expect(out).toBe('skipped')
    expect(subs).toEqual(['add'])
  })

  it('commit fails → "skipped"', async () => {
    await mkdir(join(dir, '.git'))
    const { git, subs } = scriptedRunner({
      status: { code: 0, stdout: ' M x\n', stderr: '' },
      commit: { code: 1, stdout: '', stderr: 'nothing to commit?' },
    })
    const { logger } = capturingLogger()
    const out = await snapshotMemoryTree({ dir, logger, git })
    expect(out).toBe('skipped')
    expect(subs).toEqual(['add', 'status', 'commit'])
  })

  it('commit carries the bot identity + gpgsign-off + a deterministic ISO from now', async () => {
    await mkdir(join(dir, '.git'))
    const FIXED = 1_700_000_000_000
    const { git, argv } = scriptedRunner({ status: { code: 0, stdout: ' M x\n', stderr: '' } })
    const { logger } = capturingLogger()
    await snapshotMemoryTree({ dir, logger, git, now: () => FIXED })
    const commit = argv.find((a) => a.includes('commit'))!
    expect(commit).toContain('user.name=gotong-butler')
    expect(commit).toContain('user.email=butler@gotong.local')
    expect(commit).toContain('commit.gpgsign=false') // background commit never invokes gpg
    expect(commit).toContain(`butler memory snapshot ${new Date(FIXED).toISOString()}`)
  })
})

// Real git may be absent in some CI images — probe once, skip the integration
// block rather than fail. (The dev + prod boxes ship git; unit tests above cover
// the logic regardless.)
const gitAvailable = await execFileGitRunner(['--version'], tmpdir())
  .then((r) => r.code === 0)
  .catch(() => false)

describe('snapshotMemoryTree — real git integration', () => {
  it.skipIf(!gitAvailable)('commits, no-ops when unchanged, commits again on change', async () => {
    const { logger } = capturingLogger()
    const dir = await mkdtemp(join(tmpdir(), 'gotong-memgit-real-'))
    try {
      await writeFile(join(dir, 'memory.jsonl'), 'line-1\n', 'utf8')
      const first = await snapshotMemoryTree({ dir, logger, now: () => 1_700_000_000_000 })
      expect(first).toBe('committed')
      expect((await stat(join(dir, '.git'))).isDirectory()).toBe(true)
      expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('*.tmp\n*.lock\n')

      // Unchanged tree → no empty commit.
      const second = await snapshotMemoryTree({ dir, logger, now: () => 1_700_000_001_000 })
      expect(second).toBe('nothing')

      // A real change → a second commit.
      await writeFile(join(dir, 'memory.jsonl'), 'line-1\nline-2\n', 'utf8')
      const third = await snapshotMemoryTree({ dir, logger, now: () => 1_700_000_002_000 })
      expect(third).toBe('committed')

      // History has exactly the two real commits, tagged with the snapshot message.
      const log = await execFileGitRunner(['log', '--oneline'], dir)
      expect(log.stdout.trim().split('\n')).toHaveLength(2)
      expect(log.stdout).toContain('butler memory snapshot')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!gitAvailable)('transient .tmp write-temps are gitignored (never dirty the tree)', async () => {
    const { logger } = capturingLogger()
    const dir = await mkdtemp(join(tmpdir(), 'gotong-memgit-ignore-'))
    try {
      await writeFile(join(dir, 'memory.jsonl'), 'x\n', 'utf8')
      await snapshotMemoryTree({ dir, logger, now: () => 1_700_000_000_000 })
      // A half-written tmp appears mid-flight; the next tick must see a clean tree.
      await writeFile(join(dir, 'memory.jsonl.tmp'), 'half-written', 'utf8')
      const out = await snapshotMemoryTree({ dir, logger, now: () => 1_700_000_001_000 })
      expect(out).toBe('nothing')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
