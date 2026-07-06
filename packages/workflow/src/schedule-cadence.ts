/**
 * schedule-cadence.ts — the cadence half of the LIFE-L1-M1 pure schedule core.
 *
 * Extracted from the host's `workflow-schedule-core.ts` (FDE-M3) so the WEB
 * template parser can validate a `gotong.template/v1` `schedules[]` block with
 * the SAME normaliser the host sweeper trusts at fire time — web must not
 * depend on host (kernel rule), and a duplicate validator would be a second
 * truth that drifts. Zero IO, zero LLM, zero deps: exactly the @gotong/workflow
 * contract. The due-gate / mark math stays host-side (it needs the member
 * local-time helper); only the shape vocabulary + normaliser live here.
 *
 * Fail posture (unchanged): a cadence that half-parses returns null — the
 * caller decides whether that means "skip the row" (sweeper) or "reject the
 * template loudly at install" (parser). The one deliberate clamp: an
 * `interval.everyMs` below the floor becomes the floor (too-tight is a
 * foot-gun, not an intent worth refusing).
 */

/** Floor for `interval` cadence — mirrors the heartbeat scheduler's 60 s min. */
export const SCHEDULE_MIN_INTERVAL_MS = 60_000

/** Default member UTC offset (minutes) when a cadence omits it — Malaysia +08:00,
 *  same default the daily brief uses. */
export const SCHEDULE_DEFAULT_TZ_OFFSET_MIN = 480

/** When a schedule fires. `weekday` follows JS convention (0 = Sunday). */
export type ScheduleCadence =
  | { kind: 'daily'; hour: number; tzOffsetMinutes: number }
  | { kind: 'weekly'; weekday: number; hour: number; tzOffsetMinutes: number }
  | { kind: 'interval'; everyMs: number }

function asIntInRange(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined
}

/** Normalise one raw cadence object, or null when it can't be trusted. */
export function normalizeScheduleCadence(raw: unknown): ScheduleCadence | null {
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
    const rawMs = c.everyMs
    if (typeof rawMs !== 'number' || !Number.isFinite(rawMs) || rawMs <= 0) return null
    return { kind: 'interval', everyMs: Math.max(rawMs, SCHEDULE_MIN_INTERVAL_MS) }
  }
  return null
}
