/**
 * personal-butler-task-nudge.ts — TN-M2: the notebook's stalled-task nudge.
 *
 * TN-M1 gave the butler a per-member task notebook; this sweep closes the loop
 * for the tasks a member DROPS mid-mission: a note untouched for days gets one
 * short IM ping — "这件事停了几天了,要继续吗?" — and nothing else. The triage
 * is a pure timestamp comparison ({@link triageStalledTaskNotes}), so this
 * whole path costs ZERO model calls; the framework-doesn't-run-LLMs posture
 * holds even for proactive follow-through.
 *
 * # Boundaries (TN plan doc)
 *
 * - A nudge NEVER executes a step. It asks; progressing only happens inside a
 *   conversation turn the member initiates (where governed steps still park).
 * - Two files, two writers, never crossed: the sweeper READS `tasks.json`
 *   through the read-only snapshot (a corrupt notebook is SKIPPED here — the
 *   butler's own turn owns quarantine) and WRITES only its own fact file
 *   `tasks-nudges.json` (per-task last-nudge marks). This mirrors the
 *   workflow-schedules intent/fact split: no rename races, no double writer.
 * - No per-member opt-in file: the notebook only ever contains missions the
 *   member themselves asked to track, so the "threshold" was crossed when they
 *   opened the note. The 3-day stall + 3-day per-task cooldown keeps it quiet;
 *   telling the butler to drop the task silences it for good.
 *
 * # Delivery posture (same as the proactive brief)
 *
 * Push rides the lazy F1 `pushToMember` (CARE-M8 outbox behind it). Marks are
 * written ONLY on a delivered nudge — a bridge-down miss retries next tick,
 * and a member who resumes the task in the meantime resets the stall clock,
 * which cancels the nudge naturally.
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Logger } from '@gotong/core'
import {
  formatTaskNudgeMessage,
  readTaskNotesSnapshot,
  triageStalledTaskNotes,
  TASK_NUDGE_DEFAULTS,
} from '@gotong/personal-butler'
import { ownerDir } from '@gotong/service-memory-file'

import type { ButlerBriefPush } from './personal-butler-proactive.js'

/** Poll cadence — 6h. The stall threshold is 3 DAYS; polling any tighter buys
 *  nothing, and each tick is just file reads + timestamp math (zero LLM). */
export const BUTLER_TASK_NUDGE_INTERVAL_MS = 6 * 60 * 60 * 1000

const NOTES_FILE = 'tasks.json'
const MARKS_FILE = 'tasks-nudges.json'

/** The sweeper's fact file — per-task last-nudge marks. Sole writer: this sweep. */
interface NudgeMarksFile {
  v: 1
  nudgedAt: Record<string, number>
}

/** What one member tick did — surfaced for logging + tests. */
export type TaskNudgeTickOutcome =
  | { nudged: true; count: number }
  | { nudged: false; reason: 'no-notes' | 'nothing-stalled' | 'delivery-failed' }

export interface ButlerTaskNudgeSweeperOptions {
  /** Butler memory root (`<space>/butler/memory`) — same one the factory uses. */
  rootDir: string
  /** The F1 `pushToMember`, read lazily (bridges start after arming). */
  push: ButlerBriefPush
  logger: Logger
  /** Cadence; defaults to {@link BUTLER_TASK_NUDGE_INTERVAL_MS} (6h). */
  intervalMs?: number
  /** Injectable clock (deterministic tests). Default `Date.now`. */
  now?: () => number
}

/**
 * Background sweep over the per-user namespaces (`<rootDir>/user/*`) — the same
 * enumeration the proactive/maintenance sweeps use (deliberately duplicated
 * there too: trivial, and a shared util would couple otherwise-independent
 * sweeps). Does not run at boot; first tick lands one interval after start.
 */
export class ButlerTaskNudgeSweeper {
  private readonly rootDir: string
  private readonly push: ButlerBriefPush
  private readonly log: Logger
  private readonly intervalMs: number
  private readonly now: () => number

  private timer?: ReturnType<typeof setInterval>
  private running = false

  constructor(opts: ButlerTaskNudgeSweeperOptions) {
    this.rootDir = opts.rootDir
    this.push = opts.push
    this.log = opts.logger
    this.intervalMs = opts.intervalMs ?? BUTLER_TASK_NUDGE_INTERVAL_MS
    this.now = opts.now ?? Date.now
  }

  /** Start the interval. `.unref()` so a pending tick never keeps the process alive. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.intervalMs)
    this.timer.unref?.()
    this.log.info('butler task-nudge sweep armed', { intervalMs: this.intervalMs, rootDir: this.rootDir })
  }

  /** Stop the interval (host shutdown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** One pass over every member namespace. Re-entrant-guarded + best-effort. */
  async runOnce(): Promise<void> {
    if (this.running) {
      this.log.debug('butler task-nudge: previous tick still running, skipping')
      return
    }
    this.running = true
    try {
      const userIds = await this.listUserIds()
      let nudged = 0
      for (const userId of userIds) {
        try {
          const outcome = await this.runOnceForMember(userId)
          if (outcome.nudged) nudged++
        } catch (err) {
          this.log.warn('butler task-nudge: member tick failed', {
            userId,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (nudged > 0) this.log.info('butler task-nudge: sweep complete', { members: userIds.length, nudged })
    } finally {
      this.running = false
    }
  }

  /**
   * One member tick: snapshot notes (read-only) → pure triage → template text →
   * push → mark ONLY the listed tasks on a delivered nudge. Exposed for tests.
   */
  async runOnceForMember(userId: string): Promise<TaskNudgeTickOutcome> {
    const dir = ownerDir(this.rootDir, { kind: 'user', id: userId })
    const tasks = await readTaskNotesSnapshot(join(dir, NOTES_FILE))
    if (tasks.length === 0) return { nudged: false, reason: 'no-notes' }

    const marks = await this.readMarks(dir)
    const { stalled, pruneIds } = triageStalledTaskNotes({ tasks, marks: marks.nudgedAt, now: this.now() })
    if (stalled.length === 0) {
      // Nothing due — still tidy the fact file when tasks were closed/removed,
      // so it never grows past the notebook it shadows.
      if (pruneIds.length > 0) {
        for (const id of pruneIds) delete marks.nudgedAt[id]
        await this.writeMarks(dir, marks)
      }
      return { nudged: false, reason: 'nothing-stalled' }
    }

    const listed = stalled.slice(0, TASK_NUDGE_DEFAULTS.maxListed)
    const text = formatTaskNudgeMessage(listed, stalled.length)

    let delivered = false
    let reason: string | undefined
    try {
      const res = await this.push(userId, text)
      if (res && typeof res === 'object') {
        delivered = res.delivered === true
        reason = res.reason
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err)
    }
    if (!delivered) {
      // No mark on a miss — retry next tick (bridge may be down; the outbox
      // behind pushToMember may also have parked it, in which case `delivered`
      // reflects the queue's own answer and the next triage re-decides).
      this.log.warn('butler task-nudge: composed but not delivered', { userId, reason })
      return { nudged: false, reason: 'delivery-failed' }
    }
    const at = this.now()
    for (const t of listed) marks.nudgedAt[t.id] = at
    for (const id of pruneIds) delete marks.nudgedAt[id]
    await this.writeMarks(dir, marks)
    this.log.info('butler task-nudge: nudged', { userId, count: listed.length })
    return { nudged: true, count: listed.length }
  }

  /** Read this sweep's OWN fact file. Missing/corrupt → fresh marks — worst
   *  case one extra nudge after a full cooldown, and we are the sole writer. */
  private async readMarks(dir: string): Promise<NudgeMarksFile> {
    try {
      const raw = await readFile(join(dir, MARKS_FILE), 'utf8')
      const parsed = JSON.parse(raw) as Partial<NudgeMarksFile>
      if (parsed.v === 1 && typeof parsed.nudgedAt === 'object' && parsed.nudgedAt !== null) {
        const nudgedAt: Record<string, number> = {}
        for (const [k, v] of Object.entries(parsed.nudgedAt)) {
          if (typeof v === 'number' && Number.isFinite(v)) nudgedAt[k] = v
        }
        return { v: 1, nudgedAt }
      }
    } catch {
      // fall through — fresh
    }
    return { v: 1, nudgedAt: {} }
  }

  private async writeMarks(dir: string, marks: NudgeMarksFile): Promise<void> {
    await mkdir(dir, { recursive: true })
    const file = join(dir, MARKS_FILE)
    const tmp = `${file}.tmp`
    await writeFile(tmp, `${JSON.stringify(marks, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  /** Member namespaces under `<rootDir>/user/` (dir name = verbatim userId). */
  private async listUserIds(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.rootDir, 'user'), { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return [] // user/ doesn't exist yet — no members, no work
    }
  }
}
