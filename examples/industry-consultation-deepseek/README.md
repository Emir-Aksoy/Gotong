# industry-consultation-deepseek

End-to-end "传统行业咨询管线" (5-step industry consultation pipeline) running on the **real DeepSeek API**, plus a live demonstration of v2.3 case-conversation — humans interjecting mid-workflow with full context preserved.

## Run

```bash
echo 'DEEPSEEK_API_KEY=sk-...' > .env.local   # at the repo root
pnpm --filter @gotong/example-industry-consultation-deepseek start
```

The `start` script wires `tsx --env-file=../../.env.local` so the key is sourced automatically.

## Scenario

Runs **two independent consultations** (餐饮 + 零售) end-to-end through the workflow engine, with a **case-conversation injection** after the first one:

1. **RUN 1 (餐饮)** — five workflow steps (intake → research → recommendation → memo → finalize), each step's output recorded into a case-scoped memory.
2. **Case-conversation insertion** — a `case-manager` agent is dispatched with a follow-up question; it reads the full RUN 1 case memory and answers based on the whole history.
3. **RUN 2 (零售)** — same pipeline on a different `caseId`, proving case memories don't leak across consultations.

`caseId` is passed in the trigger payload and the `WorkflowRunner` propagates it to every step. Agents read `task.payload.caseId` and attach the right case-scoped handle.

## What this proves

- **Workflow + Hub Services + case-conversation** compose cleanly: the workflow drives steps, services back state, case-conversation gives humans a real "interject" surface.
- **Two memory layers coexist**: per-case (`{kind:'workflow-run', id: caseId}`) for the consultation's history; per-agent (`{kind:'agent', id:'industry-coach-pro'}`) for cross-case knowledge like `priorCount`.
- **Real LLM cost is small**: ~11 calls per full run (5 + 1 + 5), USD $0.005–0.01, ~100–150 seconds. Fine for smoke testing without an Anthropic / OpenAI key.

Source: [`src/index.ts`](src/index.ts). Design: [`docs/enablement-flow-case-conversation-plan.md`](../../docs/enablement-flow-case-conversation-plan.md).

> **Prerequisite**: `.env.local` at the repo root with `DEEPSEEK_API_KEY=sk-...`. Get a key at [platform.deepseek.com](https://platform.deepseek.com).
