/**
 * The preceptor's "brain" — a deterministic stand-in for the LLM that reads the
 * trainee's SITUATION and the Codex ranks, then routes ONLY the pillars that fit
 * today. This is the upgrade the user asked for: 结合使用者的情况,能力分派要合适 —
 * no more blind fan-out of all three pillars every session.
 *
 * It is a real `LlmProvider` (not a fixed `MockLlmProvider` script), because the
 * routing now depends on the input the way a real model's would:
 *
 *   · Every `stream(req)` call receives the full message history. The preceptor
 *     reads the situation + ranks the demo injected into the prompt (a real
 *     preceptor would read the trainee's message + the Codex via mcp-obsidian),
 *     calls the pure `planSession`, and dispatches one pillar per planned drill.
 *   · It knows which turn it is on by COUNTING prior `tool_use` blocks in the
 *     message history (the tool-use loop appends them) — so turn k dispatches
 *     `plan.drills[k]`, and once the drills are exhausted it reports back.
 *
 * Swap this for a real provider (Anthropic / OpenAI / DeepSeek) and the routing +
 * the austere voice become the model's; the hub wiring is identical. Here it is
 * deterministic so the demo runs with no API key and self-asserts the routing.
 */

import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@aipehub/llm'

import { PILLARS, PILLAR_TITLE, type Pillar } from './codex.js'
import {
  drillIntensity,
  planSession,
  INTENSITY_TAG,
  type DailySituation,
  type PillarRank,
} from './situation.js'

/** Pillar → the drill agent's id (the DispatchToolset allow-list targets). */
const PILLAR_AGENT: Record<Pillar, string> = {
  body: 'body-drill',
  mind: 'mind-forge',
  lore: 'lore-scribe',
}

/** Pillar → the transcript title for that drill. */
const PILLAR_DRILL_TITLE: Record<Pillar, string> = {
  body: '肉身锻造',
  mind: '心志淬炼',
  lore: '学识研修',
}

/** A normal day, used when the prompt carries no parseable situation block. */
const DEFAULT_SITUATION: DailySituation = { minutes: 30, energy: 'normal' }

export function createPreceptorProvider(): LlmProvider {
  return new SituationAwarePreceptorProvider()
}

class SituationAwarePreceptorProvider implements LlmProvider {
  readonly name = 'preceptor-situation-aware'

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const { situation, ranks } = readContext(req)
    const plan = planSession(situation, ranks)
    const intensity = drillIntensity(situation)
    const turn = countDispatched(req)

    if (turn < plan.drills.length) {
      // Still routing: dispatch the pillar planned for this turn. The payload
      // carries the whole situation so the pillar can adapt its intensity.
      const drill = plan.drills[turn]!
      yield { type: 'text', text: `操练${PILLAR_TITLE[drill.pillar]} — ${drill.reason}。` }
      yield {
        type: 'tool_use',
        toolUse: {
          type: 'tool_use',
          id: `drill-${drill.pillar}`,
          name: 'dispatch_task',
          input: {
            agentId: PILLAR_AGENT[drill.pillar],
            title: PILLAR_DRILL_TITLE[drill.pillar],
            payload: { situation, reason: drill.reason },
          },
        },
      }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }

    // Drills exhausted — report what was routed and what was held back, in the
    // cold preceptor's voice. The deferrals are the proof the routing was fitted
    // to the situation rather than blindly fanned out.
    const drilled = plan.drills.map((d) => PILLAR_TITLE[d.pillar]).join('、') || '无'
    const held =
      plan.deferred.map((d) => `${PILLAR_TITLE[d.pillar]}(${d.reason})`).join(';') || '无'
    const text =
      `今日定 ${plan.capacity} 柱(${INTENSITY_TAG[intensity]})。操练:${drilled}。暂缓:${held}。` +
      '按状态行事,不逞强,亦不懈怠。'
    yield { type: 'text', text }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

/**
 * Read the trainee's situation + the Codex ranks out of the prompt. The demo
 * injects them as two compact JSON blocks (`今日状态: {...}` / `档案进度: {...}`);
 * a real preceptor would read the same facts from the trainee's message and the
 * archive. Missing/garbled blocks fall back to a normal day at baseline ranks so
 * the provider always produces a sane plan (never a hang, never a blind fan-out).
 */
function readContext(req: LlmRequest): { situation: DailySituation; ranks: PillarRank[] } {
  const text = gatherText(req)
  const situation = (parseJsonBlock(text, '今日状态') as DailySituation | null) ?? DEFAULT_SITUATION
  const rankObj = (parseJsonBlock(text, '档案进度') as Record<string, unknown> | null) ?? {}
  const ranks: PillarRank[] = PILLARS.map((p) => ({
    pillar: p,
    rank: typeof rankObj[p] === 'number' ? (rankObj[p] as number) : 1,
  }))
  return { situation, ranks }
}

/** Concatenate every text fragment across the request (system + all messages). */
function gatherText(req: LlmRequest): string {
  const parts: string[] = []
  if (req.system) parts.push(req.system)
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      parts.push(m.content)
    } else {
      for (const b of m.content) if (b.type === 'text') parts.push(b.text)
    }
  }
  return parts.join('\n')
}

/** Extract `<label>: { ... }` and JSON.parse the (flat) object; null on miss/garble. */
function parseJsonBlock(text: string, label: string): unknown {
  const m = text.match(new RegExp(`${label}\\s*:\\s*(\\{[^}]*\\})`))
  if (!m) return null
  try {
    return JSON.parse(m[1]!)
  } catch {
    return null
  }
}

/** Which turn we're on = how many `tool_use` blocks the loop has already appended. */
function countDispatched(req: LlmRequest): number {
  let n = 0
  for (const msg of req.messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue
    for (const b of msg.content) if (b.type === 'tool_use') n++
  }
  return n
}
