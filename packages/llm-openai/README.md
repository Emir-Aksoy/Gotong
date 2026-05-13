# @aipehub/llm-openai

OpenAI `LlmProvider` for [AipeHub](https://github.com/AipeHub/AipeHub). Plug into [`@aipehub/llm`](https://www.npmjs.com/package/@aipehub/llm)'s `LlmAgent`.

## Install

```bash
pnpm add @aipehub/llm-openai openai
# openai is a peer dependency — install the version you want
```

## Use

```ts
import { LlmAgent } from '@aipehub/llm'
import { OpenAIProvider } from '@aipehub/llm-openai'

const provider = new OpenAIProvider({
  // apiKey: '...'         // defaults to process.env.OPENAI_API_KEY
  // defaultModel: '...'   // defaults to 'gpt-4o-mini'
})

const reviewer = new LlmAgent({
  id: 'reviewer',
  capabilities: ['review'],
  provider,
  system: 'You return one revision suggestion.',
})
```

## Translation rules

- `LlmRequest.system` is hoisted to a leading `{ role: 'system', content }` message.
- Output cap uses `max_completion_tokens` (the modern OpenAI field), not the deprecated `max_tokens`.
- `finish_reason: 'stop'` → `'end_turn'`; `'length'` → `'max_tokens'`; anything else (`'tool_calls'`, `'content_filter'`, …) → `'error'`.
- `usage.prompt_tokens` / `completion_tokens` → `inputTokens` / `outputTokens`.

## License

MIT
