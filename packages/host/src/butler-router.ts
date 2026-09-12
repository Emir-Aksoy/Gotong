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
import { ButlerUserActivity, ButlerUserActivityError } from './butler-user-activity.js'

const butlerRouters = new WeakSet<Participant>()

/** Starts closing synchronously; pool stop must not await a self-stopping task's drain. */
export async function shutdownButlerRouter(participant: Participant | undefined): Promise<void> {
  if (participant && butlerRouters.has(participant)) await participant.onShutdown?.()
}

/**
 * Bucket for tasks that carry no `origin.userId` (operator pokes, admin
 * test-connection, anonymous dispatch). Kept distinct from any real userId so a
 * member's memory never mixes with operator scratch — and the `/me` privacy view
 * only ever reads REAL userIds, so this bucket is invisible there.
 */
export const BUTLER_ANON_USER = '_local'

/** Router shutdown is local, unlike permanent per-user quiescence. */
export class ButlerRouterClosedError extends Error {
  readonly code = 'BUTLER_ROUTER_CLOSED'
  constructor() {
    super('Butler router is closed.')
    this.name = 'ButlerRouterClosedError'
  }
}

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
   * Called at most once per distinct userId for this router, until shutdown.
   * The host injects the real factory (shared provider + key +
   * per-user memory rootDir); tests inject a fake participant.
   */
  createForUser: (userId: string) => Participant
  userActivity?: ButlerUserActivity
  /** Extra cleanup only: the router owns instance shutdown, even if it fails. */
  retireForUser?: (userId: string, participant: Participant) => void | Promise<void>
  /** Runs synchronously AFTER instance registration (e.g. deduplicated disk cleanup). */
  onUserCreated?: (userId: string) => void
  /** Bucket for tasks with no `origin.userId`. Default {@link BUTLER_ANON_USER}. */
  anonUserId?: string
  logger?: Logger
}

export interface ButlerRouter extends Participant {
  /** Number of live per-user butlers — for tests / observability. */
  readonly size: number
}

interface ResidentButler {
  participant: Participant
  unregister: () => boolean
  shutdownDone: boolean
}

/**
 * Build a {@link ButlerRouter}: a `Participant` that multiplexes one registered
 * chat agent over per-user resident butlers, routed by `task.origin.userId`.
 */
export function createButlerRouter(opts: ButlerRouterOptions): ButlerRouter {
  const anon = opts.anonUserId ?? BUTLER_ANON_USER
  const butlers = new Map<string, ResidentButler>()
  const activity = opts.userActivity ?? new ButlerUserActivity()
  const active = new Set<Promise<void>>()
  let closed = false
  let shutdown: Promise<void> | null = null

  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    if (closed) throw new ButlerRouterClosedError()
    let release!: () => void
    const settled = new Promise<void>(resolve => { release = resolve })
    // Register before factory/callback invocation, including synchronous throws
    // and reentrant shutdown requests. Only real completion releases this latch.
    active.add(settled)
    try { return await work() }
    finally { active.delete(settled); release() }
  }

  const shutdownInstance = async (resident: ResidentButler): Promise<void> => {
    if (resident.shutdownDone) return
    await resident.participant.onShutdown?.()
    resident.shutdownDone = true
  }

  const userIdOf = (task: Task): string => task.origin?.userId ?? anon

  const butlerFor = (userId: string): Participant => {
    let resident = butlers.get(userId)
    if (!resident) {
      const instance: ResidentButler = {
        participant: opts.createForUser(userId), unregister: () => false,
        shutdownDone: false,
      }
      instance.unregister = activity.register(userId, async () => {
        // Direct instance call: re-entering router shutdown would enter the
        // closed activity and could never retire. Keep failed instances to retry.
        try { await shutdownInstance(instance) }
        finally { await opts.retireForUser?.(userId, instance.participant) }
        butlers.delete(userId)
      })
      resident = instance
      butlers.set(userId, resident)
      opts.onUserCreated?.(userId)
      opts.logger?.debug('butler-router: spawned per-user butler', { id: opts.id, userId })
    }
    return resident.participant
  }

  const router: ButlerRouter = {
    id: opts.id,
    kind: 'agent',
    capabilities: opts.capabilities,

    get size(): number {
      return butlers.size
    },

    onTask(task: Task): Promise<TaskResult> {
      // The butler always implements onTask (AgentParticipant); `?` is only the
      // Participant interface's optionality.
      return run(() => {
        const userId = userIdOf(task)
        return activity.run(userId, () => butlerFor(userId).onTask!(task))
      })
    },

    onResume(task: Task, state: unknown): Promise<TaskResult> {
      // Same per-user butler (re-created if the map was cleared by a restart).
      // A participant without onResume falls back to onTask — the scheduler's
      // documented parking contract.
      return run(() => {
        const userId = userIdOf(task)
        return activity.run(userId, () => {
          const b = butlerFor(userId)
          return b.onResume ? b.onResume(task, state) : b.onTask!(task)
        })
      })
    },

    onTaskCancelled(taskId: TaskId, reason: string): Promise<void> {
      // We don't track which butler owns a given task id, so fan the cancel out
      // to every live one; butlers ignore unknown ids. Best-effort.
      return run(async () => {
        let quiesced = false
        for (const [userId, resident] of butlers) {
          try {
            await activity.run(userId, () => resident.participant.onTaskCancelled?.(taskId, reason))
          } catch (err) {
            if (err instanceof ButlerUserActivityError) quiesced = true
            opts.logger?.warn('butler-router: butler onTaskCancelled failed', { err })
          }
        }
        // Continue other users, but do not report a skipped cancellation as success.
        if (quiesced) throw new ButlerUserActivityError('BUTLER_USER_QUIESCED')
      })
    },

    // Call from outside this router's work/callbacks: awaiting shutdown from
    // inside a registered operation would wait on that operation itself.
    onShutdown(): Promise<void> {
      closed = true
      if (shutdown) return shutdown
      const pending = [...active]
      shutdown = Promise.resolve().then(async () => {
        await Promise.all(pending)
        let quiesced = false
        for (const [userId, resident] of butlers) {
          try {
            await activity.run(userId, async () => {
              await shutdownInstance(resident)
              // Quiescence may have started during shutdown. It now owns this
              // resource, so leave it registered until its extra cleanup succeeds.
              if (resident.unregister()) butlers.delete(userId)
            })
          } catch (err) {
            if (err instanceof ButlerUserActivityError) quiesced = true
            opts.logger?.warn('butler-router: butler onShutdown failed', { userId, err })
          }
        }
        if (quiesced) throw new ButlerUserActivityError('BUTLER_USER_QUIESCED')
      }).finally(() => { shutdown = null })
      return shutdown
    },
  }
  butlerRouters.add(router)
  return router
}
