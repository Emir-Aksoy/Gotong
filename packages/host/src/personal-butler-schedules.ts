/**
 * personal-butler-schedules.ts — SEN-M4. The butler's BENIGN schedules eye:
 * "我名下有哪些定时工作流,什么节奏,上次什么时候跑的".
 *
 * LIFE-L1 gave schedules an admin CRUD face only — a member asking Atong
 * "每天早上自动跑什么?" got an improvised answer. This is the member-facing
 * read-only projection over the SAME admin `list()` (one normalise path, no
 * second parser): the surface filters to rows whose `userId` IS the asking
 * member, which is exactly the ownership the sweeper dispatches under (a
 * schedule can never do more than its member could by clicking "run" in /me,
 * so a member seeing their own rows discloses nothing new).
 *
 * ── Minimal projection ───────────────────────────────────────────────────────
 * The row carries only what the rendering needs: workflowId / cadence /
 * enabled / valid / lastFiredMark. `inputs` (workflow payload), the schedule
 * id and the userId never enter the projection — same red-line posture as
 * list_peers (endpoint/token stay out structurally).
 *
 * ── Honesty notes ────────────────────────────────────────────────────────────
 * - A row that failed normalisation (`valid: false`) renders as "配置有误,
 *   没在跑" when its userId still parsed as this member; a row so broken its
 *   userId is unrecoverable belongs to no member view — the admin panel is
 *   where broken rows live.
 * - `lastFiredMark` is the sweeper's dedup mark, not a run log: for daily /
 *   weekly it IS the member-local calendar date it fired (printable as-is);
 *   for interval it is the epoch-ms instant (rendered as UTC time).
 * - Members have no write face for schedules (LIFE-L1: admin CRUD is the only
 *   writer), so the copy points at the admin panel — never at a tool.
 */

import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@gotong/llm'

import type { ScheduleCadence } from './workflow-schedule-core.js'

/** One schedule of the asking member, projected minimal (no inputs/id/userId). */
export interface ButlerScheduleRow {
  workflowId: string
  /** null = the stored row failed normalisation (`valid` will be false). */
  cadence: ScheduleCadence | null
  enabled: boolean
  valid: boolean
  /** Sweeper dedup mark: local DATE (daily/weekly) or epoch-ms string (interval). */
  lastFiredMark: string | null
}

/** The per-member roster the toolset reads. */
export interface ButlerScheduleSurface {
  listForUser(userId: string): Promise<ButlerScheduleRow[]>
}

/**
 * The narrow slice of `WorkflowScheduleAdminService` the surface wraps —
 * duck-typed so unit tests need no real sweeper/space and the butler side
 * structurally never sees upsert/remove/fire.
 */
export interface ButlerScheduleSurfaceDeps {
  admin: {
    list(): Promise<
      Array<{
        workflowId: string
        userId: string
        cadence: ScheduleCadence | null
        enabled: boolean
        valid: boolean
        lastFiredMark?: string
      }>
    >
  }
}

/**
 * Wrap the admin list into the member-scoped projection. Rows are filtered by
 * exact userId — an invalid row whose userId could not be recovered (admin's
 * invalidView yields '') matches nobody, by design.
 */
export function buildButlerScheduleSurface(deps: ButlerScheduleSurfaceDeps): ButlerScheduleSurface {
  return {
    async listForUser(userId) {
      const rows = await deps.admin.list()
      return rows
        .filter((r) => r.userId === userId)
        .map((r) => ({
          workflowId: r.workflowId,
          // Copy defensively — the projection must never alias a mutable
          // upstream object (and never carry fields beyond the declared shape).
          cadence: r.cadence ? { ...r.cadence } : null,
          enabled: r.enabled,
          valid: r.valid,
          lastFiredMark: r.lastFiredMark ?? null,
        }))
    },
  }
}

const LIST_TOOL: LlmToolDefinition = {
  name: 'list_schedules',
  description:
    '看你名下的定时工作流:哪条工作流在按什么节奏自动跑、启用没有、上次什么时候触发。成员问「每天早上自动跑什么」「我的定时还开着吗」时用它。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

export interface ButlerSchedulesDeps {
  userId: string
  schedules: ButlerScheduleSurface
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const

/** Minutes-east-of-UTC → "UTC+8" / "UTC-5:30" / "UTC". */
function fmtTz(min: number): string {
  if (min === 0) return 'UTC'
  const abs = Math.abs(min)
  const rem = abs % 60
  return `UTC${min < 0 ? '-' : '+'}${Math.floor(abs / 60)}${rem ? `:${String(rem).padStart(2, '0')}` : ''}`
}

/** Interval ms → "N 分钟" / whole hours as "N 小时". */
function fmtEvery(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  return min >= 60 && min % 60 === 0 ? `${min / 60} 小时` : `${min} 分钟`
}

/** Render a cadence in plain words — the hour is member-local per its tz. */
function cadenceLine(c: ScheduleCadence): string {
  if (c.kind === 'daily') return `每天 ${String(c.hour).padStart(2, '0')}:00(${fmtTz(c.tzOffsetMinutes)})`
  if (c.kind === 'weekly') {
    return `每周${WEEKDAYS[c.weekday] ?? String(c.weekday)} ${String(c.hour).padStart(2, '0')}:00(${fmtTz(c.tzOffsetMinutes)})`
  }
  return `每 ${fmtEvery(c.everyMs)}`
}

/**
 * Render the last-fired mark honestly per its real encoding: daily/weekly
 * marks ARE the member-local calendar date (print as-is); interval marks are
 * epoch-ms (print as UTC minute). A mark that fails to parse says so rather
 * than printing a raw number as if it were a date.
 */
function firedLine(c: ScheduleCadence | null, mark: string | null): string {
  if (mark === null) return '还没触发过'
  if (c?.kind === 'interval') {
    const ms = Number(mark)
    return Number.isFinite(ms)
      ? `上次触发:${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}(UTC)`
      : '上次触发:(记录无法解析)'
  }
  return `上次触发:${mark}`
}

class ButlerSchedulesToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerSchedulesDeps) {}

  listTools(): LlmToolDefinition[] {
    return [LIST_TOOL]
  }

  async callTool(name: string): Promise<LlmToolCallResult> {
    if (name !== 'list_schedules') return text(`未知工具:${name}`, true)
    let rows: ButlerScheduleRow[]
    try {
      rows = await this.deps.schedules.listForUser(this.deps.userId)
    } catch (err) {
      this.deps.logger?.error('butler schedules: list failed', { err })
      return text('暂时读不到定时列表,稍后再试。', true)
    }
    if (rows.length === 0) {
      return text('你名下没有定时工作流。想让某条工作流定时自动跑(比如每天早上的晨报),请管理员在面板新增。')
    }
    const lines = rows.map((r) => {
      const wf = r.workflowId || '(工作流未知)'
      if (!r.valid || r.cadence === null) {
        return `- 工作流 ${wf} — 配置有误,这条没在跑;请管理员在面板检查`
      }
      const state = r.enabled ? '已启用' : '已停用'
      return `- 工作流 ${wf} — ${cadenceLine(r.cadence)};${state};${firedLine(r.cadence, r.lastFiredMark)}`
    })
    return text(
      `你的定时工作流(${rows.length} 条):\n${lines.join('\n')}\n想新增定时或调整节奏,请管理员在面板配置。`,
    )
  }
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}

/**
 * Build the benign schedules eye. Directory tier (AFR-M3); the factory drops
 * it when the schedules surface is absent (sweeper not wired).
 */
export function buildButlerSchedulesToolset(deps: ButlerSchedulesDeps): LlmAgentToolset {
  return new ButlerSchedulesToolset(deps)
}
