import type { MemoryEntry, MemoryQuery } from '@gotong/services-sdk'
import { isActive } from './bitemporal.js'
import { importanceOf } from './importance.js'
import { tierOf } from './tiers.js'
import { formOf } from './procedure.js'

export interface RecallQuery extends MemoryQuery {
  minImportance?: number
  tier?: string
  form?: string
  /** Include superseded facts, explicitly labelled by the renderer. */
  history?: boolean
  /** Validity time, not the event time or file creation time. */
  asOf?: number
}

/** All rankers and link expansion share the same narrowing contract. */
export function filterRecall(
  entries: readonly MemoryEntry[], query: RecallQuery,
  opts?: { activeOnly?: boolean; now?: () => number },
): MemoryEntry[] {
  const at = query.asOf ?? (opts?.now ?? Date.now)()
  const active = query.asOf !== undefined || (query.history !== true && opts?.activeOnly === true)
  return entries.filter(e =>
    (!query.kinds?.length || query.kinds.includes(e.kind)) &&
    (query.since === undefined || e.ts >= query.since) &&
    (query.minImportance === undefined || importanceOf(e) >= query.minImportance) &&
    (query.tier === undefined || tierOf(e, '') === query.tier) &&
    (query.form === undefined || formOf(e, '') === query.form) &&
    (!active || isActive(e, at)))
}
