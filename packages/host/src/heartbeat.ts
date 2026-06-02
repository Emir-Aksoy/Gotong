/**
 * v5 Stream D-M1 — proactive heartbeat engine.
 *
 * OpenClaw-style "the agent wakes itself on a cadence and proactively
 * checks for things to do" — built ENTIRELY on the Phase 11 suspend/resume
 * machinery, with NO new table (decision v5 #1a):
 *
 *   - A singleton broker participant ({@link HEARTBEAT_BROKER_ID}) parks a
 *     self-renewing `suspended_tasks` row per heartbeat-enabled agent.
 *   - The existing resume sweep (host/main.ts) wakes the broker when a
 *     row's `resume_at <= now`. The broker dispatches the target agent a
 *     heartbeat task (a full turn), then throws `SuspendTaskError` with
 *     `resumeAt = now + intervalMs`. The scheduler's INSERT-OR-REPLACE
 *     renews the SAME row (deterministic id), so one row == one agent's
 *     next-due time, surviving restarts without drift.
 *   - {@link HeartbeatScheduler.reconcile} seeds rows for newly-enabled
 *     agents and prunes rows whose agent was disabled. Idempotent: the
 *     deterministic task id (`heartbeat:<agentId>`) means re-seeding an
 *     already-parked agent is a no-op (we never reset its live clock).
 *
 * The target agent needs ZERO heartbeat awareness — it just receives a
 * normal task. That keeps the north-star clean: the hub doesn't run the
 * LLM, it only schedules the wake; the agent decides what to do.
 */

import {
  AgentParticipant,
  SuspendTaskError,
  type ParticipantId,
  type Task,
  type TaskResult,
} from '@aipehub/core'

/** Fixed id of the singleton heartbeat broker participant. */
export const HEARTBEAT_BROKER_ID: ParticipantId = 'aipehub:heartbeat'

/** Deterministic `suspended_tasks.task_id` prefix → exactly one row per agent. */
export const HEARTBEAT_TASK_PREFIX = 'heartbeat:'

/** Default floor for `intervalMs` (the host clamps each agent up to this). 60 s. */
export const DEFAULT_HEARTBEAT_MIN_MS = 60_000

/**
 * Sentinel an agent returns from a heartbeat turn when nothing needs
 * attention. The host suppresses these (D-M3) so a quiet heartbeat makes no
 * noise — the "don't bother me when there's nothing to do" convention. The
 * heartbeat prompt (see {@link buildHeartbeatPayload}) instructs the agent to
 * reply with exactly this string when idle.
 */
export const HEARTBEAT_OK = 'HEARTBEAT_OK'

/**
 * The opaque `state` the broker round-trips through suspend/resume. It is
 * also the heartbeat task's payload at seed time, so `handleTask` and
 * `handleResume` parse the same shape.
 */
export interface HeartbeatState {
  targetAgentId: string
  intervalMs: number
  checklist?: string
}

/** A heartbeat-enabled agent, as surfaced by the host's agent roster. */
export interface HeartbeatAgentConfig {
  agentId: string
  intervalMs: number
  checklist?: string
}

/**
 * Narrow structural subset of `IdentityStore`'s suspended-task methods the
 * scheduler needs. Keeps host wiring duck-typed and the test store tiny —
 * the real `IdentityStore` satisfies this without importing it here.
 */
export interface HeartbeatStore {
  getSuspendedTask(taskId: string): { taskId: string; state: unknown } | null
  persistSuspendedTask(input: {
    taskId: string
    agentId: string
    resumeAt: number
    state: unknown
    taskJson: string
    hubId?: string | null
    originUserId?: string | null
  }): void
  listSuspendedTasksByAgent(agentId: string): Array<{ taskId: string; state: unknown }>
  removeSuspendedTask(taskId: string): number | void
}

/**
 * Parse + validate a `HeartbeatState`. Throws on anything unusable so a
 * corrupt row fails visibly (the resume path drops it) rather than parking
 * a ghost that wakes the wrong agent.
 */
export function parseHeartbeatState(raw: unknown): HeartbeatState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('heartbeat state must be an object')
  }
  const s = raw as Record<string, unknown>
  if (typeof s.targetAgentId !== 'string' || s.targetAgentId.length === 0) {
    throw new Error('heartbeat state.targetAgentId must be a non-empty string')
  }
  if (typeof s.intervalMs !== 'number' || !Number.isFinite(s.intervalMs) || s.intervalMs <= 0) {
    throw new Error(
      `heartbeat state.intervalMs must be a positive finite number; got ${String(s.intervalMs)}`,
    )
  }
  const out: HeartbeatState = { targetAgentId: s.targetAgentId, intervalMs: s.intervalMs }
  if (typeof s.checklist === 'string') out.checklist = s.checklist
  return out
}

/** Build the (minimal, valid) `Task` persisted as a heartbeat row's `task_json`. */
export function buildHeartbeatTask(state: HeartbeatState, now: number): Task {
  return {
    id: HEARTBEAT_TASK_PREFIX + state.targetAgentId,
    from: HEARTBEAT_BROKER_ID,
    strategy: { kind: 'explicit', to: HEARTBEAT_BROKER_ID },
    payload: { ...state },
    title: `heartbeat:${state.targetAgentId}`,
    createdAt: now,
  }
}

/**
 * The dispatched heartbeat task's payload (D-M2). It carries the agent's
 * standing checklist as a ready-to-read `prompt` so a *default* `LlmAgent`
 * — whose `buildRequest` turns `payload.prompt` into the user turn — wakes
 * with a clean, on-topic instruction and needs ZERO heartbeat awareness.
 *
 * Structured fields ride alongside for heartbeat-aware subclasses / non-LLM
 * participants:
 *   - `heartbeat: true`  — marker to branch on a heartbeat turn.
 *   - `checklist`        — the raw standing instructions (omitted if none).
 *   - `firedAt`          — wake timestamp.
 *
 * The prompt always tells the agent to reply with exactly {@link HEARTBEAT_OK}
 * when idle; D-M3 turns that reply into silence.
 */
export function buildHeartbeatPayload(state: HeartbeatState, now: number): Record<string, unknown> {
  const checklist = typeof state.checklist === 'string' ? state.checklist.trim() : ''
  const lines = ['[Heartbeat] Scheduled proactive check-in.', '']
  if (checklist.length > 0) {
    lines.push('Run through this checklist and act on anything that needs attention:', '', checklist)
  } else {
    lines.push('Review your standing responsibilities and act on anything that needs attention.')
  }
  lines.push('', `If nothing needs action, reply with exactly ${HEARTBEAT_OK} and do nothing else.`)

  const payload: Record<string, unknown> = {
    heartbeat: true,
    firedAt: now,
    prompt: lines.join('\n'),
  }
  // Keep the raw checklist only when present — absent stays absent (no `null`
  // noise), matching how `parseHeartbeatState` treats it.
  if (state.checklist !== undefined) payload.checklist = state.checklist
  return payload
}

/**
 * The disposition of one heartbeat turn after the "don't bother me when idle"
 * policy (D-M3). The host surfaces `active`/`failed` and stays quiet on `idle`.
 */
export type HeartbeatDisposition =
  | { kind: 'idle' }
  | { kind: 'active'; summary: string }
  | { kind: 'failed'; error: string }

/**
 * Pull the agent's reply text out of a heartbeat `TaskResult`. Handles the
 * two real shapes — a bare string output, or an `LlmTaskOutput`-style object
 * with a `.text` field. Returns undefined when there's no readable text (a
 * non-ok result, or an opaque object), which the classifier treats as "not
 * idle" so we never accidentally swallow a result we couldn't read.
 */
export function heartbeatResultText(result: TaskResult): string | undefined {
  if (result.kind !== 'ok') return undefined
  const out = result.output
  if (typeof out === 'string') return out
  if (out && typeof out === 'object' && typeof (out as { text?: unknown }).text === 'string') {
    return (out as { text: string }).text
  }
  return undefined
}

/**
 * Classify a heartbeat result under the suppression policy:
 *   - the agent replied exactly {@link HEARTBEAT_OK} → `idle` (suppress);
 *   - the turn errored → `failed` (surface for operator attention);
 *   - anything else with readable text → `active` (the agent has something
 *     to report / already acted — surface the summary);
 *   - parked / cancelled / no-participant / unreadable → `idle` (nothing
 *     actionable to surface; a parked heartbeat resumes on its own).
 *
 * The hub still records every heartbeat in the transcript — this policy only
 * governs notification noise, not the audit trail.
 */
export function classifyHeartbeatResult(result: TaskResult): HeartbeatDisposition {
  if (result.kind === 'failed') return { kind: 'failed', error: result.error }
  if (result.kind === 'ok') {
    const text = heartbeatResultText(result)
    if (text !== undefined && text.trim() === HEARTBEAT_OK) return { kind: 'idle' }
    if (text !== undefined && text.trim().length > 0) return { kind: 'active', summary: text.trim() }
    return { kind: 'idle' } // ok but empty/unreadable → nothing to surface
  }
  return { kind: 'idle' }
}

export interface HeartbeatParticipantOptions {
  /**
   * Fire one heartbeat at the target agent (host wires this to
   * `hub.dispatch`). A throw / rejection here MUST NOT break the schedule —
   * the broker swallows it and re-parks regardless.
   */
  fire: (state: HeartbeatState) => Promise<void>
  /** Clock injection for deterministic tests. */
  now?: () => number
}

/**
 * Singleton broker. Never does real work itself — it only re-parks to act
 * as a durable recurring trigger, dispatching the target agent each wake.
 *
 * Capabilities are empty: it is never capability-routed, only resumed by
 * id via the sweep's `Hub.resumeTask(HEARTBEAT_BROKER_ID, …)`.
 */
export class HeartbeatParticipant extends AgentParticipant {
  private readonly fire: (state: HeartbeatState) => Promise<void>
  private readonly clock: () => number

  constructor(opts: HeartbeatParticipantOptions) {
    super({ id: HEARTBEAT_BROKER_ID, capabilities: [] })
    this.fire = opts.fire
    this.clock = opts.now ?? ((): number => Date.now())
  }

  /**
   * A seed dispatch (rare — seeding normally writes the row directly via
   * the scheduler) just schedules the first wake one interval out, WITHOUT
   * firing, so a boot never triggers a heartbeat burst.
   */
  protected handleTask(task: Task): unknown {
    const st = parseHeartbeatState(task.payload)
    throw new SuspendTaskError({ resumeAt: this.clock() + st.intervalMs, state: st })
  }

  /** Each wake: fire one heartbeat at the target, then re-park for the next. */
  protected async handleResume(_task: Task, state: unknown): Promise<unknown> {
    const st = parseHeartbeatState(state)
    try {
      await this.fire(st)
    } catch {
      // A failing heartbeat must not stop the cadence — swallow and re-park.
    }
    throw new SuspendTaskError({ resumeAt: this.clock() + st.intervalMs, state: st })
  }
}

export interface HeartbeatSchedulerOptions {
  store: HeartbeatStore
  /** Returns the currently heartbeat-enabled agents (host reads the roster). */
  listEnabled: () => Promise<HeartbeatAgentConfig[]> | HeartbeatAgentConfig[]
  /** Floor applied to each agent's `intervalMs`. Default {@link DEFAULT_HEARTBEAT_MIN_MS}. */
  minIntervalMs?: number
  now?: () => number
}

/**
 * True when a parked row's stored state already matches the desired config
 * (same target, interval, checklist). Used by {@link HeartbeatScheduler.reconcile}
 * to decide whether an edit actually changed anything. Defensive: corrupt /
 * non-object state compares as "different" so an enabled agent's broken row
 * gets healed (re-persisted with valid state) rather than left to throw on
 * every wake.
 */
function sameHeartbeatConfig(storedRaw: unknown, desired: HeartbeatState): boolean {
  if (!storedRaw || typeof storedRaw !== 'object' || Array.isArray(storedRaw)) return false
  const s = storedRaw as Partial<HeartbeatState>
  if (s.targetAgentId !== desired.targetAgentId) return false
  if (s.intervalMs !== desired.intervalMs) return false
  const storedChecklist = typeof s.checklist === 'string' ? s.checklist : undefined
  return storedChecklist === desired.checklist
}

/**
 * Reconciles parked heartbeat rows against the enabled agent roster. Run on
 * boot (and on config change in D-M4). Pure data — owns no timer; the
 * existing resume sweep is the heartbeat's clock.
 */
export class HeartbeatScheduler {
  private readonly store: HeartbeatStore
  private readonly listEnabled: () => Promise<HeartbeatAgentConfig[]> | HeartbeatAgentConfig[]
  private readonly minIntervalMs: number
  private readonly clock: () => number

  constructor(opts: HeartbeatSchedulerOptions) {
    this.store = opts.store
    this.listEnabled = opts.listEnabled
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_HEARTBEAT_MIN_MS
    this.clock = opts.now ?? ((): number => Date.now())
  }

  /**
   * Bring parked heartbeat rows in line with the enabled roster:
   *   - seed a self-renewing row for each enabled agent that has none;
   *   - UPDATE a row whose stored interval / checklist drifted from the
   *     agent's current config (re-anchored to `now + newInterval` so an
   *     edit takes effect on the next wake instead of being silently
   *     ignored until a disable→re-enable cycle);
   *   - PRUNE any broker row whose target isn't currently enabled —
   *     including corrupt-state orphans (no usable `targetAgentId`), which
   *     the old guard skipped and so waked the broker forever.
   *
   * An UNCHANGED enabled row is left untouched (its running clock survives),
   * so a frequent reconcile never starves the cadence. Reconcile owns no
   * timer (only boot + agent CRUD call it), so re-anchoring on a real edit
   * can't be triggered in a tight loop. Returns what changed.
   */
  async reconcile(): Promise<{ seeded: string[]; pruned: string[]; updated: string[] }> {
    const enabled = await this.listEnabled()
    const enabledIds = new Set(enabled.map((c) => c.agentId))
    const now = this.clock()
    const seeded: string[] = []
    const pruned: string[] = []
    const updated: string[] = []

    const persistRow = (state: HeartbeatState, interval: number): void => {
      this.store.persistSuspendedTask({
        taskId: HEARTBEAT_TASK_PREFIX + state.targetAgentId,
        agentId: HEARTBEAT_BROKER_ID,
        hubId: 'local',
        originUserId: null,
        resumeAt: now + interval,
        state,
        taskJson: JSON.stringify(buildHeartbeatTask(state, now)),
      })
    }

    for (const cfg of enabled) {
      const interval = Math.max(cfg.intervalMs, this.minIntervalMs)
      const state: HeartbeatState = { targetAgentId: cfg.agentId, intervalMs: interval }
      if (cfg.checklist !== undefined) state.checklist = cfg.checklist

      const existing = this.store.getSuspendedTask(HEARTBEAT_TASK_PREFIX + cfg.agentId)
      if (!existing) {
        persistRow(state, interval)
        seeded.push(cfg.agentId)
      } else if (!sameHeartbeatConfig(existing.state, state)) {
        // Config edit (or a corrupt row for a still-enabled agent) → re-write
        // with the new state so the change actually takes effect.
        persistRow(state, interval)
        updated.push(cfg.agentId)
      }
      // else: unchanged — leave its live clock alone.
    }

    for (const row of this.store.listSuspendedTasksByAgent(HEARTBEAT_BROKER_ID)) {
      const targetId = (row.state as Partial<HeartbeatState> | null | undefined)?.targetAgentId
      // Prune when the target isn't enabled — OR when the state is corrupt
      // (no usable targetAgentId), which is a true orphan we can't map back
      // to any agent and must not let wake the broker indefinitely.
      if (typeof targetId !== 'string' || !enabledIds.has(targetId)) {
        this.store.removeSuspendedTask(row.taskId)
        pruned.push(typeof targetId === 'string' ? targetId : row.taskId)
      }
    }
    return { seeded, pruned, updated }
  }
}
