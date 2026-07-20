/**
 * A2 时段问候 + 上次对话间隔 — a zero-LLM per-turn card that lets the butler
 * greet by time-of-day and acknowledge a REAL gap since the member last talked
 * ("晚上好，好久不见 —— 距上次聊过约 5 小时"). The raw clock (A0) already gives
 * the exact time; what this adds is the GAP (needs remembered state) plus an
 * explicit 时段 + greeting hint so a weak model opens naturally instead of
 * diving straight in.
 *
 * # State — a tiny per-user `last-seen.json`, OUTSIDE the memory tree
 *
 * `{ at: <ms> }` in a sibling `presence/` dir (not `butler/memory/…`), so the
 * opt-in memory git snapshot (MU-M5) isn't churned by a timestamp that changes
 * every turn. Missing / corrupt reads as FIRST CONTACT (no gap → no card;
 * onboarding owns the very first hello).
 *
 * # Cheap + self-gating
 *
 *  - Rides the same per-turn `contextProbe` tail as the clock / 待办 cards — the
 *    byte-stable frozen block (cache prefix) is untouched.
 *  - Injects ONLY when the gap ≥ 3h. During an active back-and-forth (minutes
 *    apart) it returns `null`, so it never re-greets mid-conversation and the
 *    prompt stays byte-identical.
 *  - Pure time math + one small file; the framework runs no model here.
 *  - Every turn it persists NOW (best-effort atomic write). A write failure just
 *    means next turn sees a slightly staler "last seen" — advisory, never fatal.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { writeFileAtomic } from '@gotong/core'

/** Inject a greeting only after this long away — an active chat (minutes apart)
 *  stays silent. Morning-after-sleep is always well past this. */
export const GAP_GREET_MS = 3 * 60 * 60 * 1000

export interface ButlerLastSeenProbeDeps {
  /** Per-user `last-seen.json` path (a `presence/` sibling of the memory tree). */
  file: string
  now?: () => number
  /** IANA tz for the 时段 bucket. Default = host-resolved (honors `TZ`). */
  timeZone?: string
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void }
  /** Override the greet threshold (tests). Default {@link GAP_GREET_MS}. */
  gapThresholdMs?: number
}

/** The host's resolved IANA timezone, or `'UTC'` if the runtime can't say. */
function resolveSystemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Wall-clock hour (0–23) of `ms` in `timeZone`; -1 if the tz is unusable. */
export function hourInZone(ms: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms))
    const h = Number(parts.find((p) => p.type === 'hour')?.value)
    return Number.isFinite(h) ? h : -1
  } catch {
    return -1
  }
}

/** Map an hour to a 时段 label + a natural greeting suggestion. */
export function partOfDay(hour: number): { label: string; greeting: string } {
  if (hour < 0) return { label: '现在', greeting: '你好' } // tz unknown — stay neutral
  if (hour < 5) return { label: '深夜', greeting: '这么晚还没休息呀' }
  if (hour < 11) return { label: '早上', greeting: '早上好' }
  if (hour < 13) return { label: '中午', greeting: '中午好' }
  if (hour < 18) return { label: '下午', greeting: '下午好' }
  return { label: '晚上', greeting: '晚上好' }
}

/** A human, deliberately-fuzzy gap ("约 5 小时" / "约 2 天"). */
export function formatGap(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 90) return `约 ${Math.max(1, min)} 分钟`
  const hours = Math.round(ms / 3_600_000)
  if (hours < 24) return `约 ${hours} 小时`
  return `约 ${Math.round(ms / 86_400_000)} 天`
}

/** Render the near-status card (never called for a sub-threshold gap). */
export function buildLastSeenCard(gapMs: number, hour: number): string {
  const { label, greeting } = partOfDay(hour)
  return (
    `【近况 · 系统注入】现在是${label}，距上次和用户聊天${formatGap(gapMs)}。` +
    `若合适,自然地打个招呼再接着聊(例如"${greeting}"),别机械复述本卡、也别假装刚才还在聊。`
  )
}

/** Read `{ at }`; missing / corrupt / wrong-shape → null (first contact). */
export async function readLastSeen(file: string): Promise<number | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const v = JSON.parse(raw) as { at?: unknown } | null
    if (v && typeof v.at === 'number' && Number.isFinite(v.at)) return v.at
    return null
  } catch {
    return null
  }
}

/** Persist NOW atomically (tmp+rename). Best-effort — caller swallows. */
export async function writeLastSeen(file: string, ms: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFileAtomic(file, `${JSON.stringify({ at: ms })}\n`)
}

/**
 * Build the per-turn probe. Reads last-seen, persists NOW (best-effort), and
 * returns a greeting card only when the gap crosses the threshold; first contact
 * and active chat both return null.
 */
export function buildButlerLastSeenProbe(
  deps: ButlerLastSeenProbeDeps,
): () => Promise<string | null> {
  const now = deps.now ?? Date.now
  const timeZone = deps.timeZone ?? resolveSystemTimeZone()
  const threshold = deps.gapThresholdMs ?? GAP_GREET_MS
  return async () => {
    const at = now()
    const last = await readLastSeen(deps.file)
    // Persist THIS turn as the new "last seen" for the next one. Best-effort:
    // a write fault is advisory (next turn just sees a staler mark).
    try {
      await writeLastSeen(deps.file, at)
    } catch (err) {
      deps.logger?.warn('butler last-seen: write failed — advisory only', { err })
    }
    if (last === null) return null // first contact — onboarding owns the first hello
    const gap = at - last
    if (gap < threshold) return null // active conversation — no re-greeting
    return buildLastSeenCard(gap, hourInZone(at, timeZone))
  }
}
