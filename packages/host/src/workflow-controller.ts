/**
 * `WorkflowController` — bridge between `@gotong/web`'s admin HTTP API and the
 * `@gotong/workflow` runtime, now mediated by {@link WorkflowVersioning}.
 *
 * Implements the `WorkflowSurface` duck type the Web layer declares so the Web
 * package itself doesn't take a runtime dep on the workflow runtime.
 *
 * Since Phase 15 the controller does NOT construct or register runners itself —
 * `WorkflowVersioning` is the single authority that owns each workflow's
 * lifecycle state + immutable revisions and keeps the right resolver-backed
 * runner registered on the Hub. The controller's remaining jobs are:
 *
 *   - persist the editable YAML mirror under `definitions/<id>.yaml`
 *   - drive lifecycle transitions (import / saveDraft / publish / deprecate /
 *     archive / rollback …) by delegating to the versioning service
 *   - project the versioning state + the current revision's definition into the
 *     `WorkflowSummary` shape the admin UI consumes
 *   - the run-history read endpoints (a thin wrapper over `RunStore`)
 *
 * `importFromText` keeps the Model-B semantics "import = immediately live": it
 * writes the YAML atomically and `adopt`s the definition as a published rev1.
 * `list()` returns only the LIVE (published/deprecated) workflows — a saved
 * draft is intentionally absent until it's published.
 */

import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createLogger, extractRequiredCapabilities, type Hub, type HubLink } from '@gotong/core'
import { NEVER_RESUME_AT } from '@gotong/inbox'

import { scrubSecrets } from './scrub-secrets.js'

const log = createLogger('workflow-ctl')
import {
  RunStore,
  WorkflowRunner,
  WorkflowLifecycleError,
  parseWorkflow,
  projectWorkflowGraph,
  workflowParticipantId,
  type ArchiveRunsOptions,
  type DispatchSpec,
  type GraphNodeCrossHub,
  type LifecycleState,
  type RevisionMeta,
  type RunState,
  type RunStatusCounts,
  type RunSummary,
  type Step,
  type StepRecord,
  type WorkflowDefinition,
  type WorkflowGraphView,
} from '@gotong/workflow'
import {
  checkWorkflowStructure,
  type WorkflowInventory,
  type WorkflowStructureViolation,
} from '@gotong/evals/checkers/workflow-structure'

import type { LoadReport } from './workflow-loader.js'
import { assertNoSelfTriggerCycle } from './workflow-guards.js'
import {
  WorkflowVersioning,
  type WorkflowLifecycleView,
} from './workflow-versioning.js'
import { fetchPeerTranscript, type PeerTranscriptSlice } from './peer-transcript.js'
import type { CrossHubMarkerStore } from './cross-hub-marker.js'

export interface WorkflowSummary {
  id: string
  participantId: string
  name?: string
  description?: string
  triggerCapability: string
  /**
   * Optional UI form schema, lifted from the workflow definition's
   * `trigger.payloadSchema`. When present, the admin UI renders a
   * workflow-specific dispatch form instead of the generic JSON textarea.
   * Pass-through; the host doesn't enforce shape (the parser already did).
   */
  payloadSchema?: unknown
  /**
   * Pass-through of the workflow definition's `surface.me` block (Phase 14),
   * when present. The web layer derives the member-facing `/me` catalog from
   * this. `unknown` here so the host stays a dumb pipe.
   */
  surfaceMe?: unknown
  /**
   * Pass-through of the workflow definition's `governance` block (Phase 19 P5),
   * when present. The web layer renders it as a risk summary before import /
   * publish. `unknown` here so the host stays a dumb pipe.
   */
  governance?: unknown
  stepCount: number
  file: string | null
  /** Phase 15 — lifecycle state of this workflow. */
  state: LifecycleState
  /**
   * Phase 15 — the revision NEW runs bind to. Absent only for a workflow that
   * has never been published (a pure draft).
   */
  currentRevision?: number
  /**
   * Stream G day-2 / H — steps whose dispatch asks for a capability that an
   * OFF-HUB destination serves (and that no local participant does), i.e. they
   * leave the hub: a connected mesh peer (`kind:'peer'`, Stream G) or an
   * external A2A agent (`kind:'a2a'`, Stream H). Present (non-empty) only when
   * the controller is wired with an off-hub capability view AND the definition
   * actually has such a step. The admin UI uses this to warn — before launch —
   * "this step goes to <x>" (a mesh peer may gate it → inbox approval; an A2A
   * agent fires immediately). Pure visibility; the dispatch itself is unchanged.
   */
  crossHubSteps?: CrossHubStep[]
}

/** One workflow step that dispatches OFF this hub — to a peer hub or an external A2A agent. */
export interface CrossHubStep {
  /** The step id (or `${stepId}/${branchId}` for a parallel branch). */
  stepId: string
  /** The capability that no LOCAL participant serves — only an off-hub destination. */
  capability: string
  /** The destination's id (the peer wrapper id, or the outbound A2A agent id). */
  peer: string
  /** The destination's human label, when set. */
  peerLabel: string | null
  /**
   * What kind of off-hub destination this step reaches:
   *   - `'peer'` — a connected MESH peer (Gotong↔Gotong). It may carry an
   *     outbound approval gate, so the step can pause for inbox approval.
   *   - `'a2a'` — an EXTERNAL A2A agent (the Phase 18 C-M4 outbound edge). It
   *     fires immediately; there is no approval gate.
   * Optional for back-compat (absent ⇒ treat as `'peer'`); the producer always sets it.
   */
  kind?: 'peer' | 'a2a'
}

/**
 * v5 Stream G day-3 — the post-launch CONFIRMATION counterpart to
 * {@link CrossHubStep} (which is the pre-launch PREDICTION). Where `CrossHubStep`
 * says "this step WILL go off-hub" from static analysis of the definition,
 * `CrossHubStepRef` says "this step DID run off-hub", resolved from the run's
 * persisted, peer-agnostic `executedBy` participant id. Derived at READ time —
 * never written back to the run file — so the same run reads as a local hop or a
 * peer hop purely from the live federation view, and the workflow package stays
 * federation-blind.
 */
export interface CrossHubStepRef {
  /** The off-hub destination's participant id (== the persisted `StepRecord.executedBy`). */
  peer: string
  /** The destination's human label, when the off-hub view carries one. */
  peerLabel: string | null
  /** Whether the destination is a connected mesh peer or an external A2A agent. */
  kind: 'peer' | 'a2a'
}

/** A persisted run step plus the host's read-time cross-hub annotation (absent for local hops). */
export interface EnrichedStepRecord extends StepRecord {
  /** Set only when this step's `executedBy` resolves to an off-hub destination. */
  crossHub?: CrossHubStepRef
  /**
   * PB — the parallel analog of {@link crossHub}: each fan-out branch resolves its
   * own `branchExecutedBy[branchId]` independently, so one parallel step can have
   * some branches off-hub and some local. Keyed by branch id; only off-hub
   * branches appear (a local branch is simply absent, never a null entry).
   */
  branchCrossHub?: Record<string, CrossHubStepRef>
}

/** A {@link RunState} whose steps carry the host's read-time cross-hub annotations. */
export interface EnrichedRunState extends Omit<RunState, 'steps'> {
  steps: EnrichedStepRecord[]
}

/**
 * The off-hub capability view the controller consults to flag steps that leave
 * the hub. Duck-typed and OPTIONAL: a controller built without it (the common
 * single-hub case) flags nothing — zero behavior change. The host builds this
 * from two sources, each an entry carrying its `kind`:
 *   - connected MESH peers joined with each wrapper's advertised capabilities
 *     (Stream G G-M1: advertise == authorize) → `kind:'peer'`,
 *   - live EXTERNAL A2A agents (the C-M4 outbound edge) → `kind:'a2a'`.
 */
export interface PeerCapabilityView {
  peerCapabilities(): Array<{
    peer: string
    label: string | null
    capabilities: readonly string[]
    /** Off-hub destination kind; defaults to `'peer'` when omitted. */
    kind?: 'peer' | 'a2a'
  }>
}

/**
 * v5 Stream G day-5 — the result of asking a peer for the transcript of one
 * cross-hub step. A discriminated verdict so the web route maps cleanly to HTTP
 * without the controller throwing for the EXPECTED non-success cases (a same-hub
 * step, a disconnected peer, a peer that hasn't opted into sharing). Only a
 * genuinely-missing run/step is a 404; the soft cases render an inline note.
 *
 *   - `unknown_run` / `unknown_step` — no such run / step on disk → 404.
 *   - `not_cross_hub`  — the step never crossed a boundary (no `peerTaskId`),
 *     so there is no off-hub trace to fetch.
 *   - `no_link`        — no peer-link resolver wired (single-hub host) OR the
 *     peer is configured-but-not-connected right now.
 *   - `fetch_failed`   — the link rejected the `peer.transcript` rpc. The most
 *     common cause is the far hub NOT opting into sharing (its gate throws);
 *     the message carries the peer's reason verbatim.
 */
export type PeerStepTranscriptResult =
  | { ok: true; slice: PeerTranscriptSlice }
  | {
      ok: false
      code: 'unknown_run' | 'unknown_step' | 'not_cross_hub' | 'no_link' | 'fetch_failed'
      message: string
    }

export interface WorkflowControllerOptions {
  hub: Hub
  /**
   * Directory where uploaded workflows are persisted (the editable YAML
   * mirror). Same place the boot-time loader scans, so a restart re-adopts
   * everything the admin imported through the UI.
   */
  definitionsDir: string
  /**
   * Space root path. Backs the shared `RunStore` and (by default) the
   * `WorkflowVersioning` stores under `<spaceRoot>/workflows/`.
   */
  spaceRoot: string
  /** Injectable versioning service. Default: file-backed over `spaceRoot`. */
  versioning?: WorkflowVersioning
  /**
   * Stream G day-2 — optional connected-peer capability view. When present, the
   * controller annotates each summary with its `crossHubSteps`. Absent ⇒ no
   * cross-hub flags (single-hub deployments pay nothing).
   */
  peerCapabilities?: PeerCapabilityView
  /**
   * Stream G day-5 — optional resolver from a peer-hub id to its live `HubLink`,
   * used by {@link WorkflowController.fetchPeerStepTranscript} to pull a peer's
   * transcript of one cross-hub step on demand. Read LAZILY (a forward-declared
   * ref in the host); absent ⇒ no off-hub transcript chain (single-hub hosts
   * return `no_link`). The id passed is a step's `executedBy`, which for a mesh
   * hop equals the peer-hub wire id `linkForHub` expects.
   */
  peerLinkResolver?: (peerId: string) => HubLink | null
  /**
   * WFEDIT-S2 — optional sticky cross-hub marker store. When present, every
   * write/transition records (monotonic union) the capabilities currently
   * leaving this workflow off-hub, so the member edit boundary lock stays in
   * force even when the destination peer is offline at edit time. Absent ⇒ no
   * capture (single-hub hosts and tests pay nothing).
   */
  crossHubMarkers?: CrossHubMarkerStore
}

/**
 * Build a controller and adopt whatever the boot-time loader parsed. After this
 * the controller (via its versioning service) is the source of truth for "what
 * workflows are live in this Hub right now".
 *
 * Adoption is idempotent: a workflow that already has a persisted lifecycle
 * record (a normal restart) keeps its state (a draft stays a draft, an archived
 * one stays archived); a brand-new YAML with no record is published as rev1.
 */
export async function createWorkflowController(
  opts: WorkflowControllerOptions,
  bootReport: LoadReport,
): Promise<WorkflowController> {
  const c = new WorkflowController(opts)
  for (const w of bootReport.loaded) {
    await c.adoptAtBoot(w.definition, w.file)
  }
  return c
}

export class WorkflowController {
  readonly versioning: WorkflowVersioning
  private readonly hub: Hub
  private readonly definitionsDir: string
  private readonly spaceRoot: string
  /**
   * Shared `RunStore` for the read-side endpoints (history list / detail).
   * Writes happen through each runner's own store, but they all point at the
   * same directory, so one shared reader sees everything.
   */
  private readonly runStore: RunStore
  /**
   * id → the editable YAML mirror path. The versioning service owns lifecycle
   * truth; this map only carries the file path the UI shows / `remove` deletes.
   */
  private readonly known = new Map<string, { file: string | null }>()
  /** Stream G day-2 — connected-peer caps for cross-hub-step flags (optional). */
  private readonly peerCapabilities?: PeerCapabilityView
  /** Stream G day-5 — peer-hub id → live HubLink, for the off-hub transcript chain (optional). */
  private readonly peerLinkResolver?: (peerId: string) => HubLink | null
  /** WFEDIT-S2 — sticky cross-hub marker store; captured on every write/transition (optional). */
  private readonly crossHubMarkers?: CrossHubMarkerStore

  constructor(opts: WorkflowControllerOptions) {
    this.hub = opts.hub
    this.definitionsDir = opts.definitionsDir
    this.spaceRoot = opts.spaceRoot
    this.runStore = new RunStore(opts.spaceRoot)
    this.peerCapabilities = opts.peerCapabilities
    this.peerLinkResolver = opts.peerLinkResolver
    this.crossHubMarkers = opts.crossHubMarkers
    this.versioning =
      opts.versioning ??
      new WorkflowVersioning({ hub: opts.hub, spaceRoot: opts.spaceRoot })
  }

  /** Called by `createWorkflowController` for each boot-time parsed workflow. */
  async adoptAtBoot(definition: WorkflowDefinition, file: string | null): Promise<void> {
    await this.versioning.adopt(definition)
    this.known.set(definition.id, { file })
  }

  /** The LIVE (registered) workflows, projected into the UI summary shape. */
  async list(): Promise<WorkflowSummary[]> {
    const out: WorkflowSummary[] = []
    for (const [id, { file }] of this.known) {
      let view: WorkflowLifecycleView
      try {
        view = await this.versioning.getState(id)
      } catch {
        // Record vanished out from under us (e.g. a concurrent remove) — skip.
        continue
      }
      // Drafts / review / archived aren't live → not in the workflow list.
      if (!view.registered) continue
      out.push(this.summaryFromView(id, file, view))
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return out
  }

  /**
   * Every known workflow — live AND non-live (draft / review / archived) —
   * projected into the UI summary shape. This is the admin operator's full
   * view: unlike {@link list} (live only), it's what makes a saved draft
   * discoverable + publishable and keeps an archived tombstone inspectable
   * (its revision history survives). Ordered running-first → authoring →
   * archived, then by id, so the workflows actually serving traffic stay on top.
   *
   * The `/me` member surface never calls this — it keeps the live-only `list`.
   */
  async listAll(): Promise<WorkflowSummary[]> {
    const out: WorkflowSummary[] = []
    for (const [id, { file }] of this.known) {
      let view: WorkflowLifecycleView
      try {
        view = await this.versioning.getState(id)
      } catch {
        // Record vanished out from under us (concurrent remove) — skip.
        continue
      }
      out.push(this.summaryFromView(id, file, view))
    }
    out.sort((a, b) => {
      const ra = STATE_RANK[a.state] ?? 99
      const rb = STATE_RANK[b.state] ?? 99
      return ra !== rb ? ra - rb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    return out
  }

  /**
   * List recorded workflow runs from disk. Pass `workflowId` to filter to one
   * workflow; pass `limit` to cap the result count (newest first).
   */
  async listRuns(opts?: { workflowId?: string; limit?: number }): Promise<RunSummary[]> {
    return this.runStore.listRuns(opts)
  }

  /**
   * List runs initiated by one user (newest first) — backs the `/me` member
   * workbench's "my recent runs". Same projection as {@link listRuns} but
   * scoped to `triggeredByOrigin.userId` (the attribution `/api/me/dispatch`
   * stamps), so a member sees only the runs they kicked off.
   *
   * ease-of-use ❶-M2: a failed run's `error` (the wrapped provider error) is
   * shown to the member so the `/me` recent-runs row can explain WHY it failed
   * (the frontend runs it through `describeError`). Because that string can echo
   * a provider request — and a member must never read another participant's key
   * off a shared run row — the host scrubs it here, at the member-facing seam.
   * The admin run-detail path (`readRun`) keeps full fidelity: operators see the
   * raw error.
   */
  async listRunsByUser(
    userId: string,
    opts?: { workflowId?: string; limit?: number },
  ): Promise<RunSummary[]> {
    const rows = await this.runStore.listByUser(userId, opts)
    return rows.map((r) =>
      r.error === undefined ? r : { ...r, error: scrubSecrets(r.error) },
    )
  }

  /**
   * Load the full run state for one run, or `null` if no such run is recorded.
   *
   * v5 Stream G day-3 — each step is enriched at READ time with `crossHub` when
   * its persisted, peer-agnostic `executedBy` resolves to an off-hub destination
   * in the live federation view. This is the post-launch CONFIRMATION of where a
   * step actually ran (the run history's counterpart to the pre-launch
   * `crossHubSteps` prediction on a workflow summary). The on-disk run file is
   * never touched — `enrichRunCrossHub` clones the steps it annotates — so the
   * annotation tracks the CURRENT federation view, and a single-hub controller
   * (no off-hub view) returns the state verbatim at zero cost.
   */
  async readRun(runId: string): Promise<EnrichedRunState | null> {
    const run = await this.runStore.read(runId)
    if (!run) return null
    return this.enrichRunCrossHub(run)
  }

  /**
   * Annotate a run's steps with the off-hub destination each one ran on, derived
   * from `StepRecord.executedBy` (a bare participant id) against the live off-hub
   * capability view. Returns the state unchanged (only re-typed) when no off-hub
   * view is wired or no step has a resolvable `executedBy`, and never mutates the
   * input — only steps that gain a `crossHub` are shallow-cloned.
   */
  private enrichRunCrossHub(run: RunState): EnrichedRunState {
    if (!this.peerCapabilities) return run
    const entries = this.peerCapabilities.peerCapabilities()
    if (entries.length === 0) return run
    // peer id → label/kind. First entry wins a duplicate id (deterministic).
    const byPeer = new Map<string, { label: string | null; kind: 'peer' | 'a2a' }>()
    for (const e of entries) {
      if (!byPeer.has(e.peer)) byPeer.set(e.peer, { label: e.label, kind: e.kind ?? 'peer' })
    }
    const resolve = (id: string): CrossHubStepRef | undefined => {
      const hit = byPeer.get(id)
      return hit ? { peer: id, peerLabel: hit.label, kind: hit.kind } : undefined
    }
    const steps: EnrichedStepRecord[] = run.steps.map((s) => {
      // Simple step: a single `executedBy` resolves to one off-hub destination.
      const stepRef = s.executedBy ? resolve(s.executedBy) : undefined
      // Parallel step (PB): each branch's `executedBy` resolves on its own, so a
      // fan-out can mix off-hub and local branches in the same step.
      let branchCrossHub: Record<string, CrossHubStepRef> | undefined
      if (s.branchExecutedBy) {
        for (const [branchId, by] of Object.entries(s.branchExecutedBy)) {
          const ref = resolve(by)
          if (ref) (branchCrossHub ??= {})[branchId] = ref
        }
      }
      if (!stepRef && !branchCrossHub) return s
      const enriched: EnrichedStepRecord = { ...s }
      if (stepRef) enriched.crossHub = stepRef
      if (branchCrossHub) enriched.branchCrossHub = branchCrossHub
      return enriched
    })
    return { ...run, steps }
  }

  /**
   * v5 Stream G day-5 — fetch the executing peer's transcript of ONE cross-hub
   * step, on demand. This is the post-launch transcript CHAIN: day-3 records WHO
   * ran a step (`executedBy`) and the result; this pulls the far hub's own trace
   * of that one task so run detail can show what the off-hub agent actually did.
   *
   * The correlation is the persisted, peer-agnostic pair on the StepRecord:
   * `executedBy` (the peer-hub wire id `linkForHub` keys on for a mesh hop) +
   * `peerTaskId` (the id the far hub recorded the task under). We resolve the
   * link, then call the opt-in `peer.transcript` rpc; the far hub's gate rejects
   * unless it shares (`share_transcript`), surfaced here as `fetch_failed` with
   * the peer's reason. Never throws for an expected miss — returns a verdict.
   *
   * Only mesh peers answer this (A2A external agents have no HubLink / rpc), and
   * naturally so: an A2A `executedBy` isn't in the peer registry, so the resolver
   * returns null → `no_link`.
   *
   * PB — pass `branchId` to fetch ONE branch of a parallel step: the executor +
   * handle then come from the per-branch maps (`branchExecutedBy[branchId]` /
   * `branchPeerTaskIds[branchId]`) instead of the step-level fields. A simple step
   * (or the parallel step as a whole) omits `branchId`. A `branchId` that names a
   * local branch (or no branch) resolves to `not_cross_hub`, same as a same-hub
   * simple step; the UI only offers this affordance for branches that enrichment
   * flagged with a `branchCrossHub` ref, so it never asks for a local branch.
   */
  async fetchPeerStepTranscript(
    runId: string,
    stepId: string,
    branchId?: string,
  ): Promise<PeerStepTranscriptResult> {
    const run = await this.runStore.read(runId)
    if (!run) return { ok: false, code: 'unknown_run', message: `unknown run '${runId}'` }
    const step = run.steps.find((s) => s.stepId === stepId)
    if (!step) {
      return { ok: false, code: 'unknown_step', message: `unknown step '${stepId}' in run '${runId}'` }
    }
    // A same-hub step (or branch) never relabelled its result, so there is no
    // off-hub task to correlate. Require BOTH the peer id and the opaque handle —
    // for a parallel branch they live in the per-branch maps; for a simple step
    // in the step-level fields.
    const executedBy = branchId !== undefined ? step.branchExecutedBy?.[branchId] : step.executedBy
    const peerTaskId = branchId !== undefined ? step.branchPeerTaskIds?.[branchId] : step.peerTaskId
    if (!executedBy || !peerTaskId) {
      return {
        ok: false,
        code: 'not_cross_hub',
        message:
          branchId !== undefined
            ? `branch '${branchId}' of step '${stepId}' did not cross a hub boundary (no peer task handle recorded)`
            : 'this step did not cross a hub boundary (no peer task handle recorded)',
      }
    }
    if (!this.peerLinkResolver) {
      return { ok: false, code: 'no_link', message: 'no peer-link resolver wired (single-hub host)' }
    }
    const link = this.peerLinkResolver(executedBy)
    if (!link) {
      return {
        ok: false,
        code: 'no_link',
        message: `peer '${executedBy}' is not connected`,
      }
    }
    try {
      const slice = await fetchPeerTranscript(link, peerTaskId)
      if (!slice) {
        return { ok: false, code: 'fetch_failed', message: 'peer returned no transcript' }
      }
      return { ok: true, slice }
    } catch (err) {
      // The far hub's per-link gate throws when it hasn't opted into sharing;
      // a closed link throws too. Surface the reason; the UI renders it inline.
      return { ok: false, code: 'fetch_failed', message: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Route B P0-M3-M3 — exact count of active runs by status (archived excluded).
   * Backs the `/metrics` workflow-run gauges with a real tally rather than the
   * old 2000-row sample; the scan is O(active), which run retention bounds.
   */
  async countRuns(opts?: { workflowId?: string }): Promise<RunStatusCounts> {
    return this.runStore.countRuns(opts)
  }

  /**
   * Route B P0-M3-M2 — prune old TERMINAL runs into `runs/archive/`, bounding
   * the active scan that {@link resumeRunningRuns} / {@link listRuns} / metrics
   * walk. Delegates to the owned `RunStore`; a `running` run is never moved, so
   * this is safe to call right before the boot resume scan. Returns the run ids
   * archived this call. Empty options are a no-op.
   */
  async archiveRuns(opts: ArchiveRunsOptions): Promise<string[]> {
    return this.runStore.archiveRuns(opts)
  }

  /**
   * Scan the on-disk run history and resume any run whose recorded status is
   * still `'running'`. Typical use: called once during host boot, right after
   * the controller adopts (and the versioning service registers) the runners. A
   * normal shutdown leaves no `'running'` files behind; one that's still there
   * is the trace of a crash / kill-9 / power loss.
   *
   * For each crashed run:
   *   - if the matching runner is live on the Hub, kick off `resumeRun(state)`
   *     (fire-and-forget so a long resume doesn't block boot). The runner is
   *     resolver-backed, so it resumes on the EXACT revision the run started
   *     under (`state.definitionRevision`) — no drift onto newer logic.
   *   - if the workflow is no longer live (removed / archived), mark the run
   *     `'failed'` and persist it so the history view stops showing a stale
   *     "running" forever.
   *
   * Returns the count of runs resumed, plus the count abandoned.
   */
  async resumeRunningRuns(): Promise<{ resumed: number; abandoned: number; parked: number }> {
    const all = await this.runStore.listRuns()
    let resumed = 0
    let abandoned = 0
    let parked = 0
    for (const summary of all) {
      if (summary.status !== 'running') continue
      const state = await this.runStore.read(summary.runId)
      if (!state) continue
      // Audit M5 — a run parked on a human-inbox step is still `status:
      // 'running'` (RunStatus has no run-level 'suspended'); its suspended
      // step carries `resumeAt === NEVER_RESUME_AT`. Such a run is resumed
      // EXCLUSIVELY by the inbox-resolve path (which reads the parked task's
      // own persistent suspended_tasks row), not by boot. Re-driving it here
      // would redundantly re-read the unresolved child + re-suspend, and risks
      // racing the resolve. Leave it parked.
      if (isParkedIndefinitely(state)) {
        parked++
        continue
      }
      const participant = this.hub.registry.get(workflowParticipantId(summary.workflowId))
      if (!participant || !(participant instanceof WorkflowRunner)) {
        // Workflow no longer live — close out the run so it doesn't sit in
        // history forever pretending to still be running.
        state.status = 'failed'
        state.endedAt = Date.now()
        state.error =
          state.error ??
          `host restarted while running and workflow '${summary.workflowId}' is no longer loaded`
        await this.runStore.write(state)
        abandoned++
        continue
      }
      // We do NOT await: a long-tail resume shouldn't block boot. Errors are
      // logged because there's no caller to bubble them to.
      participant.resumeRun(state).catch((err) => {
        log.error('resume of run threw', { runId: summary.runId, err })
      })
      resumed++
    }
    return { resumed, abandoned, parked }
  }

  /**
   * Fully remove a workflow: unregister its runner, delete its lifecycle record
   * + revision snapshots, and delete the YAML mirror. In-flight tasks already
   * dispatched are NOT cancelled (the Hub lets them finish); future invocations
   * of the trigger capability get `no_participant`.
   */
  async remove(id: string): Promise<void> {
    const entry = this.known.get(id)
    if (!entry) {
      throw new Error(`workflow '${id}' is not loaded`)
    }
    await this.versioning.removeWorkflow(id)
    if (entry.file) {
      try { unlinkSync(entry.file) } catch { /* the user can rm it manually */ }
    }
    this.known.delete(id)
  }

  // --- import / lifecycle drivers -----------------------------------------

  /**
   * P2-M1 — runtime-aware structural gate. Runs `checkWorkflowStructure` against
   * a live inventory (every registered participant's capabilities) and throws on
   * violations that would break the workflow. The complement to
   * `assertNoSelfTriggerCycle` (self-trigger only): this also catches bad/forward
   * step `$ref`s and explicit dispatch at agents that don't exist — things
   * `parseWorkflow` accepts but the runner would choke on.
   *
   * Grading (see {@link isBlockingViolation}):
   *   🔴 HARD — pure structural bugs no later agent registration can fix; reject
   *      on EVERY write path (import / draft / publish):
   *      `bad_ref` / `forward_ref` / `self_trigger_cycle` / `id_collision`.
   *   🟡 `unknown_agent` — explicit `strategy.to` at an unregistered id. Likely a
   *      typo but might be cross-hub → block a deliberate go-live (`blockWarnings`
   *      = import / publish), tolerate on a draft.
   *   ⚪ `unknown_capability` — ADVISORY only, never throws: importing a workflow
   *      before its agents exist is a legitimate ordering (the bundle path; the
   *      "no_participant until an agent registers" runtime self-heals). It still
   *      rides along in the deep-check result the web layer surfaces.
   *
   * NOT called from `adoptAtBoot`: boot agent-registration order is undefined, so
   * a boot-time check would false-fail on a workflow whose agents merely haven't
   * registered yet. Interactive-write-only.
   *
   * `id_collision` is not surfaced here — `importFromText` rejects a duplicate id
   * up front and publish/saveDraft act on an existing id — so no
   * `existingWorkflowIds` is passed (it would self-collide on every re-save).
   */
  private assertStructurallySound(
    def: WorkflowDefinition,
    opts: { blockWarnings: boolean },
  ): void {
    const inventory: WorkflowInventory = {
      agents: this.hub.participants().map((p) => ({
        id: p.id,
        capabilities: [...p.capabilities],
      })),
    }
    const { violations } = checkWorkflowStructure(def, inventory)
    const blocking = violations.filter((v) => isBlockingViolation(v.kind, opts.blockWarnings))
    if (blocking.length === 0) return
    const detail = blocking.map((v) => `${v.kind} @ ${v.path}: ${v.message}`).join('; ')
    const err = new WorkflowLifecycleError(
      `workflow '${def.id}' failed structural check — ${detail}`,
      'structure_check_failed',
    )
    // Attach the structured violations so the web layer can echo them to the
    // admin UI deep-check panel instead of only a flat message string.
    ;(err as { violations?: WorkflowStructureViolation[] }).violations = blocking
    throw err
  }

  /**
   * Model-B import: parse, write the YAML atomically, and `adopt` as a published
   * rev1 (immediately live). Rejects a duplicate id — delete it first.
   */
  async importFromText(text: string): Promise<WorkflowSummary> {
    const def = parseWorkflow(text)
    assertNoSelfTriggerCycle(def)
    // Import = go live → block hard violations AND warnings (unknown_agent).
    this.assertStructurallySound(def, { blockWarnings: true })
    if (await this.versioning.has(def.id)) {
      throw new Error(
        `workflow id '${def.id}' is already loaded — delete it first (v0.1 does not support re-import).`,
      )
    }
    const filePath = await this.writeDefinitionFile(def, text)
    try {
      await this.versioning.adopt(def)
    } catch (err) {
      try { unlinkSync(filePath) } catch { /* ignore */ }
      throw err
    }
    this.known.set(def.id, { file: filePath })
    return this.summary(def.id)
  }

  /**
   * Save a workflow as a DRAFT (explicit opt-in; not live). Legal for a new id
   * or an existing draft (the versioning service rejects saving a draft over a
   * published workflow — publish an edit instead).
   */
  async saveDraft(text: string, opts: { by?: string } = {}): Promise<WorkflowSummary> {
    const def = parseWorkflow(text)
    assertNoSelfTriggerCycle(def)
    // Draft = not live → block hard violations but TOLERATE `unknown_agent`
    // (the author may add the agent before publishing). Publish re-checks.
    this.assertStructurallySound(def, { blockWarnings: false })
    const existed = await this.versioning.has(def.id)
    const filePath = await this.writeDefinitionFile(def, text)
    try {
      await this.versioning.saveDraft(def, opts)
    } catch (err) {
      // Only clean up a file we just created; an existing workflow's mirror stays.
      if (!existed) {
        try { unlinkSync(filePath) } catch { /* ignore */ }
      }
      throw err
    }
    this.known.set(def.id, { file: filePath })
    return this.summary(def.id)
  }

  /**
   * Publish a workflow. With `text`, publish that edited content as a new
   * revision (and refresh the YAML mirror); without it, promote the current
   * head (draft/review/deprecated → published).
   */
  async publish(
    id: string,
    opts: { text?: string; by?: string } = {},
  ): Promise<WorkflowSummary> {
    if (opts.text !== undefined) {
      const def = parseWorkflow(opts.text)
      assertNoSelfTriggerCycle(def)
      if (def.id !== id) {
        throw new Error(`workflow id mismatch: body declares '${def.id}', expected '${id}'`)
      }
      // Publish = go live → block hard violations AND warnings.
      this.assertStructurallySound(def, { blockWarnings: true })
      await this.writeDefinitionFile(def, opts.text)
      await this.versioning.publish(id, {
        definition: def,
        ...(opts.by !== undefined ? { by: opts.by } : {}),
      })
      this.known.set(id, { file: join(this.definitionsDir, `${sanitiseFileBase(id)}.yaml`) })
    } else {
      // No new text — promoting the current head to live. Deep-check the head
      // definition too: a draft may have been saved WITH an `unknown_agent`
      // warning (allowed), but going live must still block it.
      const headDef = await this.versioning.headDefinition(id)
      this.assertStructurallySound(headDef, { blockWarnings: true })
      await this.versioning.publish(id, opts.by !== undefined ? { by: opts.by } : {})
    }
    return this.summary(id)
  }

  async submitReview(id: string, opts: { by?: string } = {}): Promise<WorkflowSummary> {
    await this.versioning.submitReview(id, opts)
    return this.summary(id)
  }

  async backToDraft(id: string, opts: { by?: string } = {}): Promise<WorkflowSummary> {
    await this.versioning.backToDraft(id, opts)
    return this.summary(id)
  }

  async deprecate(id: string, opts: { by?: string } = {}): Promise<WorkflowSummary> {
    await this.versioning.deprecate(id, opts)
    return this.summary(id)
  }

  async archive(id: string, opts: { by?: string } = {}): Promise<WorkflowSummary> {
    await this.versioning.archive(id, opts)
    return this.summary(id)
  }

  async rollback(
    id: string,
    opts: { targetRevision: number; by?: string },
  ): Promise<WorkflowSummary> {
    await this.versioning.rollback(id, opts)
    return this.summary(id)
  }

  /** Revision metadata for one workflow, ascending. */
  async listRevisions(id: string): Promise<RevisionMeta[]> {
    return this.versioning.listRevisions(id)
  }

  /** Full lifecycle view for one workflow. */
  async getState(id: string): Promise<WorkflowLifecycleView> {
    return this.versioning.getState(id)
  }

  /**
   * The authored YAML text for `id` (v5 B-M2 template export). Returns the
   * on-disk `definitions/<id>.yaml` verbatim — the exact text that imported
   * successfully — so a template that embeds it is guaranteed to re-parse (no
   * re-emit drift from the in-memory `WorkflowDefinition`). Returns null when
   * the id is unknown or its file is missing (e.g. a never-written draft).
   */
  async exportDefinitionText(id: string): Promise<string | null> {
    const file = this.known.get(id)?.file
    if (!file) return null
    try {
      return await readFile(file, 'utf8')
    } catch {
      return null
    }
  }

  // --- internals -----------------------------------------------------------

  private async writeDefinitionFile(def: WorkflowDefinition, text: string): Promise<string> {
    // Don't create the directory until we have something valid to put in it.
    if (!existsSync(this.definitionsDir)) {
      mkdirSync(this.definitionsDir, { recursive: true })
    }
    const filePath = join(this.definitionsDir, `${sanitiseFileBase(def.id)}.yaml`)
    const tmp = `${filePath}.tmp`
    await writeFile(tmp, text, 'utf8')
    try {
      await rename(tmp, filePath)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }
    return filePath
  }

  private async summary(id: string): Promise<WorkflowSummary> {
    const view = await this.versioning.getState(id)
    const file = this.known.get(id)?.file ?? null
    const out = this.summaryFromView(id, file, view)
    // WFEDIT-S2: record the capabilities currently leaving this workflow off-hub
    // into the sticky marker (monotonic union). This is the SINGLE capture point:
    // every write (import/saveDraft/publish) and lifecycle transition funnels
    // through summary(), while read paths (list/listAll) use summaryFromView
    // directly and never capture. When the peer is offline `crossHubSteps` is
    // absent ⇒ merge ∅ ⇒ no-op, so the marker only grows while peers are
    // connected and never shrinks. Best-effort — a marker write must never fail
    // a workflow write.
    if (this.crossHubMarkers && out.crossHubSteps?.length) {
      try {
        await this.crossHubMarkers.merge(id, out.crossHubSteps.map((s) => s.capability))
      } catch (err) {
        log.warn('cross-hub marker capture failed', {
          id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return out
  }

  /** Project a lifecycle view + the relevant revision's definition into a summary. */
  private summaryFromView(
    id: string,
    file: string | null,
    view: WorkflowLifecycleView,
  ): WorkflowSummary {
    // Use the current (published) revision when there is one, else the head —
    // so a draft still surfaces its latest edited content.
    const rev = view.currentRevision ?? view.headRevision
    const resolver = this.versioning.getResolver(id)
    if (!resolver) {
      throw new Error(`workflow '${id}' has no resolver — not loaded`)
    }
    const def = resolver.byRevision(rev)
    const out: WorkflowSummary = {
      id: def.id,
      participantId: workflowParticipantId(id),
      triggerCapability: view.triggerCapability,
      stepCount: def.steps.length,
      state: view.state,
      file,
    }
    if (view.currentRevision !== undefined) out.currentRevision = view.currentRevision
    if (def.name) out.name = def.name
    if (def.description) out.description = def.description
    if (def.trigger.payloadSchema) out.payloadSchema = def.trigger.payloadSchema
    if (def.surface?.me) out.surfaceMe = def.surface.me
    if (def.governance) out.governance = def.governance
    const crossHub = this.computeCrossHubSteps(def)
    if (crossHub.length > 0) out.crossHubSteps = crossHub
    return out
  }

  /**
   * Resolve which of a definition's steps dispatch OFF this hub (to a mesh peer
   * or an external A2A agent). Returns `[]` when no off-hub view is wired
   * (single-hub case ⇒ zero cost). The local-capability set EXCLUDES the off-hub
   * destinations' participants (their ids == the entry `peer` ids) so a
   * capability such a destination itself advertises isn't mistaken for "served
   * locally" and thus wrongly suppressed — this matters for A2A agents, which
   * (unlike mesh peer wrappers) ARE registered as ordinary local participants.
   */
  private computeCrossHubSteps(def: WorkflowDefinition): CrossHubStep[] {
    if (!this.peerCapabilities) return []
    const peerEntries = this.peerCapabilities.peerCapabilities()
    if (peerEntries.length === 0) return []
    const peerIds = new Set(peerEntries.map((e) => e.peer))
    const localCaps = new Set<string>()
    for (const p of this.hub.participants()) {
      if (peerIds.has(p.id)) continue
      for (const c of p.capabilities) localCaps.add(c)
    }
    return crossHubStepsOf(def, localCaps, peerEntries)
  }

  /**
   * DAG-M2 — read-only graph projection of one workflow, for the admin UI's
   * "view flow chart" affordance. Builds the pure `{ nodes, edges }` view from the
   * SAME revision {@link summaryFromView} projects (current published rev, else
   * head — so a draft still shows its latest edited shape), then STAMPS each node
   * that dispatches off-hub with its destination. The stamp reuses
   * {@link computeCrossHubSteps}, so the chart's cross-hub marks can never disagree
   * with the summary's `crossHubSteps` (or the member edit boundary lock) — one
   * detector, no drift. Returns null for an unknown id so the web route 404s
   * cleanly. Single-hub hosts (no off-hub view) stamp nothing — zero added cost.
   */
  async graphOf(id: string): Promise<WorkflowGraphView | null> {
    let view: WorkflowLifecycleView
    try {
      view = await this.versioning.getState(id)
    } catch {
      return null
    }
    const rev = view.currentRevision ?? view.headRevision
    const resolver = this.versioning.getResolver(id)
    if (!resolver) return null
    const def = resolver.byRevision(rev)
    const graph = projectWorkflowGraph(def)
    // Stamp off-hub destinations onto the matching nodes. A `CrossHubStep.stepId`
    // is `<stepId>` for a simple step and `<stepId>/<branchId>` for a parallel
    // branch — exactly the two node-id shapes the projection emits (`step:` /
    // `branch:` prefixed; step ids are url-safe with no `/`, so the slash only
    // ever marks the synthesized branch address). Index once, annotate in one pass.
    const crossHub = this.computeCrossHubSteps(def)
    if (crossHub.length > 0) {
      const byNodeId = new Map<string, GraphNodeCrossHub>()
      for (const s of crossHub) {
        const nodeId = s.stepId.includes('/') ? `branch:${s.stepId}` : `step:${s.stepId}`
        byNodeId.set(nodeId, { peer: s.peer, peerLabel: s.peerLabel, kind: s.kind ?? 'peer' })
      }
      for (const node of graph.nodes) {
        const hit = byNodeId.get(node.id)
        if (hit) node.crossHub = hit
      }
    }
    return graph
  }
}

/**
 * Flatten a workflow's steps into `(stepId, capability)` pairs for the
 * capabilities each dispatch ASKS for. Uses the canonical
 * {@link extractRequiredCapabilities} so cross-hub detection gates on the SAME
 * notion of "required caps" as the inbound/outbound peer ACLs (no drift):
 * `explicit` dispatch and unfiltered `broadcast` yield `null` there → they
 * contribute nothing (they can't be capability-matched to a peer anyway). A
 * parallel step's branches are addressed `${stepId}/${branchId}`.
 */
function stepDispatchCapabilities(
  step: Step,
): Array<{ stepId: string; capability: string }> {
  const out: Array<{ stepId: string; capability: string }> = []
  const add = (stepId: string, spec: DispatchSpec): void => {
    const caps = extractRequiredCapabilities(spec.strategy)
    if (!caps) return
    for (const c of caps) out.push({ stepId, capability: c })
  }
  if (step.kind === 'parallel') {
    for (const b of step.branches) add(`${step.id}/${b.id}`, b.dispatch)
  } else {
    add(step.id, step.dispatch)
  }
  return out
}

/**
 * Pure off-hub-step detection (exported for direct unit testing — no Hub, no
 * versioning needed). A step leaves the hub when its dispatch asks for a
 * capability that an off-hub destination (a mesh peer OR an external A2A agent)
 * advertises AND no local participant serves.
 *
 * The "not local" guard matters: a capability that BOTH a local agent and an
 * off-hub destination can serve still routes locally (the capability strategy is
 * satisfied by any local match first), so flagging it would be a false alarm.
 * When two destinations advertise the same capability the FIRST in `peerEntries`
 * wins attribution — deterministic; the caller passes a stable order (mesh peers
 * then A2A agents). Each result carries its destination `kind`.
 */
export function crossHubStepsOf(
  def: WorkflowDefinition,
  localCapabilities: ReadonlySet<string>,
  peerEntries: ReadonlyArray<{
    peer: string
    label: string | null
    capabilities: readonly string[]
    kind?: 'peer' | 'a2a'
  }>,
): CrossHubStep[] {
  const peerCap = new Map<string, { peer: string; label: string | null; kind: 'peer' | 'a2a' }>()
  for (const e of peerEntries) {
    for (const c of e.capabilities) {
      if (!peerCap.has(c)) peerCap.set(c, { peer: e.peer, label: e.label, kind: e.kind ?? 'peer' })
    }
  }
  const out: CrossHubStep[] = []
  for (const step of def.steps) {
    for (const { stepId, capability } of stepDispatchCapabilities(step)) {
      if (localCapabilities.has(capability)) continue
      const hit = peerCap.get(capability)
      if (!hit) continue
      out.push({ stepId, capability, peer: hit.peer, peerLabel: hit.label, kind: hit.kind })
    }
  }
  return out
}

/**
 * Admin list ordering for {@link WorkflowController.listAll}: workflows that
 * actually serve traffic first, then in-progress authoring (review ahead of
 * draft), then archived tombstones at the bottom.
 */
const STATE_RANK: Record<LifecycleState, number> = {
  published: 0,
  deprecated: 1,
  review: 2,
  draft: 3,
  archived: 4,
}

/**
 * Pure-structural deep-check violations that no later agent registration can
 * fix — they're bugs in the workflow definition itself, so they block EVERY
 * write path (import / draft / publish). See `assertStructurallySound`.
 */
const HARD_VIOLATION_KINDS: ReadonlySet<string> = new Set([
  'bad_ref',
  'forward_ref',
  'self_trigger_cycle',
  'id_collision',
])

/**
 * Does a deep-check violation BLOCK the write (vs. ride along as advisory)?
 *   - HARD kinds always block.
 *   - `unknown_agent` blocks only a deliberate go-live (`blockWarnings`): import
 *     and publish, never a draft.
 *   - `unknown_capability` (and anything else) is advisory — surfaced, not thrown.
 */
function isBlockingViolation(kind: string, blockWarnings: boolean): boolean {
  if (HARD_VIOLATION_KINDS.has(kind)) return true
  return blockWarnings && kind === 'unknown_agent'
}

/**
 * Audit M5 — is this run parked indefinitely on an external event (a
 * human-inbox step), as opposed to a time-based suspend the boot resume
 * should re-arm? True when any step is suspended at the never-resume
 * sentinel. The inbox-resolve path owns these runs (it reads the parked
 * task's own persistent suspended_tasks row), so boot must not re-drive them.
 */
function isParkedIndefinitely(state: RunState): boolean {
  return state.steps.some(
    (s) => s.status === 'suspended' && s.resumeAt === NEVER_RESUME_AT,
  )
}

/**
 * Convert a workflow id into a safe file base. The id schema is already
 * url-/json-safe (letters / digits / _ . : -), but `:` is allowed inside ids
 * and macOS/Linux tolerates it while Windows does not. Replace it with `__` so
 * the filename works everywhere.
 */
function sanitiseFileBase(id: string): string {
  return id.replace(/:/g, '__')
}
