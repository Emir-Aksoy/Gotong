# @gotong/llm-anthropic

Anthropic Claude `LlmProvider` for [Gotong](https://github.com/Emir-Aksoy/Gotong). Plug into [`@gotong/llm`](https://www.npmjs.com/package/@gotong/llm)'s `LlmAgent`.

## Install

```bash
pnpm add @gotong/llm-anthropic @anthropic-ai/sdk
# @anthropic-ai/sdk is a peer dependency — install the version you want
```

## Use

```ts
import { LlmAgent } from '@gotong/llm'
import { AnthropicProvider } from '@gotong/llm-anthropic'

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

## Note on Claude Opus 4.x (thinking models)

Opus 4.x ("thinking" model family) does not accept `temperature` / `top_p` / `top_k`; the API returns 400 if any of them is set. The provider detects these models by prefix (`claude-opus-4-*`) and **silently drops** any user-supplied `temperature` before sending — adaptive thinking takes over. If you need a specific temperature, target a non-thinking model (e.g. `claude-sonnet-4-6`, `claude-haiku-4-5`).

## License

MIT
