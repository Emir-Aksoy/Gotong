/**
 * personal-butler-longrun.ts — LONG-M2. The butler's long-run task doorway:
 * two BENIGN toolsets over the per-user dossier store.
 *
 * ── Segment trio (record / complete / block) ─────────────────────────────────
 * FIRST-CLASS on the tool face: the machine-rendered relay prompt names these
 * three verbatim (AFR "指路不指空" — a prompt must never point at a tool the
 * schema doesn't carry). They also work from a NORMAL chat turn on purpose:
 * a member saying "把那个长期任务标完成" lets the model settle the dossier
 * directly, and the background chain stands down at its next wake via the
 * driver's terminal pre-guard.
 *
 * ── Control trio (start / list / cancel) ─────────────────────────────────────
 * Low-frequency lifecycle verbs → the AFR directory tier. `start` mirrors the
 * escalate fire-and-forget shape exactly: create the dossier, self-dispatch
 * ONE explicit task at the butler itself carrying only the segment marker,
 * return a receipt — the relay chain (segment → suspend → resume sweep) does
 * the rest. Decomposition ≠ authorization: everything a segment DOES still
 * gates through the butler's own benign/governed toolsets.
 *
 * ── Why benign ───────────────────────────────────────────────────────────────
 * Same argument as the task notebook + escalate: these verbs edit the member's
 * OWN ledger files and dispatch to the member's OWN butler. The store is
 * per-user by construction (the factory opens it under this member's ownerDir),
 * so `task_id` can only ever address this member's dossiers — no-leak is
 * structural, not checked.
 */

import {
  LONGRUN_LIMITS,
  LONGRUN_SEGMENT_PAYLOAD_KEY,
  LONGRUN_TOOL_NAMES,
  clipLongRunText,
  type LongRunDossier,
  type LongRunDossierStore,
  type LongRunStatus,
} from '@gotong/personal-butler'

import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@gotong/llm'
import type { ButlerAskDispatch } from './personal-butler-ask-agent.js'
import type { ButlerEscalatePush } from './personal-butler-escalate.js'

interface LongRunLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void
  error: (msg: string, meta?: Record<string, unknown>) => void
}

export interface ButlerLongRunSegmentDeps {
  store: LongRunDossierStore
  logger?: LongRunLogger
}

export interface ButlerLongRunControlDeps {
  /** The member this butler serves — dossiers and the dispatch are theirs. */
  userId: string
  /** The butler agent's OWN id (`base.id`) — the self-dispatch target. */
  butlerId: string
  /** SAME store instance as the segment trio + the driver (one promise chain). */
  store: LongRunDossierStore
  hub: ButlerAskDispatch
  /** Best-effort member push for start-failure notices (absent = web-only). */
  push?: ButlerEscalatePush
  logger?: LongRunLogger
}

const STATUS_LABEL: Record<LongRunStatus, string> = {
  active: '进行中',
  winding_down: '收尾中',
  done: '已完成',
  blocked: '等成员输入',
  cancelled: '已取消',
}

const PROGRESS_TOOL: LlmToolDefinition = {
  name: LONGRUN_TOOL_NAMES.progress,
  description:
    '长期任务专用:把本段做了什么写进任务档案。下一段冷启动时**只看档案不看本段对话**,所以 did 要自包含;facts 放后面段落还用得上的关键事实;next 写下一段该从哪一步接手;plan 传了就整份替换计划清单(带勾选状态)。',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '长期任务 id(接力提示里印着)。' },
      did: { type: 'string', description: '本段完成了什么(自包含,给下一段的自己看)。' },
      facts: {
        type: 'array',
        items: { type: 'string' },
        description: '可选:值得带给后面段落的关键事实(每条一句)。',
      },
      next: { type: 'string', description: '可选:下一段的第一步。' },
      plan: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            done: { type: 'boolean' },
          },
          required: ['text'],
          additionalProperties: false,
        },
        description: '可选:整份计划清单的替换(传了就整体覆盖,不传不动)。',
      },
    },
    required: ['task_id', 'did'],
    additionalProperties: false,
  },
}

const COMPLETE_TOOL: LlmToolDefinition = {
  name: LONGRUN_TOOL_NAMES.complete,
  description:
    '长期任务专用:整个长期任务的目标已经达成时,提交最终总结并收束任务。只在真正做完时调用——还有剩余工作就继续做或先记进展。',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '长期任务 id。' },
      summary: { type: 'string', description: '最终总结(交付了什么、结论是什么)。' },
    },
    required: ['task_id', 'summary'],
    additionalProperties: false,
  },
}

const BLOCKED_TOOL: LlmToolDefinition = {
  name: LONGRUN_TOOL_NAMES.blocked,
  description:
    '长期任务专用:缺成员的输入/决定、没法再推进时,写清楚要问什么并挂起整个任务(会主动把问题发给成员)。能自己查到/决定的事不要用它。',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '长期任务 id。' },
      question: { type: 'string', description: '要问成员的具体问题(一段话说清)。' },
    },
    required: ['task_id', 'question'],
    additionalProperties: false,
  },
}

const START_TOOL: LlmToolDefinition = {
  name: 'start_longrun_task',
  description:
    '开一项后台分段长跑的长期任务:建档、自动分段接力,每段进展记档,完成/卡住会主动告诉成员。适合一次对话装不下的多步任务(研究、整理、盯一件要跨天的事);几分钟能答完的事不要开。调用前先用一两句话告诉成员你安排了什么。',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: '给这项任务起的 id(小写字母/数字/-/_,≤64 字符,例如 market-scan-q3)。',
      },
      objective: {
        type: 'string',
        description: '任务目标(自包含:背景 + 要做什么 + 期望产出;后台段落只看它不看本对话)。',
      },
      plan: {
        type: 'array',
        items: { type: 'string' },
        description: '可选:初始分步计划(每条一步)。',
      },
      token_budget: {
        type: 'number',
        description: '可选:token 预算上限(默认 500000)。',
      },
      time_budget_minutes: {
        type: 'number',
        description: '可选:执行时长预算(分钟,只计实际执行时间,默认 360)。',
      },
    },
    required: ['task_id', 'objective'],
    additionalProperties: false,
  },
}

const LIST_TOOL: LlmToolDefinition = {
  name: 'list_longrun_tasks',
  description: '列出这位成员的长期任务档案(状态/已跑段数/目标)。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

const CANCEL_TOOL: LlmToolDefinition = {
  name: 'cancel_longrun_task',
  description: '取消一项长期任务;后台接力会在下次唤醒时自然收束,档案留在盘上。',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '要取消的长期任务 id。' },
    },
    required: ['task_id'],
    additionalProperties: false,
  },
}

class ButlerLongRunSegmentToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerLongRunSegmentDeps) {}

  listTools(): LlmToolDefinition[] {
    return [PROGRESS_TOOL, COMPLETE_TOOL, BLOCKED_TOOL]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    try {
      switch (name) {
        case LONGRUN_TOOL_NAMES.progress:
          return await this.progress(args)
        case LONGRUN_TOOL_NAMES.complete:
          return await this.complete(args)
        case LONGRUN_TOOL_NAMES.blocked:
          return await this.blocked(args)
        default:
          return text(`未知工具:${name}`, true)
      }
    } catch (err) {
      // Store validation (ButlerError) carries a model-facing reason — hand it
      // back as an isError result so the model can self-correct in-round.
      return text(err instanceof Error ? err.message : String(err), true)
    }
  }

  private async progress(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const taskId = strArg(args.task_id)
    const did = strArg(args.did)
    if (!taskId) return text('缺 task_id。', true)
    if (!did) return text('缺 did — 本段做了什么要写清楚。', true)
    const d = await this.liveDossier(taskId)
    if (typeof d === 'string') return text(d, true)

    const facts = args.facts
    if (facts !== undefined && !Array.isArray(facts)) return text('facts 要是字符串数组。', true)
    const next = args.next === undefined ? undefined : strArg(args.next)

    // The plan is a FULL replacement — validate the whole shape up front so a
    // half-good array can't leave the dossier with a mangled plan.
    let plan: { text: string; done: boolean }[] | undefined
    if (args.plan !== undefined) {
      if (!Array.isArray(args.plan)) return text('plan 要是 {text, done?} 数组(整份替换)。', true)
      if (args.plan.length > LONGRUN_LIMITS.maxPlanItems) {
        return text(`计划太长(${args.plan.length} > ${LONGRUN_LIMITS.maxPlanItems} 条)。`, true)
      }
      plan = []
      for (const item of args.plan) {
        const t = item && typeof item === 'object' ? strArg((item as { text?: unknown }).text) : ''
        if (!t) return text('plan 每条要有非空 text。', true)
        if (t.length > LONGRUN_LIMITS.maxPlanItemChars) {
          return text(`计划条目太长(> ${LONGRUN_LIMITS.maxPlanItemChars} 字):「${clipLongRunText(t, 40)}」`, true)
        }
        plan.push({ text: t, done: (item as { done?: unknown }).done === true })
      }
    }

    // Journal FIRST (it validates did/facts/next and refuses on a dead dir),
    // then the plan mutate — a rejected journal line must not half-apply.
    const seg = d.segments + 1
    await this.deps.store.appendJournal(taskId, {
      seg,
      did,
      ...(facts !== undefined ? { facts: facts.map((f) => String(f)) } : {}),
      ...(next !== undefined && next !== '' ? { next } : {}),
    })
    if (plan) {
      const replacement = plan
      await this.deps.store.mutate(taskId, (draft) => {
        draft.plan = replacement
      })
    }
    return text(`进展已记入档案(第 ${seg} 段)。${plan ? `计划已整份更新(${plan.length} 条)。` : ''}`)
  }

  private async complete(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const taskId = strArg(args.task_id)
    const summary = strArg(args.summary)
    if (!taskId) return text('缺 task_id。', true)
    if (!summary) return text('缺 summary — 总结要写清交付了什么。', true)
    const d = await this.loadOr(taskId)
    if (typeof d === 'string') return text(d, true)
    if (d.status === 'done') return text('这项任务已经标过完成了,无需重复。', true)
    if (d.status === 'cancelled') return text('这项任务已被取消,不能再标完成。', true)
    const clipped = clipLongRunText(summary, LONGRUN_LIMITS.maxObjectiveChars)
    await this.deps.store.mutate(taskId, (draft) => {
      draft.status = 'done'
      draft.doneSummary = clipped
      draft.waitingForChildren = false
    })
    return text('任务已标记完成,总结已写入档案。')
  }

  private async blocked(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const taskId = strArg(args.task_id)
    const question = strArg(args.question)
    if (!taskId) return text('缺 task_id。', true)
    if (!question) return text('缺 question — 要问成员什么要写清楚。', true)
    const d = await this.loadOr(taskId)
    if (typeof d === 'string') return text(d, true)
    if (d.status === 'done') return text('这项任务已经完成了,不用再挂起。', true)
    if (d.status === 'cancelled') return text('这项任务已被取消。', true)
    if (d.status === 'blocked') return text('这项任务已经在等成员输入了。', true)
    const clipped = clipLongRunText(question, LONGRUN_LIMITS.maxJournalDidChars)
    await this.deps.store.mutate(taskId, (draft) => {
      draft.status = 'blocked'
      draft.blockedQuestion = clipped
    })
    return text('任务已挂起等成员回答;问题会主动发给成员。')
  }

  /** Load, mapping missing/corrupt to a model-facing refusal line. */
  private async loadOr(taskId: string): Promise<LongRunDossier | string> {
    const res = await this.deps.store.load(taskId)
    if (res.kind === 'ok') return res.dossier
    return res.kind === 'missing'
      ? `没有 id 为「${clipLongRunText(taskId, 40)}」的长期任务档案。`
      : `id 为「${clipLongRunText(taskId, 40)}」的档案已损坏(坏件已隔离),请人工检查。`
  }

  /** Like loadOr, but progress additionally requires a non-terminal task. */
  private async liveDossier(taskId: string): Promise<LongRunDossier | string> {
    const d = await this.loadOr(taskId)
    if (typeof d === 'string') return d
    if (d.status === 'done' || d.status === 'cancelled') {
      return `这项任务${STATUS_LABEL[d.status]},进展记不进去了。`
    }
    if (d.status === 'blocked') {
      return '这项任务挂起等成员输入中;要继续,先取消它再重新开一项。'
    }
    return d
  }
}

class ButlerLongRunControlToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerLongRunControlDeps) {}

  listTools(): LlmToolDefinition[] {
    return [START_TOOL, LIST_TOOL, CANCEL_TOOL]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    try {
      switch (name) {
        case 'start_longrun_task':
          return await this.start(args)
        case 'list_longrun_tasks':
          return await this.list()
        case 'cancel_longrun_task':
          return await this.cancel(args)
        default:
          return text(`未知工具:${name}`, true)
      }
    } catch (err) {
      return text(err instanceof Error ? err.message : String(err), true)
    }
  }

  private async start(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const { store, hub, userId, butlerId } = this.deps
    const taskId = strArg(args.task_id)
    const objective = strArg(args.objective)
    if (!taskId) return text('缺 task_id。', true)
    if (!objective) return text('缺 objective — 目标要自包含(后台段落只看它)。', true)
    if (args.plan !== undefined && !Array.isArray(args.plan)) {
      return text('plan 要是字符串数组。', true)
    }
    const minutes = args.time_budget_minutes
    if (minutes !== undefined && (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0)) {
      return text('time_budget_minutes 要是正数。', true)
    }

    // Dossier first — the store enforces id shape, duplicates, the active-task
    // cap, and budget sanity; any refusal comes back as a model-facing reason
    // BEFORE anything is dispatched.
    await store.create({
      taskId,
      userId,
      objective,
      ...(Array.isArray(args.plan) ? { plan: args.plan.map((p) => String(p)) } : {}),
      ...(typeof args.token_budget === 'number' ? { tokenBudget: args.token_budget } : {}),
      ...(typeof minutes === 'number' ? { timeBudgetSec: Math.round(minutes * 60) } : {}),
    })

    // Fire-and-forget self-dispatch (escalate discipline): the reception turn
    // ends NOW; the chain lives in suspended_tasks from the first relay on. A
    // 'suspended' settle IS the success shape (segment ran, relay armed); 'ok'
    // means the task finished terminal within its first segment — also fine.
    void hub
      .dispatch({
        from: userId,
        origin: { orgId: 'local', userId },
        strategy: { kind: 'explicit', to: butlerId },
        payload: { [LONGRUN_SEGMENT_PAYLOAD_KEY]: taskId, prompt: `[longrun:${taskId}]` },
        title: `长期任务:${clipLongRunText(objective, 40)}`,
      })
      .then(
        (result) => {
          if (result.kind === 'suspended' || result.kind === 'ok') return
          this.deps.logger?.warn('butler longrun: first segment did not settle clean', {
            taskId,
            kind: result.kind,
          })
          return this.pushSafe(
            `长期任务「${taskId}」没能启动(${result.kind === 'no_participant' ? '管家不在线' : '首段失败'}),档案还在;稍后可以让我重试或取消它。`,
          )
        },
        (err) => {
          this.deps.logger?.error('butler longrun: start dispatch failed', { taskId, err })
          return this.pushSafe(`长期任务「${taskId}」没能启动(派发失败),档案还在;稍后可以让我重试或取消它。`)
        },
      )

    return text(
      `长期任务「${taskId}」已建档并在后台启动:会自动分段推进,进展记档,完成或需要你决定时我会主动说。现在简短告诉成员你安排了什么就行。`,
    )
  }

  private async list(): Promise<LlmToolCallResult> {
    const rows = await this.deps.store.list()
    if (rows.length === 0) return text('这位成员目前没有长期任务档案。')
    const lines = rows.map(
      (r) =>
        `「${r.taskId}」${STATUS_LABEL[r.status] ?? r.status} · 已跑 ${r.segments} 段 · ${clipLongRunText(r.objective, 60)}`,
    )
    return text(lines.join(String.fromCharCode(0x0a)))
  }

  private async cancel(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const taskId = strArg(args.task_id)
    if (!taskId) return text('缺 task_id。', true)
    const res = await this.deps.store.load(taskId)
    if (res.kind === 'missing') return text(`没有 id 为「${clipLongRunText(taskId, 40)}」的长期任务档案。`, true)
    if (res.kind === 'corrupt') {
      return text(`「${clipLongRunText(taskId, 40)}」的档案已损坏(坏件已隔离),没有可取消的活任务。`, true)
    }
    if (res.dossier.status === 'done') return text('这项任务已经完成了,不用取消。', true)
    if (res.dossier.status === 'cancelled') return text('这项任务本来就已取消。')
    await this.deps.store.mutate(taskId, (draft) => {
      draft.status = 'cancelled'
    })
    return text('已标记取消;后台接力会在下次唤醒时自然收束,档案留在盘上。')
  }

  private async pushSafe(msg: string): Promise<void> {
    const { push, userId } = this.deps
    if (!push) return
    try {
      await push(userId, msg)
    } catch (err) {
      this.deps.logger?.warn('butler longrun: push failed (notice stays in log)', { err, userId })
    }
  }
}

function strArg(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}

/** The FIRST-CLASS segment trio (the relay prompt names these three). */
export function buildButlerLongRunSegmentToolset(deps: ButlerLongRunSegmentDeps): LlmAgentToolset {
  return new ButlerLongRunSegmentToolset(deps)
}

/** The directory-tier lifecycle trio (start / list / cancel). */
export function buildButlerLongRunControlToolset(deps: ButlerLongRunControlDeps): LlmAgentToolset {
  return new ButlerLongRunControlToolset(deps)
}
