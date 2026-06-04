/**
 * The router's "brain" — a deterministic stand-in for the LLM that reads the GOAL
 * and routes the RIGHT coding agents for it. This is the upgrade: 能力分派要合适 —
 * no more fixed claude-code → codex pipeline regardless of what was asked.
 *
 * It is a real `LlmProvider` (not a fixed `MockLlmProvider` script), because the
 * routing now depends on the input the way a real model's would:
 *
 *   · Every `stream(req)` call sees the goal (the first user message) + the
 *     dispatch history. It calls the pure `planRoute(goal)` to decide which agents
 *     to dispatch (a trivial fix → Codex only; a review → Claude Code only; a
 *     feature → both), then dispatches one agent per planned step.
 *   · It knows which turn it is on by COUNTING prior `tool_use` blocks in the
 *     history — so turn k dispatches `plan.agents[k]`, then it reports back.
 *
 * Swap this for a real provider (Anthropic / OpenAI / DeepSeek) and the routing
 * judgement becomes the model's; the hub wiring is identical.
 */

import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@aipehub/llm'

import { dispatchPrompt, planRoute, type CodingAgent } from './routing.js'

/** Agent → the transcript title for that dispatch. */
const TITLE: Record<CodingAgent, string> = {
  'claude-code': 'plan / review',
  codex: 'implement',
}

export function createRouterProvider(): LlmProvider {
  return new SituationAwareRouterProvider()
}

class SituationAwareRouterProvider implements LlmProvider {
  readonly name = 'router-situation-aware'

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const goal = readGoal(req)
    const plan = planRoute(goal)
    const turn = countDispatched(req)

    if (turn < plan.agents.length) {
      const agent = plan.agents[turn]!
      yield { type: 'text', text: `→ ${agent} (${plan.kind})` }
      yield {
        type: 'tool_use',
        toolUse: {
          type: 'tool_use',
          id: `route-${agent}`,
          name: 'dispatch_task',
          input: {
            agentId: agent,
            title: TITLE[agent],
            payload: { prompt: dispatchPrompt(plan, agent, goal) },
          },
        },
      }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }

    // Routing done — report how it routed and why (the rationale is the proof the
    // dispatch was fitted to the goal, not a fixed pipeline).
    const routed = plan.agents.join(' → ')
    yield { type: 'text', text: `Routed [${plan.kind}]: ${routed}. ${plan.rationale}.` }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

/** The goal = the first user message with string content (tool results are arrays). */
function readGoal(req: LlmRequest): string {
  for (const m of req.messages) {
    if (m.role === 'user' && typeof m.content === 'string') return m.content
  }
  return ''
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
