# AipeHub

**AI + Person + Hub** — a TypeScript framework for orchestrating agent clusters and humans as first-class collaborative participants.

AipeHub is not an agent. It is a **communication space**: a registry, a message bus, a task router, and an append-only transcript. Agents — local or remote — and humans plug in through adapters and talk to each other; the Hub keeps the signals flowing.

## Core ideas

- **The Hub is dumb on purpose.** It does not run LLMs or own agent loops. It routes messages, dispatches tasks, persists the transcript, and emits events. Decisions stay with participants.
- **Humans are first-class.** A human is a `Participant` like an agent is. The Hub's async / long-running primitives apply to both.
- **One interface, two deployment shapes.** Agents implement the same `Participant` contract whether they run in-process or across the network. Local and remote agents share the same registry and the same scheduler.
- **Pluggable scheduling.** Three task-routing strategies out of the box: explicit assignment, capability matching, and broadcast claiming.

## Status

🚧 v0.1 — embeddable lib + reference web UI + WebSocket wire protocol + Node SDK. APIs may still shift before v1.0. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Quick start

```bash
pnpm install
pnpm demo               # two mock agents and a mock human collaborate
pnpm demo:broadcast     # three reviewers race, losers get cancelled
pnpm demo:persist:fresh && pnpm demo:persist:resume   # transcript across restarts
pnpm demo:web           # web UI + writer agent + alice (browse to localhost:3000)
pnpm demo:remote        # host + worker in separate processes over WebSocket
```

## Embedded — everything in one process

```ts
import { Hub } from '@aipehub/core'

const hub = new Hub()
await hub.start()
hub.register(new MyAgent())
hub.register(new MyHumanAdapter())

const result = await hub.dispatch({
  from: 'system',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'why TypeScript' },
})
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

## Packages

| Package | Purpose |
|---|---|
| `@aipehub/core` | Hub, registry, scheduler, transcript, storage, Participant base classes |
| `@aipehub/web` | Embeddable reference UI (HTTP + SSE + vanilla SPA) |
| `@aipehub/protocol` | Wire-protocol types + codec (zero runtime) |
| `@aipehub/transport-ws` | Hub-side WebSocket transport |
| `@aipehub/sdk-node` | Node SDK for remote agents |

## License

MIT
