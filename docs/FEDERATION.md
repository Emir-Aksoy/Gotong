# Federation — joining Hubs together

Gotong Hubs are dumb on purpose: they don't run LLMs and they don't
care whether a connecting agent is a single Python script or another
whole Hub. That's all the federation primitive needs. Wrap a local Hub
as one agent on a bigger Hub and you have a leader-led team that
participates upward as a single voice.

```
                Upstream Hub  (cloud, public)
                ┌────────────────────────────────────┐
                │  admin Bob                         │
                │  worker Carol                      │
                │  agent  claude-prod                │
                │  agent  alice-team  ← bridge       │
                └─────────────────┬──────────────────┘
                                  │  wss://hub.example.com/ws
                                  ▼
                Team Hub  (Alice's laptop)
                ┌────────────────────────────────────┐
                │  admin Alice                       │
                │  agent  writer-bot                 │
                │  agent  reviewer-bot               │
                └────────────────────────────────────┘
```

## What the bridge is

`TeamBridgeAgent` (in `@gotong/sdk-node`) is an ordinary
`AgentParticipant` you connect outward to an upstream Hub. Instead of
doing the work itself, its `onTask` re-dispatches to the **local Hub**
you hand it, waits for the local team's `TaskResult`, then returns the
result wrapped so the upstream side sees one clean `TaskResult` with
provenance preserved.

The bridge surface to the upstream:

| Upstream sees | Bridge does internally |
|---|---|
| Agent `alice-team`, capabilities `['draft','review']` | Forwards task by capability to local team |
| `TaskResult.kind='ok'` | Local result returned, with `localBy` / `localTaskId` folded into `output` |
| `TaskResult.kind='failed'` | Local failure, prefixed with `local team (<who>): <error>` |
| `TaskResult.kind='cancelled'` | Local cancellation propagated |

## Minimal code

```ts
import { Hub, Space } from '@gotong/core'
import { serveWeb } from '@gotong/web'
import { connect, TeamBridgeAgent } from '@gotong/sdk-node'
import { WriterBot, ReviewerBot } from './bots.js'

// 1. local team Hub (Alice's private cockpit)
const { space } = await Space.openOrInit('.gotong-team', {
  name: 'Alice team',
  adminDisplayName: 'Alice',
  config: { webPort: 3300, gating: 'open' },
})
const local = new Hub({ space })
await local.start()
local.register(new WriterBot())
local.register(new ReviewerBot())
await serveWeb(local, { port: 3300 })   // private UI for Alice

// 2. bridge outward to upstream
const bridge = new TeamBridgeAgent({
  id: 'alice-team',
  capabilities: ['draft', 'review'],     // what you expose upward
  localHub: local,
})
await connect({
  url: 'wss://hub.example.com/ws',
  agents: [bridge],
})
```

That's it. No new protocol — the bridge speaks ordinary
`@gotong/protocol` over the same WebSocket transport every other agent
uses.

## Why this is useful

- **Privacy / sovereignty**: only the bridge result leaves Alice's
  network. The internal task fanout, the per-step transcripts, who on
  the team actually did the work, all stay local. Alice's leader UI
  watches her team; the upstream admin watches only `alice-team`.

- **Capability composition**: the team can include agents Alice doesn't
  want to expose individually (private LLM keys, specialized scripts,
  human reviewers). She exposes them as a bundled team capability.

- **Local pacing**: the bridge can throttle / queue / prioritise on the
  local side however it wants; upstream just sees a single async agent.

- **Identity collapse**: one upstream `alice-team` row is easier to
  reason about for the room operator than five individual agents.

- **Trust boundary**: any compromise of the upstream Hub doesn't
  contaminate Alice's local team — the bridge is outbound-only, the
  local Hub has no inbound WebSocket exposed (well, only if Alice
  decides to).

## Task-routing inside the team

`TeamBridgeAgent` accepts an optional `mapTask(task) → { strategy, payload?, title?, deadlineMs? }`
so the team leader chooses how upstream tasks land locally:

```ts
new TeamBridgeAgent({
  id: 'alice-team',
  capabilities: ['draft', 'review'],
  localHub: local,
  mapTask: (task) => ({
    // route to whichever local agent has the most matching capabilities
    strategy: { kind: 'capability', capabilities: task.payload?.capabilities ?? [] },
  }),
})
```

If you omit `mapTask` the default behaviour is:

1. If the upstream task's `payload` is an object with a `capabilities`
   array of strings → `capability` strategy
2. Otherwise → `broadcast` (the whole local team competes for it)

## Result wrapping

When the local team succeeds, the upstream `TaskResult.output` is:

```ts
{
  localBy: 'writer-bot',                      // local agent who did it
  localTaskId: '989f107f-…',                  // for cross-Hub correlation
  output: { /* whatever the local agent returned */ },
}
```

The upstream admin can audit "alice-team delivered, and writer-bot on
her side actually did it" without leaving the upstream UI.

## Failure semantics

| Local situation | Upstream sees |
|---|---|
| Local team has no agent matching the capability | `TaskResult.kind='no_participant'`, reason includes `local team has no matching participant: …` |
| Local agent throws / returns failed | `TaskResult.kind='failed'`, error prefixed with `local team (<id>): <msg>` |
| Local Hub cancels (e.g. broadcast loser) | `TaskResult.kind='cancelled'`, reason prefixed with `local team cancelled: …` |
| WS link to upstream drops mid-task | Upstream side decides — typical scheduler reports the task failed; the local team may have already finished. Idempotency is the team leader's responsibility. |

Retries: if the upstream admin retries a failed task (via
`hub.retry(taskId)` or the admin UI's Retry button), it lands as a
brand-new task — the bridge sees a fresh `task.id` and starts a fresh
local dispatch. The local transcript records both attempts.

## Bridges of bridges

The bridge mechanism is recursive. A bridge agent on hub X can itself
have a local hub Y that contains another bridge agent connected to hub
Z. There's no protocol-level limit. Practically the chain adds one
network hop per layer; keep it shallow.

## Running the demo

```bash
pnpm demo:federated-team
```

Spawns three processes:

- **upstream-host** on `:3200` (web) / `:4200` (ws) — the "cloud"
- **team-host** on `:3300` (Alice's private UI) — connects outward to
  the upstream as agent `alice-team`
- **driver** — automates "approve the bridge, dispatch three tasks,
  print the round-trip"

You'll see the same task appear twice in each terminal — once on the
upstream as `TASK admin "draft about …" via capability`, once on the
team Hub as `TASK alice-team "[upstream] draft about …" via capability`
— and the result come back as `RESULT ok by alice-team` upstream and
`RESULT ok by writer-bot` locally.

Both `.gotong-upstream/transcript.jsonl` and
`.gotong-team/transcript.jsonl` keep the full audit trail of their own
side.
