/**
 * File-first persistence for the mutable per-workflow lifecycle record
 * (Phase 15).
 *
 * Layout (under the space root):
 *
 *   .aipehub/
 *     workflows/
 *       lifecycle/
 *         <sanitisedId>.json   — one LifecycleRecord, rewritten atomically
 *
 * Unlike `RevisionStore` (write-once snapshots), the lifecycle record is the
 * single mutable pointer per workflow: state, currentRevision, headRevision,
 * the revision metadata list, and the transition audit log. Every transition
 * rewrites it atomically (`<file>.tmp` then rename).
 *
 * Defined behind the `LifecycleStore` interface so a SQLite-backed
 * implementation can slot in later without touching callers.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { LifecycleRecord } from './lifecycle.js'
import { sanitiseFileBase } from './paths.js'

const SUBDIR_LIFECYCLE = 'lifecycle'

/** Mutable store of one {@link LifecycleRecord} per workflow id. */
export interface LifecycleStore {
  /** Create the directory tree if needed. Idempotent. */
  ensureDirs(): void
  /** Read the record for `workflowId`. Returns null if absent. */
  read(workflowId: string): Promise<LifecycleRecord | null>
  /** Persist (overwrite) the record, atomically. */
  write(record: LifecycleRecord): Promise<void>
  /** Every lifecycle record on disk. Unreadable files are skipped. */
  list(): Promise<LifecycleRecord[]>
  /** Delete the record for `workflowId` (no-op if absent). */
  remove(workflowId: string): Promise<void>
}

/** File-backed {@link LifecycleStore}. */
export class FileLifecycleStore implements LifecycleStore {
  readonly root: string
  readonly lifecycleDir: string

  constructor(spaceRoot: string) {
    this.root = join(spaceRoot, 'workflows')
    this.lifecycleDir = join(this.root, SUBDIR_LIFECYCLE)
  }

  ensureDirs(): void {
    if (!existsSync(this.lifecycleDir)) {
      mkdirSync(this.lifecycleDir, { recursive: true })
    }
  }

  private pathFor(workflowId: string): string {
    return join(this.lifecycleDir, `${sanitiseFileBase(workflowId)}.json`)
  }

  async read(workflowId: string): Promise<LifecycleRecord | null> {
    const file = this.pathFor(workflowId)
    if (!existsSync(file)) return null
    const raw = await readFile(file, 'utf8')
    try {
      return JSON.parse(raw) as LifecycleRecord
    } catch (err) {
      throw new Error(
        `LifecycleStore: '${file}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async write(record: LifecycleRecord): Promise<void> {
    const file = this.pathFor(record.workflowId)
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
    await rename(tmp, file)
  }

  async list(): Promise<LifecycleRecord[]> {
    if (!existsSync(this.lifecycleDir)) return []
    const files = await readdir(this.lifecycleDir)
    const out: LifecycleRecord[] = []
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue
      const file = join(this.lifecycleDir, f)
      try {
        const raw = await readFile(file, 'utf8')
        out.push(JSON.parse(raw) as LifecycleRecord)
      } catch {
        // Skip an unreadable/corrupt record rather than abort the whole list.
        continue
      }
    }
    return out
  }

  async remove(workflowId: string): Promise<void> {
    const file = this.pathFor(workflowId)
    if (existsSync(file)) await unlink(file)
  }
}
