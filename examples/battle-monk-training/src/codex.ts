/**
 * The Codex — the trainee's persistent STATE store (an Obsidian-style vault).
 *
 * Why a "knowledge base" here holds state, not a library: unlike
 * personal-research-hub (where the wiki is compiled reference material), this KB
 * is the acolyte's OWN evolving record across three pillars — 肉身 / 心志 / 学识.
 * Each training session appends one ranked entry per pillar, so the next session
 * reads where the last left off. Continuity is the whole point.
 *
 * Gotong never stores knowledge — this is a real directory the agents read and
 * write (same idea as personal-research-hub's wiki). The demo seeds a baseline
 * assessment per pillar; the drills advance it rank by rank.
 */

import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Pillar = 'body' | 'mind' | 'lore'
export const PILLARS: Pillar[] = ['body', 'mind', 'lore']

export const PILLAR_TITLE: Record<Pillar, string> = {
  body: '肉身',
  mind: '心志',
  lore: '学识',
}

export interface Codex {
  dir: string
  codexDir: string
}

/** Baseline assessment seeded at induction (第0阶) — austere, original flavor. */
const BASELINE: Record<Pillar, string> = {
  body: '入门评估:体能未达标。肉身是你唯一的武器,也是你的负担。',
  mind: '入门评估:心志浮动。秩序先于力量。',
  lore: '入门评估:学识空白。无知者先死。',
}

export function setupCodex(dir: string): Codex {
  const codexDir = join(dir, 'codex')
  mkdirSync(codexDir, { recursive: true })
  // The Codex home — links each pillar's state file (an interlinked vault).
  writeFileSync(
    join(codexDir, 'index.md'),
    '# 修士档案 (Codex)\n\n> 你的状态由三柱构成:肉身 / 心志 / 学识。每次操练,各柱追加一条记录。\n\n',
  )
  for (const p of PILLARS) {
    writeFileSync(join(codexDir, `${p}.md`), `# ${PILLAR_TITLE[p]}\n\n- [第0阶] ${BASELINE[p]}\n`)
    appendFileSync(join(codexDir, 'index.md'), `- [[${p}]] — ${PILLAR_TITLE[p]}\n`)
  }
  return { dir, codexDir }
}

export function pillarPath(kb: Codex, p: Pillar): string {
  return join(kb.codexDir, `${p}.md`)
}

export function readPillar(kb: Codex, p: Pillar): string {
  return readFileSync(pillarPath(kb, p), 'utf8')
}

export function readIndex(kb: Codex): string {
  return readFileSync(join(kb.codexDir, 'index.md'), 'utf8')
}

/** How many ranked entries (`- [第N阶]`) a pillar already holds (baseline counts). */
export function priorSteps(kb: Codex, p: Pillar): number {
  return (readPillar(kb, p).match(/^- \[第/gm) ?? []).length
}

export function appendEntry(kb: Codex, p: Pillar, line: string): void {
  appendFileSync(pillarPath(kb, p), `${line}\n`)
}
