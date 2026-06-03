/**
 * The preceptor's "brain" — a scripted stand-in for the LLM that assesses the
 * trainee and routes the session across the three pillars. Four turns through
 * the DispatchToolset's `dispatch_task` tool:
 *
 *   1. dispatch_task → body-drill  : 操练肉身
 *   2. dispatch_task → mind-forge  : 淬炼心志
 *   3. dispatch_task → lore-scribe : 研修学识
 *   4. plain text                  : report back, in the cold preceptor's voice
 *
 * A real provider (Anthropic / OpenAI / DeepSeek) drops in unchanged — the
 * routing and the austere voice become the model's. Here it's fixed so the demo
 * is deterministic.
 */

import { MockLlmProvider } from '@aipehub/llm'

export function createPreceptorProvider(): MockLlmProvider {
  return new MockLlmProvider({
    name: 'preceptor-mock',
    script: [
      {
        kind: 'tool_use',
        text: '操练肉身。',
        toolUses: [
          {
            type: 'tool_use',
            id: 'drill-body',
            name: 'dispatch_task',
            input: { agentId: 'body-drill', title: '肉身锻造', payload: { directive: '推进肉身' } },
          },
        ],
      },
      {
        kind: 'tool_use',
        text: '淬炼心志。',
        toolUses: [
          {
            type: 'tool_use',
            id: 'drill-mind',
            name: 'dispatch_task',
            input: { agentId: 'mind-forge', title: '心志淬炼', payload: { directive: '推进心志' } },
          },
        ],
      },
      {
        kind: 'tool_use',
        text: '研修学识。',
        toolUses: [
          {
            type: 'tool_use',
            id: 'drill-lore',
            name: 'dispatch_task',
            input: { agentId: 'lore-scribe', title: '学识研修', payload: { directive: '推进学识' } },
          },
        ],
      },
      {
        kind: 'text',
        text: '三柱已操练,记录已刻入档案。修士,明日继续。无需赘言。',
      },
    ],
    reply: 'done',
  })
}
