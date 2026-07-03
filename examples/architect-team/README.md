# architect-team

Phase 10 demo — an architect `LlmAgent` uses its tool-use loop to
dispatch sub-tasks to writer / reviewer / tester sub-agents via
`DispatchToolset`, then aggregates their replies into a final plan.

The whole point: agent-to-agent dispatch is now a **tool the LLM
chooses to call**, not a workflow-runner concern. The architect
pattern moves up from "YAML workflow does fan-out" to "the agent
decides who to dispatch to, when, and aggregates results in-loop."

## Run

```bash
pnpm demo:architect-team
```

No API key required — the architect's provider is a scripted
`MockLlmProvider` that emits three `tool_use` chunks (one per
sub-agent) on round 1 and an aggregated plan on round 2. Swap in
`AnthropicProvider` / `OpenAIProvider` and the wiring is
provider-agnostic.

## What you'll see

A transcript trace like:

```
[seq=00] JOIN     writer caps=[draft]
[seq=01] JOIN     reviewer caps=[review]
[seq=02] JOIN     tester caps=[test]
[seq=03] JOIN     architect caps=[plan]
[seq=04] TASK     system "plan something" via capability caps=[plan]
[seq=05] TASK     architect "(untitled)" via explicit to=writer ancestry=architect
[seq=06] RESULT   ok by writer
[seq=07] TASK     architect "(untitled)" via explicit to=reviewer ancestry=architect
[seq=08] RESULT   ok by reviewer
[seq=09] TASK     architect "(untitled)" via explicit to=tester ancestry=architect
[seq=10] RESULT   ok by tester
[seq=11] RESULT   ok by architect
```

The `ancestry=architect` annotation on each sub-task is the Phase 10
M2 dispatch chain — every sub-task carries the chain back to its
root. The hub uses this for two gates:

- **Depth** — chains over `MAX_DISPATCH_DEPTH` (default 5) are
  rejected so a misbehaving agent can't spawn infinite recursion.
- **Cycle** — an explicit `dispatch_task` whose target already
  appears as an ancestor's executor is rejected. Stops A → B → A
  loops on the third hop.

## What this proves

A coordinator/architect pattern that previously needed:

```yaml
# old: workflow YAML knows the structure ahead of time
steps:
  - parallel:
      - dispatch: { to: writer, ... }
      - dispatch: { to: reviewer, ... }
      - dispatch: { to: tester, ... }
  - dispatch: { to: aggregator, ... }
```

becomes:

```yaml
# new: the LLM decides at runtime
agents:
  - name: architect
    system: "You are an architect. Use dispatch_task..."
    dispatch:
      agents: [writer, reviewer, tester]
```

The architect is free to dispatch zero, one, or many sub-tasks
based on the input, and to skip the steps that don't apply.

## See also

- `DispatchToolset` source: `packages/llm/src/dispatch-toolset.ts`
- Depth + cycle gates: `packages/core/src/hub.ts` (`checkDispatchGates`)
- Phase 10 RFC: see roadmap in `docs/zh/ledger/V4-PHASE7-13-PLAN.md` section 5
- Wiring from YAML manifest: `packages/host/src/local-agent-pool.ts`
  (the `dispatch:` allow-list path).

Source: [`src/index.ts`](src/index.ts).
