#!/usr/bin/env node
/**
 * Mock DIAGNOSTIC agent — stands in for a coding agent sitting on a 会诊 panel, so
 * the consult demo runs with no API key, deterministically. It reads the problem
 * from its prompt, writes its diagnosis to DIAGNOSIS/<agent>.md in the shared
 * workspace (the consult board), and — in a cross-examination round, when the
 * prompt carries PEER DIAGNOSES — may UPGRADE its call (symptom → root cause)
 * after seeing a peer's stronger evidence. That upgrade is the whole point of a
 * panel: a lone agent that stopped at a symptom converges on the real root cause
 * once the others' findings are on the table.
 *
 * Blind by construction: in the blind round the moderator sends NO peer context
 * and this mock reads only its own prompt — it never reads the other agents'
 * board files. Cross-examination context arrives ONLY via the prompt the
 * moderator hands it (a snapshot), so parallel writes within a round are safe.
 *
 * The card format here MUST match consult-board.ts renderDiagnosis so the
 * moderator's parseDiagnosis reads it back — a real diagnostic agent writes the
 * same shape from a prompt-agreed convention; the mock writes it verbatim.
 */
import { mkdirSync, writeFileSync } from 'node:fs'

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

const agent = argOf('--agent') ?? 'panelist'
const prompt = (argOf('--prompt') ?? (await readStdin())).trim()
const problemId = prompt.match(/PROBLEM-ID:\s*(\S+)/)?.[1] ?? 'unknown'
const peerBlock = prompt.includes('PEER DIAGNOSES:')
  ? prompt.slice(prompt.indexOf('PEER DIAGNOSES:'))
  : ''

// Deterministic per-(problem, agent) scripts: a blind diagnosis, plus an optional
// crossExam(peerText) that returns an UPGRADED diagnosis when a peer's evidence is
// convincing (else null = hold your ground). A real diagnostic agent makes this
// judgement from the code; the script stands in so the demo can assert the panel
// dynamics — blind disagreement, then convergence (or a genuine deadlock).
const SCRIPTS = {
  // Blind round disagrees (a symptom + two different root causes); under
  // cross-examination the unawaited-promise evidence wins → converges.
  'auth-flaky': {
    'claude-code': {
      blind: {
        rootCause: 'missing-await',
        level: 'root-cause',
        detail:
          'The handler returns before the auth promise settles, so the test sometimes sees a half-initialised session.',
      },
    },
    codex: {
      blind: {
        rootCause: 'flaky-timeout',
        level: 'symptom',
        detail: 'The test times out — looks like a slow CI network.',
      },
      crossExam: (peers) =>
        peers.includes('missing-await')
          ? {
              rootCause: 'missing-await',
              level: 'root-cause',
              detail:
                'Re-checked against the evidence: the unawaited promise is the cause; the timeout was just the symptom.',
            }
          : null,
    },
    reviewer: {
      blind: {
        rootCause: 'race-condition',
        level: 'root-cause',
        detail: 'Two concurrent requests look like they race on the session object.',
      },
      crossExam: (peers) =>
        peers.includes('missing-await')
          ? {
              rootCause: 'missing-await',
              level: 'root-cause',
              detail:
                'The missing await explains the flakiness without needing a real race — that fits the trace better.',
            }
          : null,
    },
  },
  // Everyone is confident in a different root cause and nobody is convinced by
  // the others → stays split across rounds → the moderator escalates to a human.
  'cache-bug': {
    'claude-code': {
      blind: { rootCause: 'stale-cache', level: 'root-cause', detail: 'The cache is never invalidated on write.' },
    },
    codex: {
      blind: {
        rootCause: 'wrong-key',
        level: 'root-cause',
        detail: 'The cache key omits the tenant id, so reads cross tenants.',
      },
    },
    reviewer: {
      blind: {
        rootCause: 'missing-ttl',
        level: 'root-cause',
        detail: 'Entries have no TTL, so stale values live forever.',
      },
    },
  },
}

const script = SCRIPTS[problemId]?.[agent] ?? {
  blind: { rootCause: 'unclear', level: 'symptom', detail: 'No clear read of this problem.' },
}

let dx = script.blind
if (peerBlock && typeof script.crossExam === 'function') {
  const upgraded = script.crossExam(peerBlock)
  if (upgraded) dx = upgraded
}

process.stdout.write(`step: ${agent} ${peerBlock ? 'cross-examines peers' : 'diagnoses (blind)'} on "${problemId}"\n`)
process.stdout.write(`result: ${agent} → [${dx.level}] ${dx.rootCause}\n`)

// Write the diagnosis card into the shared consult board (cwd = workspace).
mkdirSync('DIAGNOSIS', { recursive: true })
const card = [`# Diagnosis by ${agent}`, '', `- root-cause: ${dx.rootCause}`, `- level: ${dx.level}`, '', dx.detail, ''].join(
  '\n',
)
writeFileSync(`DIAGNOSIS/${agent.replace(/[^a-zA-Z0-9_-]+/g, '_')}.md`, card)
process.exit(0)
