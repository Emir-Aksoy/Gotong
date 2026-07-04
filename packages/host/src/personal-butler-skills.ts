/**
 * personal-butler-skills.ts — the host side of the master SKILL.md (MR3 §六).
 *
 * The skill machinery in `@gotong/personal-memory` (`procedureAuthoringReviewer`
 * + `umbrellaReviewer`) is FS-free leaf code: it authors / merges `form:'procedure'`
 * entries in the jsonl and closes superseded ones, but never touches a markdown
 * file. This module is the projection: it rewrites `<userDir>/SKILL.md` to the
 * member's CURRENT active skill set — the human-readable "我会做的事", literally
 * Hermes' master SKILL.md, with the single-source-of-truth invariant kept.
 *
 * # SKILL.md is a snapshot projection, not a diary
 *
 * Unlike DREAMS.md (append-only history of each sweep — `personal-butler-dreams`),
 * SKILL.md is OVERWRITTEN every projection with the current `activeProcedures`
 * snapshot, the same way the frozen block is a current view of memory. The source
 * of truth is the jsonl procedures (active + closed); SKILL.md only renders the
 * active ones for a human. A merged-away (closed) original drops out automatically
 * because `activeProcedures` filters `isActive` — the "SQLite repoint" is free
 * from the bitemporal close, no pointer rewriting here either.
 *
 * # The projection seam
 *
 * {@link skillFileReviewer} is a host-side `MemoryReviewer` so it composes into the
 * maintenance heartbeat AFTER `umbrellaReviewer` (MR4): each tick it reads the
 * post-merge active procedures and rewrites SKILL.md, returning `{}` (a projection
 * is not a memory mutation, so it never claims work in the maintenance summary).
 *
 * # Why a machine marker line
 *
 * The file opens with a stable HTML-comment marker carrying the structured skill
 * refs as JSON (mirroring DREAMS.md). Markdown renderers ignore it, humans don't
 * see it, and {@link ButlerSkillFile.read} parses that marker instead of scraping
 * prose — so the `/me` projection is robust to any wording change in the body.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Logger } from '@gotong/core'
import {
  activeProcedures,
  isUmbrella,
  stepsOf,
  type MemoryReviewer,
  type ReviewContext,
  type ReviewOutcome,
} from '@gotong/personal-memory'
import { ownerDir } from '@gotong/service-memory-file'
import type { MemoryEntry, Owner } from '@gotong/services-sdk'

/** Filename of the per-user master skill index, written inside the user's memory dir. */
export const SKILL_FILE = 'SKILL.md'

/** The stable machine marker that opens the file (`read` keys off it). */
const MARKER_PREFIX = '<!-- gotong-skill '
const MARKER_SUFFIX = ' -->'
/** Max chars of a step shown in SKILL.md (a readable index, not a dump). */
const STEP_CLIP = 200
/** Default cap on semantic entries scanned for active procedures per projection. */
const DEFAULT_SCAN = 200

/** One skill in the SKILL.md snapshot — content-free reference for the `/me` view. */
export interface ButlerSkillRef {
  readonly id: string
  readonly name: string
  readonly stepCount: number
  /** True when this is a merged umbrella skill (vs a directly-recorded one). */
  readonly umbrella: boolean
}

/** The latest snapshot's summary, parsed from the machine marker. */
export interface ButlerSkillSummary {
  readonly writtenAt: number
  readonly count: number
  readonly skills: readonly ButlerSkillRef[]
}

export interface ButlerSkillFile {
  /** Rewrite SKILL.md to the given active-procedure snapshot (best-effort; a throw is swallowed). */
  write(procedures: readonly MemoryEntry[], now: number): Promise<void>
  /** Parse the latest snapshot's marker, or null if the file is absent/empty. */
  read(): Promise<ButlerSkillSummary | null>
  /** Delete SKILL.md (the forget-all path cleans this derived file too). */
  remove(): Promise<void>
}

export interface OpenButlerSkillFileOptions {
  /** Memory root dir (same as `openButlerMemory`). */
  rootDir: string
  /** The member whose skills these are — the namespace boundary. */
  userId: string
  logger?: Logger
}

/**
 * Shape the member-facing skill refs from a set of entries: the ACTIVE procedures
 * at `now`, each reduced to id / name / step-count / umbrella flag (no step text —
 * this is the index, callers read steps from recall). Pure; reused by the writer,
 * the `/me` view and tests so they can't drift on what "an active skill" is.
 */
export function projectButlerSkills(
  entries: readonly MemoryEntry[],
  now: number,
): ButlerSkillRef[] {
  return activeProcedures(entries, now).map((p) => ({
    id: p.id,
    name: p.text,
    stepCount: stepsOf(p).length,
    umbrella: isUmbrella(p),
  }))
}

/**
 * Open a master skill file scoped to one user, wired to the real filesystem. The
 * file lives next to the user's jsonl (via the shared `ownerDir` helper, so layout
 * + owner-id safety stay one source of truth), alongside DREAMS.md and the recall
 * index.
 */
export function openButlerSkillFile(opts: OpenButlerSkillFileOptions): ButlerSkillFile {
  if (typeof opts.userId !== 'string' || opts.userId.length === 0) {
    throw new Error('openButlerSkillFile: a non-empty userId is required (per-user namespace)')
  }
  const owner: Owner = { kind: 'user', id: opts.userId }
  const path = join(ownerDir(opts.rootDir, owner), SKILL_FILE)

  return {
    write: async (procedures: readonly MemoryEntry[], now: number): Promise<void> => {
      try {
        await mkdir(dirname(path), { recursive: true })
        // OVERWRITE — SKILL.md is a current snapshot, not append-only history.
        await writeFile(path, renderSkillFile(procedures, now), 'utf8')
      } catch (err) {
        // A human-readable projection; a write failure must never break the sweep
        // (the truth is the jsonl, this file is rebuildable).
        opts.logger?.warn('butler skill file: write failed', { err: errMsg(err) })
      }
    },
    async read(): Promise<ButlerSkillSummary | null> {
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch {
        return null // no skill file yet
      }
      return parseSkillSummary(raw)
    },
    async remove(): Promise<void> {
      await rm(path, { force: true })
    },
  }
}

export interface SkillFileReviewerOptions {
  /** The per-user skill file this projection rewrites. */
  skillFile: ButlerSkillFile
  /** Max semantic entries scanned for active procedures. Default 200. */
  maxScan?: number
}

/**
 * A host-side {@link MemoryReviewer} that projects the current active procedures
 * into SKILL.md. Compose it AFTER `umbrellaReviewer` in the maintenance heartbeat
 * so the file reflects the post-merge skill set. Returns `{}` — projecting a view
 * is not a memory mutation, so it never inflates the maintenance summary.
 */
export function skillFileReviewer(opts: SkillFileReviewerOptions): MemoryReviewer {
  const maxScan = Math.max(1, Math.floor(opts.maxScan ?? DEFAULT_SCAN))
  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    const semantic = await ctx.memory.recall({ kinds: ['semantic'], k: maxScan })
    const procs = activeProcedures(semantic, ctx.now)
    await opts.skillFile.write(procs, ctx.now)
    return {}
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function renderSkillFile(procedures: readonly MemoryEntry[], now: number): string {
  const refs = projectButlerSkills(procedures, now)
  const summary: ButlerSkillSummary = { writtenAt: now, count: refs.length, skills: refs }
  const lines: string[] = [
    `${MARKER_PREFIX}${JSON.stringify(summary)}${MARKER_SUFFIX}`,
    '# 我会做的事（技能）',
    '',
    `_${refs.length} 个技能 · 更新于 ${new Date(now).toISOString()}_`,
    '',
  ]
  // The active procedures, in the order projectButlerSkills returns them.
  const active = activeProcedures(procedures, now)
  for (const p of active) {
    const badge = isUmbrella(p) ? ' （合并）' : ''
    lines.push(`## ${p.text}${badge}`)
    const steps = stepsOf(p)
    for (let i = 0; i < steps.length; i++) lines.push(`${i + 1}. ${clip(steps[i] ?? '')}`)
    lines.push('')
  }
  if (active.length === 0) lines.push('_（还没有记录任何技能）_', '')
  return lines.join('\n')
}

/** Find the machine marker and parse its skill refs. Tolerant of a corrupt file. */
function parseSkillSummary(raw: string): ButlerSkillSummary | null {
  const line = raw
    .split('\n')
    .find((l) => l.startsWith(MARKER_PREFIX) && l.endsWith(MARKER_SUFFIX))
  if (!line) return null
  try {
    const json = line.slice(MARKER_PREFIX.length, line.length - MARKER_SUFFIX.length)
    const parsed = JSON.parse(json) as ButlerSkillSummary
    if (typeof parsed.writtenAt !== 'number' || !Array.isArray(parsed.skills)) return null
    return parsed
  } catch {
    return null // a half-written / corrupt marker is not a fatal read
  }
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > STEP_CLIP ? `${one.slice(0, STEP_CLIP)}…` : one
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
