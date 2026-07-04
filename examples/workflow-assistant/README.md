# workflow-assistant

Phase 13 M5 — end-to-end demo of the AI workflow editor pipeline.

Runs the **`WorkflowAssistantAgent`** (M1) against a real LLM, then walks each draft through `parseWorkflow` (M1) and the M4 deep checker (`@gotong/evals/checkers/workflow-structure`) so you can see exactly what a human admin would see in the web editor.

## What it shows

Four scenarios in sequence:

| # | Label | What it exercises |
|---|---|---|
| A | `happy` | LLM produces a workflow that matches the hub inventory → `valid + deepCheck.ok` (green chip) |
| B | `collision-pressure` | Ask for an id that already exists → may trip `id_collision` |
| C | `unknown-cap-pressure` | Ask for capabilities the hub doesn't expose → trips `unknown_capability` (yellow chip — the killer M4 feature) |
| D | `standalone helper` | Hand-crafted bad YAML through `verdictForYamlWithDeepCheck` directly — proves the helper is reusable outside the agent |

The synthetic "hub inventory" in `src/index.ts` (`DEMO_HINTS`) is what a real host's `createWorkflowAssistAgent` would assemble from `hub.participants()` + workflow list. Edit it to mimic your own hub.

## Run

```bash
# Real DeepSeek (cheapest, default — needs DEEPSEEK_API_KEY in .env.local)
pnpm --filter @gotong/example-workflow-assistant start

# Real Anthropic
GOTONG_DEMO_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --filter @gotong/example-workflow-assistant start

# Real OpenAI
GOTONG_DEMO_PROVIDER=openai OPENAI_API_KEY=sk-... \
  pnpm --filter @gotong/example-workflow-assistant start

# Mock — no network, no keys, deterministic
pnpm --filter @gotong/example-workflow-assistant start:mock
```

Override the model with `GOTONG_DEMO_MODEL=...` (defaults: `deepseek-v4-flash` / `claude-3-5-haiku-latest` / `gpt-4o-mini`).

## What you'll see

Each scenario prints:

- `⏱ Xms · status=...` — round-trip latency + the assistant's verdict (✓ valid+deepCheck.ok / ⚠ valid+warnings / ✗ invalid / ◌ no_yaml).
- `tokens in/out` — for cost estimation.
- LLM explanation (first 3 lines).
- Deep-check violations, if any — listed by kind + path so you can map them to the YAML.
- YAML preview (first ~12 lines).

## Costs

About USD $0.0001 per run on DeepSeek; $0.001–0.005 on Anthropic / OpenAI depending on draft length. Mock mode is free.

## See also

- [`docs/zh/AI-WORKFLOW-EDITOR.md`](../../docs/zh/AI-WORKFLOW-EDITOR.md) — full release notes for Phase 13 M1+M3+M4.
- [`packages/workflow-assistant`](../../packages/workflow-assistant) — the agent itself.
- [`packages/evals/src/checkers/workflow-structure.ts`](../../packages/evals/src/checkers/workflow-structure.ts) — the deep checker.
- [`packages/host/src/workflow-assist-agent.ts`](../../packages/host/src/workflow-assist-agent.ts) — host-side wiring (provider resolution, env config, hub.dispatch surface).

Source: [`src/index.ts`](src/index.ts).
