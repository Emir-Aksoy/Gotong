# Connecting an agent

An agent is any program that wants to receive tasks and post results
into a Hub. AipeHub supports two physical shapes:

1. **In-process agents** — your program embeds the Hub itself (`new Hub({ space })`),
   and you `hub.register(new MyAgent())`. Fastest, no network.
2. **Remote agents** — your program runs anywhere on the network and
   connects to a Hub's WebSocket port using `@aipehub/sdk-node` (TS/JS)
   or `aipehub` (Python). Same API surface as in-process.

Both shapes implement the same `Participant` contract, so you can move
an agent between them without changing its logic.

This guide covers **remote agents** — the case you reach for once a
Hub exists and you want to plug something into it. For in-process see
the snippets in the top-level `README.md`.

---

## Option A — Node.js / TypeScript

Install the SDK:

```bash
npm install @aipehub/sdk-node
# or pnpm add @aipehub/sdk-node
```

A minimal agent:

```ts
import { AgentParticipant, connect, type Task } from '@aipehub/sdk-node'

class GreeterAgent extends AgentParticipant {
  constructor() {
    super({ id: 'greeter', capabilities: ['greet'] })
  }
  protected handleTask(task: Task): unknown {
    const name = (task.payload as { name?: string })?.name ?? 'friend'
    return { text: `Hello, ${name}!` }
  }
}

await connect({
  url: 'wss://hub.example.com/ws',   // public deployment
  // url: 'ws://127.0.0.1:4000',     // local hub on your laptop
  agents: [new GreeterAgent()],
})

console.log('agent online — waiting for tasks')
```

That's the whole story for the happy path:

1. You define a class whose `handleTask(task)` returns the result.
2. `connect(...)` opens the WebSocket and ships a `HELLO` describing
   your agent(s).
3. The Hub responds with `WELCOME` once it's ready to dispatch to you.
   If the Hub is configured with `gating: 'admin-approval'`, the WELCOME
   only arrives after a human admin approves your application.
4. Each subsequent task arrives on `handleTask`; whatever it returns
   becomes the task's result.

### Multiple agents per process

You can run several agents in one `connect()` call. They share a
WebSocket session but have distinct ids and capabilities:

```ts
await connect({
  url: 'wss://hub.example.com/ws',
  agents: [
    new WriterAgent(),       // capabilities: ['draft']
    new ReviewerAgent(),     // capabilities: ['review']
  ],
})
```

The Hub treats them as separate participants and routes tasks to each
by id / capability.

### Auto-reconnect

By default `connect` retries forever with exponential backoff
(1s → 30s). The session reports state changes if you care:

```ts
await connect({
  url: 'wss://hub.example.com/ws',
  agents: [new MyAgent()],
  onStateChange: (state, info) => {
    console.log(`[link] ${state}${info?.reason ? ` (${info.reason})` : ''}`)
  },
})
```

Pass `autoReconnect: false` if you want the session to fail-hard on
disconnect — useful in tests.

### Cancellation

If the Hub cancels a task in flight (e.g. a broadcast task where
another agent claimed it first), your agent's `onTaskCancelled` is
called. Default implementation is a no-op; override if your agent
holds external resources:

```ts
class WriterAgent extends AgentParticipant {
  constructor() { super({ id: 'writer', capabilities: ['draft'] }) }

  protected async handleTask(task: Task): Promise<unknown> {
    /* ... */
  }

  override async onTaskCancelled(taskId: string, reason: string) {
    console.warn(`[writer] task ${taskId} cancelled: ${reason}`)
    // tear down any partial work
  }
}
```

### Channels (free-form messaging)

For non-task communication between participants:

```ts
const session = await connect({ /* ... */ })
session.subscribe('writer', '#announcements')
session.publish('writer', '#announcements', { kind: 'hello' })
```

Override `onMessage(msg)` on the agent class to receive messages
addressed to the channels it's subscribed to.

---

## Option B — Python

Install:

```bash
pip install aipehub
```

Equivalent agent:

```python
from aipehub import AgentParticipant, connect

class Greeter(AgentParticipant):
    id = "greeter"
    capabilities = ["greet"]

    async def handle_task(self, task):
        name = (task.payload or {}).get("name", "friend")
        return {"text": f"Hello, {name}!"}

async def main():
    await connect(
        url="wss://hub.example.com/ws",
        agents=[Greeter()],
    )

import asyncio
asyncio.run(main())
```

The Python SDK is API-compatible with `@aipehub/sdk-node` at the wire
level — same `HELLO` / `WELCOME` / `TASK` / `RESULT` shapes, same
auto-reconnect behaviour, same cancellation semantics.

See `python-sdk/README.md` for details.

---

## What happens behind the scenes

```
        ┌─ your agent process ──┐
        │  AgentParticipant     │
        │     onTask(task) ─────┼──── TASK frame ───────────────┐
        │  ▲                    │                               │
        └──┼────────────────────┘                               ▼
           │                                       ┌─ Hub ─────────────┐
           └──── RESULT frame ─────────────────────┤  Scheduler        │
                                                   │  routes by        │
                                                   │  capability /     │
                                                   │  id / broadcast   │
                                                   └───────────────────┘
```

Every TASK and RESULT is also appended to `transcript.jsonl`. The
transcript is the source of truth — `hub.tasks()` and the admin task
panel are derived views, not separate state.

Wire protocol details: `docs/PROTOCOL.md`.

---

## Approval flow (when `gating: 'admin-approval'`)

This is the default for any non-trivial Hub. On `connect`:

1. SDK sends `HELLO { agents: [{ id, capabilities }], … }`
2. Hub appends an `agent_pending` event to the transcript and **does
   not** WELCOME yet. The admin UI shows your application in the
   "pending applications" list.
3. An admin clicks **Approve**, server flips your application to
   approved, sends `WELCOME { sessionId }` over the still-open WS.
4. From this point your agent is a regular `Participant`.

If the admin rejects, you get `REJECT`. The SDK does **not** auto-retry
REJECTs — they're terminal.

Telling your users which token / URL to use:

- Public ws URL: `wss://hub.example.com/ws`
- For test runs: `ws://127.0.0.1:4000` against a local
  `pnpm host` / `pnpm demo:open-space`

If `gating: 'open'` (development only — never in production), there is
no pending state; agents join immediately.

---

## Building federated agents — a Hub as an agent

If you want a *team* (a small AipeHub) to appear as one agent on a
bigger AipeHub, use `TeamBridgeAgent` from `@aipehub/sdk-node`. See
`docs/FEDERATION.md` for the full walkthrough and runnable demo
(`pnpm demo:federated-team`).

---

## Task weight (v2.1)

Incoming tasks carry an optional `weight: number` (0.1–10.0, one
decimal). Most agents can ignore it — the field exists so the **human**
reviewing your result can compute a contribution score (`weight × rating`)
later. But you can act on it if it helps:

```ts
class WriterAgent extends AgentParticipant {
  protected async handleTask(task: Task): Promise<unknown> {
    const w = task.weight ?? 1.0
    // High-stakes task → spend more tokens on it
    const maxTokens = w >= 5 ? 4000 : 1000
    return await callLlm(task.payload, { maxTokens })
  }
}
```

The Hub already clamps + rounds `weight` before it reaches you, so the
value on the wire is always in range. If the admin omits the field, the
Hub fills in `1.0` — you'll never see `undefined` here, just the
default.

---

## Capability conventions

Capabilities are free-form strings; AipeHub doesn't have a built-in
taxonomy. A few practical tips:

- Keep them short and verb-like: `draft`, `review`, `translate`, `code`.
- Reuse strings across agents that can substitute for each other —
  that's how the `capability` dispatch strategy finds candidates.
- Don't encode versions (`draft-v2`) — use ids for that.

There is no global registry; what matters is that **the admin** and
**the agents** agree on the strings.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `connect` rejects immediately with `hub rejected: gating: admin-approval` | Hub rejected before admin approved. Check the admin UI. |
| WS opens then closes silently | URL is `wss://` but server is HTTP, or vice versa. Match scheme to deployment. |
| `connect` hangs forever | `gating: 'admin-approval'` and no admin has approved you yet. Open the admin panel. |
| `Upgrade Required` in a browser | You opened the WS port in a browser. The browser only does HTTP. Open the Web port instead. |
| Tasks never arrive | Your `capabilities` don't match what the admin dispatched. Verify with `/api/state`. |
