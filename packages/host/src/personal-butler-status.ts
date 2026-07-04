/**
 * personal-butler-status.ts — the host side of STATUS.md, the ④写状态 step of the
 * 6h maintenance heartbeat (MR4 §七).
 *
 * The maintenance pass is a COMPOSED `MemoryReviewer` (umbrella 复盘技能 +
 * cleanOutputs 清输出 + dreaming 合并记忆 + reconcile/link/budget), all FS-free
 * leaf code that mutates the jsonl and hands back a one-line summary of what the
 * tick did. ④写状态 is the projection of that summary: each tick this module
 * rewrites `<userDir>/STATUS.md` to "what the butler just did during maintenance"
 * — the human-readable heartbeat the design §八 lists alongside DREAMS.md and
 * SKILL.md.
 *
 * # STATUS.md is a current-snapshot projection, not a diary
 *
 * Like SKILL.md (and unlike append-only DREAMS.md), STATUS.md is OVERWRITTEN every
 * tick: it answers "what was the LAST maintenance pass" — current status, not
 * history. The diary of every dreaming sweep already lives in DREAMS.md (MR2); the
 * audit trail of merges lives in the jsonl's closed procedures. STATUS.md is the
 * single freshest line so a member (or operator) can glance and see the butler is
 * alive and self-maintaining, and what the last tick changed.
 *
 * # The wrapping seam — why a reviewer that wraps a reviewer
 *
 * {@link statusProjectingReviewer} wraps the COMPOSED maintenance reviewer rather
 * than sitting beside it in the compose list. It must run AFTER the inner pass so
 * it can project the inner's merged summary — composing it last would only give it
 * its own (empty) outcome, not the umbrella/clean/dream sub-summaries. So it calls
 * `inner(ctx)`, writes STATUS.md from `out.summary`, and returns `out` UNCHANGED —
 * the side-effect projection must not disturb the heartbeat's notification gating:
 * an idle tick (`inner` → `{}`, HEARTBEAT_OK) still writes a "no changes" status
 * but stays suppressed, exactly like SKILL.md projection returning `{}`.
 *
 * # Why a machine marker line
 *
 * The file opens with a stable HTML-comment marker carrying the structured status
 * as JSON (mirroring DREAMS.md / SKILL.md). Markdown renderers ignore it, humans
 * don't see it, and {@link ButlerStatusFile.read} parses that marker instead of
 * scraping prose — so the `/me` "上次维护" line is robust to any body wording.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Logger } from '@gotong/core'
import type { MemoryReviewer, ReviewContext, ReviewOutcome } from '@gotong/personal-memory'
import { ownerDir } from '@gotong/service-memory-file'
import type { Owner } from '@gotong/services-sdk'

/** Filename of the per-user maintenance status, written inside the user's memory dir. */
export const STATUS_FILE = 'STATUS.md'

/** The stable machine marker that opens the file (`read` keys off it). */
const MARKER_PREFIX = '<!-- gotong-status '
const MARKER_SUFFIX = ' -->'
/** Max chars of the status line shown (a status, not a dump). */
const SUMMARY_CLIP = 500

/** The latest maintenance tick's status, parsed from the machine marker. */
export interface ButlerStatusSummary {
  /** Epoch ms the maintenance pass ran. */
  readonly writtenAt: number
  /** What the pass did this tick (the composed reviewer's summary; '' when idle). */
  readonly summary: string
}

export interface ButlerStatusFile {
  /** Rewrite STATUS.md to the given maintenance summary (best-effort; a throw is swallowed). */
  write(summary: string, now: number): Promise<void>
  /** Parse the latest tick's marker, or null if the file is absent/empty. */
  read(): Promise<ButlerStatusSummary | null>
  /** Delete STATUS.md (the forget-all path cleans this derived file too). */
  remove(): Promise<void>
}

export interface OpenButlerStatusFileOptions {
  /** Memory root dir (same as `openButlerMemory`). */
  rootDir: string
  /** The member whose status this is — the namespace boundary. */
  userId: string
  logger?: Logger
}

/**
 * Open a maintenance status file scoped to one user, wired to the real filesystem.
 * The file lives next to the user's jsonl (via the shared `ownerDir` helper, so
 * layout + owner-id safety stay one source of truth), alongside DREAMS.md and
 * SKILL.md.
 */
export function openButlerStatusFile(opts: OpenButlerStatusFileOptions): ButlerStatusFile {
  if (typeof opts.userId !== 'string' || opts.userId.length === 0) {
    throw new Error('openButlerStatusFile: a non-empty userId is required (per-user namespace)')
  }
  const owner: Owner = { kind: 'user', id: opts.userId }
  const path = join(ownerDir(opts.rootDir, owner), STATUS_FILE)

  return {
    write: async (summary: string, now: number): Promise<void> => {
      try {
        await mkdir(dirname(path), { recursive: true })
        // OVERWRITE — STATUS.md is the current maintenance snapshot, not history.
        await writeFile(path, renderStatusFile(summary, now), 'utf8')
      } catch (err) {
        // A human-readable projection; a write failure must never break the sweep
        // (the truth is the jsonl, this file is rebuildable).
        opts.logger?.warn('butler status file: write failed', { err: errMsg(err) })
      }
    },
    async read(): Promise<ButlerStatusSummary | null> {
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch {
        return null // no status file yet
      }
      return parseStatusSummary(raw)
    },
    async remove(): Promise<void> {
      await rm(path, { force: true })
    },
  }
}

export interface StatusProjectingReviewerOptions {
  /** The per-user status file this projection rewrites each tick. */
  statusFile: ButlerStatusFile
  /**
   * The COMPOSED maintenance reviewer to run, then project. This wraps it rather
   * than composing beside it so STATUS.md sees the inner's MERGED summary (the
   * umbrella/clean/dream sub-summaries), not its own empty outcome.
   */
  inner: MemoryReviewer
}

/**
 * Wrap the composed maintenance reviewer so every tick writes STATUS.md from what
 * the pass did, then returns the inner outcome UNCHANGED. The status write is a
 * side-effect projection: it never alters the heartbeat's notification gating, so
 * an idle tick (inner → `{}`) still records a "no changes" status but stays
 * suppressed (HEARTBEAT_OK).
 */
export function statusProjectingReviewer(opts: StatusProjectingReviewerOptions): MemoryReviewer {
  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    const out = await opts.inner(ctx)
    await opts.statusFile.write(out.summary ?? '', ctx.now)
    return out
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function renderStatusFile(summary: string, now: number): string {
  const clipped = clip(summary)
  const record: ButlerStatusSummary = { writtenAt: now, summary: clipped }
  const lines: string[] = [
    `${MARKER_PREFIX}${JSON.stringify(record)}${MARKER_SUFFIX}`,
    '# 管家维护状态',
    '',
    `_更新于 ${new Date(now).toISOString()}_`,
    '',
    clipped.length > 0 ? `- ${clipped}` : '_（上次维护无需改动）_',
    '',
  ]
  return lines.join('\n')
}

/** Find the machine marker and parse its status. Tolerant of a corrupt file. */
function parseStatusSummary(raw: string): ButlerStatusSummary | null {
  const line = raw
    .split('\n')
    .find((l) => l.startsWith(MARKER_PREFIX) && l.endsWith(MARKER_SUFFIX))
  if (!line) return null
  try {
    const json = line.slice(MARKER_PREFIX.length, line.length - MARKER_SUFFIX.length)
    const parsed = JSON.parse(json) as ButlerStatusSummary
    if (typeof parsed.writtenAt !== 'number' || typeof parsed.summary !== 'string') return null
    return parsed
  } catch {
    return null // a half-written / corrupt marker is not a fatal read
  }
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > SUMMARY_CLIP ? `${one.slice(0, SUMMARY_CLIP)}…` : one
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
