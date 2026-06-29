/**
 * tiers.ts — multi-level long-term memory: TOPIC CLUSTERS × IMPORTANCE-GRADED
 * LEVELS (decision ③ "两者结合").
 *
 * The butler's long-term memory is not one flat profile. It is a small set of
 * topic CLUSTERS (画像 / 项目 / 人物 / 承诺 / 其它), and within each cluster a
 * two-LEVEL pyramid distilled from raw episodic capture:
 *
 *   episodic (raw, shared, pre-cluster)          ← capture writes here
 *       │  consolidateTiered: route + distill per cluster
 *       ▼
 *   per-cluster DIGEST  (meta.level='digest')    ← mid layer, accumulates
 *       │  promoteCluster: importance-gated fold
 *       ▼
 *   per-cluster PROFILE (meta.level='profile')   ← stable layer, one per cluster
 *
 * Both digest and profile are ordinary `semantic` entries — the level lives in
 * `meta.level` and the cluster in `meta.tier`, so this is ZERO schema change and
 * the byte-stable frozen block keeps working (it just groups by cluster in the
 * frozen-block work). A cluster profile is ALSO `meta.profile=true`, so anything
 * that already reads "the curated profile" still sees it.
 *
 * This module is the pure vocabulary: the cluster catalog, the meta accessors,
 * and a no-LLM fallback router. The distillation orchestration lives in
 * `consolidate-tiered.ts`.
 */

import type { MemoryEntry } from '@aipehub/services-sdk'

export const META_TIER = 'tier'
export const META_LEVEL = 'level'

/** The two long-term levels within a cluster. */
export type MemoryLevel = 'digest' | 'profile'

export interface TierSpec {
  /** Stable cluster id (used in `meta.tier` + the routing prompt). */
  id: string
  /** Human label (zh) for UI / prompt. */
  label?: string
  /** One line telling the router what belongs in this cluster. */
  description?: string
  /**
   * Optional substring hints for the no-LLM {@link routeFallback}. NOT used on
   * the happy path (the LLM routes) — only when the router response is unusable,
   * so a hiccup degrades routing quality instead of losing the batch.
   */
  keywords?: readonly string[]
}

export interface TierConfig {
  readonly tiers: readonly TierSpec[]
  /** Cluster for content that fits nothing else / un-routable. Must be a tier id. */
  readonly defaultTier: string
}

/** Default clusters for a personal butler. Override per deployment. */
export const DEFAULT_TIERS: TierConfig = {
  tiers: [
    {
      id: 'persona',
      label: '画像',
      description:
        'Stable facts about the user themselves — identity, preferences, situation, recurring traits and habits.',
      keywords: ['喜欢', '偏好', '习惯', '我是', 'prefer', 'i am', 'i like'],
    },
    {
      id: 'projects',
      label: '项目',
      description: 'Ongoing work, goals, plans and their current status.',
      keywords: ['项目', '计划', '目标', 'project', 'goal', 'plan'],
    },
    {
      id: 'people',
      label: '人物',
      description: 'Important people in the user’s life and the user’s relationship with them.',
      keywords: ['朋友', '同事', '家人', '老板', 'friend', 'colleague', 'boss'],
    },
    {
      id: 'commitments',
      label: '承诺',
      description: 'Promises, deadlines, appointments and things owed in either direction.',
      keywords: ['答应', '承诺', '约定', '截止', 'deadline', 'promise', 'appointment'],
    },
    {
      id: 'misc',
      label: '其它',
      description: 'Anything durable that does not fit another cluster.',
    },
  ],
  defaultTier: 'misc',
}

/** Read an entry's cluster from meta, defaulting to `fallback`. */
export function tierOf(entry: Pick<MemoryEntry, 'meta'>, fallback: string): string {
  const t = (entry.meta as { tier?: unknown } | undefined)?.tier
  return typeof t === 'string' && t.length > 0 ? t : fallback
}

/** Read an entry's level from meta, or undefined if it is not a tiered entry. */
export function levelOf(entry: Pick<MemoryEntry, 'meta'>): MemoryLevel | undefined {
  const l = (entry.meta as { level?: unknown } | undefined)?.level
  return l === 'digest' || l === 'profile' ? l : undefined
}

export function isDigest(entry: Pick<MemoryEntry, 'meta'>): boolean {
  return levelOf(entry) === 'digest'
}

export function isClusterProfile(entry: Pick<MemoryEntry, 'meta'>): boolean {
  return levelOf(entry) === 'profile'
}

/** Is `id` a configured cluster? */
export function isKnownTier(config: TierConfig, id: string): boolean {
  return config.tiers.some((t) => t.id === id)
}

/** Map an arbitrary id onto a known cluster (unknown / missing → defaultTier). */
export function normalizeTier(config: TierConfig, id: string | undefined): string {
  return id && isKnownTier(config, id) ? id : config.defaultTier
}

/**
 * Deterministic, no-LLM router used as the FALLBACK when the routing summarizer
 * returns nothing usable. Scans the entry text for each cluster's keyword hints
 * (in catalog order, first match wins); anything unmatched → defaultTier. The
 * point is to NEVER lose an episodic batch to a bad LLM response — degraded
 * routing beats a dropped batch.
 */
export function routeFallback(config: TierConfig, entry: MemoryEntry): string {
  const text = entry.text.toLowerCase()
  for (const t of config.tiers) {
    for (const kw of t.keywords ?? []) {
      if (kw && text.includes(kw.toLowerCase())) return t.id
    }
  }
  return config.defaultTier
}
