import { randomUUID } from 'node:crypto'

import { MessageBus } from './bus.js'
import { Registry } from './registry.js'
import { DefaultScheduler, type CancelNotifier, type Scheduler, type TaskInvoker } from './scheduler.js'
import { InMemoryStorage, type Storage } from './storage/index.js'
import { Space } from './space.js'
import { Transcript } from './transcript.js'
import type {
  AdmissionDecision,
  ChannelId,
  DispatchStrategy,
  Evaluation,
  HubEvent,
  Message,
  Participant,
  ParticipantId,
  PendingApplication,
  Task,
  TaskId,
  TaskResult,
} from './types.js'

interface PendingEntry {
  application: PendingApplication
  resolve: (decision: AdmissionDecision) => void
}

export interface HubConfig {
  /**
   * Bind the hub to an on-disk space (v2.0+). Required unless `storage` is
   * supplied explicitly. When `space` is provided the transcript is
   * persisted to `<space>/transcript.jsonl` and pending agent applications
   * are mirrored to `<space>/runtime/pending-apps.json` so they survive
   * a Hub crash within a single host run. (Pending apps are cleared on
   * `hub.start()` because the underlying WebSocket sessions die with the
   * host process — they're persisted for live observability, not revival.)
   */
  space?: Space
  /**
   * Persistence backend. If both `space` and `storage` are given, `storage`
   * wins (advanced use). v2.0 removes the implicit in-memory default — you
   * must pick a strategy explicitly (or pass `space` and let it pick).
   */
  storage?: Storage
  /** Replace the default scheduler. Most users don't need this. */
  schedulerFactory?: (
    registry: Registry,
    invoke: TaskInvoker,
    notifyCancel: CancelNotifier,
  ) => Scheduler
  idGenerator?: () => string
  now?: () => number
}

/**
 * Hub — the communication space. Construct one per logical workspace.
 *
 *   const hub = new Hub()
 *   await hub.start()
 *   hub.register(myAgent)
 *   hub.register(myHuman)
 *   const result = await hub.dispatch({
 *     from: 'system', strategy: { kind: 'capability', capabilities: ['draft'] },
 *     payload: { topic: 'why TS' },
 *   })
 *
 * The Hub owns the registry, message bus, scheduler, transcript, and storage.
 * It does not own agent intelligence — participants bring their own brains.
 */
export class Hub {
  readonly registry: Registry
  readonly bus: MessageBus
  readonly transcript: Transcript
  readonly space?: Space
  private readonly scheduler: Scheduler
  private readonly storage: Storage
  private readonly idGen: () => string
  private readonly now: () => number
  private started = false
  private stopped = false
  private readonly pending = new Map<string, PendingEntry>()

  constructor(config: HubConfig = {}) {
    this.space = config.space
    if (config.storage) {
      this.storage = config.storage
    } else if (config.space) {
      this.storage = config.space.storage()
    } else {
      throw new Error(
        `Hub: pass either { space: Space } or { storage: Storage }. v2.0 removed the implicit in-memory default — call \`Space.openOrInit(path, ...)\` to bind the hub to a directory, or use \`new InMemoryStorage()\` explicitly for tests.`,
      )
    }
    this.idGen = config.idGenerator ?? (() => randomUUID())
    this.now = config.now ?? (() => Date.now())
    this.transcript = new Transcript(this.storage)
    this.registry = new Registry()

    this.bus = new MessageBus(async (recipientId, msg) => {
      const p = this.registry.get(recipientId)
      if (!p || !p.onMessage) return
      await p.onMessage(msg)
    })

    const invoke: TaskInvoker = async (p, task) => {
      if (!p.onTask) {
        return {
          kind: 'no_participant',
          taskId: task.id,
          reason: `participant '${p.id}' has no onTask handler`,
          ts: this.now(),
        }
      }
      return p.onTask(task)
    }

    const notifyCancel: CancelNotifier = (id, taskId, reason) => {
      const p = this.registry.get(id)
      if (!p || !p.onTaskCancelled) return
      try {
        const r = p.onTaskCancelled(taskId, reason)
        if (r && typeof (r as Promise<unknown>).catch === 'function') {
          ;(r as Promise<unknown>).catch((err) =>
            console.error('[hub] onTaskCancelled rejected:', err),
          )
        }
      } catch (err) {
        console.error('[hub] onTaskCancelled threw:', err)
      }
    }

    const factory = config.schedulerFactory ?? ((r, inv, can) => new DefaultScheduler(r, inv, can))
    this.scheduler = factory(this.registry, invoke, notifyCancel)
  }

  /**
   * Spin up a Hub backed purely by `InMemoryStorage` — for tests and
   * short-lived in-process examples. Production code should use
   * `new Hub({ space: ... })` so that state survives a restart.
   */
  static inMemory(config: Omit<HubConfig, 'space' | 'storage'> = {}): Hub {
    return new Hub({ ...config, storage: new InMemoryStorage() })
  }

  // --- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return
    await this.transcript.load()
    // Pending applications from a previous host run are ghosts — their
    // WebSocket sessions died with the process. Clear the file so the
    // admin UI doesn't see un-actionable entries.
    if (this.space) {
      await this.space.writePendingApps([]).catch((err) =>
        console.error('[hub] could not clear pending-apps:', err),
      )
    }
    this.started = true
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    // Resolve every pending admission as a rejection so callers don't hang
    // forever when the hub shuts down with applications in flight.
    for (const [id, entry] of this.pending) {
      entry.resolve({ approved: false, reason: 'hub_stopped' })
      this.pending.delete(id)
    }
    for (const p of this.registry.all()) {
      try {
        await p.onShutdown?.()
      } catch (err) {
        console.error(`[hub] onShutdown for ${p.id} threw:`, err)
      }
    }
    if (this.storage.close) await this.storage.close()
  }

  // --- participants ---------------------------------------------------------

  register(p: Participant): void {
    this.registry.register(p)
    this.transcript.append({
      ts: this.now(),
      kind: 'participant_joined',
      data: { id: p.id, participantKind: p.kind, capabilities: p.capabilities },
    })
  }

  unregister(id: ParticipantId): Participant | undefined {
    const p = this.registry.unregister(id)
    if (!p) return undefined
    this.bus.unsubscribeAll(id)
    this.transcript.append({
      ts: this.now(),
      kind: 'participant_left',
      data: { id },
    })
    return p
  }

  participant(id: ParticipantId): Participant | undefined {
    return this.registry.get(id)
  }

  participants(): Participant[] {
    return this.registry.all()
  }

  // --- admission gating (v1.1) ---------------------------------------------

  /**
   * Submit an admission application. The returned promise resolves when an
   * admin (or any caller of `approveApplication` / `rejectApplication`) acts
   * on it — or rejects with `'hub_stopped'` if the hub stops first.
   *
   * Transport layers (e.g. `@aipehub/transport-ws` with
   * `gating: 'admin-approval'`) call this on every HELLO and gate WELCOME on
   * the decision. The application id is also appended to the transcript as
   * an `agent_pending` event so observers see it in real time.
   */
  requestAdmission(req: {
    agents: ReadonlyArray<{ id: ParticipantId; capabilities: readonly string[] }>
    meta?: Readonly<Record<string, unknown>>
  }): { applicationId: string; decision: Promise<AdmissionDecision> } {
    const application: PendingApplication = {
      id: this.idGen(),
      agents: req.agents.map((a) => ({ id: a.id, capabilities: [...a.capabilities] })),
      meta: req.meta,
      pendingSince: this.now(),
    }
    const decision = new Promise<AdmissionDecision>((resolve) => {
      this.pending.set(application.id, { application, resolve })
    })
    this.transcript.append({
      ts: application.pendingSince,
      kind: 'agent_pending',
      data: application,
    })
    this.syncPendingFile()
    return { applicationId: application.id, decision }
  }

  /** Currently-pending applications, oldest first. */
  pendingApplications(): PendingApplication[] {
    return [...this.pending.values()]
      .map((e) => e.application)
      .sort((a, b) => a.pendingSince - b.pendingSince)
  }

  /** Approve a pending application. Returns false if the id is unknown. */
  approveApplication(applicationId: string, by?: ParticipantId): boolean {
    const entry = this.pending.get(applicationId)
    if (!entry) return false
    this.pending.delete(applicationId)
    this.transcript.append({
      ts: this.now(),
      kind: 'agent_approved',
      data: {
        applicationId,
        agentIds: entry.application.agents.map((a) => a.id),
        by,
      },
    })
    this.syncPendingFile()
    entry.resolve({ approved: true, by })
    return true
  }

  /** Reject a pending application. Returns false if the id is unknown. */
  rejectApplication(
    applicationId: string,
    reason: string,
    by?: ParticipantId,
  ): boolean {
    const entry = this.pending.get(applicationId)
    if (!entry) return false
    this.pending.delete(applicationId)
    this.transcript.append({
      ts: this.now(),
      kind: 'agent_rejected',
      data: {
        applicationId,
        agentIds: entry.application.agents.map((a) => a.id),
        by,
        reason,
      },
    })
    this.syncPendingFile()
    entry.resolve({ approved: false, by, reason })
    return true
  }

  /**
   * Best-effort write of the current pending-applications set to
   * `<space>/runtime/pending-apps.json`. Fire-and-forget; on failure we
   * just log — the in-memory map is the live truth, the file is a mirror
   * for the admin UI and post-mortem inspection.
   */
  private syncPendingFile(): void {
    if (!this.space) return
    const apps = [...this.pending.values()].map((e) => e.application)
    this.space.writePendingApps(apps).catch((err) =>
      console.error('[hub] sync pending-apps failed:', err),
    )
  }

  // --- task views (v2.0) ----------------------------------------------------

  /**
   * Derive the current state of every task ever dispatched by replaying
   * the transcript. Pure read — no extra state stored.
   *
   *   - `pending`     — `task` seen, no `task_result` yet (in flight, queued,
   *                     or waiting on a human inbox)
   *   - `done`        — `task_result` with `kind: 'ok'`
   *   - `failed`      — `task_result` with `kind: 'failed' | 'no_participant'`
   *   - `cancelled`   — `task_result` with `kind: 'cancelled'`
   */
  tasks(): TaskView[] {
    const byId = new Map<TaskId, TaskView>()
    for (const e of this.transcript.all()) {
      if (e.kind === 'task') {
        byId.set(e.data.id, {
          id: e.data.id,
          task: e.data,
          status: 'pending',
          createdAt: e.data.createdAt,
        })
      } else if (e.kind === 'task_result') {
        const view = byId.get(e.data.taskId)
        if (!view) continue
        if (e.data.kind === 'ok') view.status = 'done'
        else if (e.data.kind === 'cancelled') view.status = 'cancelled'
        else view.status = 'failed'
        view.result = e.data
        view.completedAt = e.data.ts
      } else if (e.kind === 'evaluation') {
        const view = byId.get(e.data.taskId)
        if (!view) continue
        if (!view.evaluations) view.evaluations = []
        view.evaluations.push(e.data)
      }
    }
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Re-dispatch a previously-finished task. Creates a brand-new task
   * (new id, new `createdAt`) with the same `strategy` and `payload`, plus
   * a `retryOf: <original-id>` field added to the payload object so the
   * UI / consumers can trace lineage. Throws if the original task is
   * still pending — retry on a live task is a programming error.
   */
  async retry(taskId: TaskId, by: ParticipantId = 'system'): Promise<TaskResult> {
    const view = this.tasks().find((t) => t.id === taskId)
    if (!view) {
      throw new Error(`retry: unknown task ${taskId}`)
    }
    if (view.status === 'pending') {
      throw new Error(`retry: task ${taskId} is still pending — wait for it to finish`)
    }
    const orig = view.task
    const payload =
      orig.payload && typeof orig.payload === 'object' && !Array.isArray(orig.payload)
        ? { ...(orig.payload as Record<string, unknown>), retryOf: taskId }
        : { retryOf: taskId, payload: orig.payload }
    return this.dispatch({
      from: by,
      strategy: orig.strategy,
      payload,
      title: orig.title ? `retry: ${orig.title}` : undefined,
      priority: orig.priority,
    })
  }

  // --- evaluation (v1.1) ----------------------------------------------------

  /**
   * Record a reviewer's verdict on a completed task. Appended to the
   * transcript as an `evaluation` entry; no state is mutated. The caller
   * is responsible for cross-referencing `taskId` with an earlier
   * `task_result` entry — the hub does not validate the link.
   */
  evaluate(opts: {
    taskId: TaskId
    by: ParticipantId
    rating?: number
    comment?: string
  }): Evaluation {
    const ev: Evaluation = {
      taskId: opts.taskId,
      by: opts.by,
      rating: opts.rating,
      comment: opts.comment,
    }
    this.transcript.append({ ts: this.now(), kind: 'evaluation', data: ev })
    return ev
  }

  // --- messaging ------------------------------------------------------------

  subscribe(participantId: ParticipantId, channel: ChannelId): void {
    if (!this.registry.has(participantId)) {
      throw new Error(`subscribe: participant '${participantId}' is not registered`)
    }
    this.bus.subscribe(participantId, channel)
  }

  unsubscribe(participantId: ParticipantId, channel: ChannelId): void {
    this.bus.unsubscribe(participantId, channel)
  }

  publish(opts: { from: ParticipantId; channel: ChannelId; body: unknown }): Message {
    const msg: Message = {
      id: this.idGen(),
      channel: opts.channel,
      from: opts.from,
      body: opts.body,
      ts: this.now(),
    }
    this.transcript.append({ ts: msg.ts, kind: 'message', data: msg })
    this.bus.publish(msg)
    return msg
  }

  // --- tasks ----------------------------------------------------------------

  async dispatch(opts: {
    from: ParticipantId
    strategy: DispatchStrategy
    payload: unknown
    title?: string
    deadlineMs?: number
    /**
     * Scheduling priority hint, used by priority-aware schedulers (e.g.
     * `PriorityQueueScheduler`). Higher = more urgent. Default 0.
     * Ignored by the default scheduler.
     */
    priority?: number
  }): Promise<TaskResult> {
    const task: Task = {
      id: this.idGen(),
      from: opts.from,
      strategy: opts.strategy,
      payload: opts.payload,
      title: opts.title,
      deadlineMs: opts.deadlineMs,
      priority: opts.priority,
      createdAt: this.now(),
    }
    this.transcript.append({ ts: task.createdAt, kind: 'task', data: task })
    const result = await this.scheduler.dispatch(task)
    this.transcript.append({ ts: this.now(), kind: 'task_result', data: result })
    return result
  }

  // --- observability --------------------------------------------------------

  onEvent(handler: (e: HubEvent) => void): () => void {
    return this.transcript.onAppend(handler)
  }
}

// Re-export id helper for callers that want consistent ids with the Hub
export function newId(): string {
  return randomUUID()
}
export type { TaskId }

/**
 * Aggregated view of a task derived from the transcript. See `Hub.tasks()`.
 */
export type TaskStatus = 'pending' | 'done' | 'failed' | 'cancelled'

export interface TaskView {
  id: TaskId
  task: Task
  status: TaskStatus
  result?: TaskResult
  evaluations?: Evaluation[]
  createdAt: number
  completedAt?: number
}
