/**
 * workflow-schedule-sweeper.ts — LIFE-L1-M2: the background sweep that turns
 * on-disk schedule rows into zero-LLM workflow dispatches.
 *
 * The member story: "每天早上 8 点替我跑晨报流，跑完发我 IM" — with NO model
 * anywhere in the scheduling loop. The LLM only runs inside the workflow's own
 * steps; the wake/decide/dispatch path is deterministic (the settled 乙案).
 *
 * ── One gate, not a second one ───────────────────────────────────────────────
 * A due schedule dispatches through the SAME member-facing resolution as the
 * butler's `run_my_workflow` tool ({@link evaluateRunnable}: published +
 * `surface.me.enabled` + role + force-set member scope key). A schedule can
 * never do what its member couldn't do by clicking "run" in `/me` — and because
 * the run is attributed to that member, the BE-M5 run-broadcast sweep announces
 * the finished run to their IM with zero extra wiring here (its header already
 * names "a schedule" as an expected run source).
 *
 * ── Files: intent vs fact ────────────────────────────────────────────────────
 * `<space>/workflow-schedules.json` is the INTENT — an array of rows humans or
 * the admin API write. `<space>/workflow-schedules.state.json` is the FACT —
 * the per-schedule `lastFiredMark` this sweeper persists. Split on purpose: a
 * hand-edited intent file never races the machine's mark writes (the daily
 * brief merges both into one file only because that file has a single machine
 * writer). A lost/corrupt STATE file degrades to "never fired" — for daily/
 * weekly that's at most one same-day re-fire, for interval one early fire;
 * both beat a schedule wedged shut forever.
 *
 * ── Fire = attempt ───────────────────────────────────────────────────────────
 * The mark is written once the dispatch is HANDED to the hub (fire-and-forget,
 * mirroring `run_my_workflow` — a run with human steps can take hours, no
 * background tick can await it). A run that then fails is the run-broadcast's
 * story to tell ("失败 — 原因…"), not a reason to re-fire: re-running a
 * side-effectful workflow unasked is worse than a member reading one failure
 * notice. Only a synchronous dispatch throw (the hub never took it) leaves the
 * mark unwritten so the next tick retries.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Logger } from '@gotong/core'

import {
  evaluateRunnable,
  type ButlerDispatchHub,
  type ButlerWorkflowSurface,
  type RunnableWorkflow,
} from './personal-butler-workflows.js'
import {
  fireMark,
  normalizeWorkflowSchedule,
  scheduleDue,
  type WorkflowScheduleDef,
} from './workflow-schedule-core.js'

/** The intent file (an array of schedule rows), beside the space's other state. */
export const WORKFLOW_SCHEDULES_FILE = 'workflow-schedules.json'

/** The fact file — `{ [scheduleId]: lastFiredMark }`, machine-written only. */
export const WORKFLOW_SCHEDULES_STATE_FILE = 'workflow-schedules.state.json'

/** Default sweep cadence — 60 s, the same floor the interval cadence clamps to,
 *  so a min-interval schedule is checked about as often as it can fire. */
export const WORKFLOW_SCHEDULE_SWEEP_INTERVAL_MS = 60_000

/** Mirror of the butler's DEFAULT_BUTLER_ROLE — the least-privilege role a
 *  scheduled run resolves workflows with. */
const DEFAULT_SCHEDULE_ROLE = 'member'

/** What one sweep did — surfaced for logs and the tests' acceptance gate. */
export interface ScheduleSweepOutcome {
  /** Schedule ids dispatched this tick. */
  fired: string[]
  /** Rows present but not due (disabled / before-hour / already-fired / …). */
  notDue: number
  /** Rows that failed normalisation and were skipped (config errors). */
  invalid: number
  /** Due rows whose workflow was not runnable for the member role. */
  unrunnable: string[]
}

export interface WorkflowScheduleSweeperOptions {
  /** Directory holding the two schedule files (the space's data dir). */
  spaceDir: string
  /** Published-workflow catalog (`WorkflowController` satisfies it). */
  workflows: ButlerWorkflowSurface
  /** Hub dispatch surface. */
  hub: ButlerDispatchHub
  logger: Logger
  /** Sweep cadence; defaults to {@link WORKFLOW_SCHEDULE_SWEEP_INTERVAL_MS}. */
  intervalMs?: number
  /** Role the member-facing gate resolves with; defaults to `member`. */
  role?: string
  /** Injectable clock (deterministic tests). Default `Date.now`. */
  clock?: () => number
}

/** Read the RAW intent rows. Missing file ⇒ `[]` (feature unused); unparseable
 *  or non-array ⇒ `broken` (callers log, never guess). Exported for the M3
 *  admin surface, which must round-trip rows it does not understand. */
export async function readScheduleFileRaw(
  spaceDir: string,
): Promise<{ rows: unknown[]; broken: boolean }> {
  let raw: string
  try {
    raw = await readFile(join(spaceDir, WORKFLOW_SCHEDULES_FILE), 'utf8')
  } catch {
    return { rows: [], broken: false } // no file = feature unused
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? { rows: parsed, broken: false } : { rows: [], broken: true }
  } catch {
    return { rows: [], broken: true }
  }
}

/** Read + normalise the intent file (the sweep's view of it). */
async function readSchedules(
  spaceDir: string,
): Promise<{ rows: WorkflowScheduleDef[]; invalid: number; fileBroken: boolean }> {
  const { rows: rawRows, broken } = await readScheduleFileRaw(spaceDir)
  const rows: WorkflowScheduleDef[] = []
  let invalid = 0
  for (const entry of rawRows) {
    const def = normalizeWorkflowSchedule(entry)
    if (def) rows.push(def)
    else invalid++
  }
  return { rows, invalid, fileBroken: broken }
}

/** Read the fact file. Any corruption degrades to {} — see file header.
 *  Exported for the admin surface's list view (marks beside intent). */
export async function readScheduleState(spaceDir: string): Promise<Record<string, string>> {
  let raw: string
  try {
    raw = await readFile(join(spaceDir, WORKFLOW_SCHEDULES_STATE_FILE), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Persist the fact file. A lost mark is worst-case one re-fire — log, move on.
 *  Exported for the admin surface (removing a schedule drops its mark). */
export async function writeScheduleState(
  spaceDir: string,
  state: Record<string, string>,
  log: Logger,
): Promise<void> {
  try {
    await writeFile(
      join(spaceDir, WORKFLOW_SCHEDULES_STATE_FILE),
      JSON.stringify(state, null, 2),
      'utf8',
    )
  } catch (err) {
    log.error('workflow-schedules: state write failed', { err })
  }
}

/**
 * Outcome of a MANUAL fire (the admin "试跑" endpoint). It deliberately ignores
 * the due gate AND `enabled` — testing a parked/early row is the point — but
 * the member gate is NOT skippable: an unrunnable workflow still refuses, and
 * the fired mark IS written, so a hand-fired daily row won't auto-fire again
 * the same member-local day (an interval row restarts its window).
 */
export type ScheduleFireResult =
  | { ok: true; scheduleId: string; workflowId: string; userId: string; mark: string }
  | { ok: false; reason: 'not_found' | 'invalid' | 'unrunnable' | 'dispatch_failed' }

/**
 * The sweep. Mirrors the run-broadcast sweeper's lifecycle: `start()` arms an
 * unref'd interval (first tick one interval in, nothing at boot), `runOnce()`
 * is re-entrant-guarded, every schedule is best-effort (one row's throw is
 * logged and the pass moves on).
 */
export class WorkflowScheduleSweeper {
  private readonly spaceDir: string
  private readonly workflows: ButlerWorkflowSurface
  private readonly hub: ButlerDispatchHub
  private readonly log: Logger
  private readonly intervalMs: number
  private readonly role: string
  private readonly clock: () => number

  private timer?: ReturnType<typeof setInterval>
  private running = false

  constructor(opts: WorkflowScheduleSweeperOptions) {
    this.spaceDir = opts.spaceDir
    this.workflows = opts.workflows
    this.hub = opts.hub
    this.log = opts.logger
    this.intervalMs = opts.intervalMs ?? WORKFLOW_SCHEDULE_SWEEP_INTERVAL_MS
    this.role = opts.role ?? DEFAULT_SCHEDULE_ROLE
    this.clock = opts.clock ?? Date.now
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.intervalMs)
    this.timer.unref?.()
    this.log.info('workflow-schedule sweep armed', {
      intervalMs: this.intervalMs,
      spaceDir: this.spaceDir,
    })
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  async runOnce(): Promise<ScheduleSweepOutcome> {
    const empty: ScheduleSweepOutcome = { fired: [], notDue: 0, invalid: 0, unrunnable: [] }
    if (this.running) return empty
    this.running = true
    try {
      return await this.sweep()
    } catch (err) {
      // A pass-level throw (fs flake, list() outage) is logged and swallowed —
      // the next tick retries; a background sweep must never take the host down.
      this.log.error('workflow-schedule sweep failed', { err })
      return empty
    } finally {
      this.running = false
    }
  }

  private async sweep(): Promise<ScheduleSweepOutcome> {
    const { rows, invalid, fileBroken } = await readSchedules(this.spaceDir)
    if (fileBroken) {
      this.log.error('workflow-schedules file unreadable — no schedules run', {
        file: WORKFLOW_SCHEDULES_FILE,
      })
    }
    if (invalid > 0) {
      this.log.warn('workflow-schedules: skipping rows that failed validation', { invalid })
    }
    const outcome: ScheduleSweepOutcome = { fired: [], notDue: 0, invalid, unrunnable: [] }
    if (rows.length === 0) return outcome

    const state = await readScheduleState(this.spaceDir)
    const now = this.clock()

    // Resolve the catalog at most once per tick, and only when something is
    // actually due (the common all-quiet tick never touches it).
    let runnableById: Map<string, RunnableWorkflow | null> | undefined
    const catalogOnce = async () => (runnableById ??= await this.resolveCatalog())

    let stateDirty = false
    for (const def of rows) {
      const verdict = scheduleDue(def, state[def.id], now)
      if (!verdict.due) {
        outcome.notDue++
        continue
      }
      const wf = (await catalogOnce()).get(def.workflowId) ?? null
      if (!wf) {
        // A due schedule pointing at an unrunnable workflow is a CONFIG error —
        // log loudly every tick (it stays due, so it stays visible) and never
        // guess-run. The mark is NOT written: fixing the workflow (publishing
        // it / enabling surface.me) lets the same day's schedule still fire.
        outcome.unrunnable.push(def.id)
        this.log.warn('workflow-schedule due but workflow not runnable', {
          scheduleId: def.id,
          workflowId: def.workflowId,
          role: this.role,
        })
        continue
      }
      if (!this.dispatchRow(def, wf)) continue // sync throw → no mark, next tick retries
      state[def.id] = verdict.mark
      stateDirty = true
      outcome.fired.push(def.id)
      this.log.info('workflow-schedule fired', {
        scheduleId: def.id,
        workflowId: def.workflowId,
        userId: def.userId,
        mark: verdict.mark,
      })
    }

    if (stateDirty) await writeScheduleState(this.spaceDir, state, this.log)
    return outcome
  }

  /**
   * MANUAL fire — the admin "试跑" path (semantics on {@link ScheduleFireResult}).
   * Shares the sweep's dispatch + mark plumbing so there is exactly one way a
   * schedule reaches the hub. Benign race, documented: a manual fire landing in
   * the same instant as a sweep tick can double-dispatch or lose one mark write;
   * worst case is one duplicate run — same posture as a lost state file.
   */
  async fireNow(scheduleId: string): Promise<ScheduleFireResult> {
    const { rows } = await readScheduleFileRaw(this.spaceDir)
    const raw = rows.find(
      (r) => !!r && typeof r === 'object' && (r as { id?: unknown }).id === scheduleId,
    )
    if (raw === undefined) return { ok: false, reason: 'not_found' }
    const def = normalizeWorkflowSchedule(raw)
    if (!def) return { ok: false, reason: 'invalid' }
    const wf = (await this.resolveCatalog()).get(def.workflowId) ?? null
    if (!wf) return { ok: false, reason: 'unrunnable' }
    if (!this.dispatchRow(def, wf)) return { ok: false, reason: 'dispatch_failed' }
    const mark = fireMark(def.cadence, this.clock())
    const state = await readScheduleState(this.spaceDir)
    state[def.id] = mark
    await writeScheduleState(this.spaceDir, state, this.log)
    this.log.info('workflow-schedule fired (manual)', { scheduleId: def.id, mark })
    return { ok: true, scheduleId: def.id, workflowId: def.workflowId, userId: def.userId, mark }
  }

  /** Runnable view of the whole catalog, keyed by workflow id. Fail closed: an
   *  outage resolves to an empty map (logged), never a blind dispatch. */
  private async resolveCatalog(): Promise<Map<string, RunnableWorkflow | null>> {
    const map = new Map<string, RunnableWorkflow | null>()
    try {
      for (const s of await this.workflows.list()) map.set(s.id, evaluateRunnable(s, this.role))
    } catch (err) {
      this.log.error('workflow-schedules: catalog list failed; firing nothing', { err })
    }
    return map
  }

  /** Hand one schedule's run to the hub (fire-and-forget — see "fire = attempt"
   *  in the header). Returns false on a synchronous throw: the hub never took
   *  it, so the caller must not write the mark. Only DECLARED input fields are
   *  copied from the row, and the member-scope key is force-set — a hand-written
   *  row cannot smuggle another member in. */
  private dispatchRow(def: WorkflowScheduleDef, wf: RunnableWorkflow): boolean {
    const payload: Record<string, unknown> = {}
    for (const field of wf.inputFieldIds) {
      if (def.inputs && field in def.inputs) payload[field] = def.inputs[field]
    }
    payload[wf.userScopeField] = def.userId
    try {
      void this.hub
        .dispatch({
          from: def.userId,
          origin: { orgId: 'local', userId: def.userId },
          strategy: { kind: 'capability', capabilities: [wf.capability] },
          payload,
          title: `${wf.label} — 定时 ${def.id}`,
        })
        .catch((err) => {
          this.log.error('workflow-schedule dispatch failed (async)', {
            err,
            scheduleId: def.id,
          })
        })
      return true
    } catch (err) {
      this.log.error('workflow-schedule dispatch failed (sync)', { err, scheduleId: def.id })
      return false
    }
  }
}
