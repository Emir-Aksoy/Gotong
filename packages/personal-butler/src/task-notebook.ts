/**
 * task-notebook.ts — the butler's file-first task notebook (TN-M1).
 *
 * A lightweight, PER-MEMBER, cross-turn task ledger for conversational missions
 * ("帮我筹备下周聚会" — five steps, several days, several chat turns). It fills
 * the gap between "fits in one bounded tool-loop turn" and "worth a full
 * workflow": the plan lives in a FILE, so each turn the model only has to
 * "read the digest → do ONE next step → tick it off" instead of holding an
 * N-step plan across turns in its own context. That is the whole point — it is
 * what lets a WEAK model finish a long mission reliably (the same lesson
 * Hermes' `todo` toolset and Manus' todo.md recitation converged on), applied
 * with this repo's file-first discipline.
 *
 * # Boundaries (TN plan doc, user-settled)
 *
 * - BUTLER-LAYER, not framework: this module is pure fs + types — no hub, no
 *   host, no schema. Anyone embedding the butler can use it host-free.
 * - Notebook ≠ authorization: writing "下一步:发邀请" grants NOTHING — when the
 *   butler actually executes a sensitive step it still goes through the
 *   governed gate and parks for approval. The tools here only edit the list.
 * - Notebook ≠ a second workflow engine: no DAG, no dependencies, no scheduler,
 *   no auto-execution loop. The tool descriptions point structured/multi-party
 *   work at `create_workflow` and timed pings at `set_reminder`.
 *
 * # File discipline
 *
 * One JSON file (the host passes `<userDir>/tasks.json`), single machine
 * writer = the butler's own turns (the TN-M2 nudge sweeper writes a SEPARATE
 * fact file, mirroring the workflow-schedules intent/fact split, so the two
 * writers can never race each other). Writes are serialized on a promise chain
 * and land via tmp+rename. A corrupt file is QUARANTINED (renamed to
 * `tasks.json.corrupt-<ts>`) — never silently destroyed — and the notebook
 * restarts empty; explicit caps refuse loudly (no silent truncation).
 *
 * # The recitation seam
 *
 * {@link TaskNotebook.digest} renders open tasks as one compact line each.
 * The host injects it through the EXISTING CARE-M4 `contextProbe` tail (see
 * {@link composeContextProbes}), so the frozen-memory cache prefix is
 * untouched and a member with no open tasks gets `null` → their prompt stays
 * byte-identical to today.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Task } from '@gotong/core'
import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'

import { ButlerError } from './errors.js'

/** One step of a task note. Steps are ordered; `done` flips exactly once. */
export interface TaskNoteStep {
  text: string
  done: boolean
}

/** One task in the notebook. */
export interface TaskNote {
  /** Stable id (`tn-<n>`), monotonic per notebook — the handle every tool takes. */
  id: string
  title: string
  steps: TaskNoteStep[]
  /** Free-form working note — "latest state / context", overwritten on update. */
  note?: string
  status: 'open' | 'done' | 'dropped'
  createdAt: number
  updatedAt: number
}

/** On-disk shape. `nextId` persists so ids never collide across restarts. */
interface NotebookFile {
  v: 1
  nextId: number
  tasks: TaskNote[]
}

/** Explicit caps — refuse loudly instead of silently truncating. */
export const TASK_NOTEBOOK_LIMITS = {
  /** Max OPEN tasks at once (done/dropped don't count). */
  maxOpenTasks: 20,
  /** Max steps per task (including later `add_steps`). */
  maxSteps: 20,
  maxTitleChars: 120,
  maxStepChars: 200,
  maxNoteChars: 500,
  /** Max task lines in the per-turn digest (recitation stays cheap). */
  digestLines: 5,
} as const

/** Minimal logger duck (the host `Logger` satisfies it). */
export interface TaskNotebookLogger {
  warn(msg: string, meta?: Record<string, unknown>): void
}

export interface OpenTaskNotebookOptions {
  /** Absolute path of the notebook JSON (host: `<userDir>/tasks.json`). */
  file: string
  logger?: TaskNotebookLogger
  /** Test seam — defaults to `Date.now`. */
  now?: () => number
}

export interface OpenTaskNoteInput {
  title: string
  steps: string[]
  note?: string
}

export interface UpdateTaskNoteInput {
  /** 1-based indexes of steps to mark done (matching the rendered numbering). */
  doneSteps?: number[]
  /** Steps to append (capped by `maxSteps` overall). */
  addSteps?: string[]
  /** Replace the working note ('' clears it). */
  note?: string
  /** Retitle (rare — same length cap as open). */
  title?: string
}

export interface TaskNotebook {
  /** All tasks, open first (each a defensive copy). */
  list(): Promise<TaskNote[]>
  openNote(input: OpenTaskNoteInput): Promise<TaskNote>
  updateNote(id: string, patch: UpdateTaskNoteInput): Promise<TaskNote>
  closeNote(id: string, outcome?: 'done' | 'dropped'): Promise<TaskNote>
  /**
   * The per-turn recitation card: one line per open task ("title — 下一步 …"),
   * capped at {@link TASK_NOTEBOOK_LIMITS.digestLines} lines, `null` when there
   * are no open tasks (→ the probe injects nothing, prompt unchanged).
   */
  digest(): Promise<string | null>
}

/**
 * Open a notebook bound to one file (= one member). Isolation is by
 * construction: the host resolves the per-user dir (`ownerDir`) and hands us
 * the path — this module never sees userIds or layout.
 */
export function openTaskNotebook(opts: OpenTaskNotebookOptions): TaskNotebook {
  const nowMs = opts.now ?? (() => Date.now())
  let cache: NotebookFile | null = null
  // All mutations ride one promise chain — the butler is this file's ONLY
  // writer (TN-M2's sweeper writes its own fact file), so in-process
  // serialization is the whole story.
  let chain: Promise<unknown> = Promise.resolve()

  const load = async (): Promise<NotebookFile> => {
    if (cache) return cache
    let raw: string
    try {
      raw = await readFile(opts.file, 'utf8')
    } catch {
      cache = { v: 1, nextId: 1, tasks: [] } // no file yet — fresh notebook
      return cache
    }
    const parsed = parseNotebookFile(raw)
    if (parsed) {
      cache = parsed
      return cache
    }
    // Corrupt: QUARANTINE, never silently destroy the member's data. If even
    // the rename fails we still continue fresh — the bytes were unreadable
    // either way, and a wedged notebook would take the whole butler down.
    const quarantine = `${opts.file}.corrupt-${nowMs()}`
    try {
      await rename(opts.file, quarantine)
      opts.logger?.warn('task notebook: corrupt file quarantined', { file: opts.file, quarantine })
    } catch (err) {
      opts.logger?.warn('task notebook: corrupt file could not be quarantined', {
        file: opts.file,
        err: err instanceof Error ? err.message : String(err),
      })
    }
    cache = { v: 1, nextId: 1, tasks: [] }
    return cache
  }

  const save = async (nb: NotebookFile): Promise<void> => {
    await mkdir(dirname(opts.file), { recursive: true })
    const tmp = `${opts.file}.tmp`
    await writeFile(tmp, `${JSON.stringify(nb, null, 2)}\n`, 'utf8')
    await rename(tmp, opts.file) // atomic-ish: a crash never leaves half a file
  }

  /** Serialize a mutation onto the chain; reads share it so they see writes. */
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn)
    chain = next.catch(() => undefined) // a refused op must not wedge the chain
    return next
  }

  const findOpen = (nb: NotebookFile, id: string): TaskNote => {
    const t = nb.tasks.find((x) => x.id === id)
    if (!t) {
      throw new ButlerError('task_note_not_found', `没有 id 为「${id}」的任务(用 list_task_notes 查看现有任务)`)
    }
    if (t.status !== 'open') {
      throw new ButlerError('task_note_not_found', `任务「${id}」已${t.status === 'done' ? '完成' : '放弃'},不能再改`)
    }
    return t
  }

  return {
    list: () =>
      enqueue(async () => {
        const nb = await load()
        const rank = (t: TaskNote): number => (t.status === 'open' ? 0 : 1)
        return [...nb.tasks]
          .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)
          .map(cloneNote)
      }),

    openNote: (input) =>
      enqueue(async () => {
        const title = requireText('title', input.title, TASK_NOTEBOOK_LIMITS.maxTitleChars)
        if (!Array.isArray(input.steps) || input.steps.length === 0) {
          throw new ButlerError('task_note_invalid', '至少要有 1 个步骤(steps)')
        }
        if (input.steps.length > TASK_NOTEBOOK_LIMITS.maxSteps) {
          throw new ButlerError(
            'task_note_invalid',
            `步骤太多(${input.steps.length} > ${TASK_NOTEBOOK_LIMITS.maxSteps})— 这种规模的事建议用 create_workflow 建正式工作流`,
          )
        }
        const steps = input.steps.map((s, i) => ({
          text: requireText(`steps[${i + 1}]`, s, TASK_NOTEBOOK_LIMITS.maxStepChars),
          done: false,
        }))
        const note = optionalNote(input.note)
        const nb = await load()
        const open = nb.tasks.filter((t) => t.status === 'open').length
        if (open >= TASK_NOTEBOOK_LIMITS.maxOpenTasks) {
          throw new ButlerError(
            'task_note_limit',
            `进行中任务已达上限(${TASK_NOTEBOOK_LIMITS.maxOpenTasks})— 先 close_task_note 收掉几条`,
          )
        }
        const ts = nowMs()
        const task: TaskNote = {
          id: `tn-${nb.nextId}`,
          title,
          steps,
          ...(note !== undefined ? { note } : {}),
          status: 'open',
          createdAt: ts,
          updatedAt: ts,
        }
        nb.nextId += 1
        nb.tasks.push(task)
        await save(nb)
        return cloneNote(task)
      }),

    updateNote: (id, patch) =>
      enqueue(async () => {
        const nb = await load()
        const t = findOpen(nb, id)
        if (patch.doneSteps !== undefined) {
          if (!Array.isArray(patch.doneSteps) || patch.doneSteps.length === 0) {
            throw new ButlerError('task_note_invalid', 'done_steps 要是非空的步骤序号数组(从 1 数)')
          }
          for (const n of patch.doneSteps) {
            if (!Number.isInteger(n) || n < 1 || n > t.steps.length) {
              throw new ButlerError(
                'task_note_invalid',
                `步骤序号 ${String(n)} 不存在(该任务共 ${t.steps.length} 步,从 1 数)`,
              )
            }
            t.steps[n - 1]!.done = true
          }
        }
        if (patch.addSteps !== undefined) {
          if (!Array.isArray(patch.addSteps) || patch.addSteps.length === 0) {
            throw new ButlerError('task_note_invalid', 'add_steps 要是非空的步骤文本数组')
          }
          if (t.steps.length + patch.addSteps.length > TASK_NOTEBOOK_LIMITS.maxSteps) {
            throw new ButlerError(
              'task_note_limit',
              `加上新步骤会超过每任务 ${TASK_NOTEBOOK_LIMITS.maxSteps} 步的上限 — 考虑 create_workflow`,
            )
          }
          for (const [i, s] of patch.addSteps.entries()) {
            t.steps.push({
              text: requireText(`add_steps[${i + 1}]`, s, TASK_NOTEBOOK_LIMITS.maxStepChars),
              done: false,
            })
          }
        }
        if (patch.note !== undefined) {
          const note = optionalNote(patch.note)
          if (note === undefined || note === '') delete t.note
          else t.note = note
        }
        if (patch.title !== undefined) {
          t.title = requireText('title', patch.title, TASK_NOTEBOOK_LIMITS.maxTitleChars)
        }
        t.updatedAt = nowMs()
        await save(nb)
        return cloneNote(t)
      }),

    closeNote: (id, outcome = 'done') =>
      enqueue(async () => {
        if (outcome !== 'done' && outcome !== 'dropped') {
          throw new ButlerError('task_note_invalid', `outcome 只能是 done 或 dropped(收到「${String(outcome)}」)`)
        }
        const nb = await load()
        const t = findOpen(nb, id)
        t.status = outcome
        t.updatedAt = nowMs()
        await save(nb)
        return cloneNote(t)
      }),

    digest: () =>
      enqueue(async () => {
        const nb = await load()
        const open = nb.tasks.filter((t) => t.status === 'open').sort((a, b) => a.createdAt - b.createdAt)
        if (open.length === 0) return null
        const shown = open.slice(0, TASK_NOTEBOOK_LIMITS.digestLines)
        const lines = shown.map((t) => {
          const doneCount = t.steps.filter((s) => s.done).length
          const next = t.steps.find((s) => !s.done)
          const head = `- [${t.id}] ${t.title}(${doneCount}/${t.steps.length} 步)`
          return next ? `${head} 下一步: ${next.text}` : `${head} 全部步骤已完成 — 可以 close_task_note 收尾`
        })
        const more =
          open.length > shown.length ? `\n(还有 ${open.length - shown.length} 条,用 list_task_notes 查看)` : ''
        return (
          `【任务笔记本】进行中 ${open.length} 条。做完一步就用 update_task_note 勾掉;` +
          `全做完用 close_task_note 收尾:\n${lines.join('\n')}${more}`
        )
      }),
  }
}

// ─── The benign toolset ───────────────────────────────────────────────────────

/**
 * The 4 benign notebook tools. Benign on purpose — editing your own list has no
 * consequence for anyone else (same class as `set_reminder`). Executing a
 * step's real-world action is a DIFFERENT tool call that keeps its own gate.
 */
export function createTaskNotebookToolset(notebook: TaskNotebook): LlmAgentToolset {
  const defs: LlmToolDefinition[] = [
    {
      name: 'open_task_note',
      description:
        '为一件多步、跨对话的事开一条任务笔记(如「筹备聚会」拆成几步)。只是记录计划,不会执行任何步骤;' +
        '敏感动作执行时照常需要审批。多参与者/结构化流程请用 create_workflow;单次定时提醒请用 set_reminder。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: `任务标题(≤${TASK_NOTEBOOK_LIMITS.maxTitleChars} 字)。` },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: `按顺序列出步骤(1-${TASK_NOTEBOOK_LIMITS.maxSteps} 条,每条 ≤${TASK_NOTEBOOK_LIMITS.maxStepChars} 字)。`,
          },
          note: { type: 'string', description: '可选的补充说明/上下文。' },
        },
        required: ['title', 'steps'],
        additionalProperties: false,
      },
    },
    {
      name: 'update_task_note',
      description: '更新一条任务笔记:勾掉已完成的步骤(done_steps,从 1 数)、追加步骤、或改写工作备注。每完成一步就勾一步。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id(如 tn-1,见笔记本摘要或 list_task_notes)。' },
          done_steps: {
            type: 'array',
            items: { type: 'integer' },
            description: '要标记为已完成的步骤序号(从 1 数)。',
          },
          add_steps: { type: 'array', items: { type: 'string' }, description: '要追加的新步骤。' },
          note: { type: 'string', description: '覆盖工作备注(传空字符串清除)。' },
          title: { type: 'string', description: '改标题(少用)。' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'close_task_note',
      description: '收掉一条任务笔记:done=事情办完了,dropped=不做了。收掉后它就不再出现在每轮摘要里。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id(如 tn-1)。' },
          outcome: { type: 'string', enum: ['done', 'dropped'], description: '结局,默认 done。' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_task_notes',
      description: '列出任务笔记本的全部内容(含每条任务的所有步骤与状态)。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]

  return {
    listTools: () => defs,
    async callTool(name, args): Promise<LlmToolCallResult> {
      try {
        switch (name) {
          case 'open_task_note': {
            const t = await notebook.openNote({
              title: String(args.title ?? ''),
              steps: asStringArray(args.steps),
              ...(typeof args.note === 'string' ? { note: args.note } : {}),
            })
            return text(`已开任务「${t.title}」(${t.id},共 ${t.steps.length} 步)。${renderSteps(t)}`)
          }
          case 'update_task_note': {
            const t = await notebook.updateNote(String(args.id ?? ''), {
              ...(args.done_steps !== undefined ? { doneSteps: asIntArray(args.done_steps) } : {}),
              ...(args.add_steps !== undefined ? { addSteps: asStringArray(args.add_steps) } : {}),
              ...(typeof args.note === 'string' ? { note: args.note } : {}),
              ...(typeof args.title === 'string' ? { title: args.title } : {}),
            })
            const left = t.steps.filter((s) => !s.done).length
            return text(
              left === 0
                ? `「${t.title}」(${t.id})全部步骤已完成 — 用 close_task_note 收尾。${renderSteps(t)}`
                : `已更新「${t.title}」(${t.id}),还剩 ${left} 步。${renderSteps(t)}`,
            )
          }
          case 'close_task_note': {
            const outcome = args.outcome === 'dropped' ? 'dropped' : 'done'
            const t = await notebook.closeNote(String(args.id ?? ''), outcome)
            return text(outcome === 'done' ? `「${t.title}」办完了,已归档 ✓` : `「${t.title}」已放弃,不再跟进。`)
          }
          case 'list_task_notes': {
            const all = await notebook.list()
            if (all.length === 0) return text('任务笔记本是空的。')
            const rendered = all
              .map((t) => {
                const flag = t.status === 'open' ? '进行中' : t.status === 'done' ? '已完成' : '已放弃'
                return `[${t.id}] ${t.title} — ${flag}${renderSteps(t)}${t.note ? `\n  备注: ${t.note}` : ''}`
              })
              .join('\n')
            return text(rendered)
          }
          default:
            return text(`未知工具 ${name}`, true)
        }
      } catch (err) {
        // A refused op (caps / bad input / unknown id) comes back as a friendly
        // tool error the model can read and correct — never a thrown turn.
        return text(err instanceof Error ? err.message : String(err), true)
      }
    },
  }
}

// ─── The probe composer (recitation seam) ─────────────────────────────────────

/** The `contextProbe` shape `PersonalButlerAgent` accepts. */
export type ButlerContextProbe = (task: Task) => Promise<string | null>

/**
 * Compose several per-turn probes into the agent's ONE `contextProbe` slot
 * (CARE-M4): run in order, join non-null cards with a blank line, all-null →
 * null. Each part is isolated — one sick probe degrades to "its card missing",
 * never to "no cards at all" (the agent additionally guards the whole probe).
 */
export function composeContextProbes(
  ...probes: Array<ButlerContextProbe | undefined>
): ButlerContextProbe {
  const active = probes.filter((p): p is ButlerContextProbe => typeof p === 'function')
  return async (task) => {
    const cards: string[] = []
    for (const probe of active) {
      try {
        const card = await probe(task)
        if (card) cards.push(card)
      } catch {
        // isolated — see doc comment
      }
    }
    return cards.length > 0 ? cards.join('\n\n') : null
  }
}

// ─── The stall triage (TN-M2 — zero-LLM) ─────────────────────────────────────

/**
 * TN-M2 defaults — stall/cooldown are TIMESTAMP COMPARISONS, no model anywhere.
 * A task counts as stalled after `stallMs` without an update; once nudged it is
 * left alone for `cooldownMs`; one nudge message lists at most `maxListed`
 * tasks (the rest wait their turn — per-task cooldown keeps this honest).
 */
export const TASK_NUDGE_DEFAULTS = {
  stallMs: 3 * 24 * 60 * 60 * 1000,
  cooldownMs: 3 * 24 * 60 * 60 * 1000,
  maxListed: 3,
} as const

/**
 * READ-ONLY snapshot of a notebook file for observers (the TN-M2 sweeper).
 * Missing or corrupt → `[]` and NOTHING ELSE: no quarantine, no rename, no
 * write — the butler's own turn stays this file's only toucher, so a sweeper
 * racing a member's chat turn is structurally impossible (writes land via
 * rename, so a concurrent read sees the old or the new file, never half).
 */
export async function readTaskNotesSnapshot(file: string): Promise<TaskNote[]> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const parsed = parseNotebookFile(raw)
  return parsed ? parsed.tasks.map(cloneNote) : []
}

export interface TriageStalledInput {
  tasks: TaskNote[]
  /** Per-task last-nudge marks (`taskId → epoch ms`) — the sweeper's fact file. */
  marks: Record<string, number>
  now: number
  stallMs?: number
  cooldownMs?: number
}

export interface TaskNudgeTriage {
  /** Open tasks due a nudge, most-stuck first (oldest `updatedAt`). */
  stalled: TaskNote[]
  /** Mark ids whose task is gone/closed — prune so the fact file never grows. */
  pruneIds: string[]
}

/**
 * The zero-LLM progression triage: stalled = open AND untouched for `stallMs`
 * AND not nudged within `cooldownMs`. Pure — the caller owns all I/O. A nudged
 * task the member then works on gets a fresh `updatedAt`, which resets the
 * stall clock naturally; closing it prunes its mark.
 */
export function triageStalledTaskNotes(input: TriageStalledInput): TaskNudgeTriage {
  const stallMs = input.stallMs ?? TASK_NUDGE_DEFAULTS.stallMs
  const cooldownMs = input.cooldownMs ?? TASK_NUDGE_DEFAULTS.cooldownMs
  const openIds = new Set(input.tasks.filter((t) => t.status === 'open').map((t) => t.id))
  const stalled = input.tasks
    .filter((t) => t.status === 'open' && input.now - t.updatedAt >= stallMs)
    .filter((t) => {
      const nudgedAt = input.marks[t.id]
      return nudgedAt === undefined || input.now - nudgedAt >= cooldownMs
    })
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map(cloneNote)
  const pruneIds = Object.keys(input.marks).filter((id) => !openIds.has(id))
  return { stalled, pruneIds }
}

/**
 * Member-facing nudge text (IM), from a template — zero LLM. It asks, never
 * acts: continuing (or dropping) only happens in a conversation turn the
 * MEMBER initiates, per the notebook-≠-authorization boundary. No tool names
 * here — members talk, the butler does the tool calls.
 */
export function formatTaskNudgeMessage(listed: TaskNote[], totalStalled: number): string {
  const lines = listed.map((t) => {
    const doneCount = t.steps.filter((s) => s.done).length
    const next = t.steps.find((s) => !s.done)
    const head = `- ${t.title}(${doneCount}/${t.steps.length} 步)`
    return next ? `${head} 下一步: ${next.text}` : `${head} 步骤都做完了,就差收个尾`
  })
  const more = totalStalled > listed.length ? `\n(还有 ${totalStalled - listed.length} 件也停着)` : ''
  return (
    `笔记本里这${listed.length > 1 ? '几' : ''}件事有几天没动静了:\n${lines.join('\n')}${more}\n` +
    '想继续哪件就跟我说一声;不想做了也告诉我,我帮你结掉。'
  )
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function parseNotebookFile(raw: string): NotebookFile | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof json !== 'object' || json === null) return null
  const nb = json as Partial<NotebookFile>
  if (nb.v !== 1 || typeof nb.nextId !== 'number' || !Array.isArray(nb.tasks)) return null
  for (const t of nb.tasks) {
    const x = t as Partial<TaskNote>
    if (
      typeof x.id !== 'string' ||
      typeof x.title !== 'string' ||
      !Array.isArray(x.steps) ||
      (x.status !== 'open' && x.status !== 'done' && x.status !== 'dropped') ||
      typeof x.createdAt !== 'number' ||
      typeof x.updatedAt !== 'number'
    ) {
      return null
    }
    for (const s of x.steps) {
      const y = s as Partial<TaskNoteStep>
      if (typeof y.text !== 'string' || typeof y.done !== 'boolean') return null
    }
  }
  return json as NotebookFile
}

function cloneNote(t: TaskNote): TaskNote {
  return { ...t, steps: t.steps.map((s) => ({ ...s })) }
}

function requireText(field: string, value: unknown, maxChars: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ButlerError('task_note_invalid', `${field} 不能为空`)
  }
  const v = value.trim()
  if (v.length > maxChars) {
    throw new ButlerError('task_note_invalid', `${field} 太长(${v.length} > ${maxChars} 字)`)
  }
  return v
}

function optionalNote(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ButlerError('task_note_invalid', 'note 要是字符串')
  const v = value.trim()
  if (v.length > TASK_NOTEBOOK_LIMITS.maxNoteChars) {
    throw new ButlerError(
      'task_note_invalid',
      `note 太长(${v.length} > ${TASK_NOTEBOOK_LIMITS.maxNoteChars} 字)`,
    )
  }
  return v
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((x) => String(x))
}

function asIntArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.map((x) => Number(x))
}

function renderSteps(t: TaskNote): string {
  return `\n${t.steps.map((s, i) => `  ${s.done ? '✓' : '○'} ${i + 1}. ${s.text}`).join('\n')}`
}

function text(t: string, isError?: boolean): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}
