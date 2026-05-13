# @aipehub/workflow

> **Pluggable, file-first workflow runner for AipeHub.**
> The Hub is intentionally dumb — it only dispatches single tasks. This package adds
> **multi-step orchestration on top**, without touching Hub core. A workflow is just
> an `AgentParticipant` that, when it receives a task, internally calls
> `hub.dispatch()` several times in the right order with the right data, then
> returns the final result.

## Why a separate package?

AipeHub keeps the Hub small on purpose ([ARCHITECTURE.md](../../docs/ARCHITECTURE.md)).
Workflows are **a layer above** routing, not part of routing. By living in a
separate package:

- You can use AipeHub **without** workflows (it's still just a routing hub).
- You can **swap or replace** the workflow engine without touching Hub code.
- The Hub stays auditable: every step still goes through `hub.dispatch()`, every
  result still lands in the transcript.

## What it is — and what it isn't

| | This package |
|---|---|
| **Is** | A YAML/JSON schema + a runner that turns one inbound task into N sequential / parallel `hub.dispatch()` calls and returns the last step's output |
| **Is** | An `AgentParticipant` — registered with the Hub like any other agent |
| **Is** | File-first — workflow definitions are `.yaml` files; running state is `.json` files under `.aipehub/workflows/runs/` |
| **Isn't** | A DAG compiler with conditional branching (v0.2) |
| **Isn't** | A long-running scheduler (no cron, no delays) |
| **Isn't** | A modification to Hub core |

## 30-second quick start

1. Write a workflow YAML:

   ```yaml
   # workflows/editorial-flow.yaml
   schema: aipehub.workflow/v1
   workflow:
     id: editorial-flow
     name: 中文编辑流水线
     trigger:
       capability: run-editorial
     steps:
       - id: draft
         dispatch:
           strategy: { kind: capability, capabilities: [draft] }
           payload: $trigger.payload
       - id: review
         dispatch:
           strategy: { kind: capability, capabilities: [review] }
           payload: { draft: $draft.output }
     output: $review.output
   ```

2. Register the runner:

   ```ts
   import { Hub, Space } from '@aipehub/core'
   import { WorkflowRunner, parseWorkflow } from '@aipehub/workflow'
   import { readFileSync } from 'node:fs'

   const { space } = await Space.openOrInit('.aipehub', { name: 'demo' })
   const hub = new Hub({ space })
   await hub.start()

   // load + register the workflow
   const def = parseWorkflow(readFileSync('workflows/editorial-flow.yaml', 'utf8'))
   hub.register(new WorkflowRunner({ definition: def, hub, space }))
   ```

3. Dispatch:

   ```ts
   const result = await hub.dispatch({
     from: 'admin',
     strategy: { kind: 'capability', capabilities: ['run-editorial'] },
     payload: { topic: '为什么 TypeScript' },
   })
   // result.output === final review output
   ```

The runner internally fires two `hub.dispatch()` calls (one for `draft`, one for
`review`), threads the data, and returns the last one's output. Every sub-task
appears in the transcript with `from: workflow:editorial-flow`.

## File layout

```
.aipehub/
  workflows/
    runs/
      <runId>.json        ← per-run state file (start ts, steps progress, outputs)
```

Each run gets its own JSON file. The runner writes it on start, updates it after
every step, and finalizes it at the end. Crash mid-run? The file is still there
for inspection (resume is v0.2).

## Schema reference

See [`docs/WORKFLOW.md`](../../docs/WORKFLOW.md) for the full schema.

## License

MIT.
