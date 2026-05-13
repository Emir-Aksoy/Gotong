/**
 * `WorkflowController` — bridge between `@aipehub/web`'s admin HTTP API
 * and `@aipehub/workflow`'s in-process runners.
 *
 * Implements the `WorkflowSurface` duck type the Web layer declares so
 * the Web package itself doesn't take a runtime dep on the workflow
 * runtime. We can drop a different controller in front of it (mock,
 * remote-only, no-import-allowed for read-only deployments, …) without
 * touching the Web code.
 *
 * Two behaviors:
 *
 *   - `list()` returns the live set of workflows currently registered on
 *     the Hub via `WorkflowRunner` participants. We track them in-memory
 *     here (keyed by participant id) so disk drift between
 *     `definitions/*.yaml` and the in-process registrations stays
 *     observable (the registry is the source of truth).
 *
 *   - `importFromText(yaml)` parses, writes to disk **atomically**, and
 *     registers a fresh runner. Atomic semantics:
 *       1. parseWorkflow(yaml)  → reject early on bad schema
 *       2. fail if id already loaded (prevents overwrite surprises)
 *       3. mkdir + write `<def>.yaml.tmp` + rename
 *       4. WorkflowRunner construct + hub.register
 *     If step 4 fails after disk write, we delete the file we just wrote
 *     so the on-disk state matches the in-memory state.
 *
 * File names: `<workflowId>.yaml`. We use the workflow id (sanitised) so
 * a re-import overwrites cleanly and a directory `ls` matches the live
 * registry.
 */

import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Hub } from '@aipehub/core'
import {
  RunStore,
  WorkflowRunner,
  parseWorkflow,
  workflowParticipantId,
  type RunState,
  type RunSummary,
  type WorkflowDefinition,
} from '@aipehub/workflow'

import type { LoadReport } from './workflow-loader.js'

export interface WorkflowSummary {
  id: string
  participantId: string
  name?: string
  description?: string
  triggerCapability: string
  stepCount: number
  file: string | null
}

export interface WorkflowControllerOptions {
  hub: Hub
  /**
   * Directory where uploaded workflows are persisted. Same place the
   * boot-time loader scans, so a restart re-loads everything the admin
   * imported through the UI.
   */
  definitionsDir: string
  /**
   * Space root path. Used to construct `RunStore` instances for each
   * runner so workflow runs land under
   * `<spaceRoot>/workflows/runs/<runId>.json`.
   */
  spaceRoot: string
}

/**
 * Build a controller and pre-populate it with whatever the boot-time
 * loader registered. After this, the controller becomes the source of
 * truth for "what workflows are live in this Hub right now".
 */
export function createWorkflowController(
  opts: WorkflowControllerOptions,
  bootReport: LoadReport,
): WorkflowController {
  const c = new WorkflowController(opts)
  for (const w of bootReport.loaded) {
    c.indexRegistered(w.participantId, w.definition, w.file)
  }
  return c
}

export class WorkflowController {
  private readonly hub: Hub
  private readonly definitionsDir: string
  private readonly spaceRoot: string
  /**
   * Shared `RunStore` for read-side endpoints (history list / detail).
   * Writes still happen through each `WorkflowRunner`'s own store, but
   * they all point at the same directory under `spaceRoot/workflows/`,
   * so one shared reader sees everything.
   */
  private readonly runStore: RunStore
  /**
   * id → metadata for live runners we know about. The Hub's registry is
   * authoritative on participant existence; this map carries the
   * additional info (file path, definition summary) the UI needs.
   */
  private readonly known = new Map<
    string,
    { participantId: string; definition: WorkflowDefinition; file: string | null }
  >()

  constructor(opts: WorkflowControllerOptions) {
    this.hub = opts.hub
    this.definitionsDir = opts.definitionsDir
    this.spaceRoot = opts.spaceRoot
    this.runStore = new RunStore(opts.spaceRoot)
  }

  /** Called by `createWorkflowController` for each boot-time loaded workflow. */
  indexRegistered(
    participantId: string,
    definition: WorkflowDefinition,
    file: string | null,
  ): void {
    this.known.set(definition.id, { participantId, definition, file })
  }

  async list(): Promise<WorkflowSummary[]> {
    const out: WorkflowSummary[] = []
    for (const w of this.known.values()) {
      // Skip rows whose participant is no longer on the hub (paranoid
      // resync — usually only matters in tests / weird unregisters).
      if (!this.hub.registry.get(w.participantId)) continue
      out.push(this.toSummary(w))
    }
    // stable sort by id
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return out
  }

  /**
   * List recorded workflow runs from disk. Pass `workflowId` to filter
   * to one workflow; pass `limit` to cap the result count (newest first).
   */
  async listRuns(opts?: { workflowId?: string; limit?: number }): Promise<RunSummary[]> {
    return this.runStore.listRuns(opts)
  }

  /**
   * Load the full `RunState` for one run, or `null` if no such run is
   * recorded on disk.
   */
  async readRun(runId: string): Promise<RunState | null> {
    return this.runStore.read(runId)
  }

  /**
   * Unregister a workflow runner and delete its backing YAML file.
   *
   * Three-step removal, each step best-effort but ordered so a partial
   * failure leaves the most sensible state:
   *
   *   1. unregister the participant from the Hub (so no new task lands)
   *   2. delete the on-disk file (so a restart doesn't re-load it)
   *   3. drop from the in-memory index
   *
   * If step 1 fails (workflow doesn't exist), we throw and don't touch
   * disk. If step 2 fails (file already gone, permissions), we still
   * complete step 3 — the user clearly wants this workflow gone, and
   * the participant is already off the Hub.
   *
   * In-flight tasks already dispatched to this runner are NOT cancelled;
   * the Hub's normal flow lets them finish. Future invocations of the
   * trigger capability will get `no_participant`.
   */
  async remove(id: string): Promise<void> {
    const w = this.known.get(id)
    if (!w) {
      throw new Error(`workflow '${id}' is not loaded`)
    }
    const removed = this.hub.unregister(w.participantId)
    if (!removed) {
      // Out-of-sync: known map says it's there but Hub doesn't agree.
      // Drop the bookkeeping anyway and try to clean the file too.
      this.known.delete(id)
      if (w.file) {
        try { unlinkSync(w.file) } catch { /* ignore */ }
      }
      throw new Error(
        `workflow '${id}' was not on the Hub — in-memory index has been resynced. Try again.`,
      )
    }
    if (w.file) {
      try { unlinkSync(w.file) } catch { /* the user can rm it manually if needed */ }
    }
    this.known.delete(id)
  }

  async importFromText(text: string): Promise<WorkflowSummary> {
    const def = parseWorkflow(text)
    if (this.known.has(def.id)) {
      throw new Error(
        `workflow id '${def.id}' is already loaded — delete it first (v0.1 does not support re-import).`,
      )
    }
    // Don't create the directory until we have something valid to put
    // in it. Saves the operator a confusing empty `definitions/`.
    if (!existsSync(this.definitionsDir)) {
      mkdirSync(this.definitionsDir, { recursive: true })
    }
    const filePath = join(this.definitionsDir, `${sanitiseFileBase(def.id)}.yaml`)
    const tmp = `${filePath}.tmp`
    await writeFile(tmp, text, 'utf8')
    try {
      await rename(tmp, filePath)
    } catch (err) {
      // best-effort cleanup of the .tmp
      try { unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }

    // Register the runner. If this fails (Hub registry rejects), delete
    // the file we just wrote so the on-disk state matches "not loaded".
    const participantId = workflowParticipantId(def.id)
    const runner = new WorkflowRunner({
      definition: def,
      hub: this.hub,
      runStore: new RunStore(this.spaceRoot),
    })
    try {
      this.hub.register(runner)
    } catch (err) {
      try { unlinkSync(filePath) } catch { /* ignore */ }
      throw err
    }

    this.known.set(def.id, { participantId, definition: def, file: filePath })
    return this.toSummary({ participantId, definition: def, file: filePath })
  }

  private toSummary(w: {
    participantId: string
    definition: WorkflowDefinition
    file: string | null
  }): WorkflowSummary {
    const out: WorkflowSummary = {
      id: w.definition.id,
      participantId: w.participantId,
      triggerCapability: w.definition.trigger.capability,
      stepCount: w.definition.steps.length,
      file: w.file,
    }
    if (w.definition.name) out.name = w.definition.name
    if (w.definition.description) out.description = w.definition.description
    return out
  }
}

/**
 * Convert a workflow id into a safe file base. The id schema is already
 * url-/json-safe (letters / digits / _ . : -), but `:` is allowed inside
 * ids and macOS/Linux tolerates it while Windows does not. Replace it
 * with `__` so the filename works everywhere.
 */
function sanitiseFileBase(id: string): string {
  return id.replace(/:/g, '__')
}
