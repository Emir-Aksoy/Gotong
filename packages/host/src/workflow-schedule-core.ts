/**
 * workflow-schedule-core.ts — LIFE-L1-M1: the pure decision core of the
 * scheduled-workflow engine ("定时 × 工作流 × 播报" 的地基, 乙案).
 *
 * A schedule says "run workflow W as member U every day at 08:00 (their time)".
 * This module owns ONLY the deterministic decisions: parsing/normalising a
 * schedule definition and answering "is this schedule due at instant T, given
 * the mark of the last firing?". Zero IO, zero LLM, zero deps beyond the
 * already-exported {@link memberLocalNow} date math — the sweeper (M2) does the
 * reading/dispatching/persisting around it.
 *
 * ── Why mark-based dedup instead of a cron library ───────────────────────────
 * The three cadences members actually ask for (morning brief, weekly review,
 * poll-every-N-minutes sentinel) don't need cron's expressive range, and a cron
 * dep would import a parser + its own clock assumptions. The daily-brief sweeper
 * (S3-M2) already proved the shape we mirror here: a single "fire at/after HOUR,
 * at most once per member-local day" gate whose dedup is one stored string. A
 * WEEKLY cadence reuses the exact same mark (the local calendar DATE it fired):
 * same weekday next week is a different date, so it fires again with zero
 * week-boundary special-casing.
 *
 * ── Fail posture ─────────────────────────────────────────────────────────────
 * `normalizeWorkflowSchedule` returns null for a row it can't trust (missing id,
 * unknown cadence, bad hour). Unlike the daily-brief config — where bad fields
 * degrade to safe DEFAULTS — a schedule row that half-parses must NOT run with
 * guessed values (an interval misread as daily would fire at the wrong times all
 * week); a null row is skipped and surfaced by the sweeper's log, never run.
 * The one deliberate clamp: `interval.everyMs` below the floor becomes the floor
 * (the heartbeat's DEFAULT_HEARTBEAT_MIN_MS posture) — too-tight is a foot-gun,
 * not an intent worth refusing.
 */

import { memberLocalNow } from './personal-butler-proactive.js'

/** Floor for `interval` cadence — mirrors the heartbeat scheduler's 60 s min. */
export const SCHEDULE_MIN_INTERVAL_MS = 60_000

/** Default member UTC offset (minutes) when a cadence omits it — Malaysia +08:00,
 *  same default the daily brief uses. */
export const SCHEDULE_DEFAULT_TZ_OFFSET_MIN = 480

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** When a schedule fires. `weekday` follows JS convention (0 = Sunday). */
export type ScheduleCadence =
  | { kind: 'daily'; hour: number; tzOffsetMinutes: number }
  | { kind: 'weekly'; weekday: number; hour: number; tzOffsetMinutes: number }
  | { kind: 'interval'; everyMs: number }

/**
 * One schedule row (a line of the on-disk schedules file). `userId` is the
 * member the run BELONGS to: the sweeper dispatches through the same
 * member-facing gate as `run_my_workflow` (published + surface.me + role +
 * force-set scope key), so a schedule can never do what its member couldn't do
 * by clicking "run" in `/me` — and the BE-M5 run-broadcast then announces the
 * finished run to that same member with zero extra wiring.
 */
export interface WorkflowScheduleDef {
  id: string
  workflowId: string
  userId: string
  cadence: ScheduleCadence
  /** Copyable workflow inputs. The member-scope key is force-set server-side by
   *  the dispatch gate and is never read from here. */
  inputs?: Record<string, unknown>
  enabled: boolean
}

/** Why a schedule did not fire this tick — surfaced for logs + tests. */
export type ScheduleSkipReason =
  | 'disabled'
  | 'before-hour'
  | 'wrong-weekday'
  | 'already-fired'
  | 'interval-not-elapsed'

/**
 * The due verdict. `mark` is what the sweeper must persist as `lastFiredMark`
 * IF it fires: the member-local `YYYY-MM-DD` for daily/weekly (once per local
 * day), the decimal `nowMs` for interval (elapsed-since math next tick).
 */
export type ScheduleDueResult =
  | { due: true; mark: string }
  | { due: false; reason: ScheduleSkipReason }

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined
}

function asIntInRange(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined
}

function normalizeCadence(raw: unknown): ScheduleCadence | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const c = raw as Record<string, unknown>
  const tzOffsetMinutes =
    typeof c.tzOffsetMinutes === 'number' && Number.isFinite(c.tzOffsetMinutes)
      ? c.tzOffsetMinutes
      : SCHEDULE_DEFAULT_TZ_OFFSET_MIN
  if (c.kind === 'daily') {
    const hour = asIntInRange(c.hour, 0, 23)
    if (hour === undefined) return null
    return { kind: 'daily', hour, tzOffsetMinutes }
  }
  if (c.kind === 'weekly') {
    const weekday = asIntInRange(c.weekday, 0, 6)
    const hour = asIntInRange(c.hour, 0, 23)
    if (weekday === undefined || hour === undefined) return null
    return { kind: 'weekly', weekday, hour, tzOffsetMinutes }
  }
  if (c.kind === 'interval') {
    const raw = c.everyMs
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null
    return { kind: 'interval', everyMs: Math.max(raw, SCHEDULE_MIN_INTERVAL_MS) }
  }
  return null
}

/**
 * Coerce one parsed file row into a trustworthy {@link WorkflowScheduleDef},
 * or null when it can't be trusted (see fail posture in the file header).
 * `enabled` must be literally `true` — anything else keeps the row parked.
 */
export function normalizeWorkflowSchedule(raw: unknown): WorkflowScheduleDef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const id = asNonEmptyString(r.id)
  const workflowId = asNonEmptyString(r.workflowId)
  const userId = asNonEmptyString(r.userId)
  const cadence = normalizeCadence(r.cadence)
  if (!id || !workflowId || !userId || !cadence) return null
  const out: WorkflowScheduleDef = {
    id,
    workflowId,
    userId,
    cadence,
    enabled: r.enabled === true,
  }
  if (r.inputs && typeof r.inputs === 'object' && !Array.isArray(r.inputs)) {
    out.inputs = r.inputs as Record<string, unknown>
  }
  return out
}

// ---------------------------------------------------------------------------
// The due gate
// ---------------------------------------------------------------------------

/**
 * Decide whether `def` should fire at `nowMs`, given the persisted mark of its
 * last firing (undefined = never fired). Pure: same inputs, same verdict.
 */
export function scheduleDue(
  def: WorkflowScheduleDef,
  lastFiredMark: string | undefined,
  nowMs: number,
): ScheduleDueResult {
  if (!def.enabled) return { due: false, reason: 'disabled' }
  const c = def.cadence
  if (c.kind === 'interval') {
    if (lastFiredMark !== undefined) {
      const last = Number(lastFiredMark)
      // An unparseable mark (file hand-edited) counts as "never fired" rather
      // than wedging the schedule closed forever.
      if (Number.isFinite(last) && nowMs - last < c.everyMs) {
        return { due: false, reason: 'interval-not-elapsed' }
      }
    }
    return { due: true, mark: String(nowMs) }
  }
  const local = memberLocalNow(nowMs, c.tzOffsetMinutes)
  if (c.kind === 'weekly' && local.weekday !== c.weekday) {
    return { due: false, reason: 'wrong-weekday' }
  }
  if (local.hour < c.hour) return { due: false, reason: 'before-hour' }
  if (lastFiredMark === local.date) return { due: false, reason: 'already-fired' }
  return { due: true, mark: local.date }
}
