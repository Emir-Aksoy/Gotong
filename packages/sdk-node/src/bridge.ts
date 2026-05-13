/**
 * TeamBridgeAgent — bridges a local Hub onto a remote ("upstream") Hub.
 *
 * From the upstream Hub's point of view this looks like one ordinary agent
 * with a fixed id + capabilities. When the upstream dispatches a task to
 * it, the bridge does NOT do the work itself — it re-dispatches the task
 * on its own local Hub (where a team of sub-agents and/or human workers
 * live), waits for the local result, and forwards that result back up.
 *
 * This is how AipeHub federates: any Hub is a participant on a bigger Hub
 * just by wrapping it in a bridge. The local team's leader keeps their own
 * admin/worker UI on the local Hub; the upstream room sees a single agent
 * named, e.g., "alice-team" with capabilities ["draft","review"].
 *
 *   ┌─ upstream hub ─────────────────────┐
 *   │  …                                 │
 *   │  agent: alice-team  ← BridgeAgent  │
 *   └────────────────────┬───────────────┘
 *                        │  WSS via connect()
 *                        ▼
 *   ┌─ local hub (Alice's Mac) ─────────┐
 *   │  Alice (admin + worker)           │
 *   │  writer-bot, reviewer-bot         │
 *   └───────────────────────────────────┘
 *
 * Usage:
 *
 *   import { Hub, Space } from '@aipehub/core'
 *   import { connect, TeamBridgeAgent } from '@aipehub/sdk-node'
 *
 *   const { space } = await Space.openOrInit('.aipehub-local-team', { ... })
 *   const localHub = new Hub({ space })
 *   await localHub.start()
 *   localHub.register(new WriterBot())
 *
 *   const bridge = new TeamBridgeAgent({
 *     id: 'alice-team',
 *     capabilities: ['draft', 'review'],
 *     localHub,
 *     // optional: rewrite the dispatch strategy on the local side
 *     mapTask: (task) => ({
 *       strategy: { kind: 'capability', capabilities: task.capabilities ?? [] },
 *     }),
 *   })
 *
 *   await connect({ url: 'wss://hub.example.com/ws', agents: [bridge] })
 */

import {
  AgentParticipant,
  type Hub,
  type Task,
  type TaskResult,
  type DispatchStrategy,
} from '@aipehub/core'

export interface TeamBridgeOptions {
  /** Id this bridge takes on the upstream hub. */
  id: string
  /** Capabilities advertised to upstream. Default: union of local agent caps. */
  capabilities?: readonly string[]
  /** The local Hub whose participants will execute upstream tasks. */
  localHub: Hub
  /**
   * Optionally rewrite the upstream task into a local dispatch shape. The
   * default forwards the task verbatim and picks a strategy:
   *   1. If upstream task includes `capabilities` in payload → capability
   *   2. Else → broadcast among the local team
   */
  mapTask?: (task: Task) => LocalDispatchPlan
  /**
   * Default false. When true, the bridge prefixes the local task title
   * with `[upstream]` and tags `from` as `${bridge.id}` so local admins can
   * tell forwarded work apart from in-house tasks.
   */
  tagLocalTasks?: boolean
}

export interface LocalDispatchPlan {
  strategy: DispatchStrategy
  /** Override the payload sent to the local team (default: upstream payload). */
  payload?: unknown
  /** Override the title (default: upstream task.title). */
  title?: string
  /** Override the deadline (default: inherits from upstream). */
  deadlineMs?: number
}

export class TeamBridgeAgent extends AgentParticipant {
  private readonly localHub: Hub
  private readonly mapTask: (task: Task) => LocalDispatchPlan
  private readonly tagLocalTasks: boolean

  constructor(opts: TeamBridgeOptions) {
    super({ id: opts.id, capabilities: opts.capabilities ?? [] })
    this.localHub = opts.localHub
    this.tagLocalTasks = opts.tagLocalTasks ?? true
    this.mapTask = opts.mapTask ?? ((task) => defaultMap(task))
  }

  /**
   * Override `onTask` (not `handleTask`) so we can pass the upstream-side
   * TaskId straight through in the failure envelope — the base class would
   * wrap a thrown error into a generic failed result, which is fine, but
   * we want to preserve the exact `kind` (cancelled / no_participant) the
   * local hub returns.
   */
  override async onTask(task: Task): Promise<TaskResult> {
    const plan = this.mapTask(task)
    const titleBase = plan.title ?? task.title ?? '(untitled)'
    const localTitle = this.tagLocalTasks ? `[upstream] ${titleBase}` : titleBase
    try {
      const localResult = await this.localHub.dispatch({
        from: this.id,
        strategy: plan.strategy,
        payload: plan.payload ?? task.payload,
        title: localTitle,
        ...(plan.deadlineMs !== undefined
          ? { deadlineMs: plan.deadlineMs }
          : task.deadlineMs !== undefined
            ? { deadlineMs: task.deadlineMs }
            : {}),
      })
      // Rewrite the result so it refers to the UPSTREAM taskId and our id
      // as the executor. The original `by` from the local team gets folded
      // into `output` so callers can audit who really did the work.
      return reframe(task.id, this.id, localResult)
    } catch (err) {
      return {
        kind: 'failed',
        taskId: task.id,
        by: this.id,
        error:
          err instanceof Error
            ? `local hub dispatch threw: ${err.message}`
            : `local hub dispatch threw: ${String(err)}`,
        ts: Date.now(),
      }
    }
  }

  protected handleTask(): never {
    // We override onTask directly, so handleTask is unreachable. Keep an
    // explicit throw so a future refactor can't silently invoke it.
    throw new Error('TeamBridgeAgent.handleTask should never be called')
  }
}

function defaultMap(task: Task): LocalDispatchPlan {
  const payload = task.payload
  const caps =
    payload && typeof payload === 'object' && 'capabilities' in payload
      ? (payload as { capabilities?: unknown }).capabilities
      : undefined
  if (Array.isArray(caps) && caps.length > 0 && caps.every((c) => typeof c === 'string')) {
    return {
      strategy: { kind: 'capability', capabilities: caps as string[] },
    }
  }
  return {
    strategy: { kind: 'broadcast' },
  }
}

function reframe(
  upstreamTaskId: string,
  bridgeId: string,
  local: TaskResult,
): TaskResult {
  switch (local.kind) {
    case 'ok':
      return {
        kind: 'ok',
        taskId: upstreamTaskId,
        by: bridgeId,
        output: {
          localBy: local.by,
          localTaskId: local.taskId,
          output: local.output,
        },
        ts: Date.now(),
      }
    case 'failed':
      return {
        kind: 'failed',
        taskId: upstreamTaskId,
        by: bridgeId,
        error: `local team (${local.by}): ${local.error}`,
        ts: Date.now(),
      }
    case 'cancelled':
      return {
        kind: 'cancelled',
        taskId: upstreamTaskId,
        reason: `local team cancelled: ${local.reason}`,
        ts: Date.now(),
      }
    case 'no_participant':
      return {
        kind: 'no_participant',
        taskId: upstreamTaskId,
        reason: `local team has no matching participant: ${local.reason}`,
        ts: Date.now(),
      }
  }
}
