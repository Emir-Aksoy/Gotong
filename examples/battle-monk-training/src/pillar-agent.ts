/**
 * PillarAgent — one austere drill-master per pillar (body / mind / lore), the
 * deterministic stand-in. It reads the trainee's PRIOR state for continuity AND
 * today's SITUATION (carried on the dispatch payload), then appends the next
 * rank's directive — scaled to the situation's intensity — to that pillar's Codex.
 *
 * The situation-awareness is the second half of 能力分派要合适: the preceptor
 * decides WHICH pillars to drill (planSession), and each pillar decides HOW HARD
 * to push (drillIntensity). A depleted day writes a recovery directive, not
 * "drill to failure"; a strong day writes a full-load one.
 *
 * One parametrized class, instantiated three times — the three distinct LLM
 * agents (each with its own cold-voiced system prompt) live in the loadable
 * template (BM2). Here the file mechanics need no LLM, so the demo runs with no
 * key and self-asserts. Swap for real LlmAgents and the hub wiring is identical.
 */

import { AgentParticipant, type Task } from '@aipehub/core'

import { appendEntry, priorSteps, type Codex, type Pillar } from './codex.js'
import { drillIntensity, INTENSITY_TAG, type DailySituation, type Intensity } from './situation.js'

export interface PillarSpec {
  id: string
  capability: string
  pillar: Pillar
  title: string
}

/** The three pillars the preceptor routes across (ids = template agent ids). */
export const BATTLE_PILLARS: PillarSpec[] = [
  { id: 'body-drill', capability: 'body', pillar: 'body', title: '肉身锻造' },
  { id: 'mind-forge', capability: 'mind', pillar: 'mind', title: '心志淬炼' },
  { id: 'lore-scribe', capability: 'lore', pillar: 'lore', title: '学识研修' },
]

/** Per-pillar directives. `drills` cycle by rank; `recovery` is the light-day swap. */
const REGIMEN: Record<Pillar, { drills: string[]; recovery: string }> = {
  body: {
    drills: [
      '晨起冷水,负重行军五公里。疼痛是软弱离体的信号。',
      '力量操练至力竭,记录极限,下次越过它。',
      '禁食一日。体会饥饿,而不被其驱使。',
    ],
    recovery: '轻活动恢复:慢走与舒展,养护肉身而非消耗。',
  },
  mind: {
    drills: [
      '静坐半时,直面杂念而不应。心志先于肉身溃败。',
      '复诵戒律十遍。秩序是抵御混乱的唯一壁垒。',
      '剖析今日一次动摇,寻其根,根除之。',
    ],
    recovery: '静坐一刻,只观呼吸,不强求。疲时养神亦是操练。',
  },
  lore: {
    drills: [
      '研读典籍一章,默写要义。无知者先死。',
      '将所学化为一条可行法则,刻入档案。',
      '向假想之敌阐述所学;辞穷处即是漏洞。',
    ],
    recovery: '重温旧档一篇,温故即可,不增新负。',
  },
}

export class PillarAgent extends AgentParticipant {
  constructor(
    private readonly kb: Codex,
    private readonly spec: PillarSpec,
  ) {
    super({ id: spec.id, capabilities: [spec.capability] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    // Baseline is 第0阶, so prior ≥ 1; the next rank = entries already logged.
    const prior = priorSteps(this.kb, this.spec.pillar)
    const rank = prior
    const regimen = REGIMEN[this.spec.pillar]

    // Adapt the load to today's situation (carried on the payload). A depleted
    // day swaps to the recovery directive; otherwise cycle the rank's drill.
    const situation = readSituation(task)
    const intensity: Intensity = situation ? drillIntensity(situation) : 'standard'
    const directive =
      intensity === 'recovery'
        ? regimen.recovery
        : regimen.drills[(rank - 1) % regimen.drills.length]!

    // The entry references the prior count (continuity) AND the intensity tag
    // (situation-adaptation) → both are visible in the Codex and assertable.
    appendEntry(
      this.kb,
      this.spec.pillar,
      `- [第${rank}阶·${INTENSITY_TAG[intensity]}] 承前 ${prior} 阶 — ${directive}`,
    )
    return { pillar: this.spec.pillar, rank, priorEntries: prior, intensity }
  }
}

/** Narrow the dispatch payload to a usable DailySituation, or undefined. */
function readSituation(task: Task): DailySituation | undefined {
  const payload = task.payload as { situation?: Partial<DailySituation> } | null | undefined
  const s = payload?.situation
  if (!s || typeof s.minutes !== 'number' || typeof s.energy !== 'string') return undefined
  return s as DailySituation
}
