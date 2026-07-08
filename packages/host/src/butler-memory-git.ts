/**
 * butler-memory-git.ts — MU-M5: a lightweight, per-user git snapshot of the
 * butler's memory tree, taken in the 6h maintenance sweep.
 *
 * # Why (Letta MemFS: git-backed memory)
 *
 * The frontier is projecting agent memory onto git-backed files (Letta's MemFS):
 * git gives free history — time-travel, audit, and recovery from a bad
 * consolidation — over a tree you can already read on disk. Gotong's butler
 * memory is ALREADY file-first jsonl (`<root>/user/<id>/`); M5 just wraps a
 * periodic `git commit` around it so that history exists, at ZERO hot-path cost.
 *
 * # Lightweight, per-user, best-effort (the three properties that keep it safe)
 *
 *  - NOT per-write. One commit per 6h maintenance tick, and only when something
 *    actually changed (`git status --porcelain` empty → no-op). The capture hot
 *    path never touches git.
 *  - Per-user repo (`<memberDir>/.git`). Copying a member's dir carries its own
 *    history ("搬走目录 = 搬走房间"), and one member's repo lock / corruption can
 *    never touch another's — the same isolation the maintenance sweep already has.
 *  - Best-effort, never throws. No `git` binary (ENOENT), an init failure, a lock
 *    — anything — is logged and swallowed. A snapshot is an audit convenience; it
 *    must never break a maintenance tick or alter the jsonl truth.
 *
 * OPT-IN (`GOTONG_BUTLER_MEMORY_GIT`): off by default, so a deployment's memory
 * dirs don't silently become git repos (they might sit inside another repo, or the
 * operator may not want it). Byte-unchanged when unset — no `.git`, no git process.
 * The framework runs no LLM here either; a snapshot is pure git.
 */

import { execFile } from 'node:child_process'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { Logger } from '@gotong/core'

const execFileAsync = promisify(execFile)

/** Result of one git invocation — exit code + captured output. */
export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run `git <args>` in `cwd`. Injectable so tests drive the snapshotter without a
 * real git binary. A non-zero exit is a RESULT (code set), not a throw; only a
 * spawn failure (git missing) rejects — the caller treats that as a clean skip.
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>

/** Default runner: the real `git` via child_process. */
export const execFileGitRunner: GitRunner = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync('git', args as string[], {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    // execFile rejects on non-zero exit with {code, stdout, stderr} — surface it
    // as a RESULT. A missing binary (ENOENT) carries no numeric exit code, so
    // rethrow: the caller's outer catch turns "no git" into a clean skip.
    const e = err as { code?: unknown; stdout?: string; stderr?: string }
    if (typeof e.code === 'number') {
      return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
    }
    throw err
  }
}

/** What one snapshot attempt did — for tests + the sweep's log. */
export type SnapshotOutcome = 'committed' | 'nothing' | 'skipped'

export interface SnapshotMemoryTreeOptions {
  /** The member's memory dir to snapshot (`<root>/user/<id>`). */
  dir: string
  logger: Logger
  /** Injectable clock for the commit-message timestamp. Default `Date.now`. */
  now?: () => number
  /** Injectable git runner (tests). Default {@link execFileGitRunner}. */
  git?: GitRunner
}

/** Transient write-temps the butler produces (tmp+rename); never worth committing. */
const GITIGNORE_CONTENTS = '*.tmp\n*.lock\n'

/**
 * Per-command config for the snapshot commit:
 *  - a bot identity so an unconfigured git (no global user.name/email) still commits;
 *  - `commit.gpgsign=false` because this is an automated BACKGROUND commit — a global
 *    `commit.gpgsign=true` would invoke gpg, which can prompt for a passphrase and
 *    HANG the sweep (and signing a bot commit with the human's key is wrong anyway).
 *    Best-effort must never block on a key prompt.
 */
const COMMIT_IDENTITY = [
  '-c', 'user.name=gotong-butler',
  '-c', 'user.email=butler@gotong.local',
  '-c', 'commit.gpgsign=false',
]

/**
 * Take one git snapshot of `dir`: init the repo if it isn't one yet (with a
 * `.gitignore` for transient write-temps), stage everything, and commit IF
 * something changed. Returns what it did; NEVER throws (best-effort — see header).
 */
export async function snapshotMemoryTree(opts: SnapshotMemoryTreeOptions): Promise<SnapshotOutcome> {
  const git = opts.git ?? execFileGitRunner
  const now = opts.now ?? Date.now
  const { dir, logger } = opts
  try {
    // 1. Ensure a repo AT dir (its own `.git`, not merely inside an ancestor repo
    //    — a direct fs check is symlink-proof and needs no git call).
    if (!(await hasOwnGitDir(dir))) {
      const init = await git(['init'], dir)
      if (init.code !== 0) {
        logger.warn('butler memory git: init failed, skipping snapshot', { dir, stderr: init.stderr.trim() })
        return 'skipped'
      }
      await writeGitignore(dir)
    }
    // 2. Stage everything under dir.
    const add = await git(['add', '-A'], dir)
    if (add.code !== 0) {
      logger.warn('butler memory git: add failed, skipping snapshot', { dir, stderr: add.stderr.trim() })
      return 'skipped'
    }
    // 3. Nothing changed since the last tick → no empty commit (lightweight).
    const status = await git(['status', '--porcelain'], dir)
    if (status.stdout.trim() === '') return 'nothing'
    // 4. Commit the snapshot.
    const iso = new Date(now()).toISOString()
    const commit = await git([...COMMIT_IDENTITY, 'commit', '-m', `butler memory snapshot ${iso}`], dir)
    if (commit.code !== 0) {
      logger.warn('butler memory git: commit failed, skipping snapshot', { dir, stderr: commit.stderr.trim() })
      return 'skipped'
    }
    logger.debug('butler memory git: snapshot committed', { dir })
    return 'committed'
  } catch (err) {
    // git binary missing (ENOENT) or any unexpected fault → best-effort skip.
    logger.warn('butler memory git: unavailable, skipping snapshot', {
      dir,
      err: err instanceof Error ? err.message : String(err),
    })
    return 'skipped'
  }
}

/** Does `dir` have its own `.git` (i.e. is it already a repo root)? */
async function hasOwnGitDir(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, '.git'))).isDirectory()
  } catch {
    return false
  }
}

/** Write the temps `.gitignore` on first init. Best-effort — a miss just means a
 *  stray `.tmp` could get staged once, which is harmless. */
async function writeGitignore(dir: string): Promise<void> {
  try {
    await writeFile(join(dir, '.gitignore'), GITIGNORE_CONTENTS, 'utf8')
  } catch {
    // non-fatal
  }
}
