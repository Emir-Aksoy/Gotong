# broadcast-claim

Proves the `broadcast` dispatch strategy: a task fans out to every matching agent, the first `ok` wins, and the rest are cancelled mid-flight.

## Run

From the repo root:

```bash
pnpm demo:broadcast
```

## Scenario

Three reviewers all match capability `review` but respond at different speeds (250 / 500 / 1000 ms). The scheduler races them; the first to return wins and the slower two get `onTaskCancelled(reason)` calls. The terminal prints which reviewer won and which were cancelled.

## What this proves

- **Broadcast** is the third dispatch strategy (alongside `explicit` and `capability`); it's the right choice when you want "whoever's fastest", redundant grading, or first-acceptance approval.
- **Cancellation propagates** — losers get notified via `onTaskCancelled`, so they can stop spending resources on a task someone else already finished.
- **Predictable race semantics** — the delays are controlled by the agent code so the example output is deterministic, not flaky.

Source: [`src/index.ts`](src/index.ts).
