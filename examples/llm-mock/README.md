# llm-mock

Exercises the `LlmAgent` pipeline without any LLM API key. Two LLM-backed agents pass a task through a fully deterministic mock provider.

## Run

From the repo root:

```bash
pnpm demo:llm
```

## Scenario

- **writer** (capability `draft`) — `LlmAgent` backed by `MockLlmProvider`; reply derived from the topic.
- **reviewer** (capability `review`) — same `LlmAgent` shape, canned response.

The Hub dispatches by capability and the transcript prints what each agent did.

## What this proves

The point is the **abstraction seam**: `LlmAgent` + `LlmProvider` is the contract. Swapping `MockLlmProvider` for `AnthropicProvider` or `OpenAIProvider` (see [`../llm-real`](../llm-real)) is a one-line change in the constructor — **the agent code itself doesn't move**.

Use this as the template when you're building a new LLM-backed role: implement against `MockLlmProvider` first, then point at a real provider for production. Your tests can keep using the mock for free.

Source: [`src/index.ts`](src/index.ts).
