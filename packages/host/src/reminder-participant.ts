/**
 * reminder-participant.ts — the resident butler's REMINDER broker (Stream-3 S3-M1).
 *
 * A member tells the butler "半小时后提醒我喝水" in IM. The butler's benign
 * `set_reminder` tool (see `personal-butler-reminders.ts`) turns the relative time
 * into an ABSOLUTE ISO instant (with an explicit offset) and dispatches to this
 * broker's capability. The broker:
 *   1. validates `{ userId, when, text }` — a well-formed ISO time WITH an explicit
 *      offset, strictly in the FUTURE and within a max window; a past / far-out /
 *      offset-less / malformed value throws a typed `ReminderError`, so the dispatch
 *      fails visibly and the tool phrases a friendly refusal instead of parking a
 *      reminder that would fire at the wrong time (or never);
 *   2. parks the task with a FINITE `resumeAt` = the reminder instant. This is the
 *      exact mirror of `HumanInboxParticipant`'s `NEVER_RESUME_AT` park — there a
 *      HUMAN wakes the task, here a TIMER does, via the Phase 11 resume sweep;
 *   3. on resume (the sweep fires at the instant) pushes the reminder text to the
 *      member's IM through the injected `push`, then settles.
 *
 * This is the long-running-agent pattern (Phase 11) with a timer instead of a human
 * resolve — it reuses suspend/resume + the resume sweep + `suspended_tasks`
 * persistence WHOLE (a reminder set before a restart still fires afterwards, because
 * the broker registers under a FIXED id so `hub.resumeTask(REMINDER_PARTICIPANT_ID,…)`
 * finds it). No new table, no new timer.
 *
 * Delivery is best-effort: if the member's IM isn't reachable when the timer fires
 * (bridge down, member never bound), the reminder SETTLES anyway (it fired — the
 * non-delivery is logged). Re-parking to retry would risk an infinite loop and isn't
 * worth it for S3-M1; a future milestone could add a bounded retry.
 */

import { AgentParticipant, SuspendTaskError, type ParticipantId, type Task } from '@gotong/core'

/** Fixed capability a `set_reminder` tool (or any agent) dispatches to. */
export const REMINDER_CAPABILITY = 'gotong.reminder/v1'

/**
 * Fixed participant id the host registers the broker under. Fixed (not generated)
 * so the resume sweep's `hub.resumeTask(REMINDER_PARTICIPANT_ID, …)` finds it after
 * a restart — mirroring `HUMAN_INBOX_PARTICIPANT_ID`.
 */
export const REMINDER_PARTICIPANT_ID = 'gotong:reminder'

/** How far ahead a reminder may be scheduled. ~1 year + a day of slack. */
export const REMINDER_MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000

/** Longest reminder body we keep — a guard against a runaway payload. */
const REMINDER_TEXT_MAX = 2000

/** A time string must carry an explicit offset (`Z` or `±HH:MM` / `±HHMM`) so the
 * instant is unambiguous regardless of the HOST's timezone. A naive `2026-07-01T14:30`
 * would be parsed in the server's local zone and could fire hours off. */
const OFFSET_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/

/** Typed error for a malformed / out-of-window reminder — never a bare Error. The
 * message is member-readable (zh) because the `set_reminder` tool surfaces it back
 * to the LLM to correct or explain. */
export class ReminderError extends Error {
  constructor(
    readonly code:
      | 'invalid_payload'
      | 'bad_time'
      | 'missing_offset'
      | 'in_past'
      | 'too_far'
      | 'empty_text',
    message: string,
  ) {
    super(message)
    this.name = 'ReminderError'
  }
}

/** The dispatched `gotong.reminder/v1` payload. */
export interface ReminderTaskPayload {
  /** The member to remind — force-set to their own id by the `set_reminder` tool. */
  userId: string
  /** Absolute ISO 8601 instant WITH offset (e.g. `2026-07-01T14:30:00+08:00`). */
  when: string
  /** What to remind them of. */
  text: string
}

/** A validated reminder, ready to park at `whenMs`. */
export interface ParsedReminder {
  userId: string
  when: string
  whenMs: number
  text: string
}

/**
 * Validate + normalise a reminder payload. Exported so it can be unit-tested
 * directly. Throws `ReminderError` on anything the broker can't act on — the tool
 * maps that to a friendly refusal so a bad time never parks a ghost reminder.
 */
export function parseReminderPayload(
  raw: unknown,
  now: number,
  maxWindowMs: number = REMINDER_MAX_WINDOW_MS,
): ParsedReminder {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReminderError('invalid_payload', 'reminder payload must be an object')
  }
  const p = raw as Record<string, unknown>
  if (typeof p.userId !== 'string' || p.userId.length === 0) {
    throw new ReminderError('invalid_payload', 'reminder payload.userId must be a non-empty string')
  }
  if (typeof p.when !== 'string' || p.when.length === 0) {
    throw new ReminderError('bad_time', '提醒时间缺失,需要一个绝对时间(ISO 8601)。')
  }
  if (!OFFSET_SUFFIX.test(p.when)) {
    throw new ReminderError(
      'missing_offset',
      `提醒时间「${p.when}」缺少时区偏移,请写成带偏移的 ISO 8601(如 2026-07-01T14:30:00+08:00)。`,
    )
  }
  const whenMs = Date.parse(p.when)
  if (!Number.isFinite(whenMs)) {
    throw new ReminderError('bad_time', `提醒时间「${p.when}」无法解析,请用 ISO 8601 格式。`)
  }
  if (whenMs <= now) {
    throw new ReminderError('in_past', `提醒时间「${p.when}」已经过去了,请给一个将来的时间。`)
  }
  if (whenMs > now + maxWindowMs) {
    throw new ReminderError('too_far', `提醒时间「${p.when}」太远了(最多一年内)。`)
  }
  const text = typeof p.text === 'string' ? p.text.trim() : ''
  if (text.length === 0) {
    throw new ReminderError('empty_text', '提醒内容不能为空。')
  }
  return { userId: p.userId, when: p.when, whenMs, text: text.slice(0, REMINDER_TEXT_MAX) }
}

/**
 * How the broker delivers a fired reminder. Structurally satisfied by the F1
 * `pushToMember` (`ImBridgesHandle['pushToMember']`); typed narrowly here so the
 * broker takes no `im-bridge` dependency. Injected as a lazy closure in `main.ts`
 * (the IM bridges start after the broker registers), so a reminder set before the
 * bridges are up still delivers once they are.
 */
export type ReminderPush = (
  userId: string,
  text: string,
) => Promise<{ delivered: boolean; reason?: string } | void>

export interface ReminderParticipantOptions {
  /** Deliver a fired reminder to the member's IM. */
  push: ReminderPush
  /** Defaults to `REMINDER_PARTICIPANT_ID`. */
  id?: ParticipantId
  /** Defaults to `REMINDER_CAPABILITY`. */
  capability?: string
  /** Max scheduling window; defaults to `REMINDER_MAX_WINDOW_MS`. */
  maxWindowMs?: number
  /** Clock injection for deterministic tests. */
  now?: () => number
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void
    warn?: (msg: string, meta?: Record<string, unknown>) => void
  }
}

/** State carried across the park — small + JSON-safe (Phase 11 contract). */
interface ReminderState {
  userId: string
  text: string
}

export class ReminderParticipant extends AgentParticipant {
  private readonly push: ReminderPush
  private readonly maxWindowMs: number
  private readonly now: () => number
  private readonly logger: ReminderParticipantOptions['logger']

  constructor(opts: ReminderParticipantOptions) {
    super({
      id: opts.id ?? REMINDER_PARTICIPANT_ID,
      capabilities: [opts.capability ?? REMINDER_CAPABILITY],
    })
    this.push = opts.push
    this.maxWindowMs = opts.maxWindowMs ?? REMINDER_MAX_WINDOW_MS
    this.now = opts.now ?? (() => Date.now())
    this.logger = opts.logger
  }

  protected handleTask(task: Task): Promise<unknown> {
    // Throws ReminderError on a bad payload/time → onTask maps it to a `failed`
    // result, so the `set_reminder` tool sees the reason and phrases a refusal
    // rather than parking a reminder that fires wrong (or never).
    const r = parseReminderPayload(task.payload, this.now(), this.maxWindowMs)
    // Park until the instant. A FINITE resumeAt (unlike the inbox's NEVER) means
    // the resume sweep — a timer, not a person — wakes it.
    throw new SuspendTaskError({
      resumeAt: r.whenMs,
      state: { userId: r.userId, text: r.text } satisfies ReminderState,
    })
  }

  protected async handleResume(task: Task, state: unknown): Promise<unknown> {
    const s = (state ?? {}) as Partial<ReminderState>
    // Prefer the dispatching member's origin over the carried userId (defence in
    // depth — the reminder always reaches whoever set it, never a spoofed target).
    const userId = task.origin?.userId ?? (typeof s.userId === 'string' ? s.userId : '')
    const text = typeof s.text === 'string' ? s.text : ''
    if (!userId || !text) {
      // Malformed carried state (shouldn't happen). Settle rather than re-park —
      // a finite-resumeAt re-park would loop.
      this.logger?.warn?.('reminder: malformed state on resume; dropping', { taskId: task.id })
      return { text: 'reminder dropped: malformed state' }
    }
    let delivered = false
    let reason: string | undefined
    try {
      const res = await this.push(userId, `【提醒】${text}`)
      if (res && typeof res === 'object') {
        delivered = res.delivered === true
        reason = res.reason
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err)
    }
    if (delivered) {
      this.logger?.info?.('reminder fired', { userId, taskId: task.id })
    } else {
      // Best-effort: the reminder fired but couldn't reach the member. Settle
      // anyway (the timer already elapsed) and log the miss.
      this.logger?.warn?.('reminder fired but not delivered', { userId, taskId: task.id, reason })
    }
    return { text: 'reminder delivered', delivered }
  }
}
