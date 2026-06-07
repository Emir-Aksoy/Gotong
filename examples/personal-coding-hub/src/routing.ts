/**
 * routing — the PURE planner that turns a coding goal into a dispatch SCHEDULE.
 * This is the assertable core of 合理地调度多个代码 agent: the router must dispatch
 * the RIGHT coders for THIS goal, *combined with the user's standing arrangements*,
 * and — when the goal has independent parts — fan them out across SEVERAL coders
 * that work in parallel. Not a fixed claude-code → codex pipeline every time.
 *
 * Two inputs, mirroring what the user asked for:
 *
 *   1. 分析任务 — `analyzeTask(goal)` reads the goal into structured facets
 *      (review-only? trivial? needs design first? does it split into independent
 *      PARTS?). A real router model does this analysis; the keyword classifier
 *      stands in so the demo is deterministic.
 *
 *   2. 用户的安排 — a `RoutingPolicy` the user declares: which coder is good at
 *      what (`profiles` — an OPEN roster of N coders, not a hard-coded two), which
 *      coders are off right now (`unavailable`), a budget cap to one coder
 *      (`singleCoder`), and an optional preferred lead.
 *
 * `planRoute(goal, policy)` COMBINES the two into a `RoutePlan` with a structured
 * `steps` schedule:
 *
 *   · wave 0 — the LEAD (drafts the plan / does the review). Runs first.
 *   · wave 1 — the IMPLEMENTERS. A multi-part goal gets ONE implementer per part,
 *     filled from the AVAILABLE roster by strength; they share wave 1, so an
 *     orchestrator runs them CONCURRENTLY. Fewer coders on-call than parts → parts
 *     fold onto the coders there are (never dropped, never a coder doing two tasks
 *     at once). Budget-capped / only-the-lead-left → the lead does everything solo.
 *
 * So the SAME goal schedules DIFFERENTLY under different arrangements — to one
 * coder, to a lead+implementer pair, or to a lead plus several parallel
 * implementers — and always to coders that can actually do it. Everything here is
 * a pure function, so the schedule is inspectable and the demo asserts it without
 * a real LLM.
 */

/**
 * A coder is just a roster id (string), so the roster is OPEN — add `aider`,
 * `goose`, a second `claude-code` instance, … by adding a profile. (It used to be
 * a hard-coded `'claude-code' | 'codex'` union, which capped the hub at two.)
 */
export type CodingAgent = string

export type RouteKind = 'plan-then-implement' | 'plan-then-parallel' | 'direct-fix' | 'review-only'

/** What a step's coder is there to do — drives the prompt, not the coder's id. */
export type RouteRole = 'lead' | 'review' | 'implement'

/** One scheduled dispatch. Steps sharing a `wave` run concurrently. */
export interface RouteStep {
  agent: CodingAgent
  role: RouteRole
  /**
   * The independent deliverable(s) this step builds (for a multi-part feature).
   * Absent for review / a single-part implement / a solo lead.
   */
  part?: string
  /** Execution wave: 0 runs first (the lead); same-wave steps run in parallel. */
  wave: number
}

export interface RoutePlan {
  /**
   * Flat dispatched set in execution order (= `steps.map(s => s.agent)`). Kept so
   * the serial LLM-router path (one dispatch per tool-use turn) stays unchanged;
   * the parallel orchestrator reads `steps`/`wave` instead.
   */
  agents: CodingAgent[]
  /** The structured schedule: wave 0 lead, wave 1 parallel implementers. */
  steps: RouteStep[]
  kind: RouteKind
  /**
   * True when ONE coder covers a plan-then-implement task alone (the others are
   * off, or the budget caps to one) — it must both draft AND implement.
   */
  solo: boolean
  /** Why it scheduled this way — the proof the dispatch fitted goal AND arrangement. */
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
 * combines it with the task analysis to schedule sensibly.
 */
export interface RoutingPolicy {
  /** The roster + what each coder is good at. Order matters: ties pick the earlier. */
  profiles: CoderProfile[]
  /** Coders off right now (logged out / rate-limited / 不想用) — never dispatched. */
  unavailable?: CodingAgent[]
  /** Budget: cap a dispatch to ONE coder (no lead+implementer fan-out). */
  singleCoder?: boolean
  /** Preferred lead for design work, when more than one coder could lead. */
  preferLead?: CodingAgent
}

/**
 * The default roster: Claude Code leads analysis/design/refactor; Codex is the
 * fast implementer. The roster is OPEN — a third coder (e.g. `aider`) added to
 * `profiles` becomes a second implementer, so a multi-part goal fans out across
 * SEVERAL implementers in parallel (see the demo's 3-coder scenarios). Order is
 * deliberate: Codex precedes any other implementer, so a single-part feature
 * still routes to Codex.
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
  /** Needs design before code → a lead drafts, implementer(s) build. */
  needsDesign: boolean
  /**
   * The independent deliverables the goal splits into (≥1). Length ≥2 means the
   * implementation fans out across several coders working in parallel. For a
   * single-part goal this is just `[goal]`.
   */
  parts: string[]
}

const REVIEW_ONLY = [/review/i, /audit/i, /don'?t change/i, /no code change/i, /explain/i, /审查/, /评审/, /别改/, /只看/]
const TRIVIAL = [/typo/i, /rename/i, /bump.*version/i, /one[- ]?liner/i, /lint fix/i, /错别字/, /小改/, /改个名/]

/** Connectives that join independent deliverables in a goal (EN + 中文). */
const PART_SPLIT = /\s*(?:,?\s+and\s+|\s+plus\s+|;\s+|，|、|；)\s*/i

/**
 * Split a goal into independent deliverables. Conjunction-joined clauses ("add X
 * AND write tests AND update docs") become separate parts that can be built in
 * parallel. A goal with no conjunctions is a single part. Deterministic so the
 * demo can assert the fan-out; a real router model makes the same call from the
 * goal's structure.
 */
export function extractParts(goal: string): string[] {
  const clauses = goal
    .trim()
    .replace(/[.。]\s*$/, '')
    .split(PART_SPLIT)
    .map((c) => c.trim())
    .filter((c) => c.length >= 3)
  return clauses.length >= 2 ? clauses : [goal.trim()]
}

/** 分析任务 — read the goal into facets. (A real router model does this judgement.) */
export function analyzeTask(goal: string): TaskFacets {
  const g = goal.trim()
  const reviewOnly = REVIEW_ONLY.some((re) => re.test(g))
  const trivial = !reviewOnly && TRIVIAL.some((re) => re.test(g))
  const needsDesign = !reviewOnly && !trivial
  // Only a design task fans out into parts; review is one reviewer, a trivial fix
  // is one implementer, regardless of how the sentence reads.
  const parts = needsDesign ? extractParts(g) : [g]
  return { reviewOnly, trivial, needsDesign, parts }
}

/** The strength tag each role looks for when filling from the roster. */
const ROLE_STRENGTH = {
  reviewer: ['review', 'analysis'],
  lead: ['design', 'analysis', 'review'],
  implementer: ['implement', 'quick-fix', 'scaffold', 'single-file', 'tests', 'docs'],
} as const

/**
 * Combine 分析任务 (facets) with 用户的安排 (policy) into a dispatch schedule.
 * Fills each role the task needs from the AVAILABLE roster by strength, fans
 * multi-part work out across several implementers, and degrades to whoever is
 * on-call when the ideal coder is off — so it never dispatches an unavailable
 * coder and never hard-fails when one is missing.
 */
export function planRoute(goal: string, policy: RoutingPolicy = DEFAULT_CODING_POLICY): RoutePlan {
  const facets = analyzeTask(goal)
  const off = new Set(policy.unavailable ?? [])
  const available = policy.profiles.filter((p) => !off.has(p.agent))

  // Degenerate arrangement: the user took every coder off. Be honest, route none.
  if (available.length === 0) {
    return { agents: [], steps: [], kind: 'review-only', solo: false, rationale: '没有在岗的编码 agent(全部被标记不可用) → 无法分派' }
  }

  const offNote = off.size ? `(${[...off].join('/')} 不在岗)` : ''

  if (facets.reviewOnly) {
    const reviewer = pick(available, ROLE_STRENGTH.reviewer, policy.preferLead)
    return plan('review-only', [{ agent: reviewer, role: 'review', wave: 0 }], false,
      `只审查 / 解释、不改代码 → 交给在岗最善分析的 ${reviewer}${offNote},不派实现`)
  }

  if (facets.trivial) {
    const impl = pick(available, ROLE_STRENGTH.implementer)
    return plan('direct-fix', [{ agent: impl, role: 'implement', wave: 0 }], false,
      `改动琐碎(无需先设计) → 直接交给在岗的 ${impl}${offNote} 实现,跳过规划回合`)
  }

  // needsDesign: a lead drafts (wave 0), implementer(s) build (wave 1, parallel).
  const lead = pick(available, ROLE_STRENGTH.lead, policy.preferLead)
  const implPool = available.filter((p) => p.agent !== lead)

  // One coder covers it when the budget caps to one, or the lead is the only one
  // left on-call — then the lead both drafts and implements, solo.
  if (policy.singleCoder || implPool.length === 0) {
    const why = policy.singleCoder
      ? `预算限单 coder → 由主理 ${lead} 独立完成设计+实现`
      : `${[...off].join('/')} 不在岗 → 在岗的 ${lead} 一人包办设计+实现`
    return plan('plan-then-implement', [{ agent: lead, role: 'lead', wave: 0 }], true, why)
  }

  // Distribute the independent parts across the available implementers (by
  // strength), round-robin. Each implementer gets ONE wave-1 step carrying its
  // bucket of parts — so we never dispatch two concurrent tasks to one coder, and
  // when there are fewer coders than parts the extra parts fold onto them.
  const implementers = rankImplementers(implPool)
  const buckets = distribute(facets.parts, implementers.length)
  const implementSteps: RouteStep[] = buckets.map((bucketParts, i) => ({
    agent: implementers[i]!,
    role: 'implement',
    part: bucketParts.join('; '),
    wave: 1,
  }))

  const steps: RouteStep[] = [{ agent: lead, role: 'lead', wave: 0 }, ...implementSteps]
  const parallel = implementSteps.length >= 2

  if (parallel) {
    const assignments = implementSteps.map((s) => `${s.agent}←「${s.part}」`).join(', ')
    return plan('plan-then-parallel', steps, false,
      `功能可拆成 ${facets.parts.length} 个独立部件${offNote} → ${lead} 起草方案,` +
        `${implementSteps.length} 个实现者并行落地:${assignments}`)
  }

  // Single implementer (single-part feature, or several parts but only one coder
  // on-call) — the classic lead → implementer handoff via PROGRESS.md.
  const impl = implementSteps[0]!.agent
  return plan('plan-then-implement', steps, false,
    `需要先设计再落地${offNote} → ${lead} 起草方案,${impl} 据 PROGRESS.md 实现`)
}

/** Assemble a plan, deriving the flat `agents` order from the steps. */
function plan(kind: RouteKind, steps: RouteStep[], solo: boolean, rationale: string): RoutePlan {
  return { agents: steps.map((s) => s.agent), steps, kind, solo, rationale }
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

/** Order the implementer pool: strongest implementers first, then the rest. */
function rankImplementers(pool: CoderProfile[]): CodingAgent[] {
  const isImpl = (p: CoderProfile) => p.strengths.some((s) => (ROLE_STRENGTH.implementer as readonly string[]).includes(s))
  return [...pool.filter(isImpl), ...pool.filter((p) => !isImpl(p))].map((p) => p.agent)
}

/**
 * Spread `parts` across `n` buckets round-robin (n ≥ 1). With as many coders as
 * parts each bucket holds one part (max parallelism); with fewer coders the
 * leftover parts fold onto the earlier buckets. Empty buckets are dropped so we
 * only ever schedule as many implementers as there is work for.
 */
function distribute<T>(parts: T[], n: number): T[][] {
  const buckets: T[][] = Array.from({ length: Math.max(1, n) }, () => [] as T[])
  parts.forEach((part, i) => buckets[i % buckets.length]!.push(part))
  return buckets.filter((b) => b.length > 0)
}

/** Derive the per-step prompt from the role + parts (what a real router would write). */
export function stepPrompt(step: RouteStep, goal: string): string {
  if (step.role === 'review') {
    return `Review for the goal: ${goal}. Report findings; do NOT change code. Follow AGENTS.md.`
  }
  if (step.role === 'lead') {
    // A solo lead (no implementer step follows) must both plan AND implement.
    return `Draft a short implementation plan for: ${goal}. Follow AGENTS.md.`
  }
  // implement — scoped to this coder's part(s) when the work was fanned out.
  const scope = step.part && step.part !== goal ? `your part — ${step.part}` : goal
  return `Implement the plan from PROGRESS.md for: ${scope}. Keep changes small.`
}

/**
 * Back-compat prompt for the serial LLM-router path, which dispatches by agent id
 * one turn at a time. Finds this agent's step and renders its role-appropriate
 * prompt; a solo lead is told to both draft AND implement (no implementer follows).
 */
export function dispatchPrompt(plan: RoutePlan, agent: CodingAgent, goal: string): string {
  const step = plan.steps.find((s) => s.agent === agent)
  if (!step) return stepPrompt({ agent, role: 'implement', wave: 1 }, goal)
  if (step.role === 'lead' && plan.solo) {
    return `Draft a short plan AND implement it for: ${goal}. Keep changes small; follow AGENTS.md.`
  }
  return stepPrompt(step, goal)
}
