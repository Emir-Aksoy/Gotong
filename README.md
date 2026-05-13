# AipeHub

**AI + Person + Hub** — a TypeScript framework for orchestrating agent clusters and humans as first-class collaborative participants.

AipeHub is not an agent. It is a **communication space**: a registry, a message bus, a task router, and an append-only transcript. Agents — local or remote — and humans plug in through adapters and talk to each other; the Hub keeps the signals flowing.

## Core ideas

- **The Hub is dumb on purpose.** It does not run LLMs or own agent loops. It routes messages, dispatches tasks, persists the transcript, and emits events. Decisions stay with participants.
- **Humans are first-class.** A human is a `Participant` like an agent is. The Hub's async / long-running primitives apply to both.
- **One interface, two deployment shapes.** Agents implement the same `Participant` contract whether they run in-process or across the network. Local and remote agents share the same registry and the same scheduler.
- **Pluggable scheduling.** Three task-routing strategies out of the box: explicit assignment, capability matching, and broadcast claiming.
- **Bring your own LLM.** A small `LlmAgent` base class + a neutral `LlmProvider` interface let you back an agent with Claude, GPT, or any other model without touching the Hub.

## Status

**v2.0 — File-first.** A workspace is a directory on disk (`.aipehub/`). Drop the directory, drop the space. Copy it, hand the room to a teammate. Three role-distinct entry points (admin / worker / agent) keep working across hub restarts because admins, workers, sessions, transcript, and pending admissions are all files. No process-memory or browser-storage state — only HttpOnly cookies that point at rows on disk.

See [CHANGELOG.md](CHANGELOG.md) for the v0.0 → v2.0 path and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design. Wire protocol stays at `1.0`, documented in [docs/PROTOCOL.md](docs/PROTOCOL.md).

The npm packages are scoped `@aipehub/*`; the Python SDK is `aipehub` on PyPI.

## Quick start

```bash
pnpm install
pnpm demo               # two mock agents and a mock human collaborate
pnpm demo:broadcast     # three reviewers race, losers get cancelled
pnpm demo:persist:fresh && pnpm demo:persist:resume               # JSONL transcript across restarts
pnpm demo:persist:sqlite:fresh && pnpm demo:persist:sqlite:resume # SQLite transcript across restarts
pnpm demo:web           # web UI + writer agent + alice (browse to localhost:3000)
pnpm demo:remote        # host + worker in separate processes over WebSocket
pnpm demo:remote:python # Node host + Python worker (cross-language demo)
pnpm demo:cli-human     # terminal-as-human approval loop (AIPE_AUTO=1 for non-TTY)
pnpm demo:llm           # LlmAgent + mock provider (no API key needed)
pnpm demo:llm:real      # LlmAgent + real Claude/GPT (needs ANTHROPIC_API_KEY/OPENAI_API_KEY)
pnpm demo:open-space    # v1.1: Hub + WS admission gating + admin/worker web UI
```

## Embedded — everything in one process

```ts
import { Hub, Space } from '@aipehub/core'

// v2.0: bind to a directory; admins, workers, transcript all live here
const { space, adminToken } = await Space.openOrInit('.aipehub', {
  name: 'my-space',
  adminDisplayName: 'Operator',
})
console.log(`Admin URL once: http://localhost:3000/admin?token=${adminToken}`)

const hub = new Hub({ space })
await hub.start()
hub.register(new MyAgent())
hub.register(new MyHumanAdapter())

const result = await hub.dispatch({
  from: 'admin',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'why TypeScript' },
})

// for tests / in-process demos with no persistence:
const tmp = Hub.inMemory()
```

## Distributed — agents connect from another process / machine

Host process (the Hub):

```ts
import { Hub } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'

const hub = new Hub()
await hub.start()
await serveWebSocket(hub, { port: 4000 })
```

Worker process (any agent, anywhere):

```ts
import { AgentParticipant, connect } from '@aipehub/sdk-node'

class MyAgent extends AgentParticipant {
  constructor() { super({ id: 'a1', capabilities: ['draft'] }) }
  protected async handleTask(task) { return { text: '…' } }
}

await connect({ url: 'ws://hub.example.com:4000', agents: [new MyAgent()] })
```

The Hub's `dispatch(...)` calls reach the remote agent identically to a local one. See [docs/PROTOCOL.md](docs/PROTOCOL.md) for the wire format and [examples/remote-agent](examples/remote-agent) for a runnable two-process demo.

## LLM-backed agents

The Hub does not call LLMs. `LlmAgent` does — it's a thin base class that wires a Task into an `LlmProvider` and turns the response into a `TaskResult`. Swapping vendors is a one-line change.

```ts
import { Hub } from '@aipehub/core'
import { LlmAgent } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { OpenAIProvider } from '@aipehub/llm-openai'

const hub = new Hub()
await hub.start()

// Claude writes drafts
hub.register(new LlmAgent({
  id: 'writer',
  capabilities: ['draft'],
  provider: new AnthropicProvider(),        // reads ANTHROPIC_API_KEY
  system: 'You write one terse sentence.',
}))

// GPT reviews them
hub.register(new LlmAgent({
  id: 'reviewer',
  capabilities: ['review'],
  provider: new OpenAIProvider(),            // reads OPENAI_API_KEY
  system: 'You return one revision suggestion.',
}))

const draft = await hub.dispatch({
  from: 'system',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'distributed agents' },
})
```

Override `buildRequest(task)` to customize prompt assembly (retrieved context, few-shot examples) or `parseResponse(response, task)` to post-process (JSON extraction, validation re-prompt). Override `handleTask(task)` for full control — multi-step reasoning, retries, structured outputs. See [`packages/llm`](packages/llm/src/agent.ts) and the two demos in [`examples/llm-mock`](examples/llm-mock) and [`examples/llm-real`](examples/llm-real).

## Open Space — admins, workers, and agents in one room (v2.0)

Anchor the hub to a `.aipehub/` directory; admin identity, worker accounts, and gated agent admissions all live there. Web UI splits into two views (`/` worker, `/admin` admin). Hub restarts are transparent — cookies still work, admins are still admins, transcripts grow rather than restart.

```ts
import { Hub, Space } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'
import { serveWeb } from '@aipehub/web'

const { space, adminToken } = await Space.openOrInit('.aipehub', {
  name: 'my-space',
  adminDisplayName: 'Operator',
  config: { gating: 'admin-approval' },
})
console.log(`Admin URL once: http://localhost:3000/admin?token=${adminToken}`)

const hub = new Hub({ space })
await hub.start()

await serveWebSocket(hub, { port: 4000, gating: (await space.config()).gating })
await serveWeb(hub, { port: 3000 })
// admin = /admin?token=<TOKEN>   |   worker = /
```

- **Admin** signs in once with the token, then drives the room: approve / reject pending agent admissions, dispatch tasks via any of the three strategies, see all tasks in a filterable panel with a **Retry** button on failed rows, write evaluations attached to specific tasks.
- **Worker** picks a nickname + capabilities at `/`, becomes a `HumanParticipant`. A `workers.json` row + an HttpOnly cookie remember them across reloads and restarts.
- **Agent** connects to the WebSocket port; with `gating: 'admin-approval'` they hang in pending until an admin acts.

Full runnable demo in [`examples/open-space`](examples/open-space). `pnpm demo:open-space` spins host + agent in one terminal, then point a browser at the two URLs it prints.

## Packages

| Package | Purpose |
|---|---|
| `@aipehub/core` | Hub, registry, scheduler, transcript, storage, Participant base classes |
| `@aipehub/web` | Embeddable reference UI (HTTP + SSE + vanilla SPA) |
| `@aipehub/protocol` | Wire-protocol types + codec (zero runtime) |
| `@aipehub/transport-ws` | Hub-side WebSocket transport |
| `@aipehub/sdk-node` | Node SDK for remote agents |
| `@aipehub/llm` | `LlmAgent` base class + `LlmProvider` interface + `MockLlmProvider` |
| `@aipehub/llm-anthropic` | Anthropic Claude provider (peer dep: `@anthropic-ai/sdk`) |
| `@aipehub/llm-openai` | OpenAI provider (peer dep: `openai`) |
| `aipehub` (PyPI, in `python-sdk/`) | Python SDK — connect Python agents to a Hub over the same wire protocol |

## License

MIT
