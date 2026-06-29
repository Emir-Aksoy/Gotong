# @aipehub/personal-butler

The resident **personal butler** — a `MemoryAugmentedAgent` with ONE addition:
a bounded tool-loop whose **sensitive** tool calls are approval-gated. M4 of the
butler build (see `docs/zh/PERSONAL-BUTLER-DESIGN.md`). 对标 OpenClaw / Hermes
那种「一直在的智能管家」：有记忆、能灵活调用、危险动作先问人。

Leaf package — depends only on `@aipehub/core`, `@aipehub/llm`,
`@aipehub/personal-memory`. No host, no identity, no LLM credentials. The real
risk policy (classifier) and the real side effects (executor) are **injected**
by the host — same discipline as `MemorySummarizer` in `@aipehub/personal-memory`.

## What's in the box

| Export | What it does |
|---|---|
| `PersonalButlerAgent` | `MemoryAugmentedAgent` + a bounded, governance-gated `runToolLoop`. Benign tools run inline; governed tools PARK the task for a human before any side effect. |
| `GovernedActionToolset` | The sensitive actions (change hub / spend / send outward / delete), exposed as LLM tools but split into **gating** (`classify`) and **execution** (`callTool`). |
| `butlerGateState` / `readButlerGateState` / `readButlerDecision` | Checkpoint primitives: the re-runnable park state that rides `SuspendTaskError.state`, and a **fail-closed** decision reader. |
| `ButlerError` | Typed error (`no_governed_tools` / `duplicate_governed_tool`). |

## Why a custom tool-loop — and why governed tools PARK

The base `LlmAgent.runToolLoop` deliberately maps **every** `callTool` throw to
an `isError` tool result (so `DispatchToolset` can surface a child-suspend
without parking the parent). The butler needs the **opposite** for a dangerous
tool: park the parent task so a human can decide. So it owns its own loop and a
bespoke checkpoint state — the shared base loop is untouched (blast radius stays
in this package).

A governed action never re-tiers itself: `GovernedActionToolset` keeps the
classifier OUT of `callTool`. The loop classifies first; only if the verdict is
`allow` (or a human approved on resume) does it run `callTool`. That split is
what lets the butler suspend **before** the side effect, then run the very same
`callTool` once approved.

```
  user → butler.runToolLoop
    ├─ benign tool        → run inline (DispatchToolset / workflow-start / mcp)
    └─ governed tool
         classify(name,args) ─┬─ allow   → run inline
                              ├─ refuse  → isError inline (model adapts)
                              └─ approve → SuspendTaskError(NEVER_RESUME_AT)
                                            → /me inbox → human decides
                                              ├─ approve → callTool (the deferred action)
                                              └─ deny    → fail-closed isError
```

This is the same suspend/resume machinery as `@aipehub/inbox` (human steps) and
`@aipehub/acp-agent`'s permission gate — adapted from a live subprocess to a
**re-runnable** conversation, so a butler park is durable across a hub restart.

## Three verdicts

`classify(name, args)` returns one of:

| Verdict | Meaning |
|---|---|
| `{ decision: 'allow' }` | Run inline; no human. |
| `{ decision: 'approve', reason }` | Park for a human (`/me` inbox). |
| `{ decision: 'refuse', reason }` | Fail-closed inline; the model gets an `isError` result and must find another way. |

No classifier injected → each tool falls back to its `defaultVerdict`, then to
`approve` (a governed tool with no policy still asks a human). The host wires
hub-steward's `classifyStewardAction` for real four-tier policy
(safe / dangerous / cross_hub / forbidden).

## Usage

```ts
import { PersonalButlerAgent, GovernedActionToolset } from '@aipehub/personal-butler'

const governed = new GovernedActionToolset({
  tools: [
    { name: 'delete_agent', description: 'Delete a managed agent', inputSchema: { /* … */ } },
    { name: 'set_credential', description: 'Store an API key reference', inputSchema: { /* … */ } },
  ],
  classify: (name, args) => hostClassifier(name, args), // hub-steward tiering
  execute: (name, args) => hostExecutor(name, args),    // performStewardAction / member services
})

const butler = new PersonalButlerAgent({
  id: 'butler',
  provider,                 // any LlmProvider
  memory: services.memory,  // per-user MemoryHandle (frozen-block memory, inherited)
  system: 'You are my personal butler.',
  benign: [dispatchToolset, workflowStartToolset, mcpToolset], // run inline
  governed,                 // approval-gated
  maxToolRounds: 8,         // bounded — never an unbounded autonomous loop (decision D8)
})
```

On a governed park, the host turns `state.pending.approval` into a `/me` inbox
item and, on approval, resumes the task with `{ answer: { approved: true } }`
(via `HostInboxService.resumeChild`). A missing/malformed decision is treated as
a **denial** — never an implicit approval.

## Boundaries (decision D8)

- **Bounded**: `maxToolRounds` caps the loop. No unbounded autonomy.
- **Gated**: sensitive actions can't run without a human or an explicit `allow`.
- **No host exec from the leaf**: this package never touches identity, the hub,
  or credentials — it parks and lets the host do the privileged work.
