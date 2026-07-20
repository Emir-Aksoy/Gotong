/**
 * File-first persistence for workflow runs.
 *
 * Layout (under the space root, alongside `transcript.jsonl` and friends):
 *
 *   .gotong/
 *     workflows/
 *       definitions/             — optional: workflow defs that auto-load on host start
 *         editorial-flow.yaml    — content matches `gotong.workflow/v1` schema
 *         …
 *       runs/                    — one JSON per run, written atomically
 *         <runId>.json
 *         …
 *         archive/               — retained-but-pruned terminal runs (M3-M1)
 *           <runId>.json         — moved here by `archiveRuns`; excluded from
 *           …                      the active scan that boot-resume / listRuns
 *                                  / metrics walk, so they stay O(tail)
 *
 * Why files, not memory:
 *   - Stays consistent with Gotong's v2.0 "file-first" promise. Drop the
 *     directory → drop the workflow state. Copy it → hand it off.
 *   - Lets an operator inspect a half-run workflow with `jq` / `cat`.
 *   - Sets up v0.2 resume (scan the runs/ dir on startup, restart anything
 *     not in a terminal status).
 *
 * Bounding growth (Route B P0-M3): the active `runs/` dir gains one file per
 * run forever. Every `listRuns` / boot-resume / `/metrics` scrape reads ALL of
 * them (O(all)). `archiveRuns` moves old TERMINAL runs into `runs/archive/`,
 * which the non-recursive `listRunIds` naturally skips — so the active scan
 * shrinks to O(tail). Archived bytes are never lost: `readArchived` /
 * `listArchivedRunIds` reach them for audit / export. A `running` run is NEVER
 * archived — boot-resume needs it on the active path (a human-inbox-parked run
 * is also `status: 'running'`, so this one rule keeps both resumable).
 *
 * Writes are atomic: write to `<file>.tmp`, then rename. A `kill -9`
 * mid-write can never leave the run file half-formed.
 *
 * This module has zero dependencies on the Hub — it only knows about paths
 * and file IO.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { RunState, RunStatus, RunSummary } from './types.js'

const SUBDIR_RUNS = 'runs'
const SUBDIR_DEFINITIONS = 'definitions'
/** The canonical run statuses — seeded so `countRuns` always returns all four. */
const RUN_STATUSES: RunStatus[] = ['running', 'done', 'failed', 'cancelled']
/**
 * Pruned terminal runs live one level under `runs/`. Named without a `.json`
 * suffix so `listRunIds`' non-recursive `.json` filter excludes the directory
 * entry automatically — the same trick the transcript archive (M2-M2) uses to
 * keep archived segments off the active load path.
 */
const SUBDIR_ARCHIVE = 'archive'

/**
 * Retention policy for {@link RunStore.archiveRuns}. Both knobs are optional and
 * may be combined; with neither set, `archiveRuns` is a no-op (it never guesses
 * a default — the host's env policy decides, mirroring transcript `ArchiveOptions`).
 */
export interface ArchiveRunsOptions {
  /**
   * Keep this many of the NEWEST terminal runs on the active path (ranked by
   * end time, `endedAt ?? startedAt`, descending). The rest are eligible to
   * archive. Undefined ⇒ 0 protected. `running` runs are never counted here —
   * they're always retained regardless.
   */
  keepLast?: number
  /**
   * Only archive terminal runs that ended strictly before this (epoch ms,
   * keyed on `endedAt ?? startedAt`). Undefined ⇒ no age constraint. Combined
   * with `keepLast`, a run is archived only when it is BOTH unprotected AND
   * older than the cutoff.
   */
  before?: number
}

/**
 * Result of {@link RunStore.countRuns} — an exact tally over the ACTIVE run set
 * (archived runs excluded). `total` equals the sum of `byStatus` (the four
 * known statuses are always present, seeded to 0). Replaces the metrics layer's
 * old fixed-cap sampling: the scan is O(active), which run retention bounds to
 * O(tail), so the count is exact rather than a 2000-row approximation.
 */
export interface RunStatusCounts {
  total: number
  byStatus: Record<string, number>
}

/**
 * RunStore — owns the on-disk shape of `.gotong/workflows/`.
 */
export class RunStore {
  readonly root: string
  readonly runsDir: string
  readonly definitionsDir: string
  readonly archiveDir: string

  /**
   * @param spaceRoot The space root directory (e.g. `.gotong`).
   *                  The store appends `workflows/runs/` etc. underneath.
   */
  constructor(spaceRoot: string) {
    this.root = join(spaceRoot, 'workflows')
    this.runsDir = join(this.root, SUBDIR_RUNS)
    this.definitionsDir = join(this.root, SUBDIR_DEFINITIONS)
    this.archiveDir = join(this.runsDir, SUBDIR_ARCHIVE)
  }

  /** Set once the tree is known to exist; cleared if a write proves otherwise. */
  private dirsReady = false

  /**
   * Create the directory tree if it doesn't exist. Idempotent, and after the
   * first success it costs nothing.
   *
   * The memo matters because `WorkflowRunner.persist()` calls this before every
   * single step write — two synchronous `existsSync` stats per step, on the
   * event loop, re-answering a question whose answer was already yes. `write()`
   * clears the flag if the tree turns out to be gone (someone deleted the space
   * directory under a running host), so this stays self-healing rather than
   * trading correctness for the syscalls.
   */
  ensureDirs(): void {
    if (this.dirsReady) return
    if (!existsSync(this.runsDir)) {
      mkdirSync(this.runsDir, { recursive: true })
    }
    if (!existsSync(this.definitionsDir)) {
      mkdirSync(this.definitionsDir, { recursive: true })
    }
    this.dirsReady = true
  }

  /** Path for one run file. */
  pathFor(runId: string): string {
    return join(this.runsDir, `${runId}.json`)
  }

  /**
   * Write the run state atomically. Writes to `<file>.tmp` then renames.
   *
   * A missing directory tree is recreated and the write retried once — that's
   * what lets {@link ensureDirs} memoize. Any other error propagates, and a
   * second ENOENT (i.e. the recreate didn't take) does too, so a genuinely
   * broken path still fails loudly instead of looping.
   */
  async write(state: RunState): Promise<void> {
    const file = this.pathFor(state.runId)
    const tmp = `${file}.tmp`
    const body = JSON.stringify(state, null, 2)
    try {
      await writeFile(tmp, body, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      this.dirsReady = false
      this.ensureDirs()
      await writeFile(tmp, body, 'utf8')
    }
    await rename(tmp, file)
  }

  /** Load a run state by id. Returns `null` if the file doesn't exist. */
  async read(runId: string): Promise<RunState | null> {
    const file = this.pathFor(runId)
    if (!existsSync(file)) return null
    const raw = await readFile(file, 'utf8')
    try {
      return JSON.parse(raw) as RunState
    } catch (err) {
      throw new Error(
        `RunStore: '${file}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * List all run ids on disk. Useful for v0.2 resume / admin "list past
   * runs" endpoints. Returns ids in the order the filesystem gives them.
   */
  async listRunIds(): Promise<string[]> {
    if (!existsSync(this.runsDir)) return []
    const files = await readdir(this.runsDir)
    return files
      .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map((f) => f.slice(0, -'.json'.length))
  }

  /**
   * Load summary metadata for every run on disk, optionally filtered to
   * a single `workflowId`. Returns rows sorted by `startedAt` descending
   * (newest first); apply `limit` after sorting to keep the most recent.
   *
   * The full per-step output is dropped from each row — pages of 100s of
   * runs would otherwise carry MBs of payload. Use `read(runId)` to
   * fetch the complete `RunState` when the admin clicks one row.
   */
  async listRuns(opts?: {
    workflowId?: string
    limit?: number
  }): Promise<RunSummary[]> {
    return this.collectSummaries(
      (state) => !opts?.workflowId || state.workflowId === opts.workflowId,
      opts?.limit,
    )
  }

  /**
   * List runs initiated by a single user, newest first. Backs the `/me`
   * member workbench so a member sees only the runs they kicked off.
   *
   * "Initiated by" keys on `triggeredByOrigin.userId` — the attribution
   * `/api/me/dispatch` already stamps (`origin: { orgId: 'local', userId }`),
   * which the runner persists into every run file. Pre-attribution run
   * files (no `triggeredByOrigin`) simply never match, so they degrade to
   * invisible rather than crash — no run-file format change is required.
   */
  async listByUser(
    userId: string,
    opts?: { workflowId?: string; limit?: number },
  ): Promise<RunSummary[]> {
    return this.collectSummaries(
      (state) =>
        state.triggeredByOrigin?.userId === userId &&
        (!opts?.workflowId || state.workflowId === opts.workflowId),
      opts?.limit,
    )
  }

  /**
   * Shared scan behind `listRuns` / `listByUser`: read every run file, keep
   * those passing `match`, project to `RunSummary`, sort newest-first, then
   * apply `limit`.
   *
   * Files that fail to parse are quietly skipped. A half-written `.tmp` is
   * filtered out by the `.json` suffix check in `listRunIds`; an
   * intact-but-corrupt `.json` would have already failed `read()` so we log
   * to stderr and move on rather than abort the whole list.
   */
  private async collectSummaries(
    match: (state: RunState) => boolean,
    limit?: number,
  ): Promise<RunSummary[]> {
    if (!existsSync(this.runsDir)) return []
    const ids = await this.listRunIds()
    const out: RunSummary[] = []
    for (const id of ids) {
      let state: RunState | null
      try {
        state = await this.read(id)
      } catch (err) {
        console.error(`[gotong-workflow] skipping unreadable run ${id}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      if (!state) continue
      if (!match(state)) continue
      const row: RunSummary = {
        runId: state.runId,
        workflowId: state.workflowId,
        triggeredByTaskId: state.triggeredByTaskId,
        status: state.status,
        startedAt: state.startedAt,
        stepCount: state.steps.length,
      }
      if (state.endedAt !== undefined) row.endedAt = state.endedAt
      if (state.error !== undefined) row.error = state.error
      out.push(row)
    }
    out.sort((a, b) => b.startedAt - a.startedAt)
    if (limit !== undefined && limit >= 0) {
      out.length = Math.min(out.length, limit)
    }
    return out
  }

  /**
   * Count ACTIVE runs by status (archived runs excluded), optionally filtered to
   * one `workflowId`. Backs the `/metrics` workflow-run gauges with an exact
   * tally instead of the old fixed 2000-row sample: the scan reads every active
   * run file (status lives inside the JSON), which is O(active) — and run
   * retention (M3-M2) bounds the active set to O(tail). Corrupt files are
   * skipped (logged) so a single bad file never breaks the count.
   */
  async countRuns(opts?: { workflowId?: string }): Promise<RunStatusCounts> {
    const byStatus: Record<string, number> = {}
    for (const s of RUN_STATUSES) byStatus[s] = 0 // seed zeros so all four series exist
    if (!existsSync(this.runsDir)) return { total: 0, byStatus }
    const ids = await this.listRunIds()
    let total = 0
    for (const id of ids) {
      let state: RunState | null
      try {
        state = await this.read(id)
      } catch (err) {
        console.error(
          `[gotong-workflow] countRuns: skipping unreadable run ${id}: ${err instanceof Error ? err.message : String(err)}`,
        )
        continue
      }
      if (!state) continue
      if (opts?.workflowId && state.workflowId !== opts.workflowId) continue
      total++
      byStatus[state.status] = (byStatus[state.status] ?? 0) + 1
    }
    return { total, byStatus }
  }

  // --- archive / prune (Route B P0-M3) -------------------------------------

  /** Path for one archived run file (under `runs/archive/`). */
  archivePathFor(runId: string): string {
    return join(this.archiveDir, `${runId}.json`)
  }

  /**
   * Move old TERMINAL runs into `runs/archive/`, out of the active scan path.
   * Returns the run ids moved this call (possibly empty), so the host can log
   * how much it pruned.
   *
   * A run is archived iff it is terminal (`status !== 'running'`), NOT among the
   * `keepLast` newest terminal runs, AND (when `before` is set) it ended before
   * the cutoff. `running` runs — including human-inbox-parked ones, which carry
   * `status: 'running'` — are never touched, so boot-resume keeps finding them
   * on the active path. Empty options are a no-op (never archive by accident).
   *
   * The move is `rename` (atomic within a filesystem). A `kill -9` between two
   * renames leaves some runs archived and the rest active — both states are
   * individually valid, and a later `archiveRuns` finishes the job idempotently.
   */
  async archiveRuns(opts: ArchiveRunsOptions = {}): Promise<string[]> {
    const { keepLast, before } = opts
    if (keepLast === undefined && before === undefined) return []
    if (!existsSync(this.runsDir)) return []

    // Gather active terminal runs with their end-time key. Skip 'running'
    // (resume safety) and anything unreadable — leave a corrupt file on the
    // active path where `read()` surfaces it rather than silently burying it.
    const ids = await this.listRunIds()
    const terminals: Array<{ id: string; endKey: number }> = []
    for (const id of ids) {
      let state: RunState | null
      try {
        state = await this.read(id)
      } catch (err) {
        console.error(
          `[gotong-workflow] archiveRuns: skipping unreadable run ${id}: ${err instanceof Error ? err.message : String(err)}`,
        )
        continue
      }
      if (!state) continue
      if (state.status === 'running') continue // SAFETY: never archive a live/parked run
      terminals.push({ id, endKey: state.endedAt ?? state.startedAt })
    }

    // keepLast protects the newest terminal runs (by end time, desc); the rest,
    // when also older than `before`, are archived.
    terminals.sort((a, b) => b.endKey - a.endKey)
    const protectCount = keepLast ?? 0
    const moved: string[] = []
    for (let i = protectCount; i < terminals.length; i++) {
      const t = terminals[i]!
      if (before !== undefined && t.endKey >= before) continue
      if (!existsSync(this.archiveDir)) mkdirSync(this.archiveDir, { recursive: true })
      await rename(this.pathFor(t.id), this.archivePathFor(t.id))
      moved.push(t.id)
    }
    return moved
  }

  /**
   * List archived run ids (terminal runs moved out by `archiveRuns`). The
   * active `listRunIds` excludes the `archive/` subdir automatically, so this
   * is the explicit way to reach archived history for audit / export.
   */
  async listArchivedRunIds(): Promise<string[]> {
    if (!existsSync(this.archiveDir)) return []
    const files = await readdir(this.archiveDir)
    return files
      .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map((f) => f.slice(0, -'.json'.length))
  }

  /** Read an archived run state by id. Returns `null` if not in the archive. */
  async readArchived(runId: string): Promise<RunState | null> {
    const file = this.archivePathFor(runId)
    if (!existsSync(file)) return null
    const raw = await readFile(file, 'utf8')
    try {
      return JSON.parse(raw) as RunState
    } catch (err) {
      throw new Error(
        `RunStore: archived '${file}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * List all `.yaml` / `.json` files under `definitions/`. Lets the host
   * auto-load every workflow declared in the space.
   */
  async listDefinitionFiles(): Promise<string[]> {
    if (!existsSync(this.definitionsDir)) return []
    const files = await readdir(this.definitionsDir)
    return files
      .filter(
        (f) =>
          (f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json')) &&
          !f.startsWith('.'),
      )
      .map((f) => join(this.definitionsDir, f))
  }
}
