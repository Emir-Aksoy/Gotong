/**
 * situation — the trainee's intake for today, plus the PURE planner that turns it
 * into a routing decision. This is the assertable core of "结合使用者的情况,能力
 * 分派要合适": the preceptor must NOT blindly drill all three pillars every day.
 * It reads how much the trainee actually has today (time / energy / injury / a
 * pillar they want to focus) and the Codex ranks, then routes ONLY the pillars
 * that fit — and tells each pillar how hard to push.
 *
 * Why a pure function: the routing decision has to be inspectable and
 * deterministic. `planSession` takes a situation + ranks and returns exactly the
 * drills to run + the deferrals (with reasons), with NO I/O and NO LLM. The
 * preceptor provider and the demo both call it; a real preceptor LLM would make
 * the same call from the same context (the trainee's message + the Codex read via
 * mcp-obsidian), just without the determinism.
 */

import type { Pillar } from './codex.js'

export type Energy = 'low' | 'normal' | 'high'

/** What the trainee brings to today's session — the situation the preceptor reads. */
export interface DailySituation {
  /** Minutes available to train today. Scarce time → fewer pillars, lighter load. */
  minutes: number
  /** Self-reported readiness. `low` → recovery only; `high` (+ time) → full session. */
  energy: Energy
  /** Optional: a pillar the trainee asks to prioritize → always routed first. */
  focus?: Pillar
  /** Optional: a physical ailment → 肉身 (body) drilling is deferred this session. */
  ailment?: string
}

/** A pillar plus how many ranked entries it already holds (most-behind = lowest). */
export interface PillarRank {
  pillar: Pillar
  rank: number
}

/** A pillar the planner chose to drill today, with why it was routed. */
export interface DrillRoute {
  pillar: Pillar
  reason: string
}

/** A pillar the planner held back today, with why. */
export interface Deferral {
  pillar: Pillar
  reason: string
}

export interface SessionPlan {
  /** How many pillars today's situation can sustain (1–3). */
  capacity: number
  /** The pillars to drill, in routing order (focus first, then most-behind). */
  drills: DrillRoute[]
  /** The pillars held back (ailment-deferred or capacity-trimmed), with reasons. */
  deferred: Deferral[]
}

export type Intensity = 'recovery' | 'standard' | 'max'

export const INTENSITY_TAG: Record<Intensity, string> = {
  recovery: '轻负荷·恢复',
  standard: '常规',
  max: '满负荷',
}

/**
 * How many pillars the trainee can sustain today. Scarcity (low energy OR very
 * short time) collapses to a single focused pillar; abundance (high energy AND a
 * long window) opens all three; everything in between is two.
 */
export function sessionCapacity(s: DailySituation): number {
  if (s.energy === 'low' || s.minutes < 20) return 1
  if (s.energy === 'high' && s.minutes >= 50) return 3
  return 2
}

/**
 * How hard each routed pillar pushes today — same scarcity/abundance thresholds
 * as capacity, so a thin day is both fewer pillars AND lighter, and a strong day
 * is all three at full load.
 */
export function drillIntensity(s: DailySituation): Intensity {
  if (s.energy === 'low' || s.minutes < 20) return 'recovery'
  if (s.energy === 'high' && s.minutes >= 50) return 'max'
  return 'standard'
}

/**
 * The routing decision. Given today's situation and the Codex ranks, decide which
 * pillars to drill (and in what order) and which to defer.
 *
 * Rules, in order:
 *   1. An ailment defers `body` outright (don't drill an injured body).
 *   2. Priority = the focus pillar first, then most-behind (lowest rank) first,
 *      ties broken by the stable PILLAR order of the input.
 *   3. Take up to `capacity`; the remainder are deferred as capacity-trimmed.
 *
 * `ranks` is expected in PILLAR order (body, mind, lore) so equal-rank ties are
 * deterministic. The function never mutates its inputs.
 */
export function planSession(s: DailySituation, ranks: readonly PillarRank[]): SessionPlan {
  const capacity = sessionCapacity(s)
  const deferred: Deferral[] = []

  // [1] Injury defers the body pillar — never drill an injured body.
  let candidates = ranks.slice()
  if (s.ailment && s.ailment.trim().length > 0) {
    candidates = candidates.filter((r) => {
      if (r.pillar === 'body') {
        deferred.push({ pillar: 'body', reason: `因『${s.ailment!.trim()}』,今日停肉身操练` })
        return false
      }
      return true
    })
  }

  // [2] Priority order: focus pillar first, then most-behind first (stable on
  // the PILLAR input order for equal ranks).
  const ordered = candidates
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const af = s.focus === a.r.pillar ? 0 : 1
      const bf = s.focus === b.r.pillar ? 0 : 1
      if (af !== bf) return af - bf
      if (a.r.rank !== b.r.rank) return a.r.rank - b.r.rank
      return a.i - b.i
    })
    .map((x) => x.r)

  // [3] Take up to capacity; the rest are held back for next time.
  const drills: DrillRoute[] = []
  for (const r of ordered) {
    if (drills.length < capacity) {
      drills.push({ pillar: r.pillar, reason: routeReason(s, r) })
    } else {
      deferred.push({
        pillar: r.pillar,
        reason: `今日只够 ${capacity} 柱;此柱(第${r.rank}阶,较稳)顺延`,
      })
    }
  }

  return { capacity, drills, deferred }
}

function routeReason(s: DailySituation, r: PillarRank): string {
  if (s.focus === r.pillar) return '你点名专攻,首要'
  return `落后最多(第${r.rank}阶),优先`
}
