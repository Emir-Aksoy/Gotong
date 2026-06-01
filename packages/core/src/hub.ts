import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { MessageBus } from './bus.js'
import {
  FeedbackLedger,
  FileFeedbackStorage,
  MemoryFeedbackStorage,
  ReputationStore,
} from './feedback/index.js'
import { createLogger } from './logger.js'
import { Registry } from './registry.js'
import {
  DefaultScheduler,
  type CancelNotifier,
  type CrossHubExplicitResolver,
  type Scheduler,
  type SuspendNotifier,
  type TaskInvoker,
} from './scheduler.js'
import { InMemoryStorage, type Storage } from './storage/index.js'
import { Space } from './space.js'
import { isSuspendTaskError } from './suspend.js'
import { Transcript } from './transcript.js'

const log = createLogger('hub')
import type {
  AdmissionDecision,
  AncestryNode,
  ChannelId,
  ContributionRow,
  DispatchStrategy,
  Evaluation,
  HubEvent,
  Leaderboard,
  Message,
  Participant,
  ParticipantId,
  PendingApplication,
  Task,
  TaskId,
  TaskResult,
} from './types.js'

/**
 * Phase 10 M2 — hard cap on dispatch chain depth. A new dispatch whose
 * incoming `ancestry` array already has this many entries is rejected
 * before it reaches the scheduler. Default is intentionally low (5) —
 * the architect-team workflow needs maybe 2 hops in practice; anything
 * past that is almost certainly a runaway loop or a mis-instrumented
 * agent. Override via `AIPE_MAX_DISPATCH_DEPTH=N` (clamped to [1, 50]).
 */
const DEFAULT_MAX_DISPATCH_DEPTH = 5

export function readMaxDispatchDepth(): number {
  const raw = process.env.AIPE_MAX_DISPATCH_DEPTH
  if (!raw) return DEFAULT_MAX_DISPATCH_DEPTH
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    return DEFAULT_MAX_DISPATCH_DEPTH
  }
  return n
}

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
    /**
     * Phase 11 M2 — handed through from `HubConfig.suspendNotifier`.
     * Custom schedulers should pass it to whichever inner scheduler
     * ultimately calls `runOne` if they want suspend persistence.
     */
    suspendNotifier?: SuspendNotifier,
  ) => Scheduler
  /**
   * Phase 11 M2 — host-supplied persistence hook for participants
   * that throw `SuspendTaskError`. The hub itself doesn't open the
   * SQLite — the host wires this to `IdentityStore.persistSuspendedTask`.
   * Unset → suspends still resolve to `{ kind: 'suspended', ... }`
   * but won't survive a process restart.
   */
  suspendNotifier?: SuspendNotifier
  /**
   * D2 (v4 Phase 5) — cross-hub explicit-dispatch hook. When the local
   * scheduler can't find an explicit dispatch target by id, this
   * resolver is called. Returning a dispatcher closure forwards the
   * task; returning null falls through to the usual no-such-participant
   * error.
   *
   * Used for cross-hub HITL: a remote-origin task triggers a local
   * agent which then needs to ask its originating user a question —
   * the resolver maps `task.origin.orgId` to a live HubLink.
   *
   * Only consulted when the default scheduler is in use. Custom
   * schedulers via `schedulerFactory` are responsible for honoring
   * cross-hub routes themselves if they want them.
   */
  crossHubResolver?: CrossHubExplicitResolver
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
  /**
   * Outbound feedback ledger. Append-only event-sourced jsonl backing
   * the hub-mesh feedback system (M5+). When the hub is bound to a
   * `Space`, this writes to `<space>/feedback/outbound.jsonl`;
   * otherwise (e.g. `Hub.inMemory()`) it uses an in-process store
   * that is lost on hub disposal.
   */
  readonly feedback: FeedbackLedger
  /**
   * INBOUND feedback ledger — evaluations OTHER hubs have written
   * about us, fetched over a HubLink via the pull protocol (M6).
   * Same schema as `feedback`; lives at `<space>/feedback/inbound.jsonl`.
   * Read by `hub.feedback`-style queries on the receiving end (M8).
   */
  readonly inboundFeedback: FeedbackLedger
  /**
   * Per-peer reputation derived from the feedback ledger (M5b). Drives
   * the scheduler's capability-dispatch ranking: high-reputation peers
   * are tried first. Persisted to `<space>/feedback/reputation/<id>.json`
   * when bound to a Space.
   */
  readonly reputation: ReputationStore
  private readonly scheduler: Scheduler
  private readonly storage: Storage
  private readonly idGen: () => string
  private readonly now: () => number
  private started = false
  private stopped = false
  /**
   * Most-recent in-flight `space.writePendingApps()` mirror write (see
   * {@link syncPendingFile}). Tracked so {@link stop} can drain it before
   * returning — otherwise a fire-and-forget write can land during a
   * caller's teardown `rm(space, { recursive })` and trip ENOTEMPTY.
   */
  private pendingFileWrite: Promise<unknown> = Promise.resolve()
  private readonly pending = new Map<string, PendingEntry>()
  /**
   * Phase 11 M3 — stored separately so `resumeTask` can call it on
   * suspend-again without going back through the scheduler's
   * runOne. The scheduler also has its own reference (handed at
   * construction); both point at the same hook.
   */
  private readonly suspendNotifier?: SuspendNotifier

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
    this.feedback = new FeedbackLedger(
      this.space
        ? new FileFeedbackStorage({ dir: join(this.space.root, 'feedback') })
        : new MemoryFeedbackStorage(),
    )
    this.inboundFeedback = new FeedbackLedger(
      this.space
        ? new FileFeedbackStorage({
            dir: join(this.space.root, 'feedback'),
            file: 'inbound.jsonl',
          })
        : new MemoryFeedbackStorage(),
    )
    this.reputation = new ReputationStore({
      dir: this.space ? join(this.space.root, 'feedback', 'reputation') : undefined,
    })
    // Bootstrap reputation from existing ledger entries (e.g. after a
    // restart where on-disk reputation may have lagged behind ledger
    // appends). Cheap when ledger is empty / small.
    this.reputation.rebuild(this.feedback.query())
    // Wire the live feedback → reputation pipe so every future append
    // / rejection updates the score automatically.
    this.feedback.setHooks({
      onAppend: (entry) => this.reputation.recordEntry(entry.toHub, entry.rating),
      onRejected: (entry) =>
        this.reputation.recordRejection(
          entry.toHub,
          this.feedback.query({ toHub: entry.toHub }),
        ),
    })

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
            log.error('onTaskCancelled rejected', { taskId, err }),
          )
        }
      } catch (err) {
        log.error('onTaskCancelled threw', { taskId, err })
      }
    }

    // Inject reputation lookup into the default scheduler so capability
    // dispatch ranks peers by score (M5b). Custom schedulers passed via
    // `schedulerFactory` are responsible for using reputation
    // themselves if they want it.
    const crossHubResolver = config.crossHubResolver
    const suspendNotifier = config.suspendNotifier
    if (suspendNotifier) this.suspendNotifier = suspendNotifier
    const factory =
      config.schedulerFactory ??
      ((r, inv, can, sn) =>
        new DefaultScheduler(
          r,
          inv,
          can,
          (id) => this.reputation.scoreOf(id),
          crossHubResolver,
          sn,
        ))
    this.scheduler = factory(this.registry, invoke, notifyCancel, suspendNotifier)
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
        log.error('could not clear pending-apps', { err }),
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
        log.error('onShutdown threw', { participantId: p.id, err })
      }
    }
    if (this.storage.close) await this.storage.close()
    // Drain any in-flight pending-apps mirror write before returning so the
    // space's runtime/ dir is quiescent once stop() resolves. Without this a
    // fire-and-forget writePendingApps() rename (queued by approve/reject/
    // requestAdmission) can land during a caller's recursive rm() of the
    // space dir and trip ENOTEMPTY (rm's `force: true` only swallows ENOENT).
    // Already `.catch()`-ed in syncPendingFile, so this await never rejects.
    await this.pendingFileWrite
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
    /**
     * Optional service ACL the client is requesting. Carried into
     * `PendingApplication.services` so admins can review it before
     * approving. Validation happened transport-side before this call
     * (illegal owner patterns rejected with `bad_hello`); the hub
     * trusts the shape and stores it verbatim.
     */
    services?: ReadonlyArray<{
      type: string
      impl: string
      owner: { kind: string; id: string }
      config?: unknown
      /** Per-decl method ACL narrowing (v1.2). See `ApplicationServiceDecl.methods`. */
      methods?: readonly string[]
    }>
  }): { applicationId: string; decision: Promise<AdmissionDecision> } {
    // C5: pre-3.1 a HELLO that arrived *after* SIGTERM (a window of
    // milliseconds while the WS server was still accepting connections
    // but `stop()` had already cleared `this.pending`) would land an
    // entry the loop in `stop()` never sees — the awaiting session
    // sits in AWAIT_APPROVAL forever, surviving the host's exit. Now
    // requestAdmission refuses post-stop applications outright; the
    // transport rolls back the session via the normal REJECT path.
    if (this.stopped) {
      return {
        applicationId: this.idGen(),
        decision: Promise.resolve({ approved: false, reason: 'hub_stopped' }),
      }
    }
    const application: PendingApplication = {
      id: this.idGen(),
      agents: req.agents.map((a) => ({ id: a.id, capabilities: [...a.capabilities] })),
      meta: req.meta,
      pendingSince: this.now(),
      ...(req.services && req.services.length > 0
        ? {
            services: req.services.map((s) => ({
              type: s.type,
              impl: s.impl,
              owner: { kind: s.owner.kind, id: s.owner.id },
              ...(s.config !== undefined ? { config: s.config } : {}),
              ...(s.methods && s.methods.length > 0
                ? { methods: [...s.methods] }
                : {}),
            })),
          }
        : {}),
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
    // Track the in-flight write so stop() can drain it. writePendingApps
    // serialises through the Space's per-file lock, so awaiting the most
    // recent promise also awaits every write still queued behind it.
    this.pendingFileWrite = this.space.writePendingApps(apps).catch((err) =>
      log.error('sync pending-apps failed', { err }),
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
        // `weight` defaults to 1.0 for any task that was dispatched before
        // v2.1 added the field (or by a caller that omits it). Keeping the
        // default here — rather than mutating the persisted task — means
        // legacy transcripts replay byte-for-byte.
        byId.set(e.data.id, {
          id: e.data.id,
          task: e.data,
          status: 'pending',
          createdAt: e.data.createdAt,
          weight: e.data.weight ?? 1.0,
        })
      } else if (e.kind === 'task_result') {
        const view = byId.get(e.data.taskId)
        if (!view) continue
        if (e.data.kind === 'ok') view.status = 'done'
        else if (e.data.kind === 'cancelled') view.status = 'cancelled'
        else view.status = 'failed'
        view.result = e.data
        // `completedAt` is the moment the Hub recorded the result, not the
        // moment the agent self-reported it. The entry-level `ts` flows
        // through `hub.now()`, which is overridable in tests and immune to
        // clock skew on remote agents. (Pre-v2.1 this read `e.data.ts`.)
        view.completedAt = e.ts
      } else if (e.kind === 'evaluation') {
        const view = byId.get(e.data.taskId)
        if (!view) continue
        if (!view.evaluations) view.evaluations = []
        view.evaluations.push(e.data)
        // "Latest rated wins" — re-evaluating overrides the contribution
        // score. Comment-only evaluations leave the previous score in place.
        if (typeof e.data.rating === 'number') {
          view.effectiveRating = e.data.rating
          view.contribution = round1((view.weight ?? 1.0) * e.data.rating)
        }
      }
    }
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Return the latest result envelope for a task id, if one has been
   * recorded. Suspended tasks later receive a fresh resume result with
   * the same task id, so callers must read the latest view rather than
   * the first transcript match.
   */
  taskResult(taskId: TaskId): TaskResult | undefined {
    return this.tasks().find((t) => t.id === taskId)?.result
  }

  /**
   * Aggregate per-participant contribution scores over a time window.
   *
   * Counted: completed tasks (`status === 'done'`, `result.kind === 'ok'`)
   * whose `completedAt` falls in `[from, to)` and whose latest evaluation
   * carries a numeric `rating`. Each such task contributes
   * `weight × rating` to its handler's row. Failed / cancelled / unrated
   * tasks are not counted toward `totalContribution`; unrated-but-done
   * ones bump `unratedTaskCount` so admins can see the backlog of
   * "completed, awaiting review."
   *
   * Pure read — derived on the fly from the transcript every call. Cheap
   * for the "small体验版" scale this codebase targets; if you grow past a
   * few thousand completed tasks per page-load, cache the result.
   *
   *   const lb = hub.leaderboard({ from: weekAgo, to: now })
   *   lb.rows[0]  // top contributor
   */
  leaderboard(opts: { from?: number; to?: number } = {}): Leaderboard {
    const from = opts.from ?? 0
    const to = opts.to ?? this.now() + 1
    interface Accum {
      row: ContributionRow
      sumRating: number
    }
    const acc = new Map<ParticipantId, Accum>()
    let unratedTaskCount = 0
    let totalTaskCount = 0

    for (const v of this.tasks()) {
      if (v.status !== 'done' || v.result?.kind !== 'ok') continue
      const completedAt = v.completedAt ?? v.createdAt
      if (completedAt < from || completedAt >= to) continue
      // Per-task opt-out: the publisher chose not to have this task
      // shape the scoreboard. Drop it cleanly — not counted as rated,
      // not counted as unrated. The task still appears in `hub.tasks()`
      // and the transcript; the leaderboard simply doesn't see it.
      if (v.task.countContribution === false) continue
      totalTaskCount += 1
      if (v.effectiveRating == null || v.contribution == null) {
        unratedTaskCount += 1
        continue
      }
      const by = v.result.by
      const weight = v.weight ?? 1.0
      let a = acc.get(by)
      if (!a) {
        a = {
          row: {
            participantId: by,
            taskCount: 0,
            totalWeight: 0,
            totalContribution: 0,
            averageRating: 0,
            lastActivityTs: 0,
            byCapability: {},
          },
          sumRating: 0,
        }
        acc.set(by, a)
      }
      a.row.taskCount += 1
      a.row.totalWeight += weight
      a.row.totalContribution += v.contribution
      a.sumRating += v.effectiveRating
      if (completedAt > a.row.lastActivityTs) a.row.lastActivityTs = completedAt
      for (const cap of capabilitiesOfStrategy(v.task.strategy)) {
        const cur = a.row.byCapability[cap] ?? { count: 0, contribution: 0 }
        cur.count += 1
        cur.contribution = round1(cur.contribution + v.contribution)
        a.row.byCapability[cap] = cur
      }
    }

    const rows: ContributionRow[] = []
    for (const { row, sumRating } of acc.values()) {
      row.averageRating = row.taskCount > 0 ? round1(sumRating / row.taskCount) : 0
      row.totalContribution = round1(row.totalContribution)
      row.totalWeight = round1(row.totalWeight)
      rows.push(row)
    }
    // Sort by contribution desc; tie-break by lastActivityTs desc so a
    // recently-active id ranks above a long-idle one with the same score.
    rows.sort((a, b) => {
      if (b.totalContribution !== a.totalContribution) {
        return b.totalContribution - a.totalContribution
      }
      return b.lastActivityTs - a.lastActivityTs
    })

    return { from, to, rows, unratedTaskCount, totalTaskCount }
  }

  /**
   * Phase 11 M3 — re-enter a previously suspended task on its
   * original participant. Called by the host's resume sweep (M3)
   * when an entry in `suspended_tasks` is past its `resume_at`.
   *
   * Differs from `dispatch` in three ways:
   *   - The task object is reused verbatim (same id, same payload)
   *     instead of allocating a fresh one — the suspended row
   *     stored the full task envelope in `task_json`.
   *   - The participant is identified by id directly (the row
   *     captured `agent_id` at suspend time); dispatch's strategy
   *     matching / depth + cycle gates do NOT re-fire.
   *   - The participant is invoked via `onResume(task, state)` when
   *     it implemented one, falling back to `onTask(task)` otherwise.
   *
   * Behaviour on the resume side mirrors `scheduler.runOne`'s
   * suspend handling: a SuspendTaskError thrown from `onResume`
   * (suspend-again) is caught, persisted via `suspendNotifier`, and
   * surfaced as a fresh `{ kind: 'suspended', ... }` result. The
   * row gets overwritten via INSERT OR REPLACE; the sweep caller
   * checks `result.kind` before calling `removeSuspendedTask`.
   *
   * Returns the participant's result envelope. The transcript gets
   * a `task_resumed` entry (signalling re-entry) followed by the
   * usual `task_result`. There is no fresh `task` entry — the
   * original lives earlier in the same transcript at the same
   * taskId.
   */
  async resumeTask(
    agentId: ParticipantId,
    task: Task,
    state: unknown,
  ): Promise<TaskResult> {
    this.transcript.append({
      ts: this.now(),
      kind: 'task_resumed',
      data: { taskId: task.id, by: agentId },
    })
    const result = await this.runResume(agentId, task, state)
    this.transcript.append({ ts: this.now(), kind: 'task_result', data: result })
    return result
  }

  private async runResume(
    agentId: ParticipantId,
    task: Task,
    state: unknown,
  ): Promise<TaskResult> {
    const p = this.registry.get(agentId)
    if (!p) {
      return {
        kind: 'no_participant',
        taskId: task.id,
        reason: `resume target '${agentId}' is not registered`,
        ts: this.now(),
      }
    }
    // Resume routes through `onResume(task, state)` when the
    // participant implements one; otherwise we fall back to
    // `onTask(task)` so plain agents (no resume awareness) still
    // get re-run from the top. Working-memory-aware agents (Phase 11
    // M4) implement `onResume` to splice state back in.
    if (!p.onResume && !p.onTask) {
      return {
        kind: 'no_participant',
        taskId: task.id,
        reason: `participant '${agentId}' has neither onResume nor onTask`,
        ts: this.now(),
      }
    }
    this.registry.incLoad(agentId)
    try {
      const r = p.onResume
        ? await p.onResume(task, state)
        : await p.onTask!(task)
      return r
    } catch (err) {
      if (isSuspendTaskError(err)) {
        const resumeAt = err.resumeAt
        try {
          await this.suspendNotifier?.(task, agentId, {
            resumeAt,
            state: err.state,
          })
        } catch (persistErr) {
          log.error('resume → suspend-again persist threw', {
            taskId: task.id,
            by: agentId,
            resumeAt,
            err: persistErr,
          })
          return {
            kind: 'failed',
            taskId: task.id,
            by: agentId,
            error: `suspend persist failed: ${
              persistErr instanceof Error ? persistErr.message : String(persistErr)
            }`,
            ts: this.now(),
          }
        }
        return {
          kind: 'suspended',
          taskId: task.id,
          by: agentId,
          resumeAt,
          ts: this.now(),
        }
      }
      return {
        kind: 'failed',
        taskId: task.id,
        by: agentId,
        error: err instanceof Error ? err.message : String(err),
        ts: this.now(),
      }
    } finally {
      this.registry.decLoad(agentId)
    }
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
      weight: orig.weight,
      countContribution: orig.countContribution,
    })
  }

  // --- evaluation (v1.1) ----------------------------------------------------

  /**
   * Record a reviewer's verdict on a completed task. Appended to the
   * transcript as an `evaluation` entry; no state is mutated. The caller
   * is responsible for cross-referencing `taskId` with an earlier
   * `task_result` entry — the hub does not validate the link.
   *
   * `rating` is clamped to `[0, 5]` and rounded to one decimal place so
   * the persisted value is always well-formed; an out-of-range or
   * non-finite input is silently coerced rather than rejected (callers
   * are often web forms — friendlier to coerce than to 400). Pass
   * `undefined` for a comment-only evaluation; the contribution score on
   * the task view is then left unchanged by this entry.
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
      rating: sanitizeRating(opts.rating),
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
    /**
     * Contribution-system weight in [0.1, 10.0], one decimal place; default
     * 1.0 when omitted. Clamped + rounded by the Hub before being written
     * to the transcript so the persisted Task is always well-formed.
     */
    weight?: number
    /**
     * Per-task contribution-system opt-out. `false` keeps the task out of
     * `Hub.leaderboard()` aggregation entirely (no contribution, no
     * unrated-bookkeeping). Defaults to `true` (counted). The Web layer
     * sets this from the logged-in publisher's preference; callers in
     * tests or programmatic use can pass it directly.
     */
    countContribution?: boolean
    /**
     * Attribution claim for the task. Two legitimate sources:
     *
     *   - **FED-M2** — `installPeerLink`'s inbound handler forwards
     *     `task.origin` from across a HubLink. `orgId` is the peer's
     *     `selfId`; the receiver-side ACL (FED-M3) inspects this.
     *   - **B2.2.2** — local dispatchers (`/me`, workflow runner)
     *     stamp `{orgId: 'local', userId}` so the per-call quota gate
     *     in `LlmAgent.preCallHook` can debit the right user. The
     *     `'local'` sentinel makes "this is a same-hub task" obvious
     *     to anyone reading the transcript or audit log.
     *
     * The receiver-side ACL is *only* evaluated on the inbound path
     * of `installPeerLink` — local `hub.dispatch` never runs the
     * FED-M3 check, so a local `origin` claim can't accidentally
     * trip a cross-org policy.
     */
    origin?: import('./types.js').TaskOrigin
    /**
     * Phase 10 M2 — dispatch ancestry chain. Set by `DispatchToolset`
     * (the agent-to-agent path) to the parent task's `[...ancestry,
     * {taskId: parent.id, from: parent.from}]`. Root dispatches
     * (user / admin / script → hub) omit this and become an empty
     * chain on the new task.
     *
     * The hub rejects the dispatch up-front when:
     *   - chain length is already at `MAX_DISPATCH_DEPTH` (depth gate)
     *   - the new task's `from` already appears on the chain (cycle:
     *     A is dispatching while still on the call stack from a
     *     previous task A dispatched)
     *   - an `explicit` strategy targets an id already on the chain
     *     (cycle: A → B → A pattern)
     *
     * Rejected dispatches still create a task entry in the transcript
     * (so audit shows what was attempted) plus an immediate failed
     * task_result with a structured error code.
     */
    ancestry?: readonly AncestryNode[]
    /**
     * Phase 19 P4-M4 — data classification tags for the payload. Carried on
     * the task so the outbound per-link data-class allowlist can refuse a
     * cross-org send of data a peer isn't cleared for. Omitted = no classes.
     */
    dataClasses?: readonly string[]
  }): Promise<TaskResult> {
    // Phase 10 M2 gate. Evaluated BEFORE id allocation so the task id
    // sequence isn't burned by rejected attempts — but we still write
    // a transcript pair (task + failed result) under a synthetic id
    // so audit captures what was tried + why.
    const ancestry = opts.ancestry ?? []
    const gateError = checkDispatchGates(ancestry, opts.from, opts.strategy)

    const task: Task = {
      id: this.idGen(),
      from: opts.from,
      strategy: opts.strategy,
      payload: opts.payload,
      title: opts.title,
      deadlineMs: opts.deadlineMs,
      priority: opts.priority,
      weight: sanitizeWeight(opts.weight),
      countContribution: opts.countContribution,
      // FED-M2: only attach origin field when actually present, to
      // keep the transcript shape stable for legacy / single-org runs.
      ...(opts.origin ? { origin: opts.origin } : {}),
      // Phase 10 M2: only attach ancestry when non-empty for the same
      // reason — root dispatches (the common case) stay byte-identical.
      ...(ancestry.length > 0 ? { ancestry } : {}),
      // Phase 19 P4-M4: attach data classes only when declared, so legacy
      // tasks stay byte-identical in the transcript.
      ...(opts.dataClasses && opts.dataClasses.length > 0
        ? { dataClasses: opts.dataClasses }
        : {}),
      createdAt: this.now(),
    }
    this.transcript.append({ ts: task.createdAt, kind: 'task', data: task })

    if (gateError) {
      const result: TaskResult = {
        kind: 'failed',
        taskId: task.id,
        by: 'scheduler' as ParticipantId,
        error: gateError,
        ts: this.now(),
      }
      this.transcript.append({ ts: result.ts, kind: 'task_result', data: result })
      return result
    }

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
  /**
   * Task weight in [0.1, 10.0], 1 decimal — always present on a derived
   * view. For tasks written before v2.1 (no `weight` field on disk) this
   * defaults to 1.0 so the contribution math still works.
   */
  weight?: number
  /** Most recent numeric rating across `evaluations[]`, if any. */
  effectiveRating?: number
  /**
   * `weight × effectiveRating`, rounded to 1 decimal. Set iff
   * `effectiveRating` is set. Undefined for completed-but-unrated tasks.
   */
  contribution?: number
}

// --- module-level helpers (v2.1 contribution system) ---------------------

/**
 * Sanitise a task weight: clamp to `[0.1, 10.0]`, round to one decimal,
 * default to `1.0` for missing / non-finite input. The result is always a
 * finite number safe to multiply by a rating.
 */
function sanitizeWeight(w?: number): number {
  if (w == null || !Number.isFinite(w)) return 1.0
  const r = round1(w)
  if (r < 0.1) return 0.1
  if (r > 10.0) return 10.0
  return r
}

/**
 * Sanitise an evaluation rating: clamp to `[0, 5]`, round to one decimal,
 * preserve `undefined` for comment-only evaluations. The Hub never
 * rejects an evaluation just because the rating is out of range — it
 * coerces and moves on (the input is usually a web form).
 */
function sanitizeRating(r?: number): number | undefined {
  if (r == null || !Number.isFinite(r)) return undefined
  const v = round1(r)
  if (v < 0) return 0
  if (v > 5) return 5
  return v
}

/**
 * Phase 10 M2 — evaluate depth + cycle gates on a dispatch. Returns
 * an error code string when the dispatch must be rejected, or `null`
 * when it's allowed through.
 *
 * Cycle gate fires when an `explicit` strategy targets a participant
 * that already appears as some ancestor's `by` (the one that executed
 * that ancestor task). That is the A → B → A pattern. Recursive self-
 * dispatch (A → A → A …) is *not* gated here — it bottoms out at the
 * depth gate, and a self-recursive agent is a valid design.
 *
 * Capability strategies skip the cycle check because the matcher
 * hasn't picked the executor yet; the depth gate provides the bound.
 */
function checkDispatchGates(
  ancestry: readonly AncestryNode[],
  _from: ParticipantId,
  strategy: DispatchStrategy,
): string | null {
  if (ancestry.length >= readMaxDispatchDepth()) {
    return 'dispatch_depth_exceeded'
  }
  if (strategy.kind === 'explicit') {
    for (const node of ancestry) {
      if (node.by === strategy.to) {
        return 'dispatch_cycle'
      }
    }
  }
  return null
}

/**
 * Round a number to one decimal place. Avoids accumulating
 * floating-point error in the totals (`0.1 + 0.2 === 0.30000000000000004`
 * would be misleading on a leaderboard).
 */
function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Capabilities a task was routed under, for the leaderboard's
 * `byCapability` breakdown. `explicit` dispatches contribute under no
 * capability — they're personal routing, not skill-based.
 */
function capabilitiesOfStrategy(s: import('./types.js').DispatchStrategy): string[] {
  if (s.kind === 'capability') return [...s.capabilities]
  if (s.kind === 'broadcast' && s.capabilities) return [...s.capabilities]
  return []
}
