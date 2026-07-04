/**
 * consolidate-tiered.ts — the tiered (clustered, importance-graded) curation
 * pass, the runtime of decision ③ "两者结合".
 *
 * Two orchestrators on top of the flat {@link consolidate} machinery:
 *
 *   - `consolidateTiered` — fold the raw `episodic` backlog into per-cluster
 *     DIGESTS. One LLM call ROUTES the batch into clusters AND distills each
 *     (structured JSON), so routing and summarizing share a single pass. A bad
 *     LLM response never loses the batch: it falls back to a deterministic,
 *     no-LLM keyword router (`routeFallback`) and flags `routedByFallback`.
 *
 *   - `promoteCluster` — when a cluster has accumulated enough digests, collapse
 *     them into ONE stable cluster PROFILE. This is the importance gate: digests
 *     below `minImportance` are DROPPED (not folded), high-importance ones are
 *     distilled into the durable profile (which reuses `distillWithinCap`'s
 *     hard-cap-or-throw policy — the profile is the bounded layer).
 *
 * `tieredReviewer` wires both onto the heartbeat (Stream D) the same way
 * `consolidateReviewer` wires the flat path.
 *
 * Like `consolidate`, this never imports `@gotong/llm`: it takes a
 * {@link MemorySummarizer} callback, so it is trivially testable with a
 * deterministic fake that returns the routing JSON / profile text.
 *
 * Tiered and flat are ALTERNATIVE strategies for one memory, not stacked: the
 * tiered path reads/writes only entries it recognizes by `meta.tier`+`meta.level`,
 * and the flat path writes a tier-less `meta.profile=true` — wire one reviewer,
 * not both, onto a given memory.
 */

import { enforceBudget, type MemoryUsageMeasure } from './budget.js'
import {
  DEFAULT_CONSOLIDATE_KEEP_RECENT,
  DEFAULT_PROFILE_HARD_CAP,
  META_PROFILE,
  distillWithinCap,
  shouldConsolidate,
  type MemorySummarizer,
} from './consolidate.js'
import {
  DEFAULT_IMPORTANCE,
  META_IMPORTANCE,
  clampImportance,
  importanceOf,
  type Importance,
} from './importance.js'
import type { MemoryReviewer, ReviewContext, ReviewOutcome } from './review.js'
import {
  DEFAULT_TIERS,
  META_LEVEL,
  META_TIER,
  isClusterProfile,
  isDigest,
  normalizeTier,
  routeFallback,
  tierOf,
  type TierConfig,
} from './tiers.js'

import type { MemoryEntry, MemoryHandle, NewMemoryEntry } from '@gotong/services-sdk'

const META_CONSOLIDATED_AT = 'consolidatedAt'
const RECALL_WINDOW = 200

/** Soft hard-cap on a single mid-tier digest (truncated, not thrown). */
export const DEFAULT_DIGEST_HARD_CAP = 1_200
/** Promote a cluster once it holds at least this many digests. */
export const DEFAULT_PROMOTE_AFTER_DIGESTS = 4
/** On promotion, digests below this importance are DROPPED (not folded). */
export const DEFAULT_PROMOTE_MIN_IMPORTANCE: Importance = 2

// ── consolidateTiered ──────────────────────────────────────────────────────

export interface ConsolidateTieredOptions {
  memory: MemoryHandle
  summarize: MemorySummarizer
  /** Cluster catalog. Default {@link DEFAULT_TIERS}. */
  config?: TierConfig
  /** Scope every read/fold to one namespace (per-user no-leak). */
  filter?: (entry: MemoryEntry) => boolean
  /** Meta merged into every written digest (e.g. `{ user: 'alice' }`). */
  entryMeta?: Record<string, unknown>
  /** Recent episodic entries left verbatim. Default {@link DEFAULT_CONSOLIDATE_KEEP_RECENT}. */
  keepRecent?: number
  triggerEntries?: number
  triggerBytes?: number
  /** Per-digest char cap (truncated). Default {@link DEFAULT_DIGEST_HARD_CAP}. */
  digestHardCap?: number
  /** Run regardless of the trigger. */
  force?: boolean
  /** Override the routing system prompt. */
  system?: string
  now?: () => number
}

export interface TieredDigest {
  readonly tier: string
  readonly entry: MemoryEntry
  readonly importance: Importance
}

export interface ConsolidateTieredResult {
  /** Episodic entries folded into digests. */
  readonly consolidatedCount: number
  /** Digests written this pass. */
  readonly digests: ReadonlyArray<TieredDigest>
  /** True when the LLM router failed and the deterministic fallback was used. */
  readonly routedByFallback: boolean
}

/**
 * One tiered consolidation pass. Returns `null` when there is nothing to do
 * (under trigger and not forced, or too few episodic entries). Writes all
 * cluster digests BEFORE forgetting episodic (crash → duplicate, never a gap).
 */
export async function consolidateTiered(
  opts: ConsolidateTieredOptions,
): Promise<ConsolidateTieredResult | null> {
  const config = opts.config ?? DEFAULT_TIERS

  if (
    !opts.force &&
    !(await shouldConsolidate({
      memory: opts.memory,
      summarize: opts.summarize,
      ...(opts.filter ? { filter: opts.filter } : {}),
      ...(opts.triggerEntries !== undefined ? { triggerEntries: opts.triggerEntries } : {}),
      ...(opts.triggerBytes !== undefined ? { triggerBytes: opts.triggerBytes } : {}),
    }))
  ) {
    return null
  }

  const keepRecent = clampPositive(opts.keepRecent, DEFAULT_CONSOLIDATE_KEEP_RECENT)
  const now = (opts.now ?? ((): number => Date.now()))()

  const episodic = (await pullEpisodic(opts.memory, opts.filter)).sort((a, b) => a.ts - b.ts)
  if (episodic.length <= keepRecent) return null
  const toFold = episodic.slice(0, episodic.length - keepRecent)

  // Existing cluster profiles ride along as read-only background so each digest
  // captures only what is NEW (promoteCluster owns the profiles, not this pass).
  const background = await pullTiered(opts.memory, opts.filter, isClusterProfile, config)

  const { clusters, routedByFallback } = await routeAndDistill({
    summarize: opts.summarize,
    ...(opts.system !== undefined ? { system: opts.system } : {}),
    config,
    background,
    toFold,
  })

  const digestHardCap = clampPositive(opts.digestHardCap, DEFAULT_DIGEST_HARD_CAP)
  const digests: TieredDigest[] = []
  for (const c of clusters) {
    const text = capText(c.digest, digestHardCap)
    if (!text) continue
    const meta: Record<string, unknown> = {
      ...(opts.entryMeta ?? {}),
      [META_TIER]: c.tier,
      [META_LEVEL]: 'digest',
      [META_IMPORTANCE]: c.importance,
      [META_CONSOLIDATED_AT]: now,
    }
    const entry = await opts.memory.remember({ kind: 'semantic', text, meta } as NewMemoryEntry)
    digests.push({ tier: c.tier, entry, importance: c.importance })
  }

  // Defensive: produced nothing (both routing AND fallback empty) → leave the
  // episodic in place so a later pass retries; never forget without a write.
  if (digests.length === 0) return null

  let consolidatedCount = 0
  for (const e of toFold) {
    try {
      await opts.memory.forget(e.id)
      consolidatedCount++
    } catch {
      // straggler — the digest already covers it; a later pass retries
    }
  }

  return { consolidatedCount, digests, routedByFallback }
}

// ── promoteCluster ───────────────────────────────────────────────────────────

export interface PromoteClusterOptions {
  memory: MemoryHandle
  summarize: MemorySummarizer
  /** Which cluster to collapse. */
  tier: string
  config?: TierConfig
  filter?: (entry: MemoryEntry) => boolean
  entryMeta?: Record<string, unknown>
  /** Digests below this importance are dropped (not folded). Default {@link DEFAULT_PROMOTE_MIN_IMPORTANCE}. */
  minImportance?: Importance
  /** Promote once the cluster has this many digests. Default {@link DEFAULT_PROMOTE_AFTER_DIGESTS}. */
  promoteAfterDigests?: number
  /** Hard cap on the durable profile. Default {@link DEFAULT_PROFILE_HARD_CAP}. */
  profileHardCap?: number
  /** Promote regardless of the digest-count threshold. */
  force?: boolean
  system?: string
  now?: () => number
}

export interface PromoteClusterResult {
  readonly tier: string
  /** The new stable cluster profile, or null when there was nothing durable to keep. */
  readonly profile: MemoryEntry | null
  readonly foldedDigests: number
  readonly droppedDigests: number
  readonly absorbedProfiles: number
  readonly bytes: number
}

/**
 * Collapse one cluster's digests into a single stable cluster profile. Returns
 * `null` when the cluster has no digests, or fewer than `promoteAfterDigests`
 * and not forced. The importance gate: digests `< minImportance` are dropped;
 * the rest (plus any prior cluster profile) are distilled into the durable
 * profile. Throws `PersonalMemoryError('semantic_overflow')` if the profile
 * cannot fit its hard cap (via {@link distillWithinCap}).
 */
export async function promoteCluster(
  opts: PromoteClusterOptions,
): Promise<PromoteClusterResult | null> {
  const config = opts.config ?? DEFAULT_TIERS
  const tier = opts.tier
  const inTier = (e: MemoryEntry): boolean => tierOf(e, config.defaultTier) === tier

  const digests = (await pullTiered(opts.memory, opts.filter, isDigest, config))
    .filter(inTier)
    .sort((a, b) => a.ts - b.ts)
  if (digests.length === 0) return null

  const promoteAfter = opts.promoteAfterDigests ?? DEFAULT_PROMOTE_AFTER_DIGESTS
  if (!opts.force && digests.length < promoteAfter) return null

  const minImportance = opts.minImportance ?? DEFAULT_PROMOTE_MIN_IMPORTANCE
  const kept = digests.filter((d) => importanceOf(d) >= minImportance)
  const dropped = digests.filter((d) => importanceOf(d) < minImportance)
  const priorProfiles = (await pullTiered(opts.memory, opts.filter, isClusterProfile, config))
    .filter(inTier)
    .sort((a, b) => a.ts - b.ts)

  const now = (opts.now ?? ((): number => Date.now()))()

  // Everything trivial and nothing durable yet → just drop the trivial digests
  // to reclaim space; do not synthesize an empty profile.
  if (kept.length === 0 && priorProfiles.length === 0) {
    const droppedDigests = await forgetAll(opts.memory, dropped)
    return { tier, profile: null, foldedDigests: 0, droppedDigests, absorbedProfiles: 0, bytes: 0 }
  }

  const system = opts.system ?? buildPromoteSystem(config, tier)
  const user = buildPromotePrompt(priorProfiles, kept)
  const hardCap = clampPositive(opts.profileHardCap, DEFAULT_PROFILE_HARD_CAP)
  const profileText = await distillWithinCap(opts.summarize, { system, user }, hardCap)

  const importance = profileImportance(kept, priorProfiles)
  const meta: Record<string, unknown> = {
    ...(opts.entryMeta ?? {}),
    [META_TIER]: tier,
    [META_LEVEL]: 'profile',
    [META_PROFILE]: true,
    [META_IMPORTANCE]: importance,
    [META_CONSOLIDATED_AT]: now,
  }
  // Write the profile BEFORE forgetting anything it folds (crash → duplicate).
  const profile = await opts.memory.remember({ kind: 'semantic', text: profileText, meta } as NewMemoryEntry)

  const foldedDigests = await forgetAll(opts.memory, kept)
  const droppedDigests = await forgetAll(opts.memory, dropped)
  const absorbedProfiles = await forgetAll(opts.memory, priorProfiles)

  return { tier, profile, foldedDigests, droppedDigests, absorbedProfiles, bytes: profileText.length }
}

// ── tieredReviewer ───────────────────────────────────────────────────────────

export interface TieredReviewerOptions
  extends Omit<ConsolidateTieredOptions, 'memory' | 'now'> {
  /** Importance gate forwarded to {@link promoteCluster}. */
  promoteMinImportance?: Importance
  /** Digest count that triggers promotion. */
  promoteAfterDigests?: number
  /** Hard cap on durable cluster profiles. */
  profileHardCap?: number
  /**
   * Whole-namespace byte ceiling. When set, each tick runs `enforceBudget`
   * AFTER consolidate+promote — consolidation reclaims space non-destructively
   * first, then deterministic eviction is the hard backstop. Omit = no ceiling
   * (per-layer caps only, today's behavior).
   */
  budgetBytes?: number
  /** How to measure namespace usage for the budget. Default = entry text+meta
   *  UTF-8 bytes. Host can inject a real folder `du`. */
  measureBytes?: MemoryUsageMeasure
  /** Recent episodic entries the budget never evicts. */
  protectRecentEpisodic?: number
}

/**
 * Adapt the tiered pass to a {@link MemoryReviewer} for the heartbeat: each tick
 * runs `consolidateTiered`, then `promoteCluster` for every cluster that has
 * accumulated enough digests. Returns a one-line summary, or `{}` (idle) when
 * nothing happened.
 */
export function tieredReviewer(opts: TieredReviewerOptions): MemoryReviewer {
  const config = opts.config ?? DEFAULT_TIERS
  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    const consolidated = await consolidateTiered({ ...opts, memory: ctx.memory, now: () => ctx.now })

    let promotedClusters = 0
    let promotedDropped = 0
    for (const t of config.tiers) {
      const r = await promoteCluster({
        memory: ctx.memory,
        summarize: opts.summarize,
        tier: t.id,
        config,
        ...(opts.filter ? { filter: opts.filter } : {}),
        ...(opts.entryMeta ? { entryMeta: opts.entryMeta } : {}),
        ...(opts.promoteMinImportance !== undefined ? { minImportance: opts.promoteMinImportance } : {}),
        ...(opts.promoteAfterDigests !== undefined ? { promoteAfterDigests: opts.promoteAfterDigests } : {}),
        ...(opts.profileHardCap !== undefined ? { profileHardCap: opts.profileHardCap } : {}),
        now: () => ctx.now,
      })
      if (r?.profile) promotedClusters++
      if (r) promotedDropped += r.droppedDigests
    }

    // Hard backstop: after compaction reclaimed what it could, deterministically
    // evict down to the byte ceiling if one is configured.
    let evicted = 0
    let stillOver = false
    if (opts.budgetBytes !== undefined) {
      const b = await enforceBudget({
        memory: ctx.memory,
        budgetBytes: opts.budgetBytes,
        config,
        ...(opts.filter ? { filter: opts.filter } : {}),
        ...(opts.measureBytes ? { measure: opts.measureBytes } : {}),
        ...(opts.protectRecentEpisodic !== undefined
          ? { protectRecentEpisodic: opts.protectRecentEpisodic }
          : {}),
        now: () => ctx.now,
      })
      if (b) {
        evicted = b.evicted
        stillOver = b.stillOverBudget
      }
    }

    if (!consolidated && promotedClusters === 0 && promotedDropped === 0 && evicted === 0) return {}
    const parts: string[] = []
    if (consolidated) {
      parts.push(
        `tiered ${consolidated.consolidatedCount} episodic → ${consolidated.digests.length} cluster digest(s)${
          consolidated.routedByFallback ? ' (fallback routing)' : ''
        }`,
      )
    }
    if (promotedClusters > 0) parts.push(`promoted ${promotedClusters} cluster(s)`)
    if (promotedDropped > 0) parts.push(`dropped ${promotedDropped} trivial digest(s)`)
    if (evicted > 0) parts.push(`budget evicted ${evicted}${stillOver ? ' (STILL over)' : ''}`)
    return { summary: parts.join('; '), consolidated: consolidated?.consolidatedCount ?? 0 }
  }
}

// ── internals ────────────────────────────────────────────────────────────────

interface ClusterDigest {
  tier: string
  digest: string
  importance: Importance
}

const DEFAULT_TIERED_SYSTEM = `You are a personal butler's memory curator. You ROUTE recent conversation into topic clusters and write a concise digest for each.

For the conversation entries below, decide which cluster(s) the durable content belongs to, and write a short digest per cluster (a few tight bullets). Drop one-off chatter and anything already covered by an existing cluster profile. Give each cluster an importance 1-5 (1 trivial, 3 ordinary, 5 critical / must-keep).

Output ONLY a JSON object, no prose:
{"clusters":{"<clusterId>":{"digest":"...","importance":3}}}
Include a cluster key ONLY if it has durable content. Use the cluster ids from the catalog.`

async function routeAndDistill(args: {
  summarize: MemorySummarizer
  system?: string
  config: TierConfig
  background: ReadonlyArray<MemoryEntry>
  toFold: ReadonlyArray<MemoryEntry>
}): Promise<{ clusters: ClusterDigest[]; routedByFallback: boolean }> {
  const system = args.system ?? DEFAULT_TIERED_SYSTEM
  const user = buildRoutingPrompt(args.config, args.background, args.toFold)
  let raw = ''
  try {
    raw = (await args.summarize({ system, user })).trim()
  } catch {
    raw = ''
  }
  const parsed = parseClusterDigests(raw, args.config)
  if (parsed.length > 0) return { clusters: parsed, routedByFallback: false }
  return { clusters: fallbackBuckets(args.config, args.toFold), routedByFallback: true }
}

function parseClusterDigests(raw: string, config: TierConfig): ClusterDigest[] {
  if (!raw) return []
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let obj: unknown
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  const root = obj as { clusters?: unknown } | undefined
  const clusters =
    root && typeof root === 'object' && root.clusters && typeof root.clusters === 'object'
      ? (root.clusters as Record<string, unknown>)
      : (obj as Record<string, unknown> | undefined)
  if (!clusters || typeof clusters !== 'object') return []

  const byTier = new Map<string, ClusterDigest>()
  for (const [key, val] of Object.entries(clusters)) {
    if (!val || typeof val !== 'object') continue
    const v = val as { digest?: unknown; importance?: unknown }
    const digest = typeof v.digest === 'string' ? v.digest.trim() : ''
    if (!digest) continue
    const importance = clampImportance(v.importance)
    const tier = normalizeTier(config, key)
    const prev = byTier.get(tier)
    if (prev) {
      prev.digest = `${prev.digest}\n${digest}`
      if (importance > prev.importance) prev.importance = importance
    } else {
      byTier.set(tier, { tier, digest, importance })
    }
  }
  return [...byTier.values()]
}

function fallbackBuckets(config: TierConfig, toFold: ReadonlyArray<MemoryEntry>): ClusterDigest[] {
  const byTier = new Map<string, string[]>()
  for (const e of toFold) {
    const tier = routeFallback(config, e)
    const arr = byTier.get(tier) ?? []
    arr.push(e.text.replace(/\s*\n\s*/g, ' ').trim())
    byTier.set(tier, arr)
  }
  return [...byTier.entries()].map(([tier, texts]) => ({
    tier,
    digest: texts.join('\n'),
    importance: DEFAULT_IMPORTANCE,
  }))
}

function buildRoutingPrompt(
  config: TierConfig,
  background: ReadonlyArray<MemoryEntry>,
  toFold: ReadonlyArray<MemoryEntry>,
): string {
  const parts: string[] = ['[Clusters — route into these ids]']
  for (const t of config.tiers) {
    parts.push(`- ${t.id}${t.label ? ` (${t.label})` : ''}: ${t.description ?? ''}`)
  }
  parts.push('')
  if (background.length > 0) {
    parts.push('[Existing cluster profiles — background only, do NOT repeat; capture only what is new]')
    for (const p of background) {
      parts.push(`## ${tierOf(p, config.defaultTier)}`)
      parts.push(p.text)
      parts.push('')
    }
    parts.push('---')
    parts.push('')
  }
  parts.push(`[${toFold.length} recent conversation entries to route (oldest first)]`)
  for (const e of toFold) {
    parts.push(e.text)
    parts.push('')
  }
  parts.push('Output the JSON object now.')
  return parts.join('\n')
}

function buildPromoteSystem(config: TierConfig, tier: string): string {
  const spec = config.tiers.find((t) => t.id === tier)
  const name = spec?.label ? `${tier} (${spec.label})` : tier
  return (
    `You are a personal butler's memory curator. Collapse the cluster "${name}" into ONE stable profile. ` +
    `${spec?.description ?? ''} ` +
    'Carry forward an earlier profile if present, merge in the digests, drop anything superseded, ' +
    'and write a readable profile (short headed sections or tight bullets). Output the profile body only.'
  )
}

function buildPromotePrompt(
  priorProfiles: ReadonlyArray<MemoryEntry>,
  kept: ReadonlyArray<MemoryEntry>,
): string {
  const parts: string[] = []
  if (priorProfiles.length > 0) {
    parts.push('[Earlier cluster profile — carry its core forward, merge in only what is new]')
    for (const p of priorProfiles) {
      parts.push(p.text)
      parts.push('')
    }
    parts.push('---')
    parts.push('')
  }
  parts.push(`[${kept.length} cluster digest(s) to fold in (oldest first)]`)
  for (const d of kept) {
    parts.push(d.text)
    parts.push('')
  }
  parts.push('Output the curated cluster profile (see the rules in the system prompt).')
  return parts.join('\n')
}

async function pullEpisodic(
  memory: MemoryHandle,
  filter?: (e: MemoryEntry) => boolean,
): Promise<MemoryEntry[]> {
  const all = await memory.recall({ kinds: ['episodic'], k: RECALL_WINDOW })
  return filter ? all.filter(filter) : all
}

/** Pull semantic entries matching a level predicate (digest / profile), scoped. */
async function pullTiered(
  memory: MemoryHandle,
  filter: ((e: MemoryEntry) => boolean) | undefined,
  level: (e: MemoryEntry) => boolean,
  _config: TierConfig,
): Promise<MemoryEntry[]> {
  const all = await memory.recall({ kinds: ['semantic'], k: RECALL_WINDOW })
  return all.filter(level).filter((e) => (filter ? filter(e) : true))
}

async function forgetAll(memory: MemoryHandle, entries: ReadonlyArray<MemoryEntry>): Promise<number> {
  let n = 0
  for (const e of entries) {
    try {
      await memory.forget(e.id)
      n++
    } catch {
      // tolerate a straggler — the new profile already covers it
    }
  }
  return n
}

function profileImportance(
  kept: ReadonlyArray<MemoryEntry>,
  priorProfiles: ReadonlyArray<MemoryEntry>,
): Importance {
  let max = 0
  for (const e of [...kept, ...priorProfiles]) max = Math.max(max, importanceOf(e))
  return max > 0 ? (clampImportance(max) as Importance) : DEFAULT_IMPORTANCE
}

function capText(text: string, cap: number): string {
  const t = text.replace(/[ \t]+\n/g, '\n').trim()
  if (!t) return ''
  return t.length <= cap ? t : `${t.slice(0, Math.max(1, cap - 1))}…`
}

function clampPositive(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}
