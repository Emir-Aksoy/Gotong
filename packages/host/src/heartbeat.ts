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
} from '@aipehub/core'

/** Fixed id of the singleton heartbeat broker participant. */
export const HEARTBEAT_BROKER_ID: ParticipantId = 'aipehub:heartbeat'

/** Deterministic `suspended_tasks.task_id` prefix → exactly one row per agent. */
export const HEARTBEAT_TASK_PREFIX = 'heartbeat:'

/** Default floor for `intervalMs` (the host clamps each agent up to this). 60 s. */
export const DEFAULT_HEARTBEAT_MIN_MS = 60_000

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
   *   - seed a self-renewing row for each enabled agent that has none
   *     (idempotent via the deterministic id — never resets a live clock);
   *   - prune rows whose target is no longer enabled.
   * Returns what changed (for boot logging / tests).
   */
  async reconcile(): Promise<{ seeded: string[]; pruned: string[] }> {
    const enabled = await this.listEnabled()
    const enabledIds = new Set(enabled.map((c) => c.agentId))
    const now = this.clock()
    const seeded: string[] = []
    const pruned: string[] = []

    for (const cfg of enabled) {
      const taskId = HEARTBEAT_TASK_PREFIX + cfg.agentId
      if (this.store.getSuspendedTask(taskId)) continue // live row — leave its clock alone
      const interval = Math.max(cfg.intervalMs, this.minIntervalMs)
      const state: HeartbeatState = { targetAgentId: cfg.agentId, intervalMs: interval }
      if (cfg.checklist !== undefined) state.checklist = cfg.checklist
      this.store.persistSuspendedTask({
        taskId,
        agentId: HEARTBEAT_BROKER_ID,
        hubId: 'local',
        originUserId: null,
        resumeAt: now + interval,
        state,
        taskJson: JSON.stringify(buildHeartbeatTask(state, now)),
      })
      seeded.push(cfg.agentId)
    }

    for (const row of this.store.listSuspendedTasksByAgent(HEARTBEAT_BROKER_ID)) {
      const targetId = (row.state as Partial<HeartbeatState> | null | undefined)?.targetAgentId
      if (typeof targetId === 'string' && !enabledIds.has(targetId)) {
        this.store.removeSuspendedTask(row.taskId)
        pruned.push(targetId)
      }
    }
    return { seeded, pruned }
  }
}
