# @gotong/core

The Hub, message bus, registry, scheduler, transcript, and storage primitives for [Gotong](https://github.com/Emir-Aksoy/Gotong) — a TypeScript framework for orchestrating agent clusters and humans as collaborative participants.

This package is the only one most users need. Everything else (web UI, WebSocket transport, LLM agents, Python SDK) plugs in.

## Install

```bash
pnpm add @gotong/core
```

## Use

```ts
import { Hub, AgentParticipant, HumanParticipant } from '@gotong/core'

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
- `DefaultScheduler` — three strategies: `explicit`, `capability`, `broadcast`; enforces `Task.deadlineMs` at submit-time (`deadline_expired`).
- `InMemoryStorage`, `FileStorage`, `SqliteStorage` (optional peer dep `better-sqlite3`).
- **Admission gating** (v1.1) — `hub.requestAdmission(...)`, `hub.pendingApplications()`, `hub.approveApplication(...)`, `hub.rejectApplication(...)`. Used by `@gotong/transport-ws` with `gating: 'admin-approval'` to hold a connecting agent in a pending state until an admin approves. Pair with `@gotong/web` for the admin UI.
- **Evaluation** (v1.1) — `hub.evaluate({ taskId, by, rating?, comment? })` writes an append-only verdict on a finished task into the transcript.

## See also

- [docs/ARCHITECTURE.md](https://github.com/Emir-Aksoy/Gotong/blob/main/docs/ARCHITECTURE.md) — the design.
- [docs/PROTOCOL.md](https://github.com/Emir-Aksoy/Gotong/blob/main/docs/PROTOCOL.md) — the wire protocol for `@gotong/transport-ws` and `@gotong/sdk-node`.

## License

MIT
