/**
 * PillarAgent — one austere drill-master per pillar (body / mind / lore), the
 * deterministic stand-in. It reads the trainee's PRIOR state for continuity,
 * then appends the next rank's directive to that pillar's Codex file.
 *
 * One parametrized class, instantiated three times — the three distinct LLM
 * agents (each with its own cold-voiced system prompt) live in the loadable
 * template (BM2). Here the file mechanics need no LLM, so the demo runs with no
 * key and self-asserts. Swap for real LlmAgents and the hub wiring is identical.
 */

import { AgentParticipant, type Task } from '@aipehub/core'

import { appendEntry, priorSteps, type Codex, type Pillar } from './codex.js'

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

/** Austere, original directives — cycled by rank. No coddling, no warmth. */
const REGIMEN: Record<Pillar, string[]> = {
  body: [
    '晨起冷水,负重行军五公里。疼痛是软弱离体的信号。',
    '力量操练至力竭,记录极限,下次越过它。',
    '禁食一日。体会饥饿,而不被其驱使。',
  ],
  mind: [
    '静坐半时,直面杂念而不应。心志先于肉身溃败。',
    '复诵戒律十遍。秩序是抵御混乱的唯一壁垒。',
    '剖析今日一次动摇,寻其根,根除之。',
  ],
  lore: [
    '研读典籍一章,默写要义。无知者先死。',
    '将所学化为一条可行法则,刻入档案。',
    '向假想之敌阐述所学;辞穷处即是漏洞。',
  ],
}

export class PillarAgent extends AgentParticipant {
  constructor(
    private readonly kb: Codex,
    private readonly spec: PillarSpec,
  ) {
    super({ id: spec.id, capabilities: [spec.capability] })
  }

  protected async handleTask(_task: Task): Promise<unknown> {
    // Baseline is 第0阶, so prior ≥ 1; the next rank = entries already logged.
    const prior = priorSteps(this.kb, this.spec.pillar)
    const rank = prior
    const bank = REGIMEN[this.spec.pillar]
    const directive = bank[(rank - 1) % bank.length]!
    // The entry references the prior count → continuity is visible + assertable.
    appendEntry(this.kb, this.spec.pillar, `- [第${rank}阶] 承前 ${prior} 阶 — ${directive}`)
    return { pillar: this.spec.pillar, rank, priorEntries: prior }
  }
}
