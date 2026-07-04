/**
 * `butler-router.ts` — the per-user butler multiplexer (BF-M2).
 *
 * # Why this exists
 *
 * The resident `PersonalButlerAgent` binds ONE memory handle per instance
 * (`MemoryAugmentedAgent`: "later milestones bind one session per (user,
 * butler)"). But an IM channel routes MANY bound users through ONE registered
 * `chat` agent. If that single agent owned one memory handle, every member's
 * conversation would pile into the same store — the opposite of "remember ME".
 *
 * The router is the fix. It registers under the chat agent's id + capability,
 * so the hub's capability routing reaches it unchanged. On each task it reads
 * `task.origin.userId` (the IM bridge always stamps it — the bound Gotong user,
 * never the raw IM handle) and routes to a PER-USER butler, lazily built on
 * first contact and memoized for the process lifetime. Each butler opens its own
 * per-user memory namespace, so memory is isolated by construction.
 *
 * # Design: a pure multiplexer
 *
 * The router is deliberately decoupled from the host — it takes a `createForUser`
 * factory (which opens memory + constructs the butler) rather than reaching for
 * the pool / provider itself. That keeps it a small, unit-testable seam: BF-M3/M4
 * inject the real factory; tests inject a fake participant. The router holds no
 * LLM, no provider, no key — only a `Map<userId, Participant>` and the routing.
 *
 * # Resume after restart
 *
 * `onResume` routes to the SAME per-user butler. After a host restart the map is
 * empty, so it re-creates the butler for that userId: a butler is stateless apart
 * from its on-disk memory handle + the carried `state`, so a fresh instance picks
 * up the parked turn with no drift (the same no-drift contract the workflow runner
 * relies on). A participant without `onResume` falls back to `onTask`, exactly as
 * the scheduler documents.
 */

import type {
  Logger,
  Participant,
  ParticipantId,
  Task,
  TaskId,
  TaskResult,
} from '@gotong/core'

/**
 * Bucket for tasks that carry no `origin.userId` (operator pokes, admin
 * test-connection, anonymous dispatch). Kept distinct from any real userId so a
 * member's memory never mixes with operator scratch — and the `/me` privacy view
 * only ever reads REAL userIds, so this bucket is invisible there.
 */
export const BUTLER_ANON_USER = '_local'

export interface ButlerRouterOptions {
  /**
   * Registered id — the SAME id as the chat agent the router stands in for, so
   * the hub's capability routing reaches the router with no change.
   */
  id: ParticipantId
  /** Advertised capabilities (e.g. `['chat']`) — mirror the chat agent's. */
  capabilities: readonly string[]
  /**
   * Build (open per-user memory + construct) the resident butler for one user.
   * Called at most once per distinct userId; the result is memoized for the
   * process lifetime. The host injects the real factory (shared provider + key +
   * per-user memory rootDir); tests inject a fake participant.
   */
  createForUser: (userId: string) => Participant
  /** Bucket for tasks with no `origin.userId`. Default {@link BUTLER_ANON_USER}. */
  anonUserId?: string
  logger?: Logger
}

export interface ButlerRouter extends Participant {
  /** Number of live per-user butlers — for tests / observability. */
  readonly size: number
}

/**
 * Build a {@link ButlerRouter}: a `Participant` that multiplexes one registered
 * chat agent over per-user resident butlers, routed by `task.origin.userId`.
 */
export function createButlerRouter(opts: ButlerRouterOptions): ButlerRouter {
  const anon = opts.anonUserId ?? BUTLER_ANON_USER
  const butlers = new Map<string, Participant>()

  const userIdOf = (task: Task): string => task.origin?.userId ?? anon

  const butlerFor = (userId: string): Participant => {
    let b = butlers.get(userId)
    if (!b) {
      b = opts.createForUser(userId)
      butlers.set(userId, b)
      opts.logger?.debug('butler-router: spawned per-user butler', { id: opts.id, userId })
    }
    return b
  }

  return {
    id: opts.id,
    kind: 'agent',
    capabilities: opts.capabilities,

    get size(): number {
      return butlers.size
    },

    async onTask(task: Task): Promise<TaskResult> {
      const b = butlerFor(userIdOf(task))
      // The butler always implements onTask (AgentParticipant); `?` is only the
      // Participant interface's optionality.
      return b.onTask!(task)
    },

    async onResume(task: Task, state: unknown): Promise<TaskResult> {
      // Same per-user butler (re-created if the map was cleared by a restart).
      const b = butlerFor(userIdOf(task))
      // A participant without onResume falls back to onTask — the scheduler's
      // documented parking contract.
      return b.onResume ? b.onResume(task, state) : b.onTask!(task)
    },

    async onTaskCancelled(taskId: TaskId, reason: string): Promise<void> {
      // We don't track which butler owns a given task id, so fan the cancel out
      // to every live one; butlers ignore unknown ids. Best-effort.
      for (const b of butlers.values()) {
        try {
          await b.onTaskCancelled?.(taskId, reason)
        } catch (err) {
          opts.logger?.warn('butler-router: butler onTaskCancelled failed', { err })
        }
      }
    },

    async onShutdown(): Promise<void> {
      // Tear down every spawned butler (MCP toolsets, file handles…). One
      // throwing must not block the others.
      for (const [userId, b] of butlers) {
        try {
          await b.onShutdown?.()
        } catch (err) {
          opts.logger?.warn('butler-router: butler onShutdown failed', { userId, err })
        }
      }
    },
  }
}
