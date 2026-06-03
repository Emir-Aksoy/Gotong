#!/usr/bin/env node
/**
 * Mock coding-agent CLI — stands in for Claude Code / Codex in the demo + the
 * host E2E acceptance gate, so they run with no API key and deterministically.
 *
 * Reads the prompt from `--prompt <text>` (arg mode) or stdin (stdin mode),
 * streams a couple of "step:" lines (so the OBSERVE seam has something to show),
 * echoes a `result:` line, and exits 0. Plain Node (no deps) — the participant
 * spawns it via `process.execPath`.
 */

function argPrompt() {
  const i = process.argv.indexOf('--prompt')
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let data = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) data += chunk
  return data
}

const prompt = (argPrompt() ?? (await readStdin())).trim()

process.stdout.write('step: reading the repo\n')
process.stdout.write('step: drafting a change\n')
process.stdout.write(`result: handled "${prompt}"\n`)
process.exit(0)
