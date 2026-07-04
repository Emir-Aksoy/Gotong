/**
 * `GrowthReportsAdmin` — host-side implementation of the
 * `GrowthReportsAdminSurface` defined in `@gotong/core`.
 *
 * Walks the synthesist agent's live `artifact` handle to list and
 * serve consolidated 7-section markdown reports written by
 * {@link PersonalGrowthAgent.writeSynthesisReport}.
 *
 * Why we borrow the agent's *live* handle (instead of re-attaching
 * ourselves):
 *
 *   - Re-attaching files a second `Owner = {kind:'agent', id:'growth-
 *     synthesist'}` against the same plugin. The file plugin keeps
 *     per-owner state (open file descriptors during a write, trash
 *     metadata caches) and a parallel attach would race the agent's
 *     own writes — best case wasted work, worst case lost updates.
 *   - The accessor closure lets this object survive across spawn /
 *     stop cycles of the synthesist agent. Until the agent is up,
 *     `list()` returns `[]` (the surface contract); reads throw a
 *     descriptive error the web layer translates to 503.
 *
 * Concurrency: every entry point reads through the accessor once
 * per call and operates on the snapshot. If the synthesist is
 * mid-spawn or mid-stop, callers see either the old handle or no
 * handle, never a torn one.
 */

import type {
  GrowthReportSummary,
  GrowthReportsAdminSurface,
} from '@gotong/core'
import type { ArtifactHandle, ArtifactRef } from '@gotong/services-sdk'

const REPORTS_PREFIX = 'reports/'

export interface GrowthReportsAdminOpts {
  /**
   * Returns the synthesist's live artifact handle, or `undefined`
   * when the agent is currently not spawned / doesn't declare an
   * artifact `uses:`. Called on every list / read.
   */
  readonly artifactAccessor: () => ArtifactHandle | undefined
}

export class GrowthReportsAdmin implements GrowthReportsAdminSurface {
  private readonly artifactAccessor: () => ArtifactHandle | undefined

  constructor(opts: GrowthReportsAdminOpts) {
    this.artifactAccessor = opts.artifactAccessor
  }

  async list(): Promise<ReadonlyArray<GrowthReportSummary>> {
    const handle = this.artifactAccessor()
    if (!handle) return []
    let items: readonly ArtifactRef[]
    try {
      items = await handle.list({ prefix: REPORTS_PREFIX })
    } catch {
      // The artifact plugin throws when the owner directory hasn't
      // been touched yet (no `write` ever ran). That's the "empty
      // state" — return [] so the admin UI renders the placeholder.
      return []
    }

    const out: GrowthReportSummary[] = []
    for (const item of items) {
      if (!item.path.endsWith('.md')) continue
      const caseId = parseCaseId(item.path)
      if (!caseId) continue
      const summary: GrowthReportSummary = {
        path: item.path,
        caseId,
        ts: item.ts,
        sizeBytes: item.size,
      }
      out.push(summary)
    }
    // Newest-first — admin UI renders top-down.
    out.sort((a, b) => b.ts - a.ts)
    return out
  }

  async read(path: string): Promise<{ readonly markdown: string }> {
    if (!path.startsWith(REPORTS_PREFIX)) {
      throw new Error(`growth-reports: path must start with '${REPORTS_PREFIX}'`)
    }
    const handle = this.artifactAccessor()
    if (!handle) {
      throw new Error('growth-reports: synthesist artifact handle unavailable')
    }
    const r = await handle.read(path)
    return { markdown: r.content }
  }
}

/**
 * Pull the caseId segment out of an artifact path. The synthesist
 * writes under `reports/<caseId>/<filename>.md` — anything not
 * matching that shape (e.g. stray files an admin dropped in by hand)
 * returns `null` so `list()` can skip them.
 */
function parseCaseId(path: string): string | null {
  const rest = path.slice(REPORTS_PREFIX.length)
  const slashIdx = rest.indexOf('/')
  if (slashIdx <= 0) return null
  return rest.slice(0, slashIdx)
}
