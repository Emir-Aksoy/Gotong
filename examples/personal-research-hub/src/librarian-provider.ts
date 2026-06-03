/**
 * The librarian's "brain" — a scripted stand-in for the LLM that actively
 * decides what to ingest vs. retrieve. Four turns through the DispatchToolset's
 * `dispatch_task` tool:
 *
 *   1. dispatch_task → compiler   : compile raw/karpathy-software-3.0.md
 *   2. dispatch_task → compiler   : compile raw/llm-as-compiler.md
 *   3. dispatch_task → researcher : answer a question from the compiled wiki
 *   4. plain text                 : report back
 *
 * A real provider (Anthropic / OpenAI / DeepSeek) drops in unchanged — the
 * ingest-vs-retrieve decision becomes the model's. Here it's fixed so the demo
 * is deterministic.
 */

import { MockLlmProvider } from '@aipehub/llm'

export function createLibrarianProvider(): MockLlmProvider {
  return new MockLlmProvider({
    name: 'librarian-mock',
    script: [
      {
        kind: 'tool_use',
        text: 'Ingesting the first source.',
        toolUses: [
          {
            type: 'tool_use',
            id: 'compile-1',
            name: 'dispatch_task',
            input: {
              agentId: 'compiler',
              title: 'compile software-3.0',
              payload: { source: 'karpathy-software-3.0.md' },
            },
          },
        ],
      },
      {
        kind: 'tool_use',
        text: 'Ingesting the second source.',
        toolUses: [
          {
            type: 'tool_use',
            id: 'compile-2',
            name: 'dispatch_task',
            input: {
              agentId: 'compiler',
              title: 'compile llm-as-compiler',
              payload: { source: 'llm-as-compiler.md' },
            },
          },
        ],
      },
      {
        kind: 'tool_use',
        text: 'Wiki is built — now answering from it.',
        toolUses: [
          {
            type: 'tool_use',
            id: 'ask-1',
            name: 'dispatch_task',
            input: {
              agentId: 'researcher',
              title: 'answer from the wiki',
              payload: { question: '什么是 LLM as compiler,和 Software 3.0 有什么关系?' },
            },
          },
        ],
      },
      {
        kind: 'text',
        text:
          'Compiled 2 raw sources into the wiki, then answered from it — the answer is ' +
          'filed back under wiki/answers/ so it compounds.',
      },
    ],
    reply: 'done',
  })
}
