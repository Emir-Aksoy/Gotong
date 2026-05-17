# llm-real

The cross-vendor demo. One agent uses Anthropic Claude, another uses OpenAI GPT, in the same room.

## Run

```bash
ANTHROPIC_API_KEY=sk-ant-... OPENAI_API_KEY=sk-... \
  pnpm demo:llm:real
```

If only one key is present the demo skips the missing side with a clear message; if neither is present it exits early.

## Scenario

- **writer** — `AnthropicProvider`, capability `draft`.
- **reviewer** — `OpenAIProvider`, capability `review`.

The Hub dispatches a draft request to `writer`, then a review request to `reviewer`. Each agent calls its respective vendor SDK; results land back through the transcript.

## What this proves

The agent code is **byte-identical** to [`../llm-mock`](../llm-mock) — only the provider differs. That's the whole point of the `LlmProvider` interface: vendor swaps are configuration, not refactoring. Mix providers within one room when each one is strong at something different (Claude for long-form, GPT for terse rewrites, etc.).

## Costs

About USD $0.001–0.003 per run depending on which vendors you have keys for. Both models default to the cheapest tier in each provider's SDK.

Source: [`src/index.ts`](src/index.ts).
