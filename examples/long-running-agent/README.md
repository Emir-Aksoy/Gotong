# long-running-agent

Phase 11 demo — an agent suspends mid-task, the resume sweep wakes
it later, and it picks up where it left off via persisted working
memory.

The whole point: a long-running participant isn't pinned to a single
node-process lifetime. When it needs to wait — for a quota to
refresh, an external service to come back, the next morning's batch
window — it throws `SuspendTaskError({ resumeAt, state })`. The
scheduler persists the row, releases the worker slot, and a
background sweep re-enters the agent via `onResume(task, state)`
when the time comes.

## Run

```bash
pnpm demo:long-running-agent
```

No API key required — the agent is a deterministic batch processor
that suspends at the midpoint and resumes 0.8 s later. Total demo
runtime is ~1.5 s.

## What you'll see

```
[seq=00] JOIN     batch-agent caps=[batch]
[seq=01] TASK     system "process 5 items" via capability
  [agent] processing "alpha" (#1)
  [agent] processing "beta" (#2)
  [agent] reached midpoint after 2 items — suspending until 2026-05-27T…
[seq=02] RESULT   suspended by batch-agent until 2026-05-27T…
  [system] round 1 → suspended
  [system] parked 1 task(s); waiting for sweep…
[seq=03] RESUME   task=…       by batch-agent
  [agent] resumed — already processed 2 of 5 items
  [agent] processing "gamma" (#3)
  [agent] processing "delta" (#4)
  [agent] processing "epsilon" (#5)
[seq=04] RESULT   ok by batch-agent (5 processed)
  [system] sweep resumed 1 task(s); done.
```

The transcript shows the resumed task ran on the **same agent** with
the **same task id** — there's no fresh `task` entry on resume.
That's the Phase 11 contract: a parked task is the same task; it
just continues later, not a brand new one.

## What this proves

A pattern that previously needed a workflow with explicit "wait N
hours then retry" steps becomes a single `throw new
SuspendTaskError(...)` call inside agent code:

```ts
protected async handleTask(task: Task): Promise<unknown> {
  for (const item of items) {
    if (quotaExhausted) {
      throw new SuspendTaskError({
        resumeAt: Date.now() + 24 * 60 * 60_000,
        state: { processed }, // what we've done so far
      })
    }
    await process(item)
    processed.push(item)
  }
  return { processedCount: processed.length }
}

protected override async handleResume(task, state) {
  // Resume continues with what was already done — no double work.
  return this.processFrom(task, state.processed)
}
```

The framework's job:

- **Park** the task (release the worker slot, persist `state` to
  SQLite — production) so other work can flow.
- **Wake** the task at `resumeAt` via the resume sweep.
- **Re-enter** through `onResume(task, state)` instead of
  `onTask(task)` so the agent can distinguish "first run" from
  "I'm being woken up."

In a real host, the persistence is `IdentityStore.suspended_tasks`
and the sweep is `setInterval(AIPE_RESUME_SWEEP_MS)`. This demo
substitutes an in-process `Map` + a hand-rolled poll loop to keep
the example self-contained — the data shape is the same as what
the production sweep handles.

## See also

- `SuspendTaskError` source: `packages/core/src/suspend.ts`
- `Hub.resumeTask`: `packages/core/src/hub.ts`
- Suspended-tasks table + API: `packages/identity/src/schema.ts`
  (migration v=9), `packages/identity/src/store.ts`
  (`persistSuspendedTask`, `listDueSuspendedTasks`, …)
- Host resume sweep: `packages/host/src/main.ts`
  (search for `AIPE_RESUME_SWEEP_MS`)
- `LlmAgent` working memory (Phase 11 M4):
  `packages/llm/src/agent.ts` (`runToolLoop` + `handleResume`)
- Phase 11 plan: `docs/zh/ledger/V4-PHASE7-13-PLAN.md` section 六

Source: [`src/index.ts`](src/index.ts).
