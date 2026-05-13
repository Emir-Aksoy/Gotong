# @aipehub/llm

`LlmAgent` base class + neutral `LlmProvider` interface for [AipeHub](https://github.com/AipeHub/AipeHub). Builds an LLM-backed `Participant` in three lines.

The Hub does not call LLMs. `LlmAgent` does. The provider is the only place vendor SDKs are imported — pick one:

- [`@aipehub/llm-anthropic`](https://www.npmjs.com/package/@aipehub/llm-anthropic) — Anthropic Claude
- [`@aipehub/llm-openai`](https://www.npmjs.com/package/@aipehub/llm-openai) — OpenAI

Or roll your own by implementing `LlmProvider.complete(req)`.

## Install

```bash
pnpm add @aipehub/llm
# plus a provider:
pnpm add @aipehub/llm-anthropic @anthropic-ai/sdk
```

## Use

```ts
import { Hub } from '@aipehub/core'
import { LlmAgent } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'

const hub = new Hub()
await hub.start()

hub.register(new LlmAgent({
  id: 'writer',
  capabilities: ['draft'],
  provider: new AnthropicProvider(),                  // reads ANTHROPIC_API_KEY
  system: 'You write one terse sentence.',
}))

const draft = await hub.dispatch({
  from: 'system',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'distributed agents' },
})
```

## Override points

Subclass `LlmAgent` and override either of these to customize prompt assembly or output shaping:

- `buildRequest(task): LlmRequest` — translate `Task.payload` into an `LlmRequest`. Default reads `{ prompt }` / `{ topic }` / `{ history }` and injects the agent-level `system`.
- `parseResponse(response, task): unknown` — translate `LlmResponse` into the task output. Default returns `{ text, stopReason, by, usage }`.

For full control (multi-step reasoning, tool loops, retries) override `handleTask(task)` directly.

## MockLlmProvider

Ships in this package — a deterministic in-process provider for tests and no-key demos.

```ts
import { MockLlmProvider } from '@aipehub/llm'

const provider = new MockLlmProvider({
  reply: (req) => `mock reply to ${req.messages.at(-1)?.content}`,
})
```

## License

MIT
