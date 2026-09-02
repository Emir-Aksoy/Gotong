/**
 * assoc-net.ts — 联想网 (memory economy M2): the derived associative layer.
 *
 * The diagnosis this module answers, in the user's words: *agent 的记忆还是一块
 * 一块的，人的记忆是整体的*. Today a butler's knowledge is scattered across
 * separate stores — episodic/semantic memory, a knowledge tree, a task notebook,
 * a session window, long-run dossiers — and recall can only reach ONE of them.
 * The measured cost (memory-economy M1, `check:memory-integration`): cross-store
 * recall@5 = 16.7%, with three of six questions scoring a flat zero because
 * their answer lives in a store recall structurally cannot emit.
 *
 * The net does not become a new store. Its contract, in one line:
 *
 *   **网里没有一个字节是孤本** — every node is a POINTER into a store that already
 *   owns the truth. Delete this whole layer and not one byte of user data is
 *   lost; the next tick rebuilds it.
 *
 * That is what makes the net safe to derive, cache, drop and re-derive, and it
 * is why nothing here writes: this module is pure functions over a node set.
 *
 * # What is deliberately NOT here
 *
 *   - **No store knowledge.** {@link AssocStore} is an open string: the net does
 *     not know that a butler happens to have a knowledge tree or a task
 *     notebook. Store names are the CALLER's vocabulary. `personal-memory` has
 *     no host/identity dependency and this module does not add one.
 *   - **No LLM, no I/O.** Three of the four edge kinds are computed from text and
 *     timestamps; the fourth (`semantic`) is READ VERBATIM off the links the 6h
 *     maintenance chain already wrote (`meta.links`). The net therefore adds
 *     ZERO model calls — it spends what has already been paid for.
 *   - **No deletion.** Nothing here drops, closes or forgets anything. The memory
 *     economy has exactly one deletion enforcement point and it is not this one.
 *
 * # Size is bounded by construction, not by hope
 *
 * Each node keeps at most K edges per kind ({@link DEFAULT_EDGE_TOP_K}), so the
 * TOTAL edge count is `<= nodes x kinds x K` — linear in the node set, and it is
 * itself bounded by the stores' own existing budgets. Diffusion is capped at
 * {@link DEFAULT_HOPS} hops with a frontier cap. No layer here grows with the
 * number of conversation turns.
 */

import { extractTerms } from './relevance.js'

// ---------------------------------------------------------------------------
// nodes and edges
// ---------------------------------------------------------------------------

/**
 * Which store owns a node's truth. An OPEN string on purpose — see the module
 * docblock: the net must not know the caller's store taxonomy.
 */
export type AssocStore = string

/**
 * One pointer into one store. `text` is a SURFACE — the caller has already
 * trimmed it to a display-sized excerpt; the full truth stays in the store.
 */
export interface AssocNode {
  /** Globally unique across stores. The caller owns the encoding (e.g. `store:pointer`). */
  readonly id: string
  /** Which store owns this node's truth. */
  readonly store: AssocStore
  /** Surface text used for ranking and for the memory sheet. */
  readonly text: string
  /** Epoch ms of the underlying fact. */
  readonly ts: number
  /**
   * Keep-value. The caller supplies it on ONE consistent scale (memory nodes go
   * through `effectiveSalience`, other stores get a constant) — the net only
   * ever compares salience values to each other, never to a magic number.
   * Non-positive salience makes a node structurally unreachable, so
   * {@link DEFAULT_NODE_SALIENCE} is the "no opinion" value, NOT zero.
   */
  readonly salience: number
  /** Optional bitemporal validity. A node closed before `now` never diffuses. */
  readonly validFrom?: number
  readonly validTo?: number
  /**
   * Ids this node is already recorded as related to — read verbatim from the
   * existing `meta.links`. The net spends these; it never computes new ones with
   * a model.
   */
  readonly links?: readonly string[]
}

/**
 * Why two nodes are connected. The four kinds are the design's four edge types:
 *
 *   - `semantic`  an association ALREADY recorded in `meta.links` (strongest —
 *                 something decided these belong together and paid for it)
 *   - `origin`    one node's text names the other's pointer (a task note that
 *                 cites a knowledge path, a dossier that names a task id)
 *   - `cooccur`   term overlap — the workhorse that reaches ACROSS stores
 *   - `temporal`  written close together in time
 */
export type AssocEdgeKind = 'semantic' | 'origin' | 'cooccur' | 'temporal'

export interface AssocEdge {
  readonly from: string
  readonly to: string
  readonly kind: AssocEdgeKind
  /** Edge strength in (0,1]. Multiplied into the diffusion score. */
  readonly weight: number
}

/**
 * How many edges each node may KEEP per kind. A pair survives if either endpoint
 * kept it, so this caps the TOTAL at `nodes x topK` per kind — the constructive
 * size bound. It does NOT cap a single node's degree: a hub that everything
 * resembles gets picked by many others. That is fine — diffusion costs O(edges)
 * per hop, and edges stay linear in the node count.
 */
export const DEFAULT_EDGE_TOP_K = 5

/** Salience to use when the caller has no opinion. Never 0 — see {@link AssocNode.salience}. */
export const DEFAULT_NODE_SALIENCE = 1

/** Base weight per edge kind, strongest first. */
export const EDGE_KIND_WEIGHT: Readonly<Record<AssocEdgeKind, number>> = {
  semantic: 1,
  origin: 0.9,
  cooccur: 0.7,
  temporal: 0.4,
}

/** Two nodes written within this long of each other may earn a `temporal` edge. */
export const DEFAULT_TEMPORAL_WINDOW_MS = 24 * 60 * 60 * 1000

/** Term-overlap below this earns no `cooccur` edge (pure noise otherwise). */
export const DEFAULT_COOCCUR_MIN = 0.08

export interface DeriveEdgesOptions {
  /** Edges kept per node per kind. Default {@link DEFAULT_EDGE_TOP_K}. */
  topK?: number
  /** Minimum term overlap for a `cooccur` edge. Default {@link DEFAULT_COOCCUR_MIN}. */
  cooccurMin?: number
  /** Temporal window in ms. Default {@link DEFAULT_TEMPORAL_WINDOW_MS}. */
  temporalWindowMs?: number
}

/**
 * Derive the net's edges from a node set. Zero LLM, zero I/O, deterministic:
 * the same node SET yields the same edge list regardless of input order (pairs
 * are emitted with the lexicographically smaller id as `from`, and the list is
 * sorted).
 *
 * Every edge is UNDIRECTED in effect — {@link diffuse} walks both ways. Emitting
 * one row per pair (rather than two) keeps the size bound honest and makes the
 * top-K cap mean what it says.
 *
 * Per kind, each node keeps at most `topK` of its strongest edges; a pair
 * survives if EITHER endpoint kept it (the same symmetrizing rule
 * `buildLinkGraph` uses — relatedness is mutual).
 */
export function deriveEdges(
  nodes: readonly AssocNode[],
  opts: DeriveEdgesOptions = {},
): AssocEdge[] {
  const topK = Math.max(0, Math.floor(opts.topK ?? DEFAULT_EDGE_TOP_K))
  const cooccurMin = opts.cooccurMin ?? DEFAULT_COOCCUR_MIN
  const window = Math.max(0, opts.temporalWindowMs ?? DEFAULT_TEMPORAL_WINDOW_MS)
  if (topK === 0 || nodes.length < 2) return []

  const byId = new Map<string, AssocNode>()
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n)
  const uniq = [...byId.values()]
  const terms = new Map<string, Set<string>>()
  for (const n of uniq) terms.set(n.id, new Set(extractTerms(n.text)))

  // Candidate scores per kind, per node — capped to topK before merging.
  const cand: Record<AssocEdgeKind, Map<string, { to: string; s: number }[]>> = {
    semantic: new Map(),
    origin: new Map(),
    cooccur: new Map(),
    temporal: new Map(),
  }
  const push = (kind: AssocEdgeKind, from: string, to: string, s: number): void => {
    if (s <= 0) return
    pushInto(cand[kind], from, { to, s })
  }

  for (const a of uniq) {
    // semantic — verbatim from the links already on the node. Only links that
    // point at a node IN THIS SET become edges; a dangling id is silently
    // skipped rather than inventing a node for it.
    for (const id of a.links ?? []) {
      if (id !== a.id && byId.has(id)) push('semantic', a.id, id, 1)
    }
    for (const b of uniq) {
      if (a.id >= b.id) continue // one row per unordered pair
      // origin — one node's text names the other's pointer verbatim
      if (namesPointer(a, b) || namesPointer(b, a)) push('origin', a.id, b.id, 1)
      // cooccur — symmetric term overlap (Jaccard), the cross-store workhorse
      const j = jaccard(terms.get(a.id)!, terms.get(b.id)!)
      if (j >= cooccurMin) push('cooccur', a.id, b.id, j)
      // temporal — written close together
      if (window > 0) {
        const gap = Math.abs(a.ts - b.ts)
        if (gap <= window) push('temporal', a.id, b.id, 1 - gap / (window + 1))
      }
    }
  }

  // A pair survives if either endpoint kept it in its own top-K.
  const kept = new Map<string, AssocEdge>()
  for (const kind of ['semantic', 'origin', 'cooccur', 'temporal'] as const) {
    const perNode = new Map<string, { to: string; s: number }[]>()
    for (const [from, list] of cand[kind]) {
      for (const { to, s } of list) {
        pushInto(perNode, from, { to, s })
        pushInto(perNode, to, { to: from, s })
      }
    }
    for (const [from, list] of perNode) {
      const top = [...list]
        .sort((x, y) => (x.s !== y.s ? y.s - x.s : cmp(x.to, y.to)))
        .slice(0, topK)
      for (const { to, s } of top) {
        const lo = from < to ? from : to
        const hi = from < to ? to : from
        const key = `${kind} ${lo} ${hi}`
        const weight = EDGE_KIND_WEIGHT[kind] * clamp01(s)
        const prev = kept.get(key)
        if (!prev || weight > prev.weight) kept.set(key, { from: lo, to: hi, kind, weight })
      }
    }
  }

  return [...kept.values()].sort(
    (a, b) => cmp(a.kind, b.kind) || cmp(a.from, b.from) || cmp(a.to, b.to),
  )
}

// ---------------------------------------------------------------------------
// diffusion — seeds spread outward, bounded
// ---------------------------------------------------------------------------

/** How many hops a seed's activation travels. */
export const DEFAULT_HOPS = 2

/** Activation surviving one hop, before edge weight. */
export const DEFAULT_HOP_DECAY = 0.5

/** Cap on how many nodes a single diffusion may activate. */
export const DEFAULT_MAX_ACTIVATED = 200

export interface DiffuseOptions {
  /** Hops to walk. Default {@link DEFAULT_HOPS}. */
  hops?: number
  /** Per-hop decay. Default {@link DEFAULT_HOP_DECAY}. */
  hopDecay?: number
  /** Drop activations at or below this. Default 0. */
  minScore?: number
  /** Cap on activated nodes. Default {@link DEFAULT_MAX_ACTIVATED}. */
  maxActivated?: number
  /** Clock for bitemporal filtering. Omit → no validity filtering. */
  now?: number
}

export interface AssocActivation {
  readonly id: string
  readonly store: AssocStore
  readonly score: number
  /** 0 for a seed, else the fewest hops at which activation reached it. */
  readonly hops: number
}

/**
 * Spread seed activation across the net and return every activated node,
 * strongest first.
 *
 *   score(v) = ( sum over every path seed->v of  seed x hopDecay^hops x prod(weights) )
 *              x salience(v)
 *
 * Three deliberate choices:
 *
 *   - **Multi-path SUM.** Being reachable from several seeds, or by several
 *     routes, is EVIDENCE — the design says 多路径求和 and that is what makes a
 *     node sitting between two matched facts outrank one hanging off a single
 *     thread.
 *   - **Salience multiplies ONCE, at the destination.** Applying it per hop
 *     would square it on 2-hop paths and quietly turn a keep-value into a
 *     path-length penalty.
 *   - **Closed facts never diffuse.** With `now` set, a node whose validity has
 *     ended is neither activated nor traversed — 双时态翻篇 is structural here,
 *     not a post-filter someone can forget to apply.
 *
 * Deterministic and pure. Ties break by id so the order is total.
 */
export function diffuse(
  seeds: ReadonlyMap<string, number>,
  nodes: readonly AssocNode[],
  edges: readonly AssocEdge[],
  opts: DiffuseOptions = {},
): AssocActivation[] {
  const hops = Math.max(0, Math.floor(opts.hops ?? DEFAULT_HOPS))
  const decay = opts.hopDecay ?? DEFAULT_HOP_DECAY
  const minScore = opts.minScore ?? 0
  const maxActivated = Math.max(1, Math.floor(opts.maxActivated ?? DEFAULT_MAX_ACTIVATED))
  const now = opts.now

  const byId = new Map<string, AssocNode>()
  for (const n of nodes) {
    if (byId.has(n.id)) continue
    if (now !== undefined && !isOpenAt(n, now)) continue // 翻篇的不进网
    byId.set(n.id, n)
  }

  const adj = new Map<string, { to: string; weight: number }[]>()
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.weight <= 0) continue
    pushInto(adj, e.from, { to: e.to, weight: e.weight })
    pushInto(adj, e.to, { to: e.from, weight: e.weight })
  }

  const total = new Map<string, number>()
  const firstHop = new Map<string, number>()
  let frontier = new Map<string, number>()
  for (const [id, s] of seeds) {
    if (!byId.has(id) || !(s > 0)) continue
    frontier.set(id, (frontier.get(id) ?? 0) + s)
    total.set(id, (total.get(id) ?? 0) + s)
    firstHop.set(id, 0)
  }

  for (let h = 1; h <= hops && frontier.size > 0; h++) {
    const next = new Map<string, number>()
    for (const [u, act] of frontier) {
      for (const { to, weight } of adj.get(u) ?? []) {
        const add = act * decay * weight
        if (!(add > 0)) continue
        next.set(to, (next.get(to) ?? 0) + add)
      }
    }
    for (const [id, act] of next) {
      total.set(id, (total.get(id) ?? 0) + act)
      if (!firstHop.has(id)) firstHop.set(id, h)
    }
    frontier = next
  }

  const out: AssocActivation[] = []
  for (const [id, raw] of total) {
    const n = byId.get(id)
    if (!n) continue
    const score = raw * Math.max(0, n.salience)
    if (score <= minScore) continue
    out.push({ id, store: n.store, score, hops: firstHop.get(id) ?? 0 })
  }
  out.sort((a, b) => (a.score !== b.score ? b.score - a.score : cmp(a.id, b.id)))
  return out.slice(0, maxActivated)
}

// ---------------------------------------------------------------------------
// per-store quota — no single store may crowd out the rest
// ---------------------------------------------------------------------------

/**
 * Cap how many rows any one store may contribute, preserving rank order.
 *
 * Without this a store that happens to hold many near-duplicate surfaces (the
 * session window, typically) fills the page and the answer that lives elsewhere
 * never gets shown — the exact failure M1 measured, only with the stores swapped.
 * A `quota` map lets the caller cap stores differently; a number caps them all.
 */
export function applyStoreQuota<T extends { readonly store: AssocStore }>(
  ranked: readonly T[],
  quota: number | ReadonlyMap<AssocStore, number>,
): T[] {
  const used = new Map<AssocStore, number>()
  const out: T[] = []
  for (const row of ranked) {
    const cap =
      typeof quota === 'number' ? quota : (quota.get(row.store) ?? Number.POSITIVE_INFINITY)
    const n = used.get(row.store) ?? 0
    if (n >= cap) continue
    used.set(row.store, n + 1)
    out.push(row)
  }
  return out
}

// ---------------------------------------------------------------------------
// 记忆单 — the bounded, attributed page handed to the model
// ---------------------------------------------------------------------------

/** Byte budget for a memory sheet. */
export const DEFAULT_SHEET_BYTES = 2000

/** Hard cap on sheet lines, so a tiny-text corpus cannot produce a hundred rows. */
export const DEFAULT_SHEET_LINES = 12

export interface MemorySheetOptions {
  /** Byte budget (UTF-8). Default {@link DEFAULT_SHEET_BYTES}. */
  maxBytes?: number
  /** Line cap. Default {@link DEFAULT_SHEET_LINES}. */
  maxLines?: number
}

/**
 * Render nodes as the memory sheet: one line each, carrying the DATE and the
 * OWNING STORE, budgeted in bytes.
 *
 * Attribution is not decoration. A line the model cannot trace back to a store
 * is a line it will treat as its own belief; the `[date . store]` prefix is what
 * lets both the model and the reader go check. The date is there for the same
 * reason — a fact without a time cannot be reasoned about as stale.
 *
 * Budgeting is by BYTES, measured, because the caller's budget is a token budget
 * and CJK text costs several bytes per character; counting lines alone would let
 * one long row blow the frame. A row that would overflow is SKIPPED (not
 * truncated mid-sentence) and the scan continues — a later short row still gets
 * its place.
 *
 * Deterministic: same nodes in, same string out. No clock is read.
 */
export function renderMemorySheet(
  rows: readonly AssocNode[],
  opts: MemorySheetOptions = {},
): string {
  const maxBytes = Math.max(0, Math.floor(opts.maxBytes ?? DEFAULT_SHEET_BYTES))
  const maxLines = Math.max(0, Math.floor(opts.maxLines ?? DEFAULT_SHEET_LINES))
  if (maxBytes === 0 || maxLines === 0) return ''

  const lines: string[] = []
  let used = 0
  for (const n of rows) {
    if (lines.length >= maxLines) break
    const line = `- [${isoDay(n.ts)} ${n.store}] ${n.text}`
    const cost = utf8Len(line) + (lines.length > 0 ? 1 : 0) // + the newline
    if (used + cost > maxBytes) continue
    used += cost
    lines.push(line)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** `true` when `b`'s pointer (the part after the store prefix) appears in `a`'s text. */
function namesPointer(a: AssocNode, b: AssocNode): boolean {
  const i = b.id.indexOf(':')
  const pointer = i >= 0 ? b.id.slice(i + 1) : b.id
  // A one-or-two character pointer would match almost any text by accident.
  return pointer.length >= 3 && a.text.includes(pointer)
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function isOpenAt(n: AssocNode, now: number): boolean {
  if (typeof n.validFrom === 'number' && now < n.validFrom) return false
  if (typeof n.validTo === 'number' && now >= n.validTo) return false
  return true
}

function pushInto<T>(m: Map<string, T[]>, k: string, v: T): void {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isoDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function utf8Len(s: string): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}
