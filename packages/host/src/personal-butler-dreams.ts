/**
 * personal-butler-dreams.ts — the host side of the dream diary (MR2 §五.3).
 *
 * The dreaming sweep (`dreamingReviewer` in `@gotong/personal-memory`) is a pure
 * leaf reviewer: it scores, promotes and prunes, then hands a structured
 * {@link DreamRecord} to an injected {@link DreamDiaryWriter} — it deliberately
 * doesn't touch the filesystem. This module is that writer: it appends one
 * human-readable markdown block per sweep to `<userDir>/DREAMS.md`, the per-user
 * "复盘日记" the design §八 lists alongside the jsonl truth and the recall index.
 *
 * # The diary is a derived view, not truth
 *
 * Like the frozen block and the recall index, DREAMS.md is a projection — the
 * source of truth is the jsonl (the promoted profile + the absences left by
 * pruning). DREAMS.md just narrates what each sweep did so a member (or operator)
 * can review it. It's append-only history; the `/me` privacy view reads only the
 * LATEST sweep's counts ("上次复盘：提升 X 条 / 封存 Y 条").
 *
 * # Why a machine marker line per entry
 *
 * Each block opens with a stable HTML-comment marker carrying the structured
 * counts as JSON. Markdown renderers ignore it, humans don't see it, and
 * {@link ButlerDreamDiary.readLatest} parses the LAST marker instead of scraping
 * prose — so the `/me` projection is robust to any wording change in the human
 * body. One file, two audiences.
 */

import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Logger } from '@gotong/core'
import type { DreamDiaryWriter, DreamRecord } from '@gotong/personal-memory'
import { ownerDir } from '@gotong/service-memory-file'
import type { Owner } from '@gotong/services-sdk'

/** Filename of the per-user dream diary, written inside the user's memory dir. */
export const DREAMS_FILE = 'DREAMS.md'

/** The stable machine marker that opens every diary block (`readLatest` keys off it). */
const MARKER_PREFIX = '<!-- gotong-dream '
const MARKER_SUFFIX = ' -->'
/** Max chars of an entry's text shown in the diary (a diary, not a dump). */
const TEXT_CLIP = 120

/** The latest sweep's counts, for the `/me` "上次复盘" line. */
export interface DreamDiarySummary {
  readonly firedAt: number
  readonly promoted: number
  readonly pruned: number
  readonly profileBytes?: number
}

export interface ButlerDreamDiary {
  /** Append one sweep's record to DREAMS.md (best-effort; a throw is swallowed). */
  readonly writer: DreamDiaryWriter
  /** The most recent sweep's counts, or null if the diary is empty/absent. */
  readLatest(): Promise<DreamDiarySummary | null>
  /** Delete DREAMS.md (the forget-all path cleans this derived file too). */
  remove(): Promise<void>
}

export interface OpenButlerDreamDiaryOptions {
  /** Memory root dir (same as `openButlerMemory`). */
  rootDir: string
  /** The member whose diary this is — the namespace boundary. */
  userId: string
  logger?: Logger
}

/**
 * Open a dream diary scoped to one user, wired to the real filesystem. The diary
 * lives next to the user's jsonl (via the shared `ownerDir` helper, so layout +
 * owner-id safety stay one source of truth), exactly where the recall index and
 * the eventual SKILL.md / STATUS.md projections live.
 */
export function openButlerDreamDiary(opts: OpenButlerDreamDiaryOptions): ButlerDreamDiary {
  if (typeof opts.userId !== 'string' || opts.userId.length === 0) {
    throw new Error('openButlerDreamDiary: a non-empty userId is required (per-user namespace)')
  }
  const owner: Owner = { kind: 'user', id: opts.userId }
  const path = join(ownerDir(opts.rootDir, owner), DREAMS_FILE)

  return {
    writer: async (record: DreamRecord): Promise<void> => {
      try {
        // The diary usually lands next to an existing jsonl (the sweep runs
        // after memory exists), but a diary write must not assume that — create
        // the user dir so the first write can't lose the record to ENOENT.
        await mkdir(dirname(path), { recursive: true })
        await appendFile(path, renderDiaryBlock(record), 'utf8')
      } catch (err) {
        // The diary is a human-readable side log; a write failure must never
        // break the sweep (the leaf already wraps this, belt-and-suspenders).
        opts.logger?.warn('butler dream diary: append failed', { err: errMsg(err) })
      }
    },
    async readLatest(): Promise<DreamDiarySummary | null> {
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch {
        return null // no diary yet
      }
      return parseLatest(raw)
    },
    async remove(): Promise<void> {
      await rm(path, { force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function renderDiaryBlock(record: DreamRecord): string {
  const summary: DreamDiarySummary = {
    firedAt: record.firedAt,
    promoted: record.promoted.length,
    pruned: record.pruned.length,
    ...(record.profileBytes !== undefined ? { profileBytes: record.profileBytes } : {}),
  }
  const lines: string[] = [
    `${MARKER_PREFIX}${JSON.stringify(summary)}${MARKER_SUFFIX}`,
    `## 复盘 ${new Date(record.firedAt).toISOString()}`,
    '',
  ]
  if (record.promoted.length > 0) {
    const bytes = record.profileBytes !== undefined ? `（${record.profileBytes} 字）` : ''
    lines.push(`- 提升 ${record.promoted.length} 条记忆进画像${bytes}`)
    for (const e of record.promoted) lines.push(`  - [${e.id}] ${clip(e.text)}`)
  }
  if (record.pruned.length > 0) {
    lines.push(`- 封存 ${record.pruned.length} 条陈旧记忆`)
    for (const e of record.pruned) lines.push(`  - [${e.id}] ${clip(e.text)}`)
  }
  lines.push('', '')
  return lines.join('\n')
}

/** Find the LAST machine marker and parse its counts. Tolerant of a corrupt tail. */
function parseLatest(raw: string): DreamDiarySummary | null {
  const markers = raw
    .split('\n')
    .filter((l) => l.startsWith(MARKER_PREFIX) && l.endsWith(MARKER_SUFFIX))
  const last = markers.at(-1)
  if (!last) return null
  try {
    const json = last.slice(MARKER_PREFIX.length, last.length - MARKER_SUFFIX.length)
    const parsed = JSON.parse(json) as DreamDiarySummary
    if (typeof parsed.firedAt !== 'number') return null
    return parsed
  } catch {
    return null // a half-written / corrupt marker is not a fatal read
  }
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > TEXT_CLIP ? `${one.slice(0, TEXT_CLIP)}…` : one
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
