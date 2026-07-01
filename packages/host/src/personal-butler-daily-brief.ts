/**
 * personal-butler-daily-brief.ts — the resident butler's BENIGN "每天早上跟我说
 * 声早" toolset (S3-M2).
 *
 * A member says "以后每天早上八点跟我说声早" and the butler flips their daily-brief
 * opt-in ON; "别再每天早上提醒我了" flips it OFF. It exposes ONE benign tool (it
 * runs inline in the butler's loop — turning your own morning brief on/off has no
 * consequence for anyone else, the plainest self-service):
 *
 *   - `set_daily_brief` — turn this member's daily brief on/off + set the hour.
 *
 * The tool only writes the per-user opt-in file (`proactive.json`, see
 * `personal-butler-proactive.ts`); the `ButlerProactiveSweeper` polls it and does
 * the actual sending. So the FEATURE is DEFAULT-OFF: nothing happens until a member
 * explicitly opts in through this tool.
 *
 * ── The security invariant, mirrored from the reminders tool ──────────────────
 * The config is written to the member's OWN namespace (`<rootDir>/user/<userId>/`),
 * scoped by the `userId` the host forces — never a model arg — so the butler can only
 * ever set a brief for the member it serves.
 */

import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@aipehub/llm'

import {
  DEFAULT_BRIEF_HOUR,
  DEFAULT_TZ_OFFSET_MIN,
  readButlerProactiveConfig,
  writeButlerProactiveConfig,
  type ButlerProactiveConfig,
} from './personal-butler-proactive.js'

export interface ButlerDailyBriefDeps {
  /** The member this butler serves — the brief is scoped/written to their namespace. */
  userId: string
  /** Butler memory root (`<space>/butler/memory`) — the opt-in file lives per-user under it. */
  rootDir: string
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

const DAILY_BRIEF_TOOLS: LlmToolDefinition[] = [
  {
    name: 'set_daily_brief',
    description:
      '开启或关闭"每天早上主动问候"。用户想让你每天早上主动跟他说一声(如"每天早上八点跟我说声早")就 enabled=true 并给出 hour(0-23 的本地小时,默认 8);想关掉就 enabled=false。这位用户在马来西亚(UTC+8),tzOffsetMinutes 默认 480,一般不用填。',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: '开启(true)还是关闭(false)每天早上的主动问候。' },
        hour: {
          type: 'number',
          description: '本地小时(0-23),在这个点之后当天会主动问候一次;不填沿用之前的设置(默认 8)。',
        },
        tzOffsetMinutes: {
          type: 'number',
          description: '用户时区相对 UTC 的分钟偏移(马来西亚 = 480);一般不用填。',
        },
      },
      required: ['enabled'],
      additionalProperties: false,
    },
  },
]

class ButlerDailyBriefToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerDailyBriefDeps) {}

  listTools(): LlmToolDefinition[] {
    return DAILY_BRIEF_TOOLS
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name === 'set_daily_brief') return this.doSet(args)
    return text(`未知工具:${name}`, true)
  }

  private async doSet(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (typeof args.enabled !== 'boolean') {
      return text('请说清楚是要开启(enabled=true)还是关闭(enabled=false)每天早上的主动问候。', true)
    }
    const enabled = args.enabled

    let existing: ButlerProactiveConfig | null
    try {
      existing = await readButlerProactiveConfig(this.deps.rootDir, this.deps.userId)
    } catch (err) {
      this.deps.logger?.error('butler daily-brief: read config failed', { err })
      existing = null
    }
    const base: ButlerProactiveConfig = existing ?? {
      enabled: false,
      hour: DEFAULT_BRIEF_HOUR,
      tzOffsetMinutes: DEFAULT_TZ_OFFSET_MIN,
    }

    // hour: keep the member's prior hour unless they re-specified a valid 0-23 one.
    const hour =
      typeof args.hour === 'number' && Number.isInteger(args.hour) && args.hour >= 0 && args.hour <= 23
        ? args.hour
        : base.hour
    const tzOffsetMinutes =
      typeof args.tzOffsetMinutes === 'number' && Number.isFinite(args.tzOffsetMinutes)
        ? args.tzOffsetMinutes
        : base.tzOffsetMinutes

    const next: ButlerProactiveConfig = { enabled, hour, tzOffsetMinutes }
    // Carry the dedup mark so toggling the hour mid-day doesn't re-send today — EXCEPT
    // on a fresh turn-ON (disabled→enabled), where dropping it lets a just-requested
    // brief fire today once the hour is reached.
    const turningOn = enabled && !base.enabled
    if (!turningOn && base.lastSentDate) next.lastSentDate = base.lastSentDate

    try {
      await writeButlerProactiveConfig(this.deps.rootDir, this.deps.userId, next)
    } catch (err) {
      this.deps.logger?.error('butler daily-brief: write config failed', { err })
      return text('设置失败,没能保存你的偏好,待会儿再试一次吧。', true)
    }

    return enabled
      ? text(`好,我以后每天大约 ${hour} 点(你所在时区)会主动跟你说一声。想停就跟我说一声。`)
      : text('好,以后早上不主动打扰你了。')
  }
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}

/**
 * Build the per-user benign "每天早上主动问候" toolset for a resident butler. Add it
 * to `PersonalButlerAgent({ benign })`.
 */
export function buildButlerDailyBriefToolset(deps: ButlerDailyBriefDeps): LlmAgentToolset {
  return new ButlerDailyBriefToolset(deps)
}
