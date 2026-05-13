# AipeHub Architecture (v0)

This document records the design decisions for the first version. It is the source of truth when the code disagrees with itself.

## 1. Philosophy

**The Hub is a communication space, not a brain.**

AipeHub does not run LLMs. It does not implement agent loops. It does not own prompts or tool registries. Agents arrive at the Hub with their own intelligence — whether that intelligence is a Claude API call, a shell script, or a sleeping human — and the Hub's only job is to route messages, dispatch tasks, persist the transcript, and emit events.

This is the opposite stance from frameworks like CrewAI, AutoGen, or OpenBotX, all of which couple agent execution into the framework itself. AipeHub deliberately stays one layer below: it is to multi-participant collaboration what a message broker is to microservices.

**Humans are first-class participants, not a special tool call.**

Most agent frameworks treat humans as a `request_human_input` tool. AipeHub treats humans as a `Participant` with the same wire protocol as agents — they register, subscribe to channels, receive messages, accept tasks, and emit results. The only difference is in the *adapter layer*: a human adapter is backed by a UI; an agent adapter is backed by code. The Hub does not care.

## 2. Participants — the dual-track abstraction

Every actor in the system is a `Participant`. There are two concrete kinds:

- **`AgentParticipant`** — programmatic. Implements `onMessage` / `onTask` synchronously from the Hub's perspective.
- **`HumanParticipant`** — backed by a UI surface (web, CLI, IM). Tasks are presented and may sit pending indefinitely.

Both implement the same `Participant` interface. The doubling is not in the wire protocol; it is in the **adapter** that wraps the wire protocol for the participant's medium.

Wire-level contract:

```
Participant
  id: string
  kind: 'agent' | 'human'
  capabilities: string[]      // tags the scheduler matches against
  onMessage(msg): Promise<void>
  onTask?(task): Promise<TaskResult>   // optional — listen-only participants are valid
  onShutdown?(): Promise<void>
```

A `HumanParticipant` typically does not implement `onTask` directly — instead its adapter parks the task in a "pending UI" inbox and resolves the promise when the human acts.

## 3. The message bus

All in-process communication goes through an **async message bus**. Participants never call each other directly. This is the same pattern OpenBotX uses, and the reason is the same: it makes the system observable, replayable, and substitutable.

Two surfaces sit on top of the bus:

- **Channels** — pub/sub by topic. Participants `subscribe(channelId)`, then messages published to that channel reach everyone subscribed. Good for broadcasts, status, group conversations.
- **Tasks** — request/response with a typed result. Routed by the **scheduler** (see §4). Good for "do this thing and tell me what happened."

A message and a task are distinct types on purpose. Messages are fire-and-forget; tasks have an awaited `TaskResult`.

## 4. Scheduling — three strategies

The first version ships three task-routing strategies, configurable per task:

| Strategy | When | Behavior |
|---|---|---|
| `explicit` | You know who | Caller names the participant id. Hub delivers directly. |
| `capability` | You know what kind | Hub picks a participant whose capabilities cover the task's required capabilities. Default policy: least-loaded, then round-robin. |
| `broadcast` | You want a volunteer | Hub broadcasts the task to all eligible participants; the first to claim wins, others get a cancel signal. |

**Default policy by participant kind**:

- Agent tasks default to `capability`.
- Human tasks default to either `explicit` (when the dispatcher knows who) or `broadcast` (when any qualified human will do). Configurable per call.

Schedulers are pluggable — `Scheduler` is an interface, and the built-in strategies are three classes implementing it. A custom scheduler can implement any policy (load-balanced, cost-aware, priority queue, etc.).

## 5. Transcript

Every message, task, and task-result is appended to a per-Hub **transcript**. The transcript is:

- Append-only
- Ordered by Hub-assigned sequence number
- The source of truth for "what happened"

The transcript is what `serveWeb()` reads to render history. It is also what makes debugging multi-participant systems tractable.

## 6. Storage

`Storage` is an interface. The first version ships two implementations:

- **`InMemoryStorage`** — for tests, demos, and ephemeral runs. Default.
- **`SqliteStorage`** — for persistence across restarts. Single-file SQLite, no external server.

Storage is responsible for persisting:

- Transcript entries
- Pending tasks (so a Hub restart can resume mid-flight tasks)
- Participant registrations (so reconnecting participants pick up their inbox)

Storage does **not** persist participant code or behavior. Adapters re-register on Hub boot.

## 7. Web UI (reference)

A reference web UI ships in `packages/web` (planned, not in the very first cut). It is purely a *visualization and intervention surface* — it reads the transcript, lists participants, and lets a human take action on tasks routed to them. It does not run any business logic.

The web UI is optional: `hub.serveWeb({ port })` starts it; you can also bring your own UI and just consume the Hub's event stream.

## 8. Deployment shape (v1)

Single-process embeddable library:

```ts
import { Hub } from '@aipehub/core'
const hub = new Hub({ storage: new SqliteStorage('./aipe.db') })
hub.register(new MyAgent())
hub.register(new MyHumanAdapter())
await hub.dispatch({ kind: 'capability', capabilities: ['draft'], payload: ... })
```

A future version may add a `transport/` layer to let participants connect across processes (websocket / gRPC). The Hub interface stays the same.

## 9. What is explicitly NOT in v0

- LLM provider abstractions (agents bring their own)
- Tool registries / skills marketplaces
- Browser automation
- Multi-tenant auth
- Network transport (single-process only)
- A scheduler that understands cost, latency, or priority
- The web UI (designed for, not built yet)

These are intentional cuts. The v0 surface is the smallest API that proves the abstraction holds.

## 10. Module map

```
packages/core/src/
  types.ts              core types: Message, Task, TaskResult, Participant, etc.
  hub.ts                Hub facade — the only thing users construct
  bus.ts                MessageBus — pub/sub graph + async dispatch
  registry.ts           Participant registry — who's online, capabilities, load
  scheduler.ts          Scheduler interface + DefaultScheduler (three strategies)
  transcript.ts         append-only event log
  storage/
    index.ts            Storage interface
    memory.ts           in-memory impl (default)
  participants/
    agent.ts            AgentParticipant base class
    human.ts            HumanParticipant base class + simple CLI adapter
  index.ts              public re-exports
```
