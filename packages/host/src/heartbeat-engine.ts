/**
 * heartbeat-engine.ts — assembly helper that arms the v5 Stream D proactive
 * heartbeat engine in one call and hands back the reconcile hook.
 *
 * Reuses the Phase 11 suspend/resume machinery (no new table, decision v5 #1a):
 * a singleton broker parks a self-renewing `suspended_tasks` row per
 * heartbeat-enabled agent; the resume sweep wakes it on cadence; it dispatches
 * the agent a heartbeat task, then re-parks for the next interval. The engine
 * is spun up LAZILY — a hub with zero heartbeat agents stays completely
 * untouched, but one enabled at runtime (D-M4) brings the broker + scheduler
 * online on the spot. The heartbeat primitives themselves live in heartbeat.ts.
 *
 * Exists as a module (not inline in main.ts) for the GUARD-M2 line budget: the
 * arming + reconcile block was ~90 assembly lines whose only content was wiring
 * the broker/scheduler to the hub + store. Mirrors {@link armButlerSweeps}.
 * The caller keeps the returned `reconcileHeartbeats` and forwards it to the
 * web layer's agent-CRUD surface (a reconcile runs whenever an agent's
 * heartbeat opt-in changes).
 */

import type { Hub, Logger, Space } from '@gotong/core'

import type { IdentityStore } from '@gotong/identity'

import {
  DEFAULT_HEARTBEAT_MIN_MS,
  HEARTBEAT_BROKER_ID,
  HeartbeatParticipant,
  HeartbeatScheduler,
  buildHeartbeatPayload,
  classifyHeartbeatResult,
  type HeartbeatAgentConfig,
} from './heartbeat.js'

export interface HeartbeatEngineDeps {
  /** The identity store — the heartbeat broker's suspended-task backing store. */
  identity: IdentityStore
  /** Workspace — `space.agents()` is the enabled-heartbeat roster source. */
  space: Space
  /** The hub the broker registers on and dispatches heartbeat tasks through. */
  hub: Hub
  log: Logger
}

export interface HeartbeatEngineHandle {
  /**
   * Reconcile parked rows against the enabled roster. Called at boot (done once
   * inside `armHeartbeatEngine`) and by agent CRUD (web layer) on opt-in change.
   * Fully dormant — no broker, no rows — until at least one agent opts in.
   */
  reconcileHeartbeats: () => Promise<void>
}

/**
 * Build the lazy broker + scheduler, run the initial reconcile, and return the
 * reconcile hook. Call only when identity is present (a store-less hub can't
 * park heartbeat rows).
 */
export async function armHeartbeatEngine(deps: HeartbeatEngineDeps): Promise<HeartbeatEngineHandle> {
  const { identity, space, hub, log } = deps
  const heartbeatStore = identity
  const minRaw = Number(process.env.GOTONG_HEARTBEAT_MIN_MS ?? '')
  const heartbeatMinMs = Number.isFinite(minRaw) && minRaw >= 0 ? minRaw : DEFAULT_HEARTBEAT_MIN_MS
  const listEnabledHeartbeats = async (): Promise<HeartbeatAgentConfig[]> => {
    const recs = await space.agents()
    const out: HeartbeatAgentConfig[] = []
    for (const a of recs) {
      const hb = a.managed?.heartbeat
      if (!hb || hb.enabled !== true) continue
      const intervalMs =
        typeof hb.intervalMs === 'number' && Number.isFinite(hb.intervalMs) && hb.intervalMs > 0
          ? hb.intervalMs
          : DEFAULT_HEARTBEAT_MIN_MS
      const cfg: HeartbeatAgentConfig = { agentId: a.id, intervalMs }
      if (typeof hb.checklist === 'string') cfg.checklist = hb.checklist
      out.push(cfg)
    }
    return out
  }

  // Build (once) the broker + scheduler. The broker is a cheap idle
  // singleton — never capability-routed, only resumed by id via the sweep.
  let heartbeatScheduler: HeartbeatScheduler | undefined
  const ensureHeartbeatEngine = (): HeartbeatScheduler => {
    if (heartbeatScheduler) return heartbeatScheduler
    const broker = new HeartbeatParticipant({
      fire: async (st) => {
        // D-M2: the payload carries the agent's standing checklist as a
        // ready-to-read `prompt` (plus structured `heartbeat`/`checklist`
        // fields). A failing dispatch is swallowed by the broker so the
        // cadence never stalls.
        const result = await hub.dispatch({
          from: HEARTBEAT_BROKER_ID,
          strategy: { kind: 'explicit', to: st.targetAgentId },
          payload: buildHeartbeatPayload(st, Date.now()),
          title: 'heartbeat',
        })
        // D-M3 "don't bother me when idle": the hub already recorded this
        // heartbeat in the transcript (audit trail intact) — here we only
        // decide whether to make NOISE. An idle HEARTBEAT_OK stays quiet
        // (debug); a substantive turn or a failure is surfaced.
        const disp = classifyHeartbeatResult(result)
        if (disp.kind === 'active') {
          log.info('heartbeat: agent reported activity', {
            agent: st.targetAgentId,
            summary: disp.summary.slice(0, 280),
          })
        } else if (disp.kind === 'failed') {
          log.warn('heartbeat: agent turn failed', {
            agent: st.targetAgentId,
            error: disp.error,
          })
        } else {
          log.debug('heartbeat: idle (suppressed)', { agent: st.targetAgentId })
        }
      },
    })
    hub.register(broker)
    const sched = new HeartbeatScheduler({
      store: heartbeatStore,
      minIntervalMs: heartbeatMinMs,
      listEnabled: listEnabledHeartbeats,
    })
    heartbeatScheduler = sched
    log.info('heartbeat engine started', { minIntervalMs: heartbeatMinMs })
    return sched
  }

  // Reconcile parked rows against the enabled roster. Called at boot and by
  // agent CRUD (web layer). Stays fully dormant — no broker, no rows — until
  // at least one agent opts in (preserves the D-M1 zero-regression promise).
  const reconcileHeartbeats = async (): Promise<void> => {
    const enabled = await listEnabledHeartbeats()
    const rows = heartbeatStore.listSuspendedTasksByAgent(HEARTBEAT_BROKER_ID)
    if (enabled.length === 0 && rows.length === 0) return
    const r = await ensureHeartbeatEngine().reconcile()
    if (r.seeded.length > 0 || r.pruned.length > 0 || r.updated.length > 0) {
      log.info('heartbeat reconciled', {
        enabled: enabled.length,
        seeded: r.seeded.length,
        pruned: r.pruned.length,
        updated: r.updated.length,
      })
    }
  }

  await reconcileHeartbeats()
  return { reconcileHeartbeats }
}
