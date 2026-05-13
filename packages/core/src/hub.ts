import { randomUUID } from 'node:crypto'

import { MessageBus } from './bus.js'
import { Registry } from './registry.js'
import { DefaultScheduler, type CancelNotifier, type Scheduler, type TaskInvoker } from './scheduler.js'
import { InMemoryStorage, type Storage } from './storage/index.js'
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
  /** Persistence backend. Defaults to in-memory (lost on exit). */
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
  private readonly scheduler: Scheduler
  private readonly storage: Storage
  private readonly idGen: () => string
  private readonly now: () => number
  private started = false
  private stopped = false
  private readonly pending = new Map<string, PendingEntry>()

  constructor(config: HubConfig = {}) {
    this.storage = config.storage ?? new InMemoryStorage()
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

  // --- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return
    await this.transcript.load()
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
    entry.resolve({ approved: false, by, reason })
    return true
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
