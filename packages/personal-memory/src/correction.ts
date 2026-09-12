import type { MemoryEntry, MemoryKind, NewMemoryEntry } from '@gotong/services-sdk'
import { isDeepStrictEqual } from 'node:util'
import { temporalOf, type TurnTime } from './temporal.js'
import { captureCalendar } from './calendar.js'
import { evidenceSources, packEvidence, type UserEvidence } from './evidence.js'
import { PersonalMemoryError } from './errors.js'

export interface EvidenceCorrectionOptions {
  /** Trusted physical namespace; metadata is checked against it, not used to grant access. */
  userId: string
  /** Exact complete original user quote. A source ID disambiguates separate identical turns. */
  target: { quote: string; sourceId?: string }
  /** Already-selected corrected user statement, not the full "old -> new" conversation. */
  replacement: { sourceId: string; text: string; temporal: TurnTime }
  /** Full rewritten entries and new-entry payload. The executor must also budget generated id/ts. */
  maxEntryBytes: number
}

interface EntryRef { id: string; kind: MemoryKind }
export type EvidenceCorrectionPlan =
  | { status: 'not_found' | 'ambiguous'; sourceIds: string[] }
  // Untraced records are NOT implicitly safe: an executor must account for them separately.
  | { status: 'ready'; remove: EntryRef[]; rewrite: MemoryEntry[]; replacement: NewMemoryEntry; untraced: EntryRef[] }

/**
 * Computes structured-evidence changes only. No NLP intent detection, I/O, or authorization.
 * The caller must supply a complete owner snapshot and revalidate it before committing,
 * account for untraced records/caches/history, and derive intent from a trusted user turn.
 * `ready` means this calculation succeeded, never that a hard deletion has completed.
 */
export function prepareEvidenceCorrection(
  entries: readonly MemoryEntry[], opts: EvidenceCorrectionOptions,
): EvidenceCorrectionPlan {
  if (!validId(opts.userId) || !validQuote(opts.target?.quote) ||
    (opts.target.sourceId !== undefined && !validId(opts.target.sourceId)) ||
    !validId(opts.replacement?.sourceId) || !validQuote(opts.replacement.text) ||
    !Number.isSafeInteger(opts.maxEntryBytes) || opts.maxEntryBytes <= 0) invalid()
  const temporal = temporalOf({ meta: { temporal: opts.replacement.temporal } })
  if (!temporal) invalid()

  const bySource = new Map<string, UserEvidence>()
  const containers = new Map<MemoryEntry, UserEvidence[]>()
  const ids = new Set<string>()
  const untraced: EntryRef[] = []
  for (const entry of entries) {
    if (!validId(entry.id) || ids.has(entry.id) || typeof entry.text !== 'string' ||
      !['episodic', 'semantic', 'working'].includes(entry.kind) || !Number.isFinite(entry.ts)) invalid()
    ids.add(entry.id)
    const meta = entry.meta
    if (meta !== undefined && (!meta || typeof meta !== 'object' || Array.isArray(meta))) invalid()
    for (const alias of ['user', 'userId']) {
      if (Object.hasOwn(meta ?? {}, alias) && meta![alias] !== opts.userId) invalid()
    }
    const marked = (key: string) => Object.hasOwn(meta ?? {}, key)
    // Packed and raw representations are exclusive. Prioritizing one would
    // silently hide a conflicting source from a destructive-operation plan.
    if (marked('evidence') && ['userSpan', 'temporal', 'calendar'].some(marked)) invalid()
    if (marked('temporal') && !temporalOf(entry)) invalid()
    const sources = evidenceSources(entry)
    if (!sources.length) {
      if (['evidence', 'userSpan', 'calendar'].some(marked)) invalid()
      untraced.push(ref(entry))
      continue
    }
    containers.set(entry, sources)
    for (const source of sources) {
      const prior = bySource.get(source.sourceId)
      if (prior && !isDeepStrictEqual(prior, source)) {
        throw new PersonalMemoryError('evidence_source_conflict', 'Conflicting source evidence; correction not planned')
      }
      bySource.set(source.sourceId, source)
    }
  }
  if (ids.has(opts.replacement.sourceId) || bySource.has(opts.replacement.sourceId)) invalid()
  const candidates = [...bySource.values()].filter(s => s.text === opts.target.quote &&
    (opts.target.sourceId === undefined || s.sourceId === opts.target.sourceId))
  if (candidates.length !== 1) return {
    status: candidates.length ? 'ambiguous' : 'not_found', sourceIds: candidates.map(s => s.sourceId),
  }

  const sourceId = candidates[0]!.sourceId
  const remove: EntryRef[] = []
  const rewrite: MemoryEntry[] = []
  for (const [entry, sources] of containers) {
    if (!sources.some(s => s.sourceId === sourceId)) continue
    const remaining = sources.filter(s => s.sourceId !== sourceId)
    if (!remaining.length) remove.push(ref(entry))
    else {
      // Aggregated labels/steps may describe the deleted evidence. Rebuild only
      // the surviving quotes; never carry arbitrary old metadata into this plan.
      const rebuilt = pack(remaining, opts.maxEntryBytes)
      const saved = { ...rebuilt, id: entry.id, kind: entry.kind, ts: entry.ts }
      if (Buffer.byteLength(JSON.stringify(saved), 'utf8') > opts.maxEntryBytes) overflow()
      rewrite.push(saved)
    }
  }
  const calendar = captureCalendar(opts.replacement.text, temporal)
  const replacement = pack([{
    sourceId: opts.replacement.sourceId, text: opts.replacement.text, scope: opts.userId,
    temporal, ...(calendar ? { calendar } : {}),
  }], opts.maxEntryBytes)
  return { status: 'ready', remove, rewrite, replacement, untraced }
}

function ref(entry: MemoryEntry): EntryRef { return { id: entry.id, kind: entry.kind } }
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200
}
function validQuote(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4000
}
function invalid(): never {
  throw new PersonalMemoryError('correction_invalid', 'Invalid or incomplete correction evidence; correction not planned')
}
function pack(sources: readonly UserEvidence[], cap: number): NewMemoryEntry {
  const entry = packEvidence(sources, cap)
  if (!entry) overflow()
  return entry
}
function overflow(): never {
  throw new PersonalMemoryError('semantic_overflow', 'Correction evidence exceeds the entry budget; correction not planned')
}
