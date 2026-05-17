# cli-human

The terminal as a `HumanParticipant` adapter — a reference pattern for any CLI / chat / IM UI built on top of AipeHub.

## Run

```bash
pnpm demo:cli-human
```

For CI / non-TTY shells:

```bash
AIPE_AUTO=1 pnpm demo:cli-human   # auto-approves every prompt with "ok"
```

## Scenario

1. An `LlmAgent` (mock provider) writes three short drafts in a loop.
2. Each draft is dispatched to `you` — a `HumanParticipant` — for approval.
3. You see the task in the terminal; type the response (Enter alone accepts with `"ok"`; `r <reason>` rejects).
4. The Hub records each verdict in the transcript.

## What this proves

The Hub doesn't care whether the human is on stdin, in a Slack channel, on a web page, or on WeChat. The pattern is the same:

- Spawn a loop calling `human.next()` to pull pending tasks FIFO.
- Render the task in your medium (here: `stdout`).
- Capture the response (here: stdin via `readline`).
- Call `human.complete()` or `human.reject()`.

Copy this file as the skeleton when building a new human-facing UI for AipeHub.

Source: [`src/index.ts`](src/index.ts).
