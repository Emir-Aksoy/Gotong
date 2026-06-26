/**
 * Model price table + cost estimator (Phase 17 — Sprint 4).
 *
 * The identity ledger stores `cost_micros` already resolved — it is
 * deliberately model-agnostic. This module is where model-name → price
 * knowledge lives, and it lives in the host (not identity / llm) because
 * pricing is operator config: a deployment overrides it via a JSON file
 * in the workspace, the same way it configures everything else.
 *
 * Units: prices are USD per 1,000,000 tokens (the vendor list-price
 * convention). Cost is reported in integer **micro-USD** (1e-6 USD).
 * Handy identity: `tokens * pricePer1M == costMicros` exactly
 * (tokens/1e6 USD × 1e6 micros/USD), so the math is one multiply per
 * token class with a single round at the end — no float dollars ever
 * stored.
 *
 * The default table carries representative public list prices as of
 * early 2026; they WILL drift. Operators override per-model via
 * `<AIPE_SPACE>/pricing.json` (merged over the defaults at boot — see
 * {@link loadPricingTable}). An unknown model is not an error: tokens are
 * still recorded, cost is 0, and the row is flagged `unpriced` so a
 * dashboard can surface "counted, but not priced" rather than a silent $0.
 */

import { readFileSync } from 'node:fs'

/** Per-model rates, USD per 1M tokens. Cache rates default off `input`. */
export interface ModelPrice {
  /** USD per 1M fresh (un-cached) input tokens. */
  inputPer1M: number
  /** USD per 1M output tokens. */
  outputPer1M: number
  /**
   * USD per 1M cache-WRITE tokens. Omit → derived as `inputPer1M * 1.25`
   * (the Anthropic prompt-cache write premium).
   */
  cacheWritePer1M?: number
  /**
   * USD per 1M cache-READ tokens. Omit → derived as `inputPer1M * 0.1`
   * (the typical ~10× cache-read discount).
   */
  cacheReadPer1M?: number
}

export type PricingTable = Record<string, ModelPrice>

/** Just the token counts cost depends on (structurally an `LlmUsage`). */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
}

export interface CostEstimate {
  /** Integer micro-USD. 0 when `unpriced`. */
  costMicros: number
  /** True when no price entry matched `model` — tokens real, cost unknown. */
  unpriced: boolean
}

/**
 * Default price table. Keys are model-id PREFIXES: resolution does an
 * exact match first, then the LONGEST matching prefix, so a dated id like
 * `claude-opus-4-8-20260514` resolves off `claude-opus-4-8`. Cache rates
 * are omitted where they follow the standard derivation.
 *
 * Representative early-2026 list prices (USD / 1M tokens). OVERRIDE in
 * production via `<AIPE_SPACE>/pricing.json` — do not treat these as
 * billing-accurate.
 */
export const DEFAULT_PRICING: PricingTable = {
  // ---- Anthropic ----
  'claude-opus-4': { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4': { inputPer1M: 1, outputPer1M: 5 },
  'claude-3-5-haiku': { inputPer1M: 0.8, outputPer1M: 4 },
  'claude-3-5-sonnet': { inputPer1M: 3, outputPer1M: 15 },
  'claude-3-opus': { inputPer1M: 15, outputPer1M: 75 },
  // ---- OpenAI ----
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadPer1M: 0.075 },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10, cacheReadPer1M: 1.25 },
  'gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6, cacheReadPer1M: 0.1 },
  'gpt-4.1': { inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0.5 },
  'o4-mini': { inputPer1M: 1.1, outputPer1M: 4.4, cacheReadPer1M: 0.275 },
  // ---- DeepSeek (cache-hit pricing is steep; set read explicitly) ----
  'deepseek-chat': { inputPer1M: 0.27, outputPer1M: 1.1, cacheReadPer1M: 0.07 },
  'deepseek-reasoner': {
    inputPer1M: 0.55,
    outputPer1M: 2.19,
    cacheReadPer1M: 0.14,
  },
  // ---- Qwen (Alibaba) ----
  'qwen-max': { inputPer1M: 1.6, outputPer1M: 6.4 },
  'qwen-plus': { inputPer1M: 0.4, outputPer1M: 1.2 },
}

/**
 * Resolve a model id to its price: exact match, else the longest table
 * key the id starts with. Returns `undefined` when nothing matches.
 */
export function resolveModelPrice(
  model: string,
  table: PricingTable = DEFAULT_PRICING,
): ModelPrice | undefined {
  if (Object.prototype.hasOwnProperty.call(table, model)) return table[model]
  let best: ModelPrice | undefined
  let bestLen = -1
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = table[key]
      bestLen = key.length
    }
  }
  return best
}

/**
 * Estimate the cost of one LLM call in integer micro-USD. Token counts
 * default to 0 (missing cache fields are the common case). Unknown model
 * → `{ costMicros: 0, unpriced: true }`.
 */
export function estimateCostMicros(
  usage: TokenUsage,
  model: string,
  table: PricingTable = DEFAULT_PRICING,
): CostEstimate {
  const price = resolveModelPrice(model, table)
  if (!price) return { costMicros: 0, unpriced: true }
  const cacheWrite = price.cacheWritePer1M ?? price.inputPer1M * 1.25
  const cacheRead = price.cacheReadPer1M ?? price.inputPer1M * 0.1
  const micros =
    num(usage.inputTokens) * price.inputPer1M +
    num(usage.outputTokens) * price.outputPer1M +
    num(usage.cacheCreationTokens) * cacheWrite +
    num(usage.cacheReadTokens) * cacheRead
  return { costMicros: Math.max(0, Math.round(micros)), unpriced: false }
}

/**
 * Load the effective price table. `overridePath` missing / unreadable →
 * defaults silently (the normal case — most deployments ship no override).
 * Present-but-malformed (bad JSON or a bad price entry) → THROWS: a
 * misconfigured billing table must fail loud at boot, never silently bill
 * at the wrong rate. Override entries merge OVER the defaults per-model.
 */
export function loadPricingTable(overridePath?: string): PricingTable {
  if (!overridePath) return { ...DEFAULT_PRICING }
  let raw: string
  try {
    raw = readFileSync(overridePath, 'utf8')
  } catch {
    // No file (ENOENT) or unreadable → defaults. This is expected.
    return { ...DEFAULT_PRICING }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `pricing override ${overridePath} is not valid JSON: ${(err as Error).message}`,
    )
  }
  const own = validatePricingTable(parsed, overridePath)
  return { ...DEFAULT_PRICING, ...own }
}

/**
 * Validate a parsed pricing object's OWN entries (NO default merge) and return
 * it as a typed {@link PricingTable}. Throws loud on a non-object top level or
 * any bad entry. This is the single shape authority, reused by both boot-time
 * {@link loadPricingTable} AND the deterministic `setting` config-write editor —
 * so a price written through the console is rejected the same way and BEFORE it
 * lands on disk, never silently at the next boot. `label` names the source in
 * error messages (an override path at boot; e.g. "pricing.json" for the editor),
 * so the boot-path messages stay byte-identical to before.
 */
export function validatePricingTable(parsed: unknown, label: string): PricingTable {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `pricing override ${label} must be a JSON object of { model: { inputPer1M, outputPer1M, … } }`,
    )
  }
  const table: PricingTable = {}
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    table[model] = validatePrice(model, value, label)
  }
  return table
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function num(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function validatePrice(
  model: string,
  value: unknown,
  path: string,
): ModelPrice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `pricing override ${path}: model "${model}" must be an object with numeric rates`,
    )
  }
  const v = value as Record<string, unknown>
  const inputPer1M = requireRate(v.inputPer1M, model, 'inputPer1M', path)
  const outputPer1M = requireRate(v.outputPer1M, model, 'outputPer1M', path)
  const out: ModelPrice = { inputPer1M, outputPer1M }
  if (v.cacheWritePer1M !== undefined) {
    out.cacheWritePer1M = requireRate(v.cacheWritePer1M, model, 'cacheWritePer1M', path)
  }
  if (v.cacheReadPer1M !== undefined) {
    out.cacheReadPer1M = requireRate(v.cacheReadPer1M, model, 'cacheReadPer1M', path)
  }
  return out
}

function requireRate(
  v: unknown,
  model: string,
  field: string,
  path: string,
): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new Error(
      `pricing override ${path}: model "${model}" field "${field}" must be a non-negative number; got ${JSON.stringify(v)}`,
    )
  }
  return v
}
