# examples/personal-butler

A turnkey demo of the resident **personal butler** (OpenClaw / Hermes style) —
M5 of the butler build (see [`docs/zh/PERSONAL-BUTLER-DESIGN.md`](../../docs/zh/PERSONAL-BUTLER-DESIGN.md)).

A butler is two things stacked:

```
  PersonalButlerAgent
    └─ MemoryAugmentedAgent   ← memory across sessions (frozen block + capture + consolidate)
         └─ LlmAgent          ← the model
       + a bounded tool-loop   ← benign tools inline; SENSITIVE tools wait for a human
```

The framework still never decides — it routes, suspends, and resumes. A person
clears every dangerous action.

## What the demo proves (deterministic, no API key)

```
pnpm demo:personal-butler
```

| # | Invariant | How it's shown |
|---|---|---|
| **[1]** | **Memory across sessions** | Session 1: the user says "我叫阿明 / 在做奶茶店项目" → captured to episodic (M2) → `consolidate` distills a durable semantic profile (M3). A **brand-new** session reads that profile from its frozen block (M1) and recalls 奶茶店. |
| **[2]** | **Benign tools run inline** | "看看今天的日程" runs `check_calendar` straight away — no approval. |
| **[3]** | **Sensitive actions are gated** | "把 mailer 删掉" PARKS the task (`SuspendTaskError` → a `/me` inbox item) BEFORE anything happens. Approve → it runs (mailer gone). Decline → fail-closed (billing stays). |

The whole script self-asserts (it `throw`s on any mismatch), so running it IS the
anti-corrosion gate — break the loop or the memory wiring and the demo goes red.

## How it maps to production

| In this demo | In a real hub |
|---|---|
| `ButlerMockProvider` (keyword script) | any `LlmProvider` — Anthropic / DeepSeek / MiMo |
| `inMemoryHandle()` | a per-user, file-backed `MemoryHandle` from the host's memory service |
| `classify: delete_agent → approve` | hub-steward's `classifyStewardAction` (four tiers safe/dangerous/cross_hub/forbidden) |
| `execute: …` mutates a fake `Set` | the host's real member services / `performStewardAction` |
| approval simulated inline (`onResume({ answer }))` | `StewardApprovalBroker` + `HostInboxService.resumeChild` driving a real `/me` inbox |

Nothing about the butler's loop or gating changes between the two columns — only
what's injected.

## Honest boundaries

- **The deterministic demo simulates approval inline.** The full-stack acceptance
  gate — a real `Hub` + `suspendNotifier` → `IdentityStore`, a real
  `StewardApprovalBroker`, and `HostInboxService` two-step resume — is the **M6**
  deliverable (`packages/host/tests/personal-butler-e2e.test.ts`).
- **The admin enable-toggle and the `/me`「它记得你什么」privacy view** (read
  profile/episodic, forget, export) land in **M6** too: both need the butler
  registered in the host with a per-user memory namespace, which is exactly M6's
  scope. They're sequenced there rather than split awkwardly across M5/M6.
- **Example-first.** This is runtime-wired example code (`src/`), not folded into
  `aipehub start`. Folding the butler into the host CLI is the M6 host-wiring step.
