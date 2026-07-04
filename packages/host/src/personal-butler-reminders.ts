/**
 * personal-butler-reminders.ts — the resident butler's BENIGN "set a reminder"
 * toolset (Stream-3 S3-M1).
 *
 * A member says "半小时后提醒我喝水" and the butler schedules a one-shot reminder
 * that pings them back over IM at the time. It exposes one benign tool (it runs
 * inline in the butler's loop, never parks the butler turn):
 *
 *   - `set_reminder` — schedule a reminder for THIS member.
 *
 * ── Why this is safe to run inline (not governed) ────────────────────────────
 * Setting a reminder for yourself has no consequence for anyone else — it's the
 * plainest kind of self-service. The tool dispatches to the `ReminderParticipant`
 * broker (capability `gotong.reminder/v1`), which PARKS the reminder task (a
 * separate task) with a finite `resumeAt`; the butler's own turn does NOT suspend —
 * `hub.dispatch` returns `{ kind:'suspended' }` promptly once the broker parks, so
 * the tool AWAITS that result and reports back inline. (Contrast S1-M1's fire-and-
 * forget workflow run, which resolves only when the whole run finishes.)
 *
 * ── The security invariant, mirrored from S1-M1 ──────────────────────────────
 * `userId` is FORCE-SET to the member's own id server-side (never taken from the
 * model's args) and the dispatch is attributed to them, so the butler can only ever
 * remind the member it serves. The reminder TIME is validated by the broker
 * (`parseReminderPayload`): a valid ISO instant WITH an explicit offset, strictly
 * future, within a year — a bad value comes back as `{ kind:'failed' }` and the tool
 * turns it into a friendly refusal.
 */

import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'

import { REMINDER_CAPABILITY } from './reminder-participant.js'

/** Narrow projection of the dispatch result the tool inspects (a `TaskResult`). */
interface ReminderDispatchResult {
  kind: string
  error?: string
  resumeAt?: number
}

/** The narrow slice of `Hub.dispatch` the tool AWAITS (unlike S1-M1 it reads the
 * result, because dispatching to a broker that parks returns `suspended` promptly). */
export interface ButlerReminderDispatchHub {
  dispatch(input: {
    from: string
    origin: { orgId: string; userId: string }
    strategy: { kind: 'capability'; capabilities: string[] }
    payload: Record<string, unknown>
    title: string
  }): Promise<ReminderDispatchResult>
}

export interface ButlerRemindersDeps {
  /** The member this butler serves — reminders are scoped/attributed to them. */
  userId: string
  /** Hub dispatch surface. */
  hub: ButlerReminderDispatchHub
  /** Capability the reminder broker listens on; defaults to `REMINDER_CAPABILITY`. */
  capability?: string
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

const REMINDER_TOOLS: LlmToolDefinition[] = [
  {
    name: 'set_reminder',
    description:
      '给这个成员设一个一次性提醒,到时间我会通过 IM 主动提醒他。把用户说的相对时间(如"半小时后""明早8点""下周一")换算成绝对时间,用带时区偏移的 ISO 8601 格式;这位用户在马来西亚(UTC+8),默认用 +08:00(如 2026-07-01T14:30:00+08:00)。时间必须是将来、且在一年内。',
    inputSchema: {
      type: 'object',
      properties: {
        when: {
          type: 'string',
          description: '提醒的绝对时间,带时区偏移的 ISO 8601(如 2026-07-01T14:30:00+08:00)。',
        },
        text: { type: 'string', description: '提醒内容,到时会原样发给成员。' },
      },
      required: ['when', 'text'],
      additionalProperties: false,
    },
  },
]

class ButlerRemindersToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerRemindersDeps) {}

  listTools(): LlmToolDefinition[] {
    return REMINDER_TOOLS
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name === 'set_reminder') return this.doSet(args)
    return text(`未知工具:${name}`, true)
  }

  private async doSet(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const when = typeof args.when === 'string' ? args.when : ''
    const body = typeof args.text === 'string' ? args.text.trim() : ''
    if (!when) return text('缺少提醒时间(when),请给一个带时区偏移的绝对时间(如 2026-07-01T14:30:00+08:00)。', true)
    if (!body) return text('缺少提醒内容(text)。', true)

    let result: ReminderDispatchResult
    try {
      result = await this.deps.hub.dispatch({
        from: this.deps.userId,
        origin: { orgId: 'local', userId: this.deps.userId },
        strategy: { kind: 'capability', capabilities: [this.deps.capability ?? REMINDER_CAPABILITY] },
        // userId is FORCED to the member's own id — the one security invariant.
        payload: { userId: this.deps.userId, when, text: body },
        title: `提醒 — ${this.deps.userId}`,
      })
    } catch (err) {
      this.deps.logger?.error('butler reminders: dispatch failed', { err })
      return text(`设定提醒失败:${err instanceof Error ? err.message : String(err)}`, true)
    }

    if (result.kind === 'suspended') {
      // Parked successfully — the broker validated the time and will fire it.
      return text(`已设定提醒:我会在 ${when} 提醒你「${body}」。`)
    }
    if (result.kind === 'failed') {
      // The broker's ReminderError message (bad/past/too-far time) — surface it so
      // the butler can rephrase or ask for a corrected time.
      return text(result.error ?? '设定提醒失败,请检查提醒时间。', true)
    }
    // no_participant (broker not registered) or anything unexpected.
    return text('现在没法设定提醒(提醒功能未启用)。', true)
  }
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}

/**
 * Build the per-user benign "set a reminder" toolset for a resident butler. Add it
 * to `PersonalButlerAgent({ benign })`.
 */
export function buildButlerRemindersToolset(deps: ButlerRemindersDeps): LlmAgentToolset {
  return new ButlerRemindersToolset(deps)
}
