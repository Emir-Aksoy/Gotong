# @aipehub/llm-anthropic

Anthropic Claude `LlmProvider` for [AipeHub](https://github.com/AipeHub/AipeHub). Plug into [`@aipehub/llm`](https://www.npmjs.com/package/@aipehub/llm)'s `LlmAgent`.

## Install

```bash
pnpm add @aipehub/llm-anthropic @anthropic-ai/sdk
# @anthropic-ai/sdk is a peer dependency — install the version you want
```

## Use

```ts
import { LlmAgent } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'

const provider = new AnthropicProvider({
  // apiKey: '...'         // defaults to process.env.ANTHROPIC_API_KEY
  // defaultModel: '...'   // defaults to 'claude-opus-4-7'
  // defaultMaxTokens: ... // defaults to 1024
})

const writer = new LlmAgent({
  id: 'writer',
  capabilities: ['draft'],
  provider,
  system: 'You write one short sentence and stop.',
})
```

## Translation rules

- Request → `messages.create({ model, max_tokens, messages, system?, temperature? })`
- Response text = concat of all `content[]` blocks with `type === 'text'`
- `stop_reason: 'end_turn' | 'stop_sequence'` → `'end_turn'`; `'max_tokens'` → `'max_tokens'`; anything else → `'error'`
- `usage.input_tokens` / `output_tokens` → `inputTokens` / `outputTokens`

## Note on Claude Opus 4.7

Opus 4.7 does not accept `temperature` / `top_p` / `top_k`. If you pass `temperature` to a request targeting `claude-opus-4-7`, the API returns 400; the provider forwards the parameter verbatim and the error surfaces in the resulting failed `TaskResult`. Drop `temperature` to use adaptive thinking, or pick a different model.

## License

MIT
