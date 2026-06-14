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
 * The board filename base for an agent — hyphenate anything odd so a stray id can
 * never escape the board dir. Agent ids here are coder handles (claude-code /
 * codex), already filename-safe, so they round-trip to the same id. Exported so the
 * prompt convention (boardCardInstruction) names the SAME path the moderator reads.
 */
export function boardFileBase(agent: string): string {
  return agent.replace(/[^a-zA-Z0-9_-]+/g, '_')
}

/**
 * The on-disk filename for an agent's card. (Handles keep their hyphens, so the
 * filename round-trips to the same id in readAllDiagnoses.)
 */
function fileFor(board: ConsultBoard, agent: string): string {
  return join(board.dir, `${boardFileBase(agent)}.md`)
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
 * The prompt fragment that tells a REAL diagnostic agent (claude-code / codex
 * reading the repo) how to record its finding — the same card shape renderDiagnosis
 * emits and parseDiagnosis reads back, so a real agent and the mock land on one
 * format. The moderator appends this to each diagnosis prompt in real mode; the mock
 * already knows the shape so the offline demo omits it. Naming the file via
 * boardFileBase keeps the path identical to where readAllDiagnoses looks.
 *
 * `level: root-cause` is the gate that makes a panel worth more than one agent:
 * only a confident underlying-cause call counts toward consensus, so the prompt is
 * explicit that a surface effect stays `level: symptom`.
 */
export function boardCardInstruction(agent: string): string {
  return [
    'When you have finished diagnosing, WRITE your diagnosis to the file',
    `\`DIAGNOSIS/${boardFileBase(agent)}.md\` (relative to the repo root) in EXACTLY this format:`,
    '',
    '```',
    `# Diagnosis by ${agent}`,
    '',
    '- root-cause: <a short kebab-case tag, e.g. missing-await>',
    '- level: <root-cause or symptom>',
    '',
    '<one or two sentences of evidence for your call>',
    '```',
    '',
    'Use `level: root-cause` ONLY when you are confident you found the underlying',
    'cause; if you only see a surface effect (a test fails, it is slow), use',
    '`level: symptom`. Keep the root-cause tag short and canonical so peers who reach',
    'the same conclusion use the same words.',
  ].join('\n')
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
 * Render a peer-diagnoses digest from a LIST. The moderator hands this to each
 * agent in the cross-examination round as a SNAPSHOT of the previous round, so
 * parallel writes within a round never change what a peer sees mid-round.
 */
export function peerDigest(diagnoses: Diagnosis[], exclude: string): string {
  const peers = diagnoses.filter((d) => d.agent !== exclude)
  if (!peers.length) return '(no peer diagnoses yet)'
  return peers
    .map(
      (d) =>
        `- ${d.agent} says [${d.level}] ${d.rootCause}` +
        (d.detail ? `: ${d.detail.split('\n')[0]}` : ''),
    )
    .join('\n')
}

/**
 * Format the OTHER panelists' diagnoses currently on the board — what the
 * moderator hands each agent so it can rebut or corroborate. Blind-round
 * isolation lives in the caller: an agent only ever sees peers via this digest,
 * in the cross-examination round, never in the blind round.
 */
export function formatPeerDiagnoses(board: ConsultBoard, exclude: string): string {
  return peerDigest(readAllDiagnoses(board), exclude)
}
