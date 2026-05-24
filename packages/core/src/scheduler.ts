import { createLogger } from './logger.js'
import type { Registry } from './registry.js'
import type { Participant, ParticipantId, Task, TaskId, TaskResult } from './types.js'

const log = createLogger('scheduler')

/**
 * Scheduler routes a Task to one or more Participants according to the task's
 * dispatch strategy and returns the resulting TaskResult. Custom schedulers
 * can implement the Scheduler interface to add policies (cost-aware, priority,
 * etc.) — the Hub will use whatever you give it.
 */

export interface Scheduler {
  dispatch(task: Task): Promise<TaskResult>
}

export type TaskInvoker = (
  recipient: Participant,
  task: Task,
) => Promise<TaskResult>

export type CancelNotifier = (
  recipientId: ParticipantId,
  taskId: TaskId,
  reason: string,
) => void

/**
 * Optional callback returning a peer's reputation score in [-1, +1].
 * When supplied, `DefaultScheduler.dispatchCapability` ranks candidates
 * by score (descending) before falling back to least-loaded.
 *
 * Wired by `Hub` from its `ReputationStore` (M5b). New / unknown peers
 * return 0 — neutral, no penalty.
 */
export type ReputationLookup = (participantId: ParticipantId) => number

export class DefaultScheduler implements Scheduler {
  constructor(
    private readonly registry: Registry,
    private readonly invoke: TaskInvoker,
    private readonly notifyCancel: CancelNotifier,
    private readonly reputationOf?: ReputationLookup,
  ) {}

  dispatch(task: Task): Promise<TaskResult> {
    switch (task.strategy.kind) {
      case 'explicit':
        return this.dispatchExplicit(task, task.strategy.to)
      case 'capability':
        return this.dispatchCapability(task, task.strategy.capabilities)
      case 'broadcast':
        return this.dispatchBroadcast(task, task.strategy.capabilities)
    }
  }

  // --- explicit ------------------------------------------------------------

  private async dispatchExplicit(task: Task, to: ParticipantId): Promise<TaskResult> {
    const p = this.registry.get(to)
    if (!p) {
      return notFound(task.id, `participant '${to}' is not registered`)
    }
    if (!p.onTask) {
      return notFound(task.id, `participant '${to}' does not accept tasks`)
    }
    return runOne(task, p, this.registry, this.invoke)
  }

  // --- capability matching --------------------------------------------------

  private async dispatchCapability(
    task: Task,
    required: readonly string[],
  ): Promise<TaskResult> {
    const candidates = this.registry
      .byCapabilities(required)
      .filter((p) => !!p.onTask)
    if (candidates.length === 0) {
      return notFound(
        task.id,
        `no participant covers capabilities: ${required.join(', ') || '(none)'}`,
      )
    }
    // Reputation-aware ranking (M5b): higher score first, ties broken by
    // least-loaded, then by registration order (Map preserves it).
    // When reputationOf is not supplied, all scores are 0 and ranking
    // degrades to pure least-loaded — preserving pre-M5b behaviour.
    const repOf = this.reputationOf
    candidates.sort((a, b) => {
      if (repOf) {
        const ra = repOf(a.id)
        const rb = repOf(b.id)
        // Treat tiny floating-point noise as a tie.
        if (Math.abs(ra - rb) > 1e-9) return rb - ra
      }
      return this.registry.loadOf(a.id) - this.registry.loadOf(b.id)
    })
    const chosen = candidates[0]!
    return runOne(task, chosen, this.registry, this.invoke)
  }

  // --- broadcast claim ------------------------------------------------------

  private dispatchBroadcast(
    task: Task,
    required: readonly string[] | undefined,
  ): Promise<TaskResult> {
    const pool = required ? this.registry.byCapabilities(required) : this.registry.all()
    const candidates = pool.filter((p) => !!p.onTask)
    if (candidates.length === 0) {
      return Promise.resolve(
        notFound(
          task.id,
          `no participant available for broadcast${
            required ? ` with capabilities: ${required.join(', ')}` : ''
          }`,
        ),
      )
    }

    return new Promise<TaskResult>((resolve) => {
      let settled = false
      let remaining = candidates.length
      let lastFailure: TaskResult | undefined

      const cancelOthers = (winnerId: ParticipantId) => {
        for (const other of candidates) {
          if (other.id !== winnerId) {
            try {
              this.notifyCancel(other.id, task.id, 'lost broadcast race')
            } catch (err) {
              log.error('cancel notify threw', { taskId: task.id, err })
            }
          }
        }
      }

      for (const p of candidates) {
        this.registry.incLoad(p.id)
        this.invoke(p, task)
          .then((result) => {
            this.registry.decLoad(p.id)
            if (settled) return
            if (result.kind === 'ok') {
              settled = true
              cancelOthers(p.id)
              resolve(result)
              return
            }
            // failed / cancelled / no_participant — keep waiting for someone better
            lastFailure = result
            remaining--
            if (remaining === 0) {
              settled = true
              resolve(
                lastFailure ?? {
                  kind: 'failed',
                  taskId: task.id,
                  by: p.id,
                  error: 'all broadcast candidates failed',
                  ts: Date.now(),
                },
              )
            }
          })
          .catch((err) => {
            this.registry.decLoad(p.id)
            if (settled) return
            lastFailure = {
              kind: 'failed',
              taskId: task.id,
              by: p.id,
              error: err instanceof Error ? err.message : String(err),
              ts: Date.now(),
            }
            remaining--
            if (remaining === 0) {
              settled = true
              resolve(lastFailure)
            }
          })
      }
    })
  }
}

// --- helpers --------------------------------------------------------------

async function runOne(
  task: Task,
  p: Participant,
  registry: Registry,
  invoke: TaskInvoker,
): Promise<TaskResult> {
  registry.incLoad(p.id)
  try {
    return await invoke(p, task)
  } catch (err) {
    return {
      kind: 'failed',
      taskId: task.id,
      by: p.id,
      error: err instanceof Error ? err.message : String(err),
      ts: Date.now(),
    }
  } finally {
    registry.decLoad(p.id)
  }
}

function notFound(taskId: TaskId, reason: string): TaskResult {
  return { kind: 'no_participant', taskId, reason, ts: Date.now() }
}
