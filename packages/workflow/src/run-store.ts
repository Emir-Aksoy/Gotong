/**
 * File-first persistence for workflow runs.
 *
 * Layout (under the space root, alongside `transcript.jsonl` and friends):
 *
 *   .aipehub/
 *     workflows/
 *       definitions/             — optional: workflow defs that auto-load on host start
 *         editorial-flow.yaml    — content matches `aipehub.workflow/v1` schema
 *         …
 *       runs/                    — one JSON per run, written atomically
 *         <runId>.json
 *         …
 *
 * Why files, not memory:
 *   - Stays consistent with AipeHub's v2.0 "file-first" promise. Drop the
 *     directory → drop the workflow state. Copy it → hand it off.
 *   - Lets an operator inspect a half-run workflow with `jq` / `cat`.
 *   - Sets up v0.2 resume (scan the runs/ dir on startup, restart anything
 *     not in a terminal status).
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

import type { RunState } from './types.js'

const SUBDIR_RUNS = 'runs'
const SUBDIR_DEFINITIONS = 'definitions'

/**
 * RunStore — owns the on-disk shape of `.aipehub/workflows/`.
 */
export class RunStore {
  readonly root: string
  readonly runsDir: string
  readonly definitionsDir: string

  /**
   * @param spaceRoot The space root directory (e.g. `.aipehub`).
   *                  The store appends `workflows/runs/` etc. underneath.
   */
  constructor(spaceRoot: string) {
    this.root = join(spaceRoot, 'workflows')
    this.runsDir = join(this.root, SUBDIR_RUNS)
    this.definitionsDir = join(this.root, SUBDIR_DEFINITIONS)
  }

  /** Create the directory tree if it doesn't exist. Idempotent. */
  ensureDirs(): void {
    if (!existsSync(this.runsDir)) {
      mkdirSync(this.runsDir, { recursive: true })
    }
    if (!existsSync(this.definitionsDir)) {
      mkdirSync(this.definitionsDir, { recursive: true })
    }
  }

  /** Path for one run file. */
  pathFor(runId: string): string {
    return join(this.runsDir, `${runId}.json`)
  }

  /**
   * Write the run state atomically. Writes to `<file>.tmp` then renames.
   * Throws if the directory tree doesn't exist (call `ensureDirs` first).
   */
  async write(state: RunState): Promise<void> {
    const file = this.pathFor(state.runId)
    const tmp = `${file}.tmp`
    const body = JSON.stringify(state, null, 2)
    await writeFile(tmp, body, 'utf8')
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
