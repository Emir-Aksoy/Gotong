/**
 * The shared project workspace — the thing that makes "two coding agents share
 * project-level files" concrete. Both agents run with their `cwd` set to this
 * directory, so AGENTS.md (the spec) and PROGRESS.md (the running log) are
 * literally the same bytes on disk for both of them.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface SharedWorkspace {
  dir: string
  specFile: string
  progressFile: string
}

const AGENTS_MD = `# Project spec (shared by every coding agent)

This repo is driven by an AipeHub personal hub. Two coding agents — Codex and a
DeepSeek-backed TUI — operate on THIS directory. They coordinate through two
shared files:

- AGENTS.md  — this spec. Both coders are pointed at this same repo, so they read
  the same spec.
- PROGRESS.md — the running progress log. EVERY agent reads it before working and
  appends one line when done. It is the handoff baton between agents.

Conventions:
- Keep changes small and reversible.
- Never run destructive commands (rm -rf, git push --force) without human sign-off.
`

const PROGRESS_MD = `# Progress log

> Shared handoff log. Each agent appends \`- [<agent>] <what it did>\` here, in order.

`

/**
 * Materialise a shared project repo with the spec + progress log on disk.
 * `overwrite` defaults to true (a throwaway demo dir). Pass `overwrite:false`
 * when pointing at a REAL repo so we seed the two shared files only when absent
 * and never clobber the user's own project.
 */
export function setupSharedWorkspace(dir: string, opts: { overwrite?: boolean } = {}): SharedWorkspace {
  const overwrite = opts.overwrite ?? true
  mkdirSync(dir, { recursive: true })
  const specFile = join(dir, 'AGENTS.md')
  const progressFile = join(dir, 'PROGRESS.md')
  if (overwrite || !existsSync(specFile)) writeFileSync(specFile, AGENTS_MD)
  if (overwrite || !existsSync(progressFile)) writeFileSync(progressFile, PROGRESS_MD)
  return { dir, specFile, progressFile }
}

/**
 * The shared-context convention the hub injects ahead of every task, so each
 * coding agent — whichever the router picked — reads the same spec + progress
 * log and logs its own progress. Deterministic: it does NOT depend on the LLM
 * remembering to do it. The real task follows the `TASK:` marker the mock reads.
 */
export function withSharedContext(task: string): string {
  return [
    'Project spec: AGENTS.md. Progress log: PROGRESS.md.',
    'Read both before working, and append a one-line entry to PROGRESS.md when done.',
    `TASK: ${task}`,
  ].join('\n')
}

/** Read the shared progress log back — the demo prints it to prove the sharing. */
export function readProgress(ws: SharedWorkspace): string {
  return existsSync(ws.progressFile) ? readFileSync(ws.progressFile, 'utf8') : ''
}

/**
 * Make the workspace a git repo. The real coding CLIs (codex, and most DeepSeek
 * TUIs) prefer a repo; without this they print a noisy `fatal: not a git
 * repository` (non-fatal — they still write files — but it muddies the log).
 * Best-effort: `git init` alone clears the error; the seed commit is skipped if
 * git has no user.name/email configured (we don't want to fail the run on that).
 */
export function initGitRepo(dir: string): void {
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
  } catch {
    return // no git on PATH — nothing more we can do, and it's not worth failing
  }
  try {
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
    execFileSync('git', ['commit', '-q', '-m', 'seed: shared coding workspace'], { cwd: dir, stdio: 'ignore' })
  } catch {
    /* no git identity configured — `git init` alone is enough to silence the probe */
  }
}
