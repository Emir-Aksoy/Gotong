# AipeHub

**AI + Person + Hub** — a TypeScript framework for orchestrating agent clusters and humans as first-class collaborative participants.

AipeHub is not an agent. It is a **communication space**: a registry, a message bus, a task router, and an append-only transcript. Agents and humans plug in through adapters and talk to each other; the Hub keeps the signals flowing.

## Core ideas

- **Hub is dumb on purpose.** It does not decide what to think. It routes messages, dispatches tasks, persists state, and emits events. The decisions stay with participants.
- **Humans are first-class.** A human is a `Participant` like an agent is. The Hub's async / long-running primitives apply to both.
- **Pluggable scheduling.** Three task-routing strategies out of the box: explicit assignment, capability matching, and broadcast claiming.
- **Embeddable.** `new Hub()` inside your own app. No daemon required. Optional web UI for visibility.

## Status

🚧 Early development. APIs will change. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design decisions driving the first version.

## Quick start

```bash
pnpm install
pnpm demo
```

Watch two mock agents and a mock human collaborate to draft and approve a short writeup.

## License

MIT
