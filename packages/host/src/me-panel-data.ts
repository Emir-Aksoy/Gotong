/**
 * me-panel-data.ts — SDUI C1-a. Member-facing read-only projections for the
 * panel's HUB-INTERNAL named data sources (`schedules.mine` / `tasks.mine` /
 * `status.hub`). The renderer fetches these via GET /api/me/panel/data/* and
 * the web layer pins userId from the session — this module never trusts a
 * caller-supplied id beyond passing it through `ownerDir`'s safety assert.
 *
 * Disclosure argument, per source (no new surface is invented here):
 *  - `schedules.mine` — the SEN-M4 `ButlerScheduleSurface` projection, reused
 *    as-is: rows are filtered to the exact session user; ownership already IS
 *    the disclosure boundary (the sweeper dispatches on that same userId).
 *  - `tasks.mine`     — the member's OWN task notebook (TN), read with the
 *    TN-M2 observer snapshot (missing/corrupt → [] and nothing else; the
 *    butler's turn stays the file's only writer). The free-form working
 *    `note` is deliberately NOT projected — the list needs title + progress.
 *  - `status.hub`     — the SEN-M1 patrol card face (`derivePatrolCards`, the
 *    ONE authority for red/yellow verdicts). Any member can already pull the
 *    same cards through the benign `hub_health` tool; this is the same
 *    projection over HTTP, not a wider one. Full HealthSnapshot detail
 *    (agent rows, connector inventory) structurally stays out.
 *  - `longrun.mine` (OBS-M2) — this member's OWN long-run dossiers, read with
 *    the observer snapshot (`readLongRunSnapshot`): missing/corrupt → skipped
 *    and NOTHING ELSE, the driver's segment stays the only writer. Same TN-M2
 *    discipline, same reason. Disclosure is unchanged: the member can already
 *    ask Atong for every one of these fields through `list_longrun_tasks`;
 *    this is that data on a card instead of in a sentence.
 *  - `usage.mine` (C1-b) — this member's OWN ledger rows, day-bucketed. The
 *    BE-M1 `ButlerUsageSurface` already discloses the same per-user roll-up
 *    (by model, cumulative) to the member via `my_status`; this face is the
 *    same filter (userId) on a different axis (UTC calendar day, windowed).
 *    Other members' usage structurally stays out — the query pins userId.
 *
 * Every getter is three-state honest: surface not wired → null (the renderer
 * shows "source not enabled"), wired but empty → [], data → rows.
 */
import { join } from 'node:path'

import {
  readLongRunSnapshot,
  readTaskNotesSnapshot,
  type LongRunChildRow,
  type LongRunPlanItem,
  type LongRunStatus,
} from '@gotong/personal-butler'
import { ownerDir } from '@gotong/service-memory-file'

import type { AdminHealthSurface } from './admin-health.js'
import { butlerLongRunRoot } from './butler-space-dirs.js'
import { derivePatrolCards } from './personal-butler-patrol.js'
import type { ButlerScheduleSurface } from './personal-butler-schedules.js'

/** Day-bucketed slice of the identity ledger (aggregateLedger groupBy:'day'). */
export interface PanelUsageSurface {
  /** Rows for ONE user in `[since, now)`, keyed by UTC calendar day. */
  dailyForUser(
    userId: string,
    since: number,
  ): Array<{ key: string; calls: number; inputTokens: number; outputTokens: number; costMicros: number }>
}

export interface MePanelDataDeps {
  /** Butler memory root (`<space>/butler/memory`) — the TN notebook lives per-user under it. */
  memoryRoot: string
  /** Lazy — main.ts assigns these refs after construction (onboarding.health 同款惯例). */
  schedules: () => ButlerScheduleSurface | undefined
  health: () => AdminHealthSurface | undefined
  usage?: () => PanelUsageSurface | undefined
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
}

export interface MePanelScheduleRow {
  workflowId: string
  cadence:
    | { kind: 'daily'; hour: number; tzOffsetMinutes: number }
    | { kind: 'weekly'; weekday: number; hour: number; tzOffsetMinutes: number }
    | { kind: 'interval'; everyMs: number }
    | null
  enabled: boolean
  valid: boolean
  lastFiredMark: string | null
}

export interface MePanelTaskRow {
  id: string
  title: string
  stepsDone: number
  stepsTotal: number
  updatedAt: number
}

export interface MePanelStatusCard {
  id: string
  severity: 'red' | 'yellow'
  label: string
  fact: string
}

/**
 * 一项长期任务在卡片上的样子。
 *
 * 刻意比 `MePanelTaskRow` 宽:一项长任务的进展**不是**「几步做完了」——
 * 「它为什么没动」(在等子活 / 在待命等你开口)、预算烧到哪、跑了几段、
 * 上一段到底做了什么,才是人离开几小时后回来真正想知道的东西。少一样,
 * 这张卡就退回成「问阿同」的一个更慢的入口。
 *
 * 每一处自由文本都在**这一层**按码点截断:档案自己的上限(objective 2000、
 * journal.did 1000)是给模型读的,不是给一张卡读的。
 */
export interface MePanelLongRunRow {
  taskId: string
  objective: string
  status: LongRunStatus
  /** 已完成的段数(正在跑的那段是 segments + 1)。 */
  segments: number
  updatedAt: number
  /** 至多 `PLAN_ROWS` 条;`planTotal` 是盘上真实条数(no silent caps)。 */
  plan: LongRunPlanItem[]
  planTotal: number
  planDone: number
  children: Array<Pick<LongRunChildRow, 'id' | 'summary' | 'status'>>
  childrenTotal: number
  childrenPending: number
  budget: { tokensUsed: number; tokenBudget: number; timeUsedSec: number; timeBudgetSec: number }
  /**
   * 为什么它现在不动。null = 它在跑(或者已经结束了)。位序镜像段末裁决
   * 自己的臂序:等子活压过待命——一个真在飞的子活比一句「暂时没事可做」
   * 更能解释此刻的静止。
   */
  waiting: 'children' | 'standby' | null
  /** 待命时它自己说的「在等什么」。 */
  standbyNote?: string
  /** 无条件回看时刻:再没有人开口,它也会在这时候自己醒一次。 */
  standbyCheckBackAt?: number
  blockedQuestion?: string
  doneSummary?: string
  /** 上一段没有干净收尾(崩溃/回收)。 */
  interrupted: boolean
  /** 旧→新(日志自己的顺序,条目自带段号)。 */
  journal: Array<{ seg: number; at: number; did: string; next?: string }>
}

export interface MePanelUsageDay {
  /** UTC calendar day, `YYYY-MM-DD` (the ledger's own bucketing). */
  day: string
  calls: number
  inputTokens: number
  outputTokens: number
  costMicros: number
}

export interface MePanelData {
  schedulesForUser(userId: string): Promise<MePanelScheduleRow[] | null>
  tasksForUser(userId: string): Promise<MePanelTaskRow[] | null>
  hubStatus(): Promise<MePanelStatusCard[] | null>
  usageForUser(userId: string, range: 'week' | 'month'): Promise<MePanelUsageDay[] | null>
  /**
   * `maxFinished` 只封顶**已结束**那一截;没完的任务永远全出。这不是展示
   * 偏好——一个还在跑的任务被一堆已完成的挤出卡片,正是这张卡要治的病。
   * `more` 是盘上没被返回的档案数(no silent caps)。
   */
  longRunForUser(
    userId: string,
    maxFinished?: number,
  ): Promise<{ tasks: MePanelLongRunRow[]; more: number } | null>
}

/** 卡片上的条数上限。总数随行走(`planTotal`/`childrenTotal`),截了要说。 */
const PLAN_ROWS = 12
const CHILD_ROWS = 6
const JOURNAL_ROWS = 3

/** 按**码点**截断(增补平面的字不会被劈成两半),截了缀一个省略号。 */
function clip(text: string, max: number): string {
  const cps = Array.from(text)
  return cps.length <= max ? text : `${cps.slice(0, max).join('')}\u2026`
}

export function buildMePanelData(deps: MePanelDataDeps): MePanelData {
  return {
    async schedulesForUser(userId) {
      const surface = deps.schedules()
      if (!surface) return null
      // The SEN-M4 projection already filters by exact userId and copies
      // defensively — pass rows through untouched (one projection, one truth).
      return surface.listForUser(userId)
    },

    async tasksForUser(userId) {
      // ownerDir asserts the id shape before any path assembly (traversal
      // guard), same boundary the notebook itself writes under.
      let file: string
      try {
        file = join(ownerDir(deps.memoryRoot, { kind: 'user', id: userId }), 'tasks.json')
      } catch {
        return []
      }
      const tasks = await readTaskNotesSnapshot(file)
      return tasks
        .filter((t) => t.status === 'open')
        .map((t) => ({
          id: t.id,
          title: t.title,
          stepsDone: t.steps.filter((s) => s.done).length,
          stepsTotal: t.steps.length,
          updatedAt: t.updatedAt,
        }))
    },

    async hubStatus() {
      const surface = deps.health()
      if (!surface) return null
      try {
        return derivePatrolCards(await surface.snapshot()).map((c) => ({
          id: c.id,
          severity: c.severity,
          label: c.label,
          fact: c.fact,
        }))
      } catch (err) {
        // A failing health probe must not 500 the panel — the renderer's
        // "load failed" state is the honest answer.
        deps.logger?.warn('me-panel-data: health snapshot failed', { err })
        return []
      }
    },

    async longRunForUser(userId, maxFinished) {
      // 与 tasks.mine 同一道 traversal 守卫。这两条都是盘上直读、没有
      // 「未接线」这个状态,故 null 事实上不会发生——留着那一支只是让路由
      // 那边的分发对每个数据源都是同一个形状。
      let dir: string
      try {
        dir = ownerDir(butlerLongRunRoot(deps.memoryRoot), { kind: 'user', id: userId })
      } catch {
        return { tasks: [], more: 0 }
      }
      const snap = await readLongRunSnapshot(dir, {
        maxFinished,
        journalTail: JOURNAL_ROWS,
        logger: deps.logger ? { warn: deps.logger.warn } : undefined,
      })
      return {
        more: snap.more,
        tasks: snap.tasks.map(({ dossier: d, journal }) => {
          const pending = d.children.filter((c) => c.status === 'pending').length
          // 等子活的旗是 sticky 的(裁决那边还有第二道 `pending > 0` 守卫),
          // 所以这里也必须要求真有在飞的子活——照旗直报会让一个早就收齐的
          // 任务在卡上永远显示「在等」。
          const waiting: MePanelLongRunRow['waiting'] =
            d.waitingForChildren && pending > 0 ? 'children' : d.standby ? 'standby' : null
          return {
            taskId: d.taskId,
            objective: clip(d.objective, 200),
            status: d.status,
            segments: d.segments,
            updatedAt: d.updatedAt,
            plan: d.plan.slice(0, PLAN_ROWS).map((i) => ({ text: clip(i.text, 120), done: i.done })),
            planTotal: d.plan.length,
            planDone: d.plan.filter((i) => i.done).length,
            children: d.children.slice(-CHILD_ROWS).map((c) => ({
              id: c.id,
              summary: clip(c.summary, 120),
              status: c.status,
            })),
            childrenTotal: d.children.length,
            childrenPending: pending,
            budget: { ...d.budget },
            waiting,
            ...(waiting === 'standby' && d.standby
              ? { standbyNote: clip(d.standby.note, 160), standbyCheckBackAt: d.standby.checkBackAtMs }
              : {}),
            ...(d.blockedQuestion ? { blockedQuestion: clip(d.blockedQuestion, 400) } : {}),
            ...(d.doneSummary ? { doneSummary: clip(d.doneSummary, 400) } : {}),
            interrupted: d.interrupted,
            journal: journal.map((e) => ({
              seg: e.seg,
              at: e.at,
              did: clip(e.did, 240),
              ...(e.next ? { next: clip(e.next, 160) } : {}),
            })),
          }
        }),
      }
    },

    async usageForUser(userId, range) {
      const surface = deps.usage?.()
      if (!surface) return null
      const days = range === 'month' ? 30 : 7
      try {
        // The ledger aggregate orders by cost DESC; a chart needs time order.
        // Keys are `YYYY-MM-DD`, so a lexical sort IS chronological.
        return surface
          .dailyForUser(userId, Date.now() - days * 86_400_000)
          .map((r) => ({
            day: r.key,
            calls: r.calls,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            costMicros: r.costMicros,
          }))
          .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
      } catch (err) {
        deps.logger?.warn('me-panel-data: usage aggregate failed', { err })
        return []
      }
    },
  }
}
