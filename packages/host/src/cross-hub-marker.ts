/**
 * WFEDIT-S1 — the sticky cross-hub marker for the member workflow-edit boundary
 * lock.
 *
 * WHY this exists. `enforceEditBoundary` (workflow-edit-guard.ts) decides whether
 * a member's natural-language edit touched a cross-hub egress by asking
 * `crossHubStepsOf` against the CURRENTLY-connected peers. That has a gap the M1
 * module note flagged: if the destination peer is OFFLINE at edit time, the
 * workflow reads as purely-local and the egress lock can't see the hop — only the
 * ingress (trigger) lock still fires. A member could then retarget/remove/
 * re-classify that cross-hub hop while the peer is down.
 *
 * This store closes that gap. The host records, per workflow, the set of
 * capabilities ever observed leaving that workflow off-hub (captured at the
 * authoritative write paths while peers ARE connected — see the controller's
 * capture hook). The set is MONOTONIC (union, never shrink): once a capability is
 * known to be off-hub for a workflow, it stays recorded even when the peer drops.
 * The edit guard then feeds these as a synthetic offline-peer entry so a step
 * that STILL dispatches such a capability is re-flagged as egress and locked,
 * even with the peer offline.
 *
 * Capability granularity (not per-step): cross-hub-ness is fundamentally a
 * property of the CAPABILITY (does an off-hub destination serve it?), which is
 * exactly what `crossHubStepsOf`'s "served locally ⇒ not egress" guard keys off.
 * Recording capabilities (a) lets a capability brought in-house auto-deactivate
 * the lock, and (b) keeps the marker robust to step renames. The guard re-derives
 * each step's data classes from the live definition, so the marker carries no
 * data-class state.
 *
 * File-first ("状态都是磁盘文件"): one JSON file per workflow under
 * `<spaceRoot>/workflows/cross-hub/`. No identity table, no migration. Reads are
 * best-effort — a missing or corrupt file yields an empty set (the lock falls
 * back to live detection, never crashes an edit or a boot).
 */

import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic } from '@gotong/core'

/** The slice the controller (capture) and the edit service (consult) depend on. */
export interface CrossHubMarkerStore {
  /**
   * The capabilities ever observed leaving `workflowId` off-hub (deduped, sorted
   * — canonical so order never reads as a change). Empty when unknown.
   */
  get(workflowId: string): Promise<string[]>
  /**
   * Union `capabilities` into the workflow's sticky set (monotonic — never
   * shrinks). A no-op for an empty list, or when nothing is new (so a member-edit
   * publish while the peer is offline merges ∅ and touches no file).
   */
  merge(workflowId: string, capabilities: readonly string[]): Promise<void>
}

interface MarkerFile {
  workflowId: string
  /** Canonical: deduped + sorted. */
  capabilities: string[]
  updatedAt: string
}

/** Path-safe file base for a workflow id (ids are already constrained, but be defensive). */
function fileBase(workflowId: string): string {
  const safe = workflowId.replace(/[^A-Za-z0-9._-]/g, '_')
  // Avoid empty / dotfile names for a pathological id.
  return safe.length > 0 && safe !== '.' && safe !== '..' ? safe : '_'
}

function canon(caps: Iterable<string>): string[] {
  return [...new Set([...caps].map((c) => String(c)))].sort()
}

/**
 * File-backed {@link CrossHubMarkerStore}. One `<spaceRoot>/workflows/cross-hub/
 * <id>.json` per workflow, written atomically (tmp + rename). Construct one and
 * share it between the controller (capture) and the edit service (consult).
 */
export class FileCrossHubMarkerStore implements CrossHubMarkerStore {
  private readonly dir: string

  constructor(spaceRoot: string) {
    this.dir = join(spaceRoot, 'workflows', 'cross-hub')
  }

  private fileFor(workflowId: string): string {
    return join(this.dir, `${fileBase(workflowId)}.json`)
  }

  async get(workflowId: string): Promise<string[]> {
    const file = this.fileFor(workflowId)
    if (!existsSync(file)) return []
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<MarkerFile>
      if (!parsed || !Array.isArray(parsed.capabilities)) return []
      return canon(parsed.capabilities.filter((c): c is string => typeof c === 'string'))
    } catch {
      // Corrupt / unreadable → behave as "unknown". The live detector still runs;
      // we never crash an edit or a boot over a bad marker file.
      return []
    }
  }

  async merge(workflowId: string, capabilities: readonly string[]): Promise<void> {
    const incoming = canon(capabilities)
    if (incoming.length === 0) return
    const existing = await this.get(workflowId)
    const merged = canon([...existing, ...incoming])
    // Monotonic: if nothing new, don't rewrite the file.
    if (merged.length === existing.length) return
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    const payload: MarkerFile = {
      workflowId,
      capabilities: merged,
      updatedAt: new Date().toISOString(),
    }
    await writeFileAtomic(this.fileFor(workflowId), JSON.stringify(payload, null, 2))
  }
}
