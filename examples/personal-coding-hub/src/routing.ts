/**
 * routing — the PURE planner that turns a coding goal into a dispatch decision.
 * This is the assertable core of 能力分派要合适: the router must route the RIGHT
 * agents for THIS goal, not run a fixed claude-code → codex pipeline every time.
 *
 *   · a trivial fix (typo / rename / one-liner) → just Codex, implement directly,
 *     no planning round;
 *   · a review/explain-only ask → just Claude Code, analyze, NO implementation;
 *   · anything that needs design before code → Claude Code drafts, Codex implements.
 *
 * Keyword heuristics stand in for an LLM's judgement so the demo is deterministic;
 * a real router reads the same goal and makes the same call. The classifier is a
 * pure function so the routing is inspectable and the demo can assert it.
 */

export type CodingAgent = 'claude-code' | 'codex'

export type RouteKind = 'plan-then-implement' | 'direct-fix' | 'review-only'

export interface RoutePlan {
  /** Ordered dispatch — one or two agents, the RIGHT ones for this goal. */
  agents: CodingAgent[]
  kind: RouteKind
  rationale: string
}

/** "Just look / explain, don't change code" → Claude Code only (no implementation). */
const REVIEW_ONLY = [/review/i, /audit/i, /don'?t change/i, /no code change/i, /explain/i, /审查/, /评审/, /别改/, /只看/]

/** "Tiny, no design needed" → Codex direct, skip the planning round. */
const TRIVIAL = [/typo/i, /rename/i, /bump.*version/i, /one[- ]?liner/i, /lint fix/i, /错别字/, /小改/, /改个名/]

export function planRoute(goal: string): RoutePlan {
  const g = goal.trim()
  if (REVIEW_ONLY.some((re) => re.test(g))) {
    return {
      agents: ['claude-code'],
      kind: 'review-only',
      rationale: '只审查 / 解释、不改代码 → 交给善于分析的 Claude Code,不派实现',
    }
  }
  if (TRIVIAL.some((re) => re.test(g))) {
    return {
      agents: ['codex'],
      kind: 'direct-fix',
      rationale: '改动琐碎(无需先设计) → 直接交给 Codex 实现,跳过规划回合',
    }
  }
  return {
    agents: ['claude-code', 'codex'],
    kind: 'plan-then-implement',
    rationale: '需要先设计再落地 → Claude Code 起草方案,Codex 据 PROGRESS.md 实现',
  }
}

/** Derive the per-agent prompt from the plan + goal (what a real router would write). */
export function dispatchPrompt(plan: RoutePlan, agent: CodingAgent, goal: string): string {
  if (agent === 'claude-code') {
    return plan.kind === 'review-only'
      ? `Review for the goal: ${goal}. Report findings; do NOT change code. Follow AGENTS.md.`
      : `Draft a short implementation plan for: ${goal}. Follow AGENTS.md.`
  }
  // codex
  return plan.kind === 'direct-fix'
    ? `Implement directly: ${goal}. Keep changes small; follow AGENTS.md.`
    : `Implement the plan from PROGRESS.md for: ${goal}. Keep changes small.`
}
