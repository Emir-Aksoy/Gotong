# codex-deepseek-hub — Codex + a DeepSeek TUI, scheduled by one router

A personal **AI 桌面** case AipeHub can carry: one router LLM actively manages two
terminal coding agents — **Codex** and a **DeepSeek-backed TUI** — as hub
`Participant`s, dispatching the RIGHT coder for each goal. Both operate on the
**same repo** (shared `cwd`), so they share project-level files: `AGENTS.md` (the
spec) and `PROGRESS.md` (the handoff baton).

> Sister example to [`personal-coding-hub`](../personal-coding-hub) (Claude Code +
> Codex). This one is a **separate, self-contained** hub pairing **Codex with a
> DeepSeek TUI** — nothing here touches `personal-coding-hub`.

## The pairing — 能力分派要合适

The two coders have complementary strengths, and the router routes by them rather
than running a fixed pipeline:

| Coder | Role | Good at |
|---|---|---|
| `deepseek-tui` | **lead** (the reasoner) | review, analysis, design, multi-file refactor |
| `codex` | **fast implementer** | scaffolding, quick fixes, building a plan into code |

DeepSeek's reasoner is strong at analysis/design, so it **leads the thinking**;
Codex is the fast hands that turn a plan into code. The router combines two inputs
(exactly like the sister hub):

1. **分析任务** — `analyzeTask(goal)` reads the goal into facets (review-only?
   trivial? needs design first?). A real router model makes this judgement; a
   keyword classifier stands in so the demo is deterministic.
2. **用户的安排** — a declarative `RoutingPolicy`: the roster + what each coder is
   good at, which coders are off right now (`unavailable`), a budget cap
   (`singleCoder`), an optional preferred lead.

`planRoute(goal, policy)` combines them — so the **same** goal routes
**differently** under different arrangements, and always to a coder that can
actually do it:

```
feature  · default roster   → deepseek-tui (drafts) → codex (implements)
feature  · codex off        → deepseek-tui alone (drafts AND implements)
feature  · budget = 1 coder → deepseek-tui alone
trivial  · default roster   → codex (direct fix)
trivial  · codex off        → deepseek-tui covers the small fix
review-only (don't change)  → deepseek-tui (reports findings, no implementation)
```

## Run (deterministic, no API key)

```bash
pnpm demo:codex-deepseek-hub
# or
pnpm -C examples/codex-deepseek-hub start
```

It runs each scenario in its own throwaway repo + hub, and **asserts** that the
SET of agents that appended to the shared `PROGRESS.md` equals what the goal
should route — proof the dispatch fitted the goal × arrangement, not a fixed
pipeline. A final **safety-gate** scenario shows a destructive instruction
(`rm -rf … && git push --force`) parking *before any spawn* and failing closed
when the human denies it.

The router brain and the coders are deterministic stand-ins, but the **file
sharing is real**: a real temp repo with a real `AGENTS.md` + `PROGRESS.md` that
both coders read and append to.

## Real mode — driving the actual Codex + a DeepSeek TUI

`real-agents.ts` / `index.real.ts` (see `pnpm start:real`) wire the same hub to
the real tools:

- **router brain** → DeepSeek (`https://api.deepseek.com`, OpenAI-compatible),
  needs `DEEPSEEK_API_KEY`. The dispatch tool is scoped to the two coders.
- **`codex`** → the real `codex` CLI (`codex exec --sandbox workspace-write …`),
  using its own login. No key is injected by the hub.
- **`deepseek-tui`** → a **DeepSeek-backed terminal coding agent**. DeepSeek's API
  is OpenAI-compatible, so any OpenAI-compatible terminal coder can be pointed at
  it. The command is **configurable** (`DEEPSEEK_TUI_CMD` / `DEEPSEEK_TUI_ARGS`)
  so you can use whichever DeepSeek TUI you run; the default is documented in
  `real-agents.ts`.

Each tool authenticates via its own login / key — the hub never sees the coders'
credentials and the coders never see the router's. Three independent auth layers,
kept apart on purpose.

## North Star alignment

- The **framework runs no LLM** — the router and the coders are external agents;
  the hub only routes the dispatch and records the transcript.
- **People are `Participant`s** — the safety gate parks a dangerous action and
  resumes only on a human decision (Phase 16 inbox in production), not a bespoke
  "ask the human" tool.
- **State is files** — `AGENTS.md` + `PROGRESS.md` on disk are the shared memory;
  copy the directory and you copy the room.
- **Example-first** — host `main.ts` is untouched; this is a self-contained demo.
