/**
 * routing — the PURE planner that turns a coding goal into a dispatch decision.
 * This is the assertable core of 合理地调度: the router must dispatch the RIGHT
 * coding agents for THIS goal, *combined with the user's standing arrangements* —
 * not run a fixed claude-code → codex pipeline every time.
 *
 * Two inputs, mirroring what the user asked for:
 *
 *   1. 分析任务 — `analyzeTask(goal)` reads the goal into structured facets
 *      (review-only? trivial? needs design first?). A real router model does this
 *      analysis; the keyword classifier stands in so the demo is deterministic.
 *
 *   2. 用户的安排 — a `RoutingPolicy` the user declares: which coder is good at
 *      what (`profiles`), which coders are off right now (`unavailable` — logged
 *      out / rate-limited / 不想用), a budget cap to one coder (`singleCoder`), and
 *      an optional preferred lead. This is the standing arrangement the hub is
 *      configured with.
 *
 * `planRoute(goal, policy)` COMBINES the two: it works out which roles the task
 * needs (a reviewer / an implementer / a lead+implementer), then fills each role
 * from the *available* roster by strength — degrading sensibly when the ideal
 * coder is off (the on-call coder covers it) rather than failing. So the SAME
 * goal routes DIFFERENTLY under different arrangements, and always to a coder
 * that can actually do it. Everything here is a pure function, so the routing is
 * inspectable and the demo can assert it without a real LLM.
 */

export type CodingAgent = 'claude-code' | 'codex'

/** Narrow an arbitrary value to a known coding-agent id. */
export function isAgent(x: unknown): x is CodingAgent {
  return x === 'claude-code' || x === 'codex'
}

// Coder aliases for reading names out of plain language (中英). The claude-code
// pattern is tried first and never matches "codex", so order is safe.
const AGENT_ALIASES: Array<[RegExp, CodingAgent]> = [
  [/claude[-\s]?code|claude/i, 'claude-code'],
  [/codex/i, 'codex'],
]

/** The coding agents named in a piece of text, in roster order (lead first). */
export function agentsIn(text: string): CodingAgent[] {
  const out: CodingAgent[] = []
  for (const [re, agent] of AGENT_ALIASES) if (re.test(text) && !out.includes(agent)) out.push(agent)
  return out
}

export type RouteKind = 'plan-then-implement' | 'direct-fix' | 'review-only'

export interface RoutePlan {
  /** Ordered dispatch — one or two coders, the RIGHT ones for goal × policy. */
  agents: CodingAgent[]
  kind: RouteKind
  /**
   * True when ONE coder covers a plan-then-implement task alone (the other is
   * off, or the budget caps to one) — it must both draft AND implement.
   */
  solo: boolean
  /** Why it routed this way — the proof the dispatch fitted goal AND arrangement. */
  rationale: string
}

/** What the user declares each coder is good at — the role-fill roster. */
export interface CoderProfile {
  agent: CodingAgent
  /** Strength tags the task's needed role is matched against. */
  strengths: string[]
}

/**
 * 用户的安排 — the standing arrangement the hub is configured with. The router
 * combines it with the task analysis to dispatch sensibly.
 */
export interface RoutingPolicy {
  /** The roster + what each coder is good at. */
  profiles: CoderProfile[]
  /** Coders off right now (logged out / rate-limited / 不想用) — never dispatched. */
  unavailable?: CodingAgent[]
  /** Budget: cap a dispatch to ONE coder (no plan+implement pair). */
  singleCoder?: boolean
  /** Preferred lead for design work, when more than one coder could lead. */
  preferLead?: CodingAgent
}

/**
 * The default roster: Claude Code leads analysis/design/refactor; Codex is the
 * fast implementer. Under this policy the routing reproduces the obvious calls
 * (review → Claude Code, trivial → Codex, feature → both).
 */
export const DEFAULT_CODING_POLICY: RoutingPolicy = {
  profiles: [
    { agent: 'claude-code', strengths: ['review', 'analysis', 'design', 'refactor', 'multi-file'] },
    { agent: 'codex', strengths: ['implement', 'quick-fix', 'scaffold', 'single-file'] },
  ],
}

/** The structured reading of a goal — what a router model extracts before routing. */
export interface TaskFacets {
  /** "Just look / explain, don't change code" → a reviewer, no implementation. */
  reviewOnly: boolean
  /** "Tiny, no design needed" → one implementer, skip the planning round. */
  trivial: boolean
  /** Needs design before code → a lead drafts, an implementer builds. */
  needsDesign: boolean
}

const REVIEW_ONLY = [/review/i, /audit/i, /don'?t change/i, /no code change/i, /explain/i, /审查/, /评审/, /别改/, /只看/]
const TRIVIAL = [/typo/i, /rename/i, /bump.*version/i, /one[- ]?liner/i, /lint fix/i, /错别字/, /小改/, /改个名/]

/** 分析任务 — read the goal into facets. (A real router model does this judgement.) */
export function analyzeTask(goal: string): TaskFacets {
  const g = goal.trim()
  const reviewOnly = REVIEW_ONLY.some((re) => re.test(g))
  const trivial = !reviewOnly && TRIVIAL.some((re) => re.test(g))
  return { reviewOnly, trivial, needsDesign: !reviewOnly && !trivial }
}

/**
 * 显式分派 — what the user named directly in the goal. When the goal itself names
 * coders ("交给 codex 实现", "claude-code 设计、codex 实现"), that overrides the
 * role-fill for THIS task; absent a naming, `agents` is undefined and planRoute
 * uses the standing arrangement instead. A real router reads this from the goal too.
 */
export interface ExplicitAssignment {
  /** Coders the user named in the goal, roster order — overrides role-fill. */
  agents?: CodingAgent[]
}

// A naming counts as an explicit dispatch only when a dispatch verb is also present,
// so "tidy claude-code's comments" (mentions a name, no dispatch intent) won't match.
const ASSIGN_TRIGGER = /交给|派给|分派|指定|让|用|route to|assign|dispatch/i

/** Read any explicit per-task assignment out of the goal (显式分派). */
export function parseExplicitAssignment(goal: string): ExplicitAssignment {
  const named = agentsIn(goal)
  if (named.length && ASSIGN_TRIGGER.test(goal)) return { agents: named }
  return {}
}

/**
 * 会诊触发 — does the goal explicitly ask for a multi-agent consult (会诊 / a
 * second opinion / find the real root cause)? When it does, the flow convenes the
 * diagnostic panel (blind → cross-examine → converge) INSTEAD of routing a normal
 * coding task; the real root cause then flows back to a coder as a fix. A real
 * router reads this intent from the goal the same way. `symptom` is the goal with
 * the trigger phrasing stripped — display only; the panel keys on a problem id.
 */
export interface ConsultRequest {
  consult: boolean
  symptom?: string
}

// `会诊(?:一下)?` swallows the common "会诊一下" particle so the stripped symptom
// doesn't lead with a dangling "一下:"; the optional group keeps bare "会诊" matching,
// and it can't over-eat (下午/下游 etc.) because only the full 一下 particle is consumed.
const CONSULT_TRIGGER = /会诊(?:一下)?|一起诊断|共同诊断|找(出|到)?根因|second opinion|consult\b|root[-\s]?cause/i

/** Detect an explicit 会诊 request in the goal (mirrors parseExplicitAssignment). */
export function parseConsultRequest(goal: string): ConsultRequest {
  if (!CONSULT_TRIGGER.test(goal)) return { consult: false }
  const symptom = goal
    .replace(CONSULT_TRIGGER, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:：,，.。-]+/, '')
    .trim()
  return { consult: true, symptom: symptom || goal.trim() }
}

/** The strength tag each role looks for when filling from the roster. */
const ROLE_STRENGTH = {
  reviewer: ['review', 'analysis'],
  lead: ['design', 'analysis', 'review'],
  implementer: ['implement', 'quick-fix', 'scaffold', 'single-file'],
} as const

/**
 * Combine 分析任务 (facets) with 用户的安排 (policy) into a dispatch decision.
 * Fills each role the task needs from the AVAILABLE roster by strength, degrading
 * to whoever is on-call when the ideal coder is off — so it never dispatches an
 * unavailable coder and never hard-fails when one is missing.
 */
export function planRoute(
  goal: string,
  policy: RoutingPolicy = DEFAULT_CODING_POLICY,
  override?: ExplicitAssignment,
): RoutePlan {
  const facets = analyzeTask(goal)
  const off = new Set(policy.unavailable ?? [])

  // 显式分派 wins: the user named the coder(s) for THIS task in the goal itself.
  // Honor on-call (never dispatch an off coder), keep lead→impl roles so the
  // handoff prompts still fit; if every named coder is off, fall through to the
  // standing arrangement (honest degrade).
  if (override?.agents?.length) {
    const named = override.agents.filter((a) => !off.has(a))
    if (named.length) {
      const kind: RouteKind = facets.reviewOnly
        ? 'review-only'
        : named.length === 1
          ? 'direct-fix'
          : 'plan-then-implement'
      const skipped = override.agents.filter((a) => off.has(a))
      const note = skipped.length ? ` (跳过不在岗的 ${skipped.join('/')})` : ''
      return {
        agents: named,
        kind,
        solo: named.length === 1 && kind !== 'review-only',
        rationale: `用户在目标里点名 → 按指定派给 ${named.join(' → ')}${note}`,
      }
    }
  }

  const available = policy.profiles.filter((p) => !off.has(p.agent))

  // Degenerate arrangement: the user took every coder off. Be honest, route none.
  if (available.length === 0) {
    return { agents: [], kind: 'review-only', solo: false, rationale: '没有在岗的编码 agent(全部被标记不可用) → 无法分派' }
  }

  const offNote = off.size ? `(${[...off].join('/')} 不在岗)` : ''

  if (facets.reviewOnly) {
    const reviewer = pick(available, ROLE_STRENGTH.reviewer, policy.preferLead)
    return {
      agents: [reviewer],
      kind: 'review-only',
      solo: false,
      rationale: `只审查 / 解释、不改代码 → 交给在岗最善分析的 ${reviewer}${offNote},不派实现`,
    }
  }

  if (facets.trivial) {
    const impl = pick(available, ROLE_STRENGTH.implementer)
    return {
      agents: [impl],
      kind: 'direct-fix',
      solo: false,
      rationale: `改动琐碎(无需先设计) → 直接交给在岗的 ${impl}${offNote} 实现,跳过规划回合`,
    }
  }

  // needsDesign: a lead drafts, an implementer builds.
  const lead = pick(available, ROLE_STRENGTH.lead, policy.preferLead)
  const implPool = available.filter((p) => p.agent !== lead)
  const impl = implPool.length ? pick(implPool, ROLE_STRENGTH.implementer) : lead

  // One coder covers it when the budget caps to one, or the lead is the only one
  // left on-call — then the lead both drafts and implements.
  if (policy.singleCoder || impl === lead) {
    const why = policy.singleCoder
      ? `预算限单 coder → 由主理 ${lead} 独立完成设计+实现`
      : `${[...off].join('/')} 不在岗 → 在岗的 ${lead} 一人包办设计+实现`
    return { agents: [lead], kind: 'plan-then-implement', solo: true, rationale: why }
  }

  return {
    agents: [lead, impl],
    kind: 'plan-then-implement',
    solo: false,
    rationale: `需要先设计再落地${offNote} → ${lead} 起草方案,${impl} 据 PROGRESS.md 实现`,
  }
}

/**
 * Pick the best available coder for a role: first one whose strengths match
 * `wanted` (a `prefer`-ed agent wins if it also qualifies), else degrade to the
 * first available coder so the task still gets done by someone on-call.
 */
function pick(available: CoderProfile[], wanted: readonly string[], prefer?: CodingAgent): CodingAgent {
  const qualifies = (p: CoderProfile) => p.strengths.some((s) => wanted.includes(s))
  if (prefer) {
    const p = available.find((x) => x.agent === prefer && qualifies(x))
    if (p) return p.agent
  }
  return (available.find(qualifies) ?? available[0]!).agent
}

/** Derive the per-agent prompt from the plan + goal (what a real router would write). */
export function dispatchPrompt(plan: RoutePlan, agent: CodingAgent, goal: string): string {
  if (agent === 'claude-code') {
    if (plan.kind === 'review-only') {
      return `Review for the goal: ${goal}. Report findings; do NOT change code. Follow AGENTS.md.`
    }
    // A solo lead must both plan AND implement — no implementer turn follows.
    return plan.solo
      ? `Draft a short plan AND implement it for: ${goal}. Keep changes small; follow AGENTS.md.`
      : `Draft a short implementation plan for: ${goal}. Follow AGENTS.md.`
  }
  // codex
  return plan.kind === 'direct-fix'
    ? `Implement directly: ${goal}. Keep changes small; follow AGENTS.md.`
    : `Implement the plan from PROGRESS.md for: ${goal}. Keep changes small.`
}
