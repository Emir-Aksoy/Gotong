# AipeHub Architecture (v0.1)

This document records the design decisions for the framework. It is the source of truth when the code disagrees with itself.

| Version | Lands |
|---|---|
| v0.0 | Embeddable library: Hub, three dispatch strategies, transcript, FileStorage, web UI |
| v0.1 | **Wire protocol + WebSocket transport + Node SDK** — remote agents can connect from another process/machine |

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
- **`FileStorage`** — durable JSONL append-only log. One transcript entry per line, single file, no external dependencies. Crash-tolerant: a partial trailing line is skipped on load with a warning.

v0 persists **transcript entries only**. Pending tasks and participant registrations are runtime-only and lost on Hub restart — adapters must re-register and re-dispatch any in-flight work themselves. See §11 for the implications when you resume.

A future `SqliteStorage` will subsume both with structured queries and pending-task journaling. The interface stays the same.

## 7. Web UI (reference)

A reference web UI ships in `packages/web`. It is a *visualization and intervention surface* — it reads the transcript, lists participants, and lets humans take action on tasks routed to them. It does not run any business logic.

Surface area:

- **Snapshot** `GET /api/state` — current participants, full transcript, pending human tasks
- **Live stream** `GET /api/stream` (Server-Sent Events) — every appended `TranscriptEntry`
- **Action** `POST /api/tasks/:id/(complete|reject)` — resolves a pending task on whichever `HumanParticipant` currently holds it

The frontend is a single vanilla-JS page; no bundler, no framework, no build step beyond `tsc` for the server. Use it as-is, or read it as ~250 lines of reference for building your own UI on top of `hub.onEvent()`.

```ts
import { Hub } from '@aipehub/core'
import { serveWeb } from '@aipehub/web'

const hub = new Hub()
await hub.start()
const web = await serveWeb(hub, { port: 3000 })
// later: await web.close()
```

## 8. Deployment shapes

AipeHub supports two deployment shapes with the *same* Hub API in both. Local and remote agents register into the same `Registry`; the scheduler does not distinguish them.

### 8a. Embedded — everything in one process

Library mode. Agents are in-process objects.

```ts
import { Hub, FileStorage } from '@aipehub/core'

const hub = new Hub({ storage: new FileStorage('./aipe.jsonl') })
await hub.start()
hub.register(new MyAgent())
hub.register(new MyHumanAdapter())
await hub.dispatch({
  from: 'system',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'why TS' },
})
```

### 8b. Distributed — agents in other processes (v0.1)

The Hub process opens a WebSocket transport. Remote agents speak the wire protocol defined in [PROTOCOL.md](./PROTOCOL.md). Hub-side they appear in the registry as `RemoteAgentParticipant`s — capability matching, broadcast races, and explicit dispatch all work uniformly.

```ts
// host process
import { Hub } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'

const hub = new Hub()
await hub.start()
const ws = await serveWebSocket(hub, {
  port: 4000,
  authenticate: (apiKey) => apiKey === process.env.AIPE_API_KEY,
})
// hub.dispatch(...) just works — remote agents look identical to local ones
```

```ts
// worker process — Node SDK
import { AgentParticipant, connect } from '@aipehub/sdk-node'

class MyAgent extends AgentParticipant {
  constructor() { super({ id: 'a1', capabilities: ['draft'] }) }
  protected async handleTask(task) { return { text: '…' } }
}

const session = await connect({
  url: 'ws://hub.example.com:4000',
  agents: [new MyAgent()],
  apiKey: process.env.AIPE_API_KEY,
})
```

SDKs in other languages (Python is next) will speak the same JSON protocol. See [PROTOCOL.md](./PROTOCOL.md) for frame definitions, the state machine, heartbeat, and disconnect semantics.

## 9. What is explicitly NOT in v0.1 (yet)

- LLM provider abstractions (agents still bring their own)
- Tool registries / skills marketplaces
- Browser automation
- Multi-tenant auth — v0.1 has API-key auth only; per-agent identity tokens are v0.4
- Python / Go / browser SDKs — only Node SDK ships in v0.1
- A scheduler that understands cost, latency, or priority
- Persistent pending tasks across restarts (only transcript persists; see §11)
- Reconnect that preserves in-flight tasks (current behavior: failed with `remote_disconnect`)

These are intentional cuts. The surface is meant to stay small until each feature has a concrete use case demanding it.

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
    index.ts            Storage interface + re-exports
    memory.ts           InMemoryStorage (default; ephemeral)
    file.ts             FileStorage (JSONL append-only, durable)
  participants/
    agent.ts            AgentParticipant base class
    human.ts            HumanParticipant — async task inbox driven by an adapter
  index.ts              public re-exports

packages/web/
  src/server.ts         Node http server: SSE stream + state snapshot + task action API
  src/index.ts          serveWeb() export
  static/index.html     single-page UI shell
  static/app.js         vanilla-JS client; connects to /api/stream
  static/styles.css

packages/protocol/      wire-protocol types, constants, and codec — zero runtime
  src/frames.ts         ClientFrame / ServerFrame discriminated unions
  src/constants.ts      PROTOCOL_VERSION, heartbeat / timeout defaults
  src/codec.ts          decodeFrame / encodeFrame

packages/transport-ws/  Hub-side WebSocket transport
  src/server.ts         serveWebSocket(hub, opts)
  src/session.ts        per-connection state machine (AWAIT_HELLO → READY → DEAD)
  src/remote-participant.ts  RemoteAgentParticipant — Participant that proxies over WS

packages/sdk-node/      Node SDK for remote agents
  src/session.ts        connect(opts) + auto-reconnect with exponential backoff
  src/index.ts          re-exports AgentParticipant for one-stop import

examples/
  hello-collab/         capability + explicit dispatch, mock human auto-approves
  broadcast-claim/      broadcast strategy: three reviewers race, losers get cancelled
  persist-and-resume/   FileStorage round-trip: seq continues across restarts
  web-demo/             web UI in front of a perpetual writer + alice loop
  remote-agent/         host + worker in separate processes over the wire protocol
```

## 11. Asynchrony — what is and is not synchronized

A few semantic edges that matter once you build something real on top of the Hub. Each is a deliberate v0 choice, not an oversight.

### Resume rewrites `participant_joined` on every boot

`Transcript.load()` brings back every prior entry, but `register()` after boot writes a fresh `participant_joined` entry — the Hub treats each process as a new session. If you derive "currently online" from the transcript alone, pair each `participant_joined` with the latest `participant_left` (or session boundary) to know who's actually present. The transcript is the journal of what happened, not a snapshot of right now.

### Broadcast cancel notifications race with `dispatch()` resolution

When a broadcast winner is decided, `dispatch()` resolves immediately with the winner's result. The losers' `onTaskCancelled` callbacks are scheduled but not necessarily run yet. Demos that print "winner!" right after `await dispatch(...)` often see the cancel log lines arrive afterward in non-deterministic order. This is OK by design — cancels are best-effort notifications, not part of the task-result contract. If you need them ordered, sleep a tick before reading.

### Remote disconnect fails in-flight tasks

When a WebSocket session drops, the Hub-side `RemoteAgentParticipant` resolves every outstanding `onTask` promise as `{ kind: 'failed', error: 'remote_disconnect' }` and unregisters itself. The dispatcher's `await hub.dispatch(...)` will return that failure result rather than hang. The transcript records a `participant_left` entry per disconnected agent. A future protocol revision may add a `RESUME` frame with the prior `sessionId` to recover in-flight tasks across a brief disconnect — out of scope for v0.1.

### Transcript persistence is fire-and-forget per append

`Transcript.append()` returns synchronously after pushing the entry to the in-memory log; the Storage write is dispatched on a separate promise chain. Consequences:

- A crash *between* `await dispatch(...)` and `await hub.stop()` may lose the last few entries.
- `await hub.stop()` *does* flush — for `FileStorage`, `close()` awaits the serial write queue.
- If you need write-through for a specific moment, await a follow-up no-op or call `hub.stop()`.

A future version may add `transcript.flush(): Promise<void>` if a real use case appears. For now, the fast in-memory path is more valuable than a per-append durability guarantee.
