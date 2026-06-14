/**
 * The consult board — DIAGNOSIS/<agent>.md files in the shared workspace. Each
 * diagnostic agent writes ITS OWN file, so the blind round is blind by
 * construction: an agent writes its file without ever reading the others'. The
 * moderator reads them all back to tally a verdict, and for the cross-examination
 * round it hands each agent the OTHERS' diagnoses (formatPeerDiagnoses) so they
 * can rebut or corroborate — the actual "相互沟通" of a 会诊.
 *
 * Mirrors PROGRESS.md's shared-handoff convention, but one file PER agent (not a
 * single appended log) so parallel blind writes never collide on disk.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { type Diagnosis, type DiagnosisLevel } from './consult.js'

export interface ConsultBoard {
  /** <workspace>/DIAGNOSIS — one <agent>.md per panelist. */
  dir: string
}

/** Create the board directory under the shared workspace. */
export function setupConsultBoard(workspaceDir: string): ConsultBoard {
  const dir = join(workspaceDir, 'DIAGNOSIS')
  mkdirSync(dir, { recursive: true })
  return { dir }
}

/**
 * The on-disk filename for an agent's card. Agent ids here are coder handles
 * (claude-code / codex) — safe as filenames — but we hyphenate anything odd so a
 * stray id can never escape the board dir. (Handles keep their hyphens, so the
 * filename round-trips to the same id in readAllDiagnoses.)
 */
function fileFor(board: ConsultBoard, agent: string): string {
  return join(board.dir, `${agent.replace(/[^a-zA-Z0-9_-]+/g, '_')}.md`)
}

/**
 * Render one diagnosis as a human-readable Markdown card with a small
 * machine-readable header the moderator parses back. A real diagnostic agent
 * writes the same shape (prompt-agreed); the mock writes it verbatim.
 */
export function renderDiagnosis(d: Diagnosis): string {
  return [
    `# Diagnosis by ${d.agent}`,
    '',
    `- root-cause: ${d.rootCause}`,
    `- level: ${d.level}`,
    '',
    (d.detail ?? '').trim(),
    '',
  ].join('\n')
}

export function writeDiagnosis(board: ConsultBoard, d: Diagnosis): void {
  writeFileSync(fileFor(board, d.agent), renderDiagnosis(d))
}

/**
 * Parse a diagnosis card back. Tolerant: a missing/garbled level reads as
 * 'symptom' (the conservative default — an unparseable call does NOT get counted
 * as a confident root cause), and a missing root-cause yields null (no vote, no
 * card).
 */
export function parseDiagnosis(agent: string, text: string): Diagnosis | null {
  const lines = text.split('\n')
  let root: string | undefined
  let level: DiagnosisLevel = 'symptom'
  let detailStart = lines.length
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const rm = line.match(/^-\s*root-cause:\s*(.+)$/)
    if (rm) root = (rm[1] ?? '').trim()
    const lm = line.match(/^-\s*level:\s*(.+)$/)
    if (lm) {
      level = (lm[1] ?? '').trim().toLowerCase() === 'root-cause' ? 'root-cause' : 'symptom'
      detailStart = i + 1 // detail starts after the level line
      break
    }
  }
  if (!root) return null
  const detail = lines.slice(detailStart).join('\n').trim() || undefined
  return { agent, rootCause: root, level, ...(detail ? { detail } : {}) }
}

/** Read one agent's diagnosis off the board (null if absent or unparseable). */
export function readDiagnosis(board: ConsultBoard, agent: string): Diagnosis | null {
  const f = fileFor(board, agent)
  if (!existsSync(f)) return null
  return parseDiagnosis(agent, readFileSync(f, 'utf8'))
}

/** Read every diagnosis on the board, in filename order (skips ones that don't parse). */
export function readAllDiagnoses(board: ConsultBoard): Diagnosis[] {
  if (!existsSync(board.dir)) return []
  const out: Diagnosis[] = []
  for (const name of readdirSync(board.dir).sort()) {
    if (!name.endsWith('.md')) continue
    const agent = name.replace(/\.md$/, '')
    const d = parseDiagnosis(agent, readFileSync(join(board.dir, name), 'utf8'))
    if (d) out.push(d)
  }
  return out
}

/**
 * Format the OTHER panelists' diagnoses for the cross-examination round — what
 * the moderator hands each agent so it can rebut or corroborate. Blind-round
 * isolation lives here: an agent only ever sees peers via THIS function, in the
 * cross-examination round, never in the blind round.
 */
export function formatPeerDiagnoses(board: ConsultBoard, exclude: string): string {
  const peers = readAllDiagnoses(board).filter((d) => d.agent !== exclude)
  if (!peers.length) return '(no peer diagnoses yet)'
  return peers
    .map(
      (d) =>
        `- ${d.agent} says [${d.level}] ${d.rootCause}` +
        (d.detail ? `: ${d.detail.split('\n')[0]}` : ''),
    )
    .join('\n')
}
