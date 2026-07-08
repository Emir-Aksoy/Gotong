/**
 * butler-clock.ts — give the resident butler a passive sense of "now".
 *
 * # The problem
 *
 * A `MemoryAugmentedAgent`'s system prompt LEADS with a byte-stable frozen
 * memory block (so the prompt-cache prefix never changes — see
 * `@gotong/personal-memory`'s `MemorySession`). The current wall-clock is the
 * exact opposite of byte-stable: it changes every minute. So the time can NEVER
 * live in the frozen block — a butler that only had the frozen block literally
 * cannot know what day it is, which is why asking it "现在几点 / 今天几号" fell
 * flat.
 *
 * # The fix: ride the per-turn context-probe seam (CARE-M4)
 *
 * `PersonalButlerAgent` already appends a per-turn `contextProbe` card to the
 * END of the system prompt — after the frozen block + persona — precisely for
 * variable context that must NOT touch the cache prefix (the onboarding 现状卡,
 * the task-notebook recitation digest). The clock is one more such card: a pure
 * `Date` render, re-run every turn, injected into the variable tail. Zero LLM
 * (the framework runs no model here — this is arithmetic on a timestamp), zero
 * new dependency, and the cache prefix stays byte-identical.
 *
 * # Timezone (why it's explicit, not "just use the system clock")
 *
 * `Date` is an absolute instant; a human-facing "今天几号 / 现在几点" only means
 * something in a timezone. The host process's system tz is NOT reliably the
 * member's: a Malaysian user's hub can run on a server whose tz is UTC or
 * Asia/Shanghai (or a dev box in America/Los_Angeles). So the card ALWAYS prints
 * the IANA zone + UTC offset it used, and a UTC anchor, so the reading is
 * unambiguous and the model can convert to any other zone on request. The zone
 * defaults to the host-resolved one (which honors the standard `TZ` env var —
 * set `TZ=Asia/Kuala_Lumpur` in the deployment to pin it) and is overridable per
 * call for tests / future per-user wiring.
 *
 * # Never throws
 *
 * A bad `timeZone` string makes `Intl.DateTimeFormat` throw. The card MUST still
 * appear (a butler with no time sense is the very bug we're fixing), so a format
 * failure degrades to a plain UTC ISO rendering rather than dropping the card.
 */

import type { ButlerContextProbe } from './task-notebook.js'

export interface ButlerClockProbeOptions {
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number
  /**
   * IANA timezone (e.g. `Asia/Kuala_Lumpur`). Default = host-resolved
   * (`Intl.DateTimeFormat().resolvedOptions().timeZone`, which honors `TZ`).
   */
  timeZone?: string
  /** Locale for the weekday / field rendering. Default `zh-CN`. */
  locale?: string
}

/** The host's resolved IANA timezone, or `'UTC'` if the runtime can't say. */
function resolveSystemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** `2026-07-08T14:34Z` — a compact minute-precision UTC anchor for conversions. */
function utcAnchor(ms: number): string {
  // toISOString → `2026-07-08T14:34:56.000Z`; keep through the minute.
  return new Date(ms).toISOString().slice(0, 16) + 'Z'
}

/**
 * Render the one-line current-time card, e.g.
 *   `【当前时间】2026-07-08 星期二 22:34（Asia/Kuala_Lumpur, UTC+08:00）· UTC 2026-07-08T14:34Z`
 * Pure + total: on any formatting fault it falls back to a UTC ISO line so the
 * card is never dropped.
 */
export function renderClockCard(ms: number, timeZone: string, locale = 'zh-CN'): string {
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date(ms))
    const get = (t: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === t)?.value ?? ''
    const date = `${get('year')}-${get('month')}-${get('day')}`
    const time = `${get('hour')}:${get('minute')}`
    const weekday = get('weekday')
    // `longOffset` renders as `GMT+08:00`; present it as `UTC+08:00`.
    const offset = get('timeZoneName').replace(/^GMT/, 'UTC') || 'UTC+00:00'
    return `【当前时间】${date} ${weekday} ${time}（${timeZone}, ${offset}）· UTC ${utcAnchor(ms)}`
  } catch {
    // Bad tz / exotic runtime → still give SOME time (the whole point).
    return `【当前时间】UTC ${utcAnchor(ms)}`
  }
}

/**
 * A `ButlerContextProbe` that injects the current date/time every turn. Always
 * returns a non-null card — knowing "now" is table stakes for an assistant, and
 * the card rides the variable prompt tail (never the cached frozen block). Wire
 * it FIRST in the factory's `composeContextProbes(...)` so time leads the tail.
 */
export function buildButlerClockProbe(opts: ButlerClockProbeOptions = {}): ButlerContextProbe {
  const now = opts.now ?? Date.now
  const locale = opts.locale ?? 'zh-CN'
  const timeZone = opts.timeZone ?? resolveSystemTimeZone()
  return async () => renderClockCard(now(), timeZone, locale)
}
