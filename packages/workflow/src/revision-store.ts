/**
 * File-first persistence for immutable workflow revisions (Phase 15).
 *
 * Layout (under the space root, alongside `runs/` and `definitions/`):
 *
 *   .gotong/
 *     workflows/
 *       revisions/
 *         <sanitisedId>/
 *           1.json            — a WorkflowRevision (meta + frozen definition)
 *           2.json
 *           …
 *
 * Immutability is enforced at the store layer, not by convention: `write()`
 * refuses to overwrite an existing `<rev>.json` (throws WorkflowRevisionError
 * code `revision_exists`). A run bound to revision N can therefore always read
 * back the exact definition it started under, even after newer revisions are
 * published — this is what kills the run-drift bug.
 *
 * The store is defined behind the `RevisionStore` interface so a SQLite-backed
 * implementation can slot in later WITHOUT touching callers. The workflow
 * package stays zero-runtime-dependency (only node builtins + `@gotong/core`).
 *
 * Writes are atomic (`writeFileAtomic`), mirroring `RunStore`.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic } from '@gotong/core'

import { WorkflowRevisionError, type RevisionMeta, type WorkflowRevision } from './lifecycle.js'
import { sanitiseFileBase } from './paths.js'
import type { WorkflowDefinition } from './types.js'

const SUBDIR_REVISIONS = 'revisions'

/**
 * Content-identity hash for a workflow definition: sha256 over a
 * canonical-JSON serialization (object keys sorted recursively) so the hash is
 * stable regardless of key insertion / re-serialization order. Used for
 * integrity checks, no-op-publish dedupe (identical content → no new revision),
 * and rollback's "current content == revision K" assertion.
 */
export function hashDefinition(def: WorkflowDefinition): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(def))).digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * Append-only, write-once store of revision snapshots. Implementations must
 * key by `(workflowId, revision)` and refuse to overwrite an existing one.
 */
export interface RevisionStore {
  /** Create the directory tree if needed. Idempotent. */
  ensureDirs(): void
  /**
   * Persist one revision, write-once. The workflow id is taken from
   * `rev.definition.id`. Throws WorkflowRevisionError(`revision_exists`) if the
   * `(id, revision)` slot is already taken.
   */
  write(rev: WorkflowRevision): Promise<void>
  /** Read one revision snapshot. Returns null if absent. */
  read(workflowId: string, revision: number): Promise<WorkflowRevision | null>
  /** Metadata for every revision of `workflowId`, ascending by revision. */
  list(workflowId: string): Promise<RevisionMeta[]>
  /** The next free revision number for `workflowId` (1 if none exist yet). */
  nextRevisionNumber(workflowId: string): Promise<number>
  /**
   * Delete ALL revisions of `workflowId` (no-op if none). Used only when a
   * workflow is fully removed — a clean slate so the id can be re-imported from
   * a fresh rev1. This is end-of-life cleanup, NOT a mutation of a live
   * workflow's history (the write-once immutability guarantee is about never
   * overwriting an existing revision while the workflow exists).
   */
  removeAll(workflowId: string): Promise<void>
}

/** File-backed {@link RevisionStore}. */
export class FileRevisionStore implements RevisionStore {
  readonly root: string
  readonly revisionsDir: string

  constructor(spaceRoot: string) {
    this.root = join(spaceRoot, 'workflows')
    this.revisionsDir = join(this.root, SUBDIR_REVISIONS)
  }

  ensureDirs(): void {
    if (!existsSync(this.revisionsDir)) {
      mkdirSync(this.revisionsDir, { recursive: true })
    }
  }

  private dirFor(workflowId: string): string {
    return join(this.revisionsDir, sanitiseFileBase(workflowId))
  }

  private pathFor(workflowId: string, revision: number): string {
    return join(this.dirFor(workflowId), `${revision}.json`)
  }

  async write(rev: WorkflowRevision): Promise<void> {
    const workflowId = rev.definition.id
    const dir = this.dirFor(workflowId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = this.pathFor(workflowId, rev.revision)
    if (existsSync(file)) {
      throw new WorkflowRevisionError(
        `revision ${rev.revision} of workflow '${workflowId}' already exists — revisions are immutable`,
        'revision_exists',
      )
    }
    await writeFileAtomic(file, JSON.stringify(rev, null, 2))
  }

  async read(workflowId: string, revision: number): Promise<WorkflowRevision | null> {
    const file = this.pathFor(workflowId, revision)
    if (!existsSync(file)) return null
    const raw = await readFile(file, 'utf8')
    try {
      return JSON.parse(raw) as WorkflowRevision
    } catch (err) {
      throw new WorkflowRevisionError(
        `revision file '${file}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        'revision_corrupt',
      )
    }
  }

  async list(workflowId: string): Promise<RevisionMeta[]> {
    const dir = this.dirFor(workflowId)
    if (!existsSync(dir)) return []
    const files = await readdir(dir)
    const out: RevisionMeta[] = []
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue
      const n = Number(f.slice(0, -'.json'.length))
      if (!Number.isInteger(n)) continue
      const rev = await this.read(workflowId, n)
      if (!rev) continue
      // Project to metadata — drop the heavy definition blob.
      const { definition: _drop, ...meta } = rev
      out.push(meta)
    }
    out.sort((a, b) => a.revision - b.revision)
    return out
  }

  async nextRevisionNumber(workflowId: string): Promise<number> {
    const dir = this.dirFor(workflowId)
    if (!existsSync(dir)) return 1
    const files = await readdir(dir)
    let max = 0
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue
      const n = Number(f.slice(0, -'.json'.length))
      if (Number.isInteger(n) && n > max) max = n
    }
    return max + 1
  }

  async removeAll(workflowId: string): Promise<void> {
    const dir = this.dirFor(workflowId)
    if (existsSync(dir)) await rm(dir, { recursive: true, force: true })
  }
}
