/**
 * reconcile.ts — write-time reconciliation (decision A / 用户 Q1「调用-修正
 * 同步」). The Mem0 pattern: when facts come in, don't blindly append — compare
 * against what's already stored and decide ADD / UPDATE / DELETE / NOOP.
 *
 * # Why this exists
 *
 * Today the only ways a fact enters durable memory are the `remember` tool
 * (blind append — duplicates and contradictions pile up) and consolidation
 * (which folds *episodic* into profiles but never touches the ad-hoc semantic
 * facts the model `remember`'d). Over a long-lived butler's life the ad-hoc
 * layer rots: "lives in KL" and "moved to Penang" sit side by side, the same
 * preference is stored three times. Reconciliation is the cure long-lived
 * agents need most.
 *
 * # At the turn boundary / heartbeat, NOT per write (decision A)
 *
 * Reconciling needs an LLM call. Doing it on every `remember` would be
 * "synchronized with every write" — expensive and pointless mid-turn. Decision
 * A is "synchronized with the *conversation*": run it at the turn boundary with
 * the turn's candidate facts, or on the heartbeat as a periodic dedup of the
 * stored set. {@link reconcileReviewer} is the heartbeat form;
 * {@link reconcile} with `candidates` is the turn-boundary form.
 *
 * # No LLM import, fail-soft
 *
 * Like {@link consolidate}, this takes a {@link MemorySummarizer} callback, so
 * it never imports `@aipehub/llm` and is trivially testable with a deterministic
 * fake that returns the ops JSON. A bad/empty/unparseable model response yields
 * ZERO operations (`noModel: true`) — reconciliation never corrupts memory on a
 * model hiccup. Every write happens BEFORE its paired delete (an update writes
 * the merged fact, then forgets the old one → a crash leaves a duplicate, never
 * a gap). Ops referencing an unknown id are dropped, never acted on (a model
 * can't make us delete a phantom).
 */

import type { MemoryEntry, MemoryHandle, MemoryKind, NewMemoryEntry } from '@aipehub/services-sdk'

import { openedMeta, type MemoryValidityWriter } from './bitemporal.js'
import { isProfile, type MemorySummarizer } from './consolidate.js'
import { clampImportance, importanceOf, META_IMPORTANCE, type Importance } from './importance.js'
import type { MemoryReviewer, ReviewContext, ReviewOutcome } from './review.js'
import { isClusterProfile, isDigest } from './tiers.js'

/** Window pulled when scanning the stored set for a reconcile pass. */
export const RECONCILE_RECALL_WINDOW = 200
/** Heartbeat dedup fires once the ad-hoc stored set reaches this size. */
export const DEFAULT_RECONCILE_TRIGGER_ENTRIES = 8

/** One reconciliation decision (the LLM emits a list of these). */
export type ReconcileOp =
  | { readonly op: 'add'; readonly text: string; readonly importance?: Importance }
  | { readonly op: 'update'; readonly id: string; readonly text: string; readonly importance?: Importance }
  | { readonly op: 'delete'; readonly id: string }
  | { readonly op: 'noop' }

export interface ReconcileOptions {
  /** The memory to reconcile. */
  memory: MemoryHandle
  /** The reconciliation LLM call. */
  summarize: MemorySummarizer
  /**
   * New candidate facts from the latest conversation (turn-boundary form).
   * Empty / omitted = pure dedup of the stored set (heartbeat form).
   */
  candidates?: readonly string[]
  /**
   * Scope the stored set + every write to one namespace (per-user no-leak).
   * Added/updated entries MUST carry the same scoping meta — pass it in
   * `entryMeta` so future passes still see them.
   */
  filter?: (entry: MemoryEntry) => boolean
  /** Which kind the reconciled facts live in. Default `'semantic'`. */
  kind?: MemoryKind
  /**
   * Which stored entries are eligible to reconcile. Default for `semantic`:
   * ad-hoc facts only (NOT cluster digests / profiles — those are owned by the
   * tiered pass). For other kinds: all of that kind.
   */
  existingFilter?: (entry: MemoryEntry) => boolean
  /** Max stored entries pulled for context. Default {@link RECONCILE_RECALL_WINDOW}. */
  recallK?: number
  /** Meta merged into every added/updated entry (e.g. `{ user: 'alice' }`). */
  entryMeta?: Record<string, unknown>
  /** Override the reconciliation system prompt. */
  system?: string
  /**
   * Opt-in (decision D): bitemporal mode. When true AND {@link closeEntry} is
   * supplied, an UPDATE keeps the old fact as a CLOSED time-edge (stamps its
   * `validTo`) and writes the new fact with `validFrom` + `supersedes`, instead
   * of forgetting the old one; a DELETE closes the interval instead of forgetting.
   * Default off → overwrite / true-delete, byte-identical to pre-D. Without
   * `closeEntry` it degrades to that default (the handle can't close in place).
   */
  bitemporal?: boolean
  /**
   * Required for {@link bitemporal} to take effect: close an entry's interval by
   * stamping `meta.validTo` in place (the handle has no meta-only update, so the
   * host wires a file-backed patch — see `closedMeta`).
   */
  closeEntry?: MemoryValidityWriter
  now?: () => number
}

export interface ReconcileResult {
  readonly added: number
  readonly updated: number
  readonly deleted: number
  readonly nooped: number
  /** True when the model response was unusable → zero ops ran (fail-soft). */
  readonly noModel: boolean
}

/**
 * Run one reconciliation pass. Returns `null` when there is nothing to do
 * (no stored facts and no candidates; or a pure-dedup pass over fewer than two
 * stored facts). Never throws on a bad model response — yields zero ops.
 */
export async function reconcile(opts: ReconcileOptions): Promise<ReconcileResult | null> {
  const kind: MemoryKind = opts.kind ?? 'semantic'
  const candidates = (opts.candidates ?? []).map((c) => c.trim()).filter(Boolean)

  const existing = await pullExisting(opts, kind)
  if (existing.length === 0 && candidates.length === 0) return null
  // Pure dedup of <2 facts has nothing to merge.
  if (candidates.length === 0 && existing.length < 2) return null

  const byId = new Map(existing.map((e) => [e.id, e]))
  const system = opts.system ?? DEFAULT_RECONCILE_SYSTEM
  const user = buildReconcilePrompt(existing, candidates)

  let raw = ''
  try {
    raw = (await opts.summarize({ system, user })).trim()
  } catch {
    raw = ''
  }
  const ops = parseReconcileOps(raw)
  if (ops === null) {
    return { added: 0, updated: 0, deleted: 0, nooped: 0, noModel: true }
  }

  const now = (opts.now ?? ((): number => Date.now()))()
  const baseMeta = opts.entryMeta ?? {}
  // Bitemporal mode needs a way to close intervals in place; without the writer
  // it degrades to the default overwrite/true-delete (the handle has no meta-only
  // update). Off by default → byte-identical to pre-D.
  const bitemporal = opts.bitemporal === true && !!opts.closeEntry
  const touched = new Set<string>() // an id may be acted on once (first op wins)
  let added = 0
  let updated = 0
  let deleted = 0
  let nooped = 0

  for (const op of ops) {
    if (op.op === 'noop') {
      nooped++
      continue
    }
    if (op.op === 'add') {
      const text = op.text.trim()
      if (!text) continue
      // bitemporal: stamp validFrom so every fact carries when it began.
      const addMeta = bitemporal ? openedMeta(baseMeta, now) : baseMeta
      await opts.memory.remember(makeEntry(kind, text, addMeta, clampImportance(op.importance), now))
      added++
      continue
    }
    // update / delete reference a stored id — fail-safe on phantom ids.
    const target = byId.get(op.id)
    if (!target || touched.has(op.id)) continue
    if (op.op === 'delete') {
      // bitemporal: close the interval (keep the history); else true-delete.
      if (bitemporal) await opts.closeEntry!(target, now)
      else await opts.memory.forget(op.id)
      touched.add(op.id)
      deleted++
      continue
    }
    // update: write the new fact BEFORE retiring the old (crash → transient
    // overlap, never a gap). bitemporal: the new fact carries validFrom +
    // supersedes and the old one is CLOSED (validTo stamped), not forgotten;
    // else overwrite — forget the old one.
    const text = op.text.trim()
    if (!text) continue
    const importance =
      op.importance !== undefined ? clampImportance(op.importance) : importanceOf(target)
    const updMeta = bitemporal ? openedMeta(baseMeta, now, op.id) : baseMeta
    await opts.memory.remember(makeEntry(kind, text, updMeta, importance, now))
    if (bitemporal) await opts.closeEntry!(target, now)
    else await opts.memory.forget(op.id)
    touched.add(op.id)
    updated++
  }

  return { added, updated, deleted, nooped, noModel: false }
}

/**
 * Adapt {@link reconcile} to a {@link MemoryReviewer}: each heartbeat tick
 * de-duplicates / supersedes the stored ad-hoc set (no candidates). Fires only
 * once the eligible set reaches `triggerEntries` (default
 * {@link DEFAULT_RECONCILE_TRIGGER_ENTRIES}) so it doesn't spend a model call on
 * a near-empty set every tick. Returns a one-line summary when it changed
 * anything, else `{}` (idle).
 */
export function reconcileReviewer(
  opts: Omit<ReconcileOptions, 'memory' | 'candidates' | 'now'> & { triggerEntries?: number },
): MemoryReviewer {
  const trigger = opts.triggerEntries ?? DEFAULT_RECONCILE_TRIGGER_ENTRIES
  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    const kind: MemoryKind = opts.kind ?? 'semantic'
    const eligible = await pullExisting({ ...opts, memory: ctx.memory }, kind)
    if (eligible.length < trigger) return {}

    const r = await reconcile({ ...opts, memory: ctx.memory, now: () => ctx.now })
    if (!r || (r.updated === 0 && r.deleted === 0 && r.added === 0)) return {}
    const parts: string[] = []
    if (r.updated > 0) parts.push(`merged ${r.updated}`)
    if (r.deleted > 0) parts.push(`dropped ${r.deleted}`)
    if (r.added > 0) parts.push(`added ${r.added}`)
    return { summary: `reconciled: ${parts.join(', ')}` }
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

export const DEFAULT_RECONCILE_SYSTEM = `You are a personal butler's memory curator performing RECONCILIATION.

You maintain a set of durable facts about the user. Given the CURRENT stored facts (each with an id) and, optionally, NEW candidate facts from the latest conversation, decide the MINIMAL set of edits so the stored facts stay correct, non-redundant, and current.

Emit one operation per decision:
- {"op":"add","text":"<new fact>","importance":3}                  a genuinely new fact not already stored
- {"op":"update","id":"<id>","text":"<merged fact>","importance":3} a stored fact a candidate corrects/refines — merge and keep the id
- {"op":"delete","id":"<id>"}                                       a stored fact now wrong or fully superseded
- {"op":"noop"}                                                     nothing to change (e.g. a candidate is already known)

Rules:
- Prefer UPDATE over add+delete when a candidate refines an existing fact ("moved from A to B" → update the residence fact).
- Only reference ids that appear in the stored-facts list. NEVER invent an id.
- Keep facts atomic and durable; drop one-off chatter.
- importance is 1 (trivial) to 5 (critical).

Output ONLY a JSON object, no prose:
{"ops":[ ... ]}`

async function pullExisting(
  opts: Pick<ReconcileOptions, 'memory' | 'filter' | 'kind' | 'existingFilter' | 'recallK'>,
  kind: MemoryKind,
): Promise<MemoryEntry[]> {
  const k = opts.recallK ?? RECONCILE_RECALL_WINDOW
  const all = await opts.memory.recall({ kinds: [kind], k })
  const scoped = opts.filter ? all.filter((e) => opts.filter!(e)) : all
  const eligible = opts.existingFilter ?? defaultExistingFilter(kind)
  return scoped.filter(eligible).sort((a, b) => a.ts - b.ts)
}

/** Default eligibility: for `semantic`, ad-hoc facts only (skip tiered digest/
 *  profile AND the flat consolidation profile, which their own passes own); for
 *  any other kind, all of it. `isClusterProfile` keys off `meta.level` so it
 *  only catches the TIERED profile; a flat `consolidate` profile carries just
 *  `meta.profile === true` (no level) → `isProfile` is the guard that protects
 *  it from being reconciled as if it were an editable ad-hoc fact. */
function defaultExistingFilter(kind: MemoryKind): (e: MemoryEntry) => boolean {
  if (kind !== 'semantic') return () => true
  return (e) => !isDigest(e) && !isClusterProfile(e) && !isProfile(e)
}

function makeEntry(
  kind: MemoryKind,
  text: string,
  baseMeta: Record<string, unknown>,
  importance: Importance,
  _now: number,
): NewMemoryEntry {
  return { kind, text, meta: { ...baseMeta, [META_IMPORTANCE]: importance } }
}

function buildReconcilePrompt(
  existing: ReadonlyArray<MemoryEntry>,
  candidates: ReadonlyArray<string>,
): string {
  const parts: string[] = ['[Stored facts — "id: text"]']
  if (existing.length === 0) parts.push('(none yet)')
  for (const e of existing) {
    parts.push(`- ${e.id}: ${e.text.replace(/\s*\n\s*/g, ' ').trim()}`)
  }
  parts.push('')
  if (candidates.length > 0) {
    parts.push('[New candidate facts from the latest conversation]')
    for (const c of candidates) parts.push(`- ${c}`)
    parts.push('')
  }
  parts.push('Output the JSON object of operations now.')
  return parts.join('\n')
}

/**
 * Tolerant ops parser. Returns `null` when the response is unusable (so the
 * caller reports `noModel` and changes nothing), or a validated op list (which
 * MAY be empty if every entry was malformed).
 */
function parseReconcileOps(raw: string): ReconcileOp[] | null {
  if (!raw) return null
  const objStart = raw.indexOf('{')
  const arrStart = raw.indexOf('[')
  // Accept either {"ops":[...]} or a bare [...] array. Use whichever bracket
  // opens FIRST — for a bare array the only `{` is an inner element, so keying
  // off `{` alone would slice out one element and miss the array.
  const useArray = arrStart >= 0 && (objStart < 0 || arrStart < objStart)
  let jsonText: string | null = null
  if (useArray) {
    const arrEnd = raw.lastIndexOf(']')
    if (arrEnd > arrStart) jsonText = raw.slice(arrStart, arrEnd + 1)
  } else if (objStart >= 0) {
    const end = raw.lastIndexOf('}')
    if (end > objStart) jsonText = raw.slice(objStart, end + 1)
  }
  if (!jsonText) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { ops?: unknown } | null)?.ops)
      ? (parsed as { ops: unknown[] }).ops
      : null
  if (!list) return null

  const ops: ReconcileOp[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const v = item as { op?: unknown; id?: unknown; text?: unknown; importance?: unknown }
    const op = typeof v.op === 'string' ? v.op : ''
    if (op === 'noop') {
      ops.push({ op: 'noop' })
    } else if (op === 'add') {
      if (typeof v.text === 'string' && v.text.trim()) {
        ops.push({ op: 'add', text: v.text, ...impField(v.importance) })
      }
    } else if (op === 'update') {
      if (typeof v.id === 'string' && v.id && typeof v.text === 'string' && v.text.trim()) {
        ops.push({ op: 'update', id: v.id, text: v.text, ...impField(v.importance) })
      }
    } else if (op === 'delete') {
      if (typeof v.id === 'string' && v.id) ops.push({ op: 'delete', id: v.id })
    }
  }
  return ops
}

function impField(raw: unknown): { importance?: Importance } {
  return typeof raw === 'number' ? { importance: clampImportance(raw) } : {}
}
