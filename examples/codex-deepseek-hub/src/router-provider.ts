/**
 * The router's "brain" — a deterministic stand-in for the LLM that reads the GOAL
 * and routes the RIGHT coding agents for it, *combined with the user's standing
 * arrangements*. 合理地调度 — no fixed deepseek-tui → codex pipeline, and no
 * dispatching a coder the user has taken off-call.
 *
 * It is a real `LlmProvider` (not a fixed `MockLlmProvider` script), because the
 * routing depends on the input the way a real model's would:
 *
 *   · The provider is constructed with the user's `RoutingPolicy` (the roster +
 *     who's on-call + budget) — the same arrangement a real hub is configured with.
 *   · Every `stream(req)` call sees the goal (the first user message) + the
 *     dispatch history. It calls the pure `planRoute(goal, policy)` to combine the
 *     task analysis with the arrangement, then dispatches one coder per planned step.
 *   · It knows which turn it is on by COUNTING prior `tool_use` blocks in the
 *     history — so turn k dispatches `plan.agents[k]`, then it reports back.
 *
 * Swap this for a real provider (DeepSeek / Anthropic / OpenAI), feed the same
 * policy in the system prompt, and the routing judgement becomes the model's; the
 * hub wiring is identical (see `real-agents.ts`).
 */

import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'

import {
  dispatchPrompt,
  parseExplicitAssignment,
  planRoute,
  DEFAULT_CODING_POLICY,
  type CodingAgent,
  type RoutingPolicy,
} from './routing.js'

/** Agent → the transcript title for that dispatch. */
const TITLE: Record<CodingAgent, string> = {
  'deepseek-tui': 'plan / review',
  codex: 'implement',
}

/** Build the router brain bound to a user arrangement (defaults to the std roster). */
export function createRouterProvider(policy: RoutingPolicy = DEFAULT_CODING_POLICY): LlmProvider {
  return new SituationAwareRouterProvider(policy)
}

class SituationAwareRouterProvider implements LlmProvider {
  readonly name = 'router-situation-aware'

  constructor(private readonly policy: RoutingPolicy) {}

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const goal = readGoal(req)
    // Combine the standing arrangement with any 显式分派 the user named in the goal
    // itself — naming a coder ("交给 codex …") overrides the role-fill for this task.
    const plan = planRoute(goal, this.policy, parseExplicitAssignment(goal))
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
