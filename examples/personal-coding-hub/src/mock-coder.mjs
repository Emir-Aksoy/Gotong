#!/usr/bin/env node
/**
 * Mock coding-agent CLI — stands in for Claude Code / Codex so the demo runs with
 * no API key, deterministically. What it proves: it operates ENTIRELY inside its
 * cwd (the shared project repo), reading the shared spec + progress log and
 * appending its own progress entry — exactly what a real headless coding agent
 * does. Two of these pointed at the SAME cwd literally share files.
 *
 *   [1] read ./AGENTS.md     — the shared project spec (both agents see it)
 *   [2] read ./PROGRESS.md   — the shared progress log (the handoff baton)
 *   [3] "do the work"        — append a marker to ./work.log (a real on-disk change)
 *   [4] append to PROGRESS.md — `- [<agent>] <task>` (the next agent will read it)
 *
 * Plain Node, no deps. The CliParticipant spawns it via process.execPath with
 * cwd set to the shared workspace, so the relative reads below resolve there.
 */
import { appendFileSync, readFileSync, existsSync } from 'node:fs'

function argOf(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let data = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) data += chunk
  return data
}

const agent = argOf('--agent') ?? 'coder'
const rawPrompt = (argOf('--prompt') ?? (await readStdin())).trim()
// The hub's shared-context wrapper puts the real task after a `TASK:` marker; if
// it isn't there (a raw dispatch), use the whole prompt. Keep the first line for
// a clean one-line progress entry.
const marker = rawPrompt.match(/TASK:\s*([\s\S]*)$/)
const task = (marker ? marker[1] : rawPrompt).trim().split('\n')[0] || '(empty task)'

// [1] read the shared project spec from cwd — proves this agent sees the same
// AGENTS.md the other agent sees.
const specTitle = existsSync('AGENTS.md')
  ? (readFileSync('AGENTS.md', 'utf8').split('\n').find((l) => l.trim()) ?? '').replace(/^#\s*/, '').trim()
  : '(no AGENTS.md)'
process.stdout.write(`step: read project spec — "${specTitle}"\n`)

// [2] read the shared progress log — proves the handoff: a later agent sees the
// earlier agent's entries.
const before = existsSync('PROGRESS.md') ? readFileSync('PROGRESS.md', 'utf8') : ''
const priorEntries = before.split('\n').filter((l) => l.startsWith('- [')).length
process.stdout.write(`step: read progress log (${priorEntries} prior entries)\n`)

// [3] do the work — touch a shared artifact so the change is real on disk.
process.stdout.write(`step: ${agent} working on "${task}"\n`)
appendFileSync('work.log', `${agent}: ${task}\n`)

// [4] append this agent's progress entry — the next agent will read it.
appendFileSync('PROGRESS.md', `- [${agent}] ${task}\n`)

process.stdout.write(`result: ${agent} done — appended a PROGRESS.md entry\n`)
process.exit(0)
