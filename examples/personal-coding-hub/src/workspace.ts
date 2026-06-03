/**
 * The shared project workspace — the thing that makes "two coding agents share
 * project-level files" concrete. Both agents run with their `cwd` set to this
 * directory, so AGENTS.md (the spec) and PROGRESS.md (the running log) are
 * literally the same bytes on disk for both of them.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface SharedWorkspace {
  dir: string
  specFile: string
  progressFile: string
}

const AGENTS_MD = `# Project spec (shared by every coding agent)

This repo is driven by an AipeHub personal hub. Two coding agents — Claude Code
and Codex — operate on THIS directory. They coordinate through two shared files:

- AGENTS.md  — this spec. (Codex reads AGENTS.md; Claude Code reads CLAUDE.md —
  a symlink to this file makes one spec serve both.)
- PROGRESS.md — the running progress log. EVERY agent reads it before working and
  appends one line when done. It is the handoff baton between agents.

Conventions:
- Keep changes small and reversible.
- Never run destructive commands (rm -rf, git push --force) without human sign-off.
`

const PROGRESS_MD = `# Progress log

> Shared handoff log. Each agent appends \`- [<agent>] <what it did>\` here, in order.

`

/** Materialise a shared project repo with the spec + progress log on disk. */
export function setupSharedWorkspace(dir: string): SharedWorkspace {
  mkdirSync(dir, { recursive: true })
  const specFile = join(dir, 'AGENTS.md')
  const progressFile = join(dir, 'PROGRESS.md')
  writeFileSync(specFile, AGENTS_MD)
  writeFileSync(progressFile, PROGRESS_MD)
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
