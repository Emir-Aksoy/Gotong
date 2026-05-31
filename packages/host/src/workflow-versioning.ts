/**
 * `WorkflowVersioning` — host-side service that owns the lifecycle + revision
 * state of every workflow and keeps the right runners registered on the Hub.
 *
 * It is the persistence + orchestration layer above two file-first stores from
 * `@aipehub/workflow` and the pure `transition()` state machine:
 *
 *   - `RevisionStore`  — immutable, write-once snapshots (`<rev>.json`)
 *   - `LifecycleStore` — the one mutable record per workflow (state, pointers,
 *                        revision metadata, audit log)
 *
 * The split is deliberate: `transition()` only flips `state` (pure, unit-tested
 * with hand-built records); this service does the revision bookkeeping
 * (allocate / hash / write the snapshot, move `currentRevision` / `headRevision`)
 * and the side effects (persist the record, register/unregister the Hub runner)
 * that a pure function can't.
 *
 * WHY this kills run-drift: every workflow gets a {@link HostDefinitionResolver}
 * bound to its in-memory entry. A `WorkflowRunner` constructed with that
 * resolver stamps `RunState.definitionRevision = resolver.current().revision`
 * at run start and, on resume, executes `resolver.byRevision(thatRevision)` —
 * the *exact* snapshot the run began under. Publishing a new revision only
 * moves the `currentRevision` pointer; in-flight / suspended runs keep
 * resolving their original revision. The runner stays registered on a stable
 * (frozen) trigger capability across publishes, so there is no Hub churn.
 *
 * Concurrency: a near-simultaneous double publish is bounded by the
 * `RevisionStore`'s write-once guarantee — the loser's `<head+1>.json` write
 * throws `revision_exists` rather than silently clobbering. Admin actions are
 * rare and HTTP-serialized, so we keep it at that (no extra lock).
 */

import type { Hub, ParticipantId } from '@aipehub/core'
import {
  FileLifecycleStore,
  FileRevisionStore,
  RunStore,
  WorkflowRunner,
  hashDefinition,
  isLiveState,
  legalActions,
  transition,
  workflowParticipantId,
  WorkflowLifecycleError,
  WorkflowRevisionError,
  type DefinitionResolver,
  type LifecycleAction,
  type LifecycleRecord,
  type LifecycleState,
  type LifecycleStore,
  type ResolvedDefinition,
  type RevisionMeta,
  type RevisionStore,
  type TransitionLog,
  type WorkflowDefinition,
} from '@aipehub/workflow'

/**
 * The Hub surface the service needs: register/unregister runners and check the
 * registry. The runner construction also needs `dispatch`, which the concrete
 * `Hub` provides — so we take the concrete type (the host already depends on
 * `@aipehub/core`) rather than re-declaring a structural subset.
 */
export type VersioningHub = Hub

export interface WorkflowVersioningOptions {
  hub: VersioningHub
  /** Space root — the two stores and per-runner `RunStore` live under it. */
  spaceRoot: string
  /** Override the revision store (default: file-backed). For tests / SQLite later. */
  revisions?: RevisionStore
  /** Override the lifecycle store (default: file-backed). */
  lifecycle?: LifecycleStore
  /** Clock injection for deterministic tests. */
  now?: () => number
}

/** A read-only projection of one workflow's lifecycle, for `getState`. */
export interface WorkflowLifecycleView {
  workflowId: string
  state: LifecycleState
  /** The revision a NEW run binds to. Absent for a never-published draft. */
  currentRevision?: number
  headRevision: number
  triggerCapability: string
  revisions: RevisionMeta[]
  history: TransitionLog[]
  /** Actions legal from the current state — drives the admin UI buttons. */
  legalActions: LifecycleAction[]
  /** Whether a runner is live on the Hub right now. */
  registered: boolean
}

/** Common `{by}` audit input for the transition methods. */
export interface ActorOpts {
  by?: string
}

/**
 * In-memory cache for one workflow. The resolver closes over THIS object (not a
 * snapshot of `record`), so reassigning `entry.record` on each transition makes
 * the resolver see the latest `currentRevision` synchronously — exactly what
 * `WorkflowRunner` needs at `handleTask` / `resumeRun` time.
 */
interface Entry {
  record: LifecycleRecord
  /** Every revision's frozen definition, in memory, so `byRevision` is sync. */
  defs: Map<number, WorkflowDefinition>
  resolver: HostDefinitionResolver
  /** Set while a runner is registered on the Hub; null when not live. */
  participantId: ParticipantId | null
}

/**
 * A {@link DefinitionResolver} backed by a live {@link Entry}. Synchronous: it
 * reads the in-memory `record.currentRevision` pointer and the pre-hydrated
 * `defs` map, never the disk. The service keeps both up to date.
 */
class HostDefinitionResolver implements DefinitionResolver {
  constructor(
    private readonly workflowId: string,
    private readonly entry: Entry,
  ) {}

  current(): ResolvedDefinition {
    const rev = this.entry.record.currentRevision
    if (rev === undefined) {
      throw new WorkflowRevisionError(
        `workflow '${this.workflowId}' has no published revision`,
        'no_current_revision',
      )
    }
    return { revision: rev, definition: this.byRevision(rev) }
  }

  byRevision(revision: number): WorkflowDefinition {
    const def = this.entry.defs.get(revision)
    if (!def) {
      throw new WorkflowRevisionError(
        `workflow '${this.workflowId}' revision ${revision} is not available`,
        'revision_missing',
      )
    }
    return def
  }
}

export class WorkflowVersioning {
  private readonly hub: VersioningHub
  private readonly spaceRoot: string
  private readonly revisions: RevisionStore
  private readonly lifecycle: LifecycleStore
  private readonly runStore: RunStore
  private readonly now: () => number
  private readonly entries = new Map<string, Entry>()

  constructor(opts: WorkflowVersioningOptions) {
    this.hub = opts.hub
    this.spaceRoot = opts.spaceRoot
    this.revisions = opts.revisions ?? new FileRevisionStore(opts.spaceRoot)
    this.lifecycle = opts.lifecycle ?? new FileLifecycleStore(opts.spaceRoot)
    this.runStore = new RunStore(opts.spaceRoot)
    this.now = opts.now ?? (() => Date.now())
    this.revisions.ensureDirs()
    this.lifecycle.ensureDirs()
  }

  // --- Boot / hydration ----------------------------------------------------

  /**
   * Load every persisted lifecycle record into memory and register a runner for
   * each live (published/deprecated) one. Call once at boot, BEFORE adopting
   * on-disk `definitions/*.yaml`, so an already-versioned workflow isn't
   * re-genesised. Idempotent.
   */
  async hydrate(): Promise<void> {
    const records = await this.lifecycle.list()
    for (const record of records) {
      await this.ensureLoaded(record.workflowId)
    }
  }

  /**
   * Adopt a definition as a published rev1 — the Model-B "import = immediately
   * live" path, also used at boot for each `definitions/<id>.yaml`. Idempotent:
   * if the workflow already has a lifecycle record, this is a no-op and the
   * possibly-different `def` is ignored (out-of-band YAML edit reconciliation is
   * out of scope this sprint). Registers the runner.
   */
  async adopt(def: WorkflowDefinition, opts: ActorOpts = {}): Promise<LifecycleRecord> {
    const existing = await this.ensureLoaded(def.id)
    if (existing) return existing.record
    return this.genesis(def, 'published', 'import', opts.by)
  }

  /**
   * Save a NEW workflow as a draft (explicit opt-in; NOT live). If the workflow
   * is already a draft, append the edited content as a new head revision (still
   * draft). Editing an already-published workflow is not a draft operation —
   * use {@link publish} (Model B: publish goes live). Throws
   * `illegal_transition` if the existing workflow isn't a draft.
   */
  async saveDraft(def: WorkflowDefinition, opts: ActorOpts = {}): Promise<LifecycleRecord> {
    const existing = await this.ensureLoaded(def.id)
    if (!existing) return this.genesis(def, 'draft', 'saveDraft', opts.by)

    if (existing.record.state !== 'draft') {
      throw new WorkflowLifecycleError(
        `cannot save a draft over a '${existing.record.state}' workflow — publish an edit instead`,
        'illegal_transition',
      )
    }
    this.assertCapability(existing.record, def)
    // No-op dedupe against the current head — re-saving identical content keeps
    // the same revision rather than burning a number.
    const headHash = metaFor(existing.record, existing.record.headRevision)?.contentHash
    if (headHash === hashDefinition(def)) return existing.record

    await this.appendRevision(existing, def, 'saveDraft', opts.by)
    existing.record = { ...existing.record, updatedAt: this.now() }
    await this.persist(existing)
    return existing.record
  }

  // --- Lifecycle transitions ----------------------------------------------

  /** draft → review. Frozen candidate; still not live. */
  async submitReview(id: string, opts: ActorOpts = {}): Promise<LifecycleRecord> {
    return this.flip(id, 'submitReview', opts.by)
  }

  /** review → draft. Send a candidate back for more editing. */
  async backToDraft(id: string, opts: ActorOpts = {}): Promise<LifecycleRecord> {
    return this.flip(id, 'backToDraft', opts.by)
  }

  /**
   * Publish — make a workflow live and point `currentRevision` at the content
   * to route to. Two shapes:
   *
   *   - `publish(id)` (no definition): promote the current head revision. Used
   *     for draft/review → published and deprecated → published (un-deprecate).
   *   - `publish(id, { definition })`: publish an EDIT. The capability must be
   *     unchanged (`capability_immutable` otherwise). If the content is
   *     identical to what's already current/head, it's a no-op publish (no new
   *     revision). Otherwise a new head revision is appended and becomes current.
   *
   * Legal from draft / review / published / deprecated (see the state machine).
   * Registers the runner.
   */
  async publish(
    id: string,
    opts: ActorOpts & { definition?: WorkflowDefinition } = {},
  ): Promise<LifecycleRecord> {
    const entry = await this.require(id)
    const at = this.now()
    const def = opts.definition

    if (def) this.assertCapability(entry.record, def)

    // Flip state first (pure; also enforces legality, e.g. archived → publish
    // throws `illegal_transition`). Revision bookkeeping happens after.
    let record = transition(entry.record, 'publish', actorInput(at, opts.by))

    let targetRev: number
    if (def) {
      const baseRev = entry.record.currentRevision ?? entry.record.headRevision
      const baseHash = metaFor(entry.record, baseRev)?.contentHash
      if (baseHash === hashDefinition(def)) {
        // No-op content: promote the existing revision, don't append.
        targetRev = baseRev
      } else {
        targetRev = await this.appendRevision(entry, def, 'publish', opts.by)
        // appendRevision mutated entry.record's revisions/headRevision — re-read.
        record = {
          ...record,
          revisions: entry.record.revisions,
          headRevision: entry.record.headRevision,
        }
      }
    } else {
      targetRev = record.headRevision
    }

    record = { ...record, currentRevision: targetRev }
    entry.record = record
    await this.persist(entry)
    this.syncRegistration(entry)
    return entry.record
  }

  /** published → deprecated. Soft sunset: stays live, hidden from `/me`. */
  async deprecate(id: string, opts: ActorOpts = {}): Promise<LifecycleRecord> {
    return this.flip(id, 'deprecate', opts.by)
  }

  /** deprecated → archived. Tombstone: unregister the runner. Terminal. */
  async archive(id: string, opts: ActorOpts = {}): Promise<LifecycleRecord> {
    return this.flip(id, 'archive', opts.by)
  }

  /**
   * Roll back the current published content to an earlier revision, audibly.
   * Append-only: the target revision's definition is CLONED as a new head
   * revision (`origin: 'rollback'`, `rolledBackFrom: target`) and becomes
   * current; the workflow stays published. So "current == revision K" shows up
   * as `hashDefinition(newRev) === hashDefinition(revK)`. Legal only from
   * published.
   */
  async rollback(
    id: string,
    opts: ActorOpts & { targetRevision: number },
  ): Promise<LifecycleRecord> {
    const entry = await this.require(id)
    const at = this.now()
    const target = opts.targetRevision
    const targetDef = entry.defs.get(target)
    if (!targetDef) {
      throw new WorkflowRevisionError(
        `workflow '${id}' has no revision ${target} to roll back to`,
        'revision_missing',
      )
    }

    // Flip state (pure; requires targetRevision, enforces published-only).
    let record = transition(
      entry.record,
      'rollback',
      { ...actorInput(at, opts.by), targetRevision: target },
    )
    const rev = await this.appendRevision(entry, targetDef, 'rollback', opts.by, target)
    record = {
      ...record,
      revisions: entry.record.revisions,
      headRevision: entry.record.headRevision,
      currentRevision: rev,
    }
    entry.record = record
    await this.persist(entry)
    this.syncRegistration(entry)
    return entry.record
  }

  // --- Reads ---------------------------------------------------------------

  /** Revision metadata for `id`, ascending. Throws `unknown_workflow` if absent. */
  async listRevisions(id: string): Promise<RevisionMeta[]> {
    const entry = await this.require(id)
    return [...entry.record.revisions].sort((a, b) => a.revision - b.revision)
  }

  /** Full lifecycle view for `id`. Throws `unknown_workflow` if absent. */
  async getState(id: string): Promise<WorkflowLifecycleView> {
    const entry = await this.require(id)
    const r = entry.record
    const view: WorkflowLifecycleView = {
      workflowId: r.workflowId,
      state: r.state,
      headRevision: r.headRevision,
      triggerCapability: r.triggerCapability,
      revisions: [...r.revisions],
      history: [...r.history],
      legalActions: legalActions(r.state),
      registered: entry.participantId !== null,
    }
    if (r.currentRevision !== undefined) view.currentRevision = r.currentRevision
    return view
  }

  /** The resolver for `id`, for callers that construct their own runner. */
  getResolver(id: string): DefinitionResolver | null {
    return this.entries.get(id)?.resolver ?? null
  }

  // --- Internals -----------------------------------------------------------

  /**
   * Create the genesis (rev1) record for a brand-new workflow in `state`. The
   * import / first-save is audited via `revisions[0].origin` + `createdAt`, so
   * `history` starts empty (there was no prior state to transition from).
   */
  private async genesis(
    def: WorkflowDefinition,
    state: LifecycleState,
    origin: 'import' | 'saveDraft',
    by?: string,
  ): Promise<LifecycleRecord> {
    const at = this.now()
    const meta: RevisionMeta = {
      revision: 1,
      contentHash: hashDefinition(def),
      createdAt: at,
      origin,
      ...(by !== undefined ? { createdBy: by } : {}),
    }
    await this.revisions.write({ ...meta, definition: def })
    const record: LifecycleRecord = {
      workflowId: def.id,
      state,
      // A draft has nothing published yet; a published genesis points at rev1.
      ...(state === 'published' ? { currentRevision: 1 } : {}),
      headRevision: 1,
      triggerCapability: def.trigger.capability,
      revisions: [meta],
      history: [],
      updatedAt: at,
    }
    await this.lifecycle.write(record)
    const entry = this.installEntry(record, new Map([[1, def]]))
    this.syncRegistration(entry)
    return record
  }

  /** Pure-transition helper for the actions that don't touch revisions. */
  private async flip(
    id: string,
    action: LifecycleAction,
    by?: string,
  ): Promise<LifecycleRecord> {
    const entry = await this.require(id)
    entry.record = transition(entry.record, action, actorInput(this.now(), by))
    await this.persist(entry)
    this.syncRegistration(entry)
    return entry.record
  }

  /**
   * Allocate the next head revision, write its immutable snapshot, and update
   * the entry's `revisions` / `headRevision` / `defs`. Does NOT touch `state` or
   * `currentRevision` (the caller does, after `transition()`).
   */
  private async appendRevision(
    entry: Entry,
    def: WorkflowDefinition,
    origin: RevisionMeta['origin'],
    by?: string,
    rolledBackFrom?: number,
  ): Promise<number> {
    const rev = entry.record.headRevision + 1
    const meta: RevisionMeta = {
      revision: rev,
      contentHash: hashDefinition(def),
      createdAt: this.now(),
      origin,
      ...(by !== undefined ? { createdBy: by } : {}),
      ...(rolledBackFrom !== undefined ? { rolledBackFrom } : {}),
    }
    await this.revisions.write({ ...meta, definition: def })
    entry.record = {
      ...entry.record,
      revisions: [...entry.record.revisions, meta],
      headRevision: rev,
    }
    entry.defs.set(rev, def)
    return rev
  }

  /** Reject a content change that would move the frozen trigger capability. */
  private assertCapability(record: LifecycleRecord, def: WorkflowDefinition): void {
    if (def.trigger.capability !== record.triggerCapability) {
      throw new WorkflowLifecycleError(
        `cannot change trigger.capability ('${record.triggerCapability}' → ` +
          `'${def.trigger.capability}') — it is frozen across revisions; ` +
          `import a new workflow id instead`,
        'capability_immutable',
      )
    }
  }

  /** Register if the state is live and we aren't yet; unregister if the reverse. */
  private syncRegistration(entry: Entry): void {
    const live = isLiveState(entry.record.state)
    if (live && !entry.participantId) {
      this.registerRunner(entry)
    } else if (!live && entry.participantId) {
      this.hub.unregister(entry.participantId)
      entry.participantId = null
    }
  }

  private registerRunner(entry: Entry): void {
    if (entry.participantId) return
    const participantId = workflowParticipantId(entry.record.workflowId)
    // Defensive: if some other boot path already registered this id, adopt it
    // rather than throwing on a duplicate register. (M5 wires a single path.)
    if (this.hub.registry.get(participantId)) {
      entry.participantId = participantId
      return
    }
    const { definition } = entry.resolver.current()
    const runner = new WorkflowRunner({
      definition,
      hub: this.hub,
      runStore: this.runStore,
      resolver: entry.resolver,
    })
    this.hub.register(runner)
    entry.participantId = participantId
  }

  /** Build the in-memory entry + its resolver and index it. */
  private installEntry(record: LifecycleRecord, defs: Map<number, WorkflowDefinition>): Entry {
    // The resolver needs a live reference to the entry; build the entry first
    // with a placeholder, then attach. (Self-referential init — honest cast.)
    const entry: Entry = {
      record,
      defs,
      participantId: null,
      resolver: undefined as unknown as HostDefinitionResolver,
    }
    entry.resolver = new HostDefinitionResolver(record.workflowId, entry)
    this.entries.set(record.workflowId, entry)
    return entry
  }

  /** Load an entry from memory, or hydrate it from the stores. Null if absent. */
  private async ensureLoaded(id: string): Promise<Entry | null> {
    const inMem = this.entries.get(id)
    if (inMem) return inMem
    const record = await this.lifecycle.read(id)
    if (!record) return null
    const defs = new Map<number, WorkflowDefinition>()
    for (const meta of record.revisions) {
      const rev = await this.revisions.read(id, meta.revision)
      if (rev) defs.set(meta.revision, rev.definition)
    }
    const entry = this.installEntry(record, defs)
    this.syncRegistration(entry)
    return entry
  }

  private async require(id: string): Promise<Entry> {
    const entry = await this.ensureLoaded(id)
    if (!entry) {
      throw new WorkflowLifecycleError(`unknown workflow '${id}'`, 'unknown_workflow')
    }
    return entry
  }

  private async persist(entry: Entry): Promise<void> {
    await this.lifecycle.write(entry.record)
  }
}

function metaFor(record: LifecycleRecord, rev: number): RevisionMeta | undefined {
  return record.revisions.find((m) => m.revision === rev)
}

function actorInput(at: number, by?: string): { at: number; by?: string } {
  return by !== undefined ? { at, by } : { at }
}
