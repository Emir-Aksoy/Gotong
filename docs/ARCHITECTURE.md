# AipeHub Architecture (v0.2)

This document records the design decisions for the framework. It is the source of truth when the code disagrees with itself.

| Version | Lands |
|---|---|
| v0.0 | Embeddable library: Hub, three dispatch strategies, transcript, FileStorage, web UI |
| v0.1 | Wire protocol + WebSocket transport + Node SDK — remote agents can connect from another process/machine |
| v0.2 | `LlmAgent` base class + neutral `LlmProvider` interface + Anthropic / OpenAI providers — drop in an LLM-backed agent without coupling the Hub to any vendor SDK |
| v0.3 | `SqliteStorage` — durable transcript persistence backed by SQLite (`better-sqlite3` optional peer dep). FileStorage stays the no-dependency default. |
| v0.4 | Per-agent identity at HELLO — `authenticate` can return `{ ok: true, allowedAgents: ['a1', 'a2'] }` to bind an API key to a specific set of agent ids. A leaked key cannot impersonate any other agent. New `forbidden_agent` REJECT code. Back-compat: boolean return still works. |
| v0.5 | Python SDK (`python-sdk/`, package name `aipehub`) — second language client. `AgentParticipant` + `connect()` mirror the Node SDK; tests pass against a fake Hub server; `examples/remote-python` runs a Node host + Python worker end-to-end over the same wire protocol. |
| v0.6 | CLI human adapter — `examples/cli-human` shows the terminal driving a `HumanParticipant`: tasks render to stdout, responses come back through readline (`AIPE_AUTO=1` skips the prompt for CI / non-TTY). Reference pattern for any UI / chat / IM adapter built on `human.next()` / `human.complete()` / `human.reject()`. |
| v0.7 | **Deadlines** — `Task.deadlineMs` added to the wire type: tasks past their deadline resolve as `failed` with `error: 'deadline_expired'` and never reach a participant. (Originally shipped behind a `PriorityQueueScheduler` wrapper + `Task.priority`; the 2026-06 audit found zero adoption and folded deadline enforcement into `DefaultScheduler`, removing the wrapper, the `schedulerFactory` seam, and `Task.priority`.) |

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

`Scheduler` is an interface and `DefaultScheduler` is its single production implementation (three strategies). It also enforces `Task.deadlineMs`: tasks past their deadline at submit-time resolve as `failed` with `error: 'deadline_expired'` without ever reaching a participant.

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
- **`SqliteStorage`** (v0.3) — `better-sqlite3`-backed table `transcript(seq PK, ts, kind, data)` with WAL mode. Indexed reads on `seq`, single-transaction inserts, and full crash recovery via SQLite's journaling. Optional peer dependency: install `better-sqlite3` if you want it; `FileStorage` stays the zero-dep default.

Which one to pick:
- **`FileStorage`** — small / medium transcripts, no native deps, easiest to inspect (it's just JSONL). Tail it with `tail -f`.
- **`SqliteStorage`** — long-running Hubs, large transcripts, or workloads where you want SELECT-by-seq instead of scanning the whole file. Comes with a one-time native-module install.

v0 persists **transcript entries only**. Pending tasks and participant registrations are runtime-only and lost on Hub restart — adapters must re-register and re-dispatch any in-flight work themselves. See §12 for the implications when you resume.

Pending-task journaling on top of `SqliteStorage` is a follow-up — the schema has room for it (just add a `pending_tasks` table); the Hub-side wiring is what's not yet built.

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

## 9. LlmAgent — vendor-neutral LLM participants (v0.2)

The Hub does not call LLMs. `LlmAgent` does — it's a thin `AgentParticipant` subclass that wires a Task into an `LlmProvider` and turns the model's response into a `TaskResult`. The provider is the only place vendor SDKs are imported.

```
Hub                                         (knows nothing about LLMs)
 └── LlmAgent                                (translates Task ↔ LlmRequest/Response)
       └── LlmProvider                       (translates neutral ↔ vendor SDK)
              ├── AnthropicProvider          → @anthropic-ai/sdk
              ├── OpenAIProvider             → openai
              └── MockLlmProvider            (in-process, no network)
```

**Neutral wire types** (zero vendor coupling — these live in `@aipehub/llm`):

```ts
interface LlmProvider {
  readonly name: string                                          // 'anthropic' | 'openai' | …
  complete(req: LlmRequest): Promise<LlmResponse>
}
interface LlmRequest {
  system?: string                                                // top-level, Anthropic-style
  messages: { role: 'user' | 'assistant'; content: string }[]
  maxTokens?: number
  temperature?: number
  model?: string                                                 // per-request model override
}
interface LlmResponse {
  text: string
  stopReason: 'end_turn' | 'max_tokens' | 'error'
  usage?: { inputTokens: number; outputTokens: number }
  raw?: unknown                                                  // vendor envelope (escape hatch)
}
```

**Two override points on `LlmAgent`** — almost every customization needs only one of these:

| Hook | Use it for |
|---|---|
| `buildRequest(task): LlmRequest` | Prompt assembly. Default reads `{ prompt }`, `{ topic }`, `{ history }` from `task.payload` and injects the agent-level `system`. Override to inject retrieved context, few-shot examples, tool descriptions. |
| `parseResponse(response, task): unknown` | Output shaping. Default returns `{ text, stopReason, by, usage }`. Override to parse JSON, extract code blocks, validate with re-prompt on failure. |

For full control (multi-step reasoning, custom retry, streaming) override `handleTask(task)` directly — same escape hatch any `AgentParticipant` already has.

**Provider error semantics.** Providers throw on transport / auth / rate-limit errors; `AgentParticipant.onTask` catches the throw and produces a `failed` `TaskResult` with the error message. A `stopReason: 'error'` on a successful response is a soft failure — the provider got a response body but the model bailed (refusal, content filter, unknown reason); the caller sees the partial text plus the stop reason and decides what to do.

**Why providers are separate packages.** `@anthropic-ai/sdk` and `openai` are both ~1MB+ peer dependencies. Most users only want one vendor; bundling both into a `@aipehub/llm` mega-package would punish everyone for the polyglot case. Splitting also lets each provider track its vendor SDK's version independently.

**Streaming, tool calls, and JSON mode** are NOT in v0.2 — see §10. The neutral `LlmResponse` is a finished, text-only completion.

## 10. What is and isn't in scope (as of v2.1)

Since v0.2 the project has filled in a number of items that used to be on this "not yet" list. The table below is the **current** state, not historical.

| Feature | Status | Where it lives |
|---|---|---|
| Python SDK | ✅ shipped (v0.5) | `python-sdk/`, package name `aipehub` on PyPI |
| `SqliteStorage` | ✅ shipped (v0.3) | `packages/core/src/storage/sqlite.ts`, peer dep `better-sqlite3` |
| Per-agent identity at HELLO | ✅ shipped (v0.4) | `authenticate(apiKey) → { ok, allowedAgents? }`; new `forbidden_agent` REJECT code |
| Deadlines | ✅ shipped (v0.7, folded into `DefaultScheduler` 2026-06) | `Task.deadlineMs`; `error: 'deadline_expired'` |
| Host-managed LLM agents (no code) | ✅ shipped (v2.1) | `LocalAgentPool` in `@aipehub/host`; YAML/JSON manifest in admin UI |
| Encrypted API-key storage | ✅ shipped (v2.1) | AES-256-GCM in `<space>/secrets.enc.json`; master key file or `AIPE_SECRET_KEY` env |
| Contribution scoring + leaderboard | ✅ shipped (v2.1) | `Task.weight`, `Evaluation.rating`, `hub.leaderboard(...)`, per-publisher opt-out |
| Template library (built-in + community) | ✅ shipped (v2.1) | `templates/{,community}/{agents,teams}/`; manifest parser in `@aipehub/web` |
| LLM streaming | ✅ shipped (v3.8 / Phase 8) | `LlmProvider.stream(req)` returns `AsyncIterable<LlmStreamChunk>`. `LlmAgent` consumes chunks per round; `LocalAgentPool` forwards them as `llm_stream_chunk` transcript entries; `@aipehub/web` SSE re-streams them to the admin UI for typewriter-style render. |
| **Tool / function calling inside `LlmAgent`** | ❌ not yet | `LlmAgent` passes `task.payload` through, returns text. Multi-turn tool loops are app code today. |
| **Persistent pending tasks across restarts** | ❌ not yet | Only the transcript is persisted. A pending-tasks table on `SqliteStorage` is sketched but not wired. See §12. |
| **Reconnect that preserves in-flight tasks** | ❌ not yet | Disconnect fails outstanding tasks as `remote_disconnect`. A `RESUME` frame with prior `sessionId` is reserved on the wire but not implemented. |
| **Go / Rust / browser SDKs** | ❌ not yet | Wire protocol is stable and language-agnostic — community ports welcome. |
| **Cost-aware / latency-aware / priority scheduling** | ❌ not yet | `DefaultScheduler` covers routing + deadlines; richer policies (priority queues, cost ceiling, P99-latency target, agent health weighting) are roadmap. |
| **Browser automation as a built-in capability** | ❌ not yet | Out of scope for the core; would belong in a separate agent package. |

These cuts are deliberate. The surface stays small until each feature has a concrete use case demanding it.

## 11. Module map

```
packages/core/src/
  types.ts              core types: Message, Task, TaskResult, Participant, etc.
  hub.ts                Hub facade — the only thing users construct
  bus.ts                MessageBus — pub/sub graph + async dispatch
  registry.ts           Participant registry — who's online, capabilities, load
  scheduler.ts          Scheduler interface + DefaultScheduler (three strategies + deadline enforcement)
  transcript.ts         append-only event log
  storage/
    index.ts            Storage interface + re-exports
    memory.ts           InMemoryStorage (default; ephemeral)
    file.ts             FileStorage (JSONL append-only, durable)
    sqlite.ts           SqliteStorage (better-sqlite3, WAL, indexed by seq)
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

packages/llm/           LlmAgent base + neutral LlmProvider interface (v0.2)
  src/types.ts          LlmProvider, LlmRequest, LlmResponse — zero vendor coupling
  src/agent.ts          LlmAgent — buildRequest / parseResponse override points
  src/mock.ts           MockLlmProvider — deterministic in-process provider for tests/demos

packages/llm-anthropic/ Anthropic Claude provider — peer dep @anthropic-ai/sdk
  src/provider.ts       AnthropicProvider — translates LlmRequest ↔ messages.create

packages/llm-openai/    OpenAI provider — peer dep openai
  src/provider.ts       OpenAIProvider — translates LlmRequest ↔ chat.completions.create

examples/
  hello-collab/         capability + explicit dispatch, mock human auto-approves
  broadcast-claim/      broadcast strategy: three reviewers race, losers get cancelled
  persist-and-resume/   FileStorage round-trip: seq continues across restarts
  web-demo/             web UI in front of a perpetual writer + alice loop
  remote-agent/         host + worker in separate processes over the wire protocol
  llm-mock/             LlmAgent + MockLlmProvider — no API key needed
  llm-real/             LlmAgent + Anthropic & OpenAI — Claude writes, GPT reviews
  remote-python/        Node Hub + Python worker (cross-language) — v0.5
  cli-human/            terminal-as-human adapter; readline-driven approval loop — v0.6

python-sdk/             Python SDK (PyPI name: aipehub) — v0.5
  src/aipehub/
    protocol.py         frame constants + outbound builders (mirrors @aipehub/protocol)
    agent.py            AgentParticipant — sync or async handle_task
    session.py          connect() + Session state machine (mirrors @aipehub/sdk-node)
  tests/                pytest-asyncio against a real websockets fake-Hub
```

## 12. Asynchrony — what is and is not synchronized

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
