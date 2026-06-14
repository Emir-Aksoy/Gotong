/**
 * policy — persist + edit the STANDING division of labour (「总分工层」) in plain
 * language, so the end user changes who-does-what WITHOUT editing code.
 *
 * routing.ts decides per-task dispatch from a RoutingPolicy. Until now that policy
 * was a hard-coded TS object (the deterministic demo) or baked into the router's
 * system prompt (the real CLI) — neither changeable by a "5-minutes, no code" user.
 * This module makes the policy a FILE (the single source of truth, living next to
 * the repo so copying the repo carries the arrangement) and turns a sentence like
 * "codex 今天不在岗" / "以后让 claude-code 主理" into a policy edit written back to
 * that file. Both run modes derive from the same file: the deterministic planRoute
 * reads it directly; the real router renders it into its system prompt.
 *
 * The natural-language parser here is a deterministic stand-in (keyword / pattern,
 * 中英) — the SAME role a real LLM plays, but assertable without a key. Swap it for
 * an LLM call and the file contract is unchanged. Mirrors router-provider.ts: the
 * mechanism (a sentence → a policy edit → written back → both modes re-derive) is
 * what matters, not which brain parses the sentence.
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { DEFAULT_CODING_POLICY, agentsIn, isAgent, type CodingAgent, type RoutingPolicy } from './routing.js'

// ——— persistence: the policy file is the single source of truth ———

/**
 * Load the standing arrangement from a JSON file. Best-effort: a missing file is
 * the first-run default; a corrupt one falls back to the default roster (with a
 * warning) rather than crashing the hub — the user can always re-state it in words.
 */
export function loadPolicy(path: string): RoutingPolicy {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RoutingPolicy>
    return normalizePolicy(parsed)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[policy] ${path} 读取失败, 回落默认 roster: ${(err as Error).message}`)
    }
    return clonePolicy(DEFAULT_CODING_POLICY)
  }
}

/** Write the standing arrangement back (pretty JSON + trailing newline). */
export function savePolicy(path: string, policy: RoutingPolicy): void {
  writeFileSync(path, JSON.stringify(policy, null, 2) + '\n')
}

/** Deep-copy a policy so edits never mutate DEFAULT_CODING_POLICY's shared arrays. */
export function clonePolicy(p: RoutingPolicy): RoutingPolicy {
  return {
    profiles: p.profiles.map((x) => ({ agent: x.agent, strengths: [...x.strengths] })),
    ...(p.unavailable ? { unavailable: [...p.unavailable] } : {}),
    ...(p.singleCoder !== undefined ? { singleCoder: p.singleCoder } : {}),
    ...(p.preferLead ? { preferLead: p.preferLead } : {}),
  }
}

/** Coerce a parsed-from-disk shape into a valid policy (drops junk, keeps defaults). */
function normalizePolicy(p: Partial<RoutingPolicy>): RoutingPolicy {
  const base = clonePolicy(DEFAULT_CODING_POLICY)
  if (Array.isArray(p.profiles) && p.profiles.length) {
    const profiles = p.profiles
      .filter((x) => x && isAgent(x.agent) && Array.isArray(x.strengths))
      .map((x) => ({ agent: x.agent, strengths: x.strengths.map(String) }))
    if (profiles.length) base.profiles = profiles
  }
  if (Array.isArray(p.unavailable)) {
    const off = p.unavailable.filter(isAgent)
    if (off.length) base.unavailable = off
    else delete base.unavailable
  } else delete base.unavailable
  if (typeof p.singleCoder === 'boolean') {
    if (p.singleCoder) base.singleCoder = true
    else delete base.singleCoder
  } else delete base.singleCoder
  if (isAgent(p.preferLead)) base.preferLead = p.preferLead
  else delete base.preferLead
  return base
}

// ——— natural-language editing of the standing arrangement ———

export interface PolicyEditResult {
  /** The policy AFTER the edit (unchanged if nothing was understood). */
  policy: RoutingPolicy
  /** Human-readable 中文 summary of each change, for echoing back to the user. */
  changes: string[]
  /** false → no clause matched; the caller tells the user "没听懂, 换个说法". */
  understood: boolean
}

// One intent per clause. 中英 patterns. OFF is tested before ON because "不在岗"
// contains "在岗" — testing OFF first keeps "codex 不在岗" from reading as on-call.
const OFF_RE = /不在岗|下线|登出|离线|限流|歇|不可用|别用|停用|rate.?limit|unavailable|\boff\b|log(?:ged)?\s?out/i
const ON_RE = /回来|上线|在岗|可用|恢复|启用|\bback\b|\bon\b|available/i
const LEAD_RE = /主理|主导|带头|领头|主力|负责设计|\blead\b|prefer/i
const SINGLE_ON_RE = /限单|只用一个|省着|省点|预算|一个人|单个|\bsingle\b|budget|one\s?(?:coder|agent)/i
const SINGLE_OFF_RE = /放开|都用|两个都|不限|\bfull\b|\bboth\b|unlimited/i

/**
 * Apply a plain-language instruction to the standing arrangement. Splits compound
 * sentences ("codex 不在岗, claude 主理") into clauses and applies one intent each,
 * so the deterministic stand-in handles the common multi-part case too. A real LLM
 * would parse the whole sentence; the file contract it produces is identical.
 */
export function applyPolicyEdit(policy: RoutingPolicy, instruction: string): PolicyEditResult {
  let next = clonePolicy(policy)
  const changes: string[] = []
  for (const clause of splitClauses(instruction)) {
    next = applyOne(next, clause, changes)
  }
  // Re-clone so the result keys are in canonical order (profiles → unavailable →
  // singleCoder → preferLead) regardless of which clause set which — keeps the
  // persisted routing-policy.json deterministic across edit orders (clean diffs).
  return { policy: clonePolicy(next), changes, understood: changes.length > 0 }
}

function applyOne(policy: RoutingPolicy, clause: string, changes: string[]): RoutingPolicy {
  const next = clonePolicy(policy)
  const named = agentsIn(clause)

  // on-call ⇄ off-call — needs a named coder.
  if (OFF_RE.test(clause) && named.length) {
    const off = new Set(next.unavailable ?? [])
    for (const a of named) if (!off.has(a)) { off.add(a); changes.push(`${a} → 标记不在岗`) }
    next.unavailable = [...off]
  } else if (ON_RE.test(clause) && named.length) {
    const off = new Set(next.unavailable ?? [])
    for (const a of named) if (off.delete(a)) changes.push(`${a} → 恢复在岗`)
    if (off.size) next.unavailable = [...off]
    else delete next.unavailable
  }

  // preferred lead — needs a named coder.
  if (LEAD_RE.test(clause) && named.length) {
    const lead = named[0]!
    if (next.preferLead !== lead) { next.preferLead = lead; changes.push(`主理 → ${lead}`) }
  }

  // budget cap — no coder needed (OFF wins over ON if both somehow match).
  if (SINGLE_OFF_RE.test(clause)) {
    if (next.singleCoder) { delete next.singleCoder; changes.push('预算 → 放开 (可派两个 coder)') }
  } else if (SINGLE_ON_RE.test(clause)) {
    if (!next.singleCoder) { next.singleCoder = true; changes.push('预算 → 限单 coder') }
  }

  return next
}

/** Split a compound instruction into single-intent clauses. */
function splitClauses(text: string): string[] {
  return text
    .split(/[、,，;；。\n]+|\s+(?:然后|而且|并且|以及)\s+|\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean)
}

// ——— rendering (read-out for the user + prompt injection for the real router) ———

/** The on-call coders (roster minus those marked unavailable). */
export function onCall(policy: RoutingPolicy): CodingAgent[] {
  const off = new Set(policy.unavailable ?? [])
  return policy.profiles.map((p) => p.agent).filter((a) => !off.has(a))
}

/** 中文 read-out of the standing arrangement — what `:roster` prints. */
export function describePolicy(policy: RoutingPolicy): string[] {
  const lines = policy.profiles.map((p) => `  · ${p.agent} 擅长: ${p.strengths.join(' / ')}`)
  lines.push(`  · 在岗: ${onCall(policy).join(', ') || '无'}`)
  if (policy.unavailable?.length) lines.push(`  · 不在岗: ${policy.unavailable.join(', ')}`)
  lines.push(`  · 主理: ${policy.preferLead ?? '(按任务自动选)'}`)
  lines.push(`  · 预算: ${policy.singleCoder ? '限单 coder (主理一人包办)' : '可派两个 coder'}`)
  return lines
}

/**
 * English render of the standing arrangement for the REAL router's system prompt.
 * The policy file is the source of truth; the real LLM router reads THIS so a file
 * edit changes the model's judgement without touching code (real-agents.ts M3).
 */
export function renderPolicyForPrompt(policy: RoutingPolicy): string {
  const lines = ['Current standing arrangement (the user can change this any time):']
  for (const p of policy.profiles) lines.push(`  - ${p.agent} is good at: ${p.strengths.join(', ')}.`)
  if (policy.unavailable?.length) {
    lines.push(`  - OFF-CALL right now — NEVER dispatch: ${policy.unavailable.join(', ')}. The on-call coder covers that role.`)
  } else {
    lines.push('  - All coders are on-call.')
  }
  if (policy.preferLead) lines.push(`  - Preferred lead for design work: ${policy.preferLead}.`)
  if (policy.singleCoder) lines.push('  - Budget caps to ONE coder: the lead drafts AND implements itself (no implementer turn).')
  return lines.join('\n')
}
