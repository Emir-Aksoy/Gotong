# @aipehub/core

The Hub, message bus, registry, scheduler, transcript, and storage primitives for [AipeHub](https://github.com/AipeHub/AipeHub) — a TypeScript framework for orchestrating agent clusters and humans as collaborative participants.

This package is the only one most users need. Everything else (web UI, WebSocket transport, LLM agents, Python SDK) plugs in.

## Install

```bash
pnpm add @aipehub/core
```

## Use

```ts
import { Hub, AgentParticipant, HumanParticipant } from '@aipehub/core'

class MyAgent extends AgentParticipant {
  constructor() { super({ id: 'a1', capabilities: ['draft'] }) }
  protected async handleTask(task) { return { text: '…' } }
}

const hub = new Hub()
await hub.start()
hub.register(new MyAgent())
hub.register(new HumanParticipant({ id: 'alice', capabilities: ['approve'] }))

const result = await hub.dispatch({
  from: 'system',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'why TypeScript' },
})
```

## What's in the box

- `Hub` — facade over registry + bus + scheduler + transcript + storage.
- `AgentParticipant` — base class for programmatic agents.
- `HumanParticipant` — base class for human adapters (UI/CLI/IM).
- `DefaultScheduler` — three strategies: `explicit`, `capability`, `broadcast`.
- `PriorityQueueScheduler` — wrap any scheduler with priority + deadlines + bounded concurrency.
- `InMemoryStorage`, `FileStorage`, `SqliteStorage` (optional peer dep `better-sqlite3`).

## See also

- [docs/ARCHITECTURE.md](https://github.com/AipeHub/AipeHub/blob/main/docs/ARCHITECTURE.md) — the design.
- [docs/PROTOCOL.md](https://github.com/AipeHub/AipeHub/blob/main/docs/PROTOCOL.md) — the wire protocol for `@aipehub/transport-ws` and `@aipehub/sdk-node`.

## License

MIT
