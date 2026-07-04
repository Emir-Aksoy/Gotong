# hello-collab

The minimum demo that proves the Gotong abstraction holds. Two agents and one human pass a writing task back and forth.

## Run

From the repo root:

```bash
pnpm demo
```

(Equivalent to `pnpm --filter @gotong/example-hello-collab start`.)

## Scenario

1. **WriterAgent** drafts a short writeup on a topic.
2. **ReviewerAgent** reads the draft and suggests one revision.
3. **WriterAgent** revises based on the suggestion.
4. **Alice** (a `HumanParticipant`) is asked to approve the final version.

Steps 1–3 exercise **capability matching** — the dispatcher does not name the agent, only the required capability. Step 4 exercises **explicit** routing — the dispatcher names Alice.

Alice's UI is simulated by a small loop that auto-approves after a short "thinking" delay. In a real app this loop is what the web UI does for you.

## What this proves

- Same `AgentParticipant` contract for two different agents.
- Same `HumanParticipant` contract for the human.
- Two of three dispatch strategies (`capability`, `explicit`).
- No network, no persistence — everything runs in one process against `Hub.inMemory()`. Good first read.

Source: [`src/index.ts`](src/index.ts).
