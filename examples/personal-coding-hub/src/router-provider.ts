/**
 * The router's "brain" — a scripted stand-in for the LLM that actively decides
 * WHO does WHAT. Three turns, driven through the DispatchToolset's `dispatch_task`
 * tool:
 *
 *   1. dispatch_task → claude-code : draft an implementation plan
 *   2. dispatch_task → codex       : implement it (codex reads the draft from
 *                                    PROGRESS.md that claude-code just appended)
 *   3. plain text                  : report back how it routed
 *
 * A real provider (Anthropic / OpenAI / DeepSeek) drops in unchanged — the
 * routing decision becomes the model's, and the dispatched prompts get derived
 * from the incoming goal. Here they're fixed so the demo is deterministic.
 */

import { MockLlmProvider } from '@aipehub/llm'

export function createRouterProvider(): MockLlmProvider {
  return new MockLlmProvider({
    name: 'router-mock',
    script: [
      {
        kind: 'tool_use',
        text: 'Plan first — routing the draft to Claude Code.',
        toolUses: [
          {
            type: 'tool_use',
            id: 'route-draft',
            name: 'dispatch_task',
            input: {
              agentId: 'claude-code',
              title: 'draft the plan',
              payload: { prompt: 'Draft a short implementation plan for the goal; follow AGENTS.md.' },
            },
          },
        ],
      },
      {
        kind: 'tool_use',
        text: 'Draft is logged — handing implementation to Codex.',
        toolUses: [
          {
            type: 'tool_use',
            id: 'route-impl',
            name: 'dispatch_task',
            input: {
              agentId: 'codex',
              title: 'implement the plan',
              payload: { prompt: 'Implement the plan from PROGRESS.md; keep changes small.' },
            },
          },
        ],
      },
      {
        kind: 'text',
        text:
          'Routed: Claude Code drafted the plan, Codex implemented it. Both shared the same ' +
          'repo — PROGRESS.md holds the handoff trail.',
      },
    ],
    reply: 'done',
  })
}
