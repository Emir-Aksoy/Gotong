# AipeHub

[English](README.md) · [中文文档](docs/zh/README.md)

**AI + Person + Hub** — a TypeScript framework for orchestrating agent clusters and humans as first-class collaborative participants.

AipeHub is not an agent. It is a **communication space**: a registry, a message bus, a task router, and an append-only transcript. Agents — local or remote — and humans plug in through adapters and talk to each other; the Hub keeps the signals flowing.

## Core ideas

- **The Hub is dumb on purpose.** It does not run LLMs or own agent loops. It routes messages, dispatches tasks, persists the transcript, and emits events. Decisions stay with participants.
- **Humans are first-class.** A human is a `Participant` like an agent is. The Hub's async / long-running primitives apply to both.
- **One interface, two deployment shapes.** Agents implement the same `Participant` contract whether they run in-process or across the network. Local and remote agents share the same registry and the same scheduler.
- **Pluggable scheduling.** Three task-routing strategies out of the box: explicit assignment, capability matching, and broadcast claiming.
- **Bring your own LLM.** A small `LlmAgent` base class + a neutral `LlmProvider` interface let you back an agent with Claude, GPT, or any other model without touching the Hub.

## Status

**v2.0 — File-first.** A workspace is a directory on disk (`.aipehub/`). Drop the directory, drop the space. Copy it, hand the room to a teammate. Admins, workers, sessions, transcript, and pending admissions are all files; HttpOnly cookies are the only browser-side state. Restarts are transparent.

The npm packages are scoped `@aipehub/*`; the Python SDK is `aipehub` on PyPI. License: [MIT](LICENSE).

## Pick your door

> **Lost?** Start at [`docs/OVERVIEW.md`](docs/OVERVIEW.md) — a single page that ties usage, license, agent on-boarding, template downloads, multi-user teams, and multi-team federation into one narrative. The table below is the by-role drill-down.

| You are… | Read this | TL;DR |
|---|---|---|
| 🧭 **First time here** | [`docs/OVERVIEW.md`](docs/OVERVIEW.md) | 5-minute map of every concept + a "small-team workflow" walkthrough. |
| 🧑 **A worker / admin joining a room** | [`docs/HUMAN.md`](docs/HUMAN.md) | Open the URL the operator gave you; pick a nickname; you're in. |
| 🤖 **Writing an agent to plug in** | [`docs/AGENT.md`](docs/AGENT.md) | `@aipehub/sdk-node` or Python `aipehub`. Subclass `AgentParticipant`. |
| 🧩 **Bringing in an LLM agent without writing code** | [`docs/TEMPLATES.md`](docs/TEMPLATES.md) + [`templates/`](templates/) | YAML manifest → paste / upload in admin UI → host spawns it for you. Two sets: project-original (`templates/agents/`) and CC0/MIT community-adapted (`templates/community/`). |
| 🔧 **Running the server** | [`docs/DEPLOY.md`](docs/DEPLOY.md) | `pnpm host` for local, Caddy + systemd for public. |
| 🪢 **Federating two hubs (team → org)** | [`docs/FEDERATION.md`](docs/FEDERATION.md) | `TeamBridgeAgent` makes a whole sub-Hub appear upstream as one agent — keeps internal members / keys / sub-tasks private. |
| 🔌 **Driving a Hub from Claude Desktop / Cursor / Cline** | [`docs/MCP.md`](docs/MCP.md) | `@aipehub/mcp-server` is an MCP bridge — 5 tools (list / dispatch / evaluate / leaderboard / tasks). Add 5 lines to your MCP client config. |
| ⚖️ **Worried about license / commercial use** | [`docs/LICENSE-FAQ.md`](docs/LICENSE-FAQ.md) | MIT throughout. Embeddable in closed-source / SaaS. Community templates are CC0 + MIT. |
| 🧠 **Designing on top of it** | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) + [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | Hub is dumb on purpose; wire protocol is v1.0. |
| 📊 **Sizing a deployment** | [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) | Pre-launch baseline numbers + how to rerun the load test against your own hardware. |

### Adding an agent — two paths

|  | Host-managed (no code) | External SDK (your code) |
|---|---|---|
| **You do** | Paste / upload a YAML manifest in admin UI | Write `AgentParticipant.handleTask`, call `connect(url, agents)` |
| **Where it runs** | Inside the Hub process (LocalAgentPool) | Anywhere on the network |
| **What it can do** | LLM tasks via Anthropic / OpenAI / Mock providers | Anything — LLMs, scrapers, private data, ML models, scripts |
| **API key lives** | Encrypted in `.aipehub/secrets.enc.json` (per-agent or workspace default) | Wherever your code reads it |
| **On restart** | Auto-respawned by `LocalAgentPool` | Your code reconnects (SDK has built-in auto-retry) |
| **Best for** | End users • standard roles • one-click templates | Developers • private logic • cross-language workers |
| **Read** | [`docs/TEMPLATES.md`](docs/TEMPLATES.md) | [`docs/AGENT.md`](docs/AGENT.md) |

Both paths plug into the same Hub. Mix freely — a room can have host-managed `writer-zh` next to your private SDK-connected `rag-agent`.

Contributing? See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues: [`SECURITY.md`](SECURITY.md). Version history: [`CHANGELOG.md`](CHANGELOG.md).

## Quick start

### Get running in 30 seconds — pick one

```bash
# A. Docker (recommended — no Node setup, works on macOS / Windows / Linux)
docker compose up
# → http://127.0.0.1:3000  + admin URL printed in the logs
# → state persists under ./data

# B. From source (cloned repo, full demo set available)
pnpm install
pnpm build
pnpm host
```

Both boot the same binary. Open the printed admin URL → save the token → you're in.

> 💡 **Distribution.** No `npm publish` at this stage — Docker (A) and source (B)
> are the two supported install paths. The earlier "queued for v2.1" npm plan has
> been **descoped**; the registry choice (npm / JSR / source-only) is an open
> decision tracked in [RELEASE-CHECKLIST](.github/RELEASE-CHECKLIST.md). Pre-built
> single-file binaries for macOS / Windows are a planned but non-blocking item —
> Docker already covers the "click and run" cross-platform case.

CLI flags (from a built repo):

```bash
pnpm exec aipehub-host --help       # full env-var reference
pnpm exec aipehub-host --version    # current host version
```

After it boots, follow [`docs/OVERVIEW.md`](docs/OVERVIEW.md) for the "what now" walkthrough.

### Logging

Structured logging is **on by default** — JSON line per event when stdout is piped (for `jq` / Loki / ELK / Datadog), pretty-printed when stdout is a terminal. Three env vars control it:

```bash
AIPE_LOG_LEVEL=info       # silent | trace | debug | info (default) | warn | error | fatal
AIPE_LOG_FORMAT=json      # json | pretty (default: auto by TTY)
AIPE_LOG_DISABLED=1       # hard-off escape hatch
```

Filter by component with `jq` once you've got JSON output:

```bash
pnpm host 2>&1 | jq 'select(.comp == "local-agents")'
```

### Demos (cloned repo)

Once you've `pnpm install && pnpm build`-ed, every collaboration pattern in the framework has a runnable demo:

```bash
# in-process demos (no network)
pnpm demo                # two mock agents + one mock human
pnpm demo:broadcast      # three reviewers race, losers cancelled

# persistence demos
pnpm demo:persist:fresh && pnpm demo:persist:resume
pnpm demo:persist:sqlite:fresh && pnpm demo:persist:sqlite:resume

# remote agents
pnpm demo:remote         # host + worker in separate processes
pnpm demo:remote:python  # Node host + Python worker (cross-language)
pnpm demo:cli-human      # terminal-as-human approval loop

# LLM-backed agents
pnpm demo:llm            # LlmAgent + mock provider (no API key needed)
pnpm demo:llm:real       # real Claude/GPT (needs ANTHROPIC_API_KEY/OPENAI_API_KEY)

# v2.0 full stack — web UI + agent admission + tasks panel
pnpm demo:open-space
pnpm demo:federated-team # one Hub joins another Hub as a single agent
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

## Hub Services — agent memory, artifacts, datastores (v2.2)

An agent can declare what state it wants the host to keep on its
behalf. Three first-party "services" ship today; the plumbing is
plugin-from-day-1 so adding a fourth is a separate npm package.

```yaml
# templates/agents/industry-coach-with-memory.yaml
schema: aipehub.agent/v1
agent:
  id: industry-coach
  capabilities: [intake]
  provider: anthropic
  model: claude-opus-4-7
  system: |
    Use memory.recall before answering; artifact.write the report
    afterwards; cases.sql for structured industry comparisons.
  uses:
    - { type: memory,    impl: file,   config: { kinds: [episodic, semantic] } }
    - { type: artifact,  impl: file,   config: { name: industry-reports } }
    - { type: datastore, impl: sqlite, config: { name: cases, schema: "..." } }
```

At spawn time the host resolves each `uses:` entry to a typed handle
the agent reads from `ctx.memory`, `ctx.artifact`, `ctx.datastore.<name>`.
Owner-based isolation is the default — two agents asking for `memory:file`
get two different stores. Data layout lives under `<space>/services/`:

```
<space>/services/
├─ plugins.json                    # which plugins to load (auto-seeded)
├─ memory/file/agent/<agentId>/    # one dir per (plugin, owner)
├─ artifact/file/agent/<agentId>/
└─ datastore/sqlite/agent/<agentId>/<name>.sqlite
```

Soft delete is a click in the admin "服务 / Services" tab; data moves
to per-plugin `.trash/`, lives 30 days, then a background sweeper
hard-deletes it. Restore is one POST until then. Full design is in
[`docs/services-rfc.md`](docs/services-rfc.md).

| Package | What it provides |
|---|---|
| `@aipehub/services-sdk` | `ServicePlugin` contract, registry, loader. The seam plugin authors implement. |
| `@aipehub/service-memory-file` | First-party `memory:file` — episodic / semantic / working as JSONL. |
| `@aipehub/service-artifact-file` | First-party `artifact:file` — per-owner directories of files with MIME + size guards. |
| `@aipehub/service-datastore-sqlite` | First-party `datastore:sqlite` — KV + raw SQL on one `.sqlite` per declared name. |

### Writing your own plugin

```ts
// my-plugin/src/index.ts
import type { ServicePlugin } from '@aipehub/services-sdk'

class MyPlugin implements ServicePlugin {
  readonly type = 'memory'
  readonly impl = 'redis'
  readonly version = '0.1.0'

  async init(ctx) { /* open the redis pool */ }
  async validateConfig(raw) { /* parse + reject bad shapes */ }
  async attach(owner, config) { /* return a MemoryHandle */ }
  async detach(owner) { /* close the per-owner cache */ }
  async softDelete(owner) { /* return a TrashRef; the host stores it */ }
  async restore(ref) { /* throws TrashRestoreConflictError on collision */ }
  async hardDelete(ref) { /* irreversible */ }
  async describe(owner) { /* admin UI snapshot — sizeBytes, preview */ }
  async shutdown() { /* drain + close */ }
}

export default () => new MyPlugin()
```

Drop the package name into `<space>/services/plugins.json` and restart
the host — `loadPlugins` dynamic-imports the entry, calls `init`, and
the plugin is available to every agent's yaml `uses:`. Plugin load
failures are non-fatal: a bad plugin shows up in the boot log but
doesn't crash the host.

> **Deployment note**: the host resolves plugin packages from its own
> `node_modules/`, so third-party plugins need to be installed where
> the host can see them — `pnpm add my-org/aipehub-redis-memory` in
> the host workspace, or a `package.json` dependency on the deploy
> image. Putting the package name in `plugins.json` alone is not enough
> if the package itself isn't on disk.

## Packages

| Package | Purpose |
|---|---|
| `@aipehub/core` | Hub, registry, scheduler, transcript, storage, Participant base classes |
| `@aipehub/web` | Embeddable reference UI (HTTP + SSE + vanilla SPA) |
| `@aipehub/host` | Production binary — env-driven, no demo state, ships `aipehub-host` |
| `@aipehub/protocol` | Wire-protocol types + codec (zero runtime) |
| `@aipehub/transport-ws` | Hub-side WebSocket transport |
| `@aipehub/sdk-node` | Node SDK for remote agents (also exports `TeamBridgeAgent`) |
| `@aipehub/llm` | `LlmAgent` base class + `LlmProvider` interface + `MockLlmProvider` |
| `@aipehub/llm-anthropic` | Anthropic Claude provider (peer dep: `@anthropic-ai/sdk`) |
| `@aipehub/llm-openai` | OpenAI provider (peer dep: `openai`) |
| `@aipehub/services-sdk` | Hub Services plugin contract (v2.2) — see the section above |
| `@aipehub/service-memory-file` | First-party `memory:file` plugin (JSONL on disk) |
| `@aipehub/service-artifact-file` | First-party `artifact:file` plugin (per-owner dirs, MIME-gated) |
| `@aipehub/service-datastore-sqlite` | First-party `datastore:sqlite` plugin (KV + SQL) |
| `@aipehub/mcp-server` | MCP (Model Context Protocol) bridge — let Claude Desktop / Cursor drive a Hub |
| `aipehub` (PyPI, in `python-sdk/`) | Python SDK — connect Python agents to a Hub over the same wire protocol |

## License

**MIT** for the project itself — see [`LICENSE`](LICENSE).

- ✅ Commercial use, closed-source derivatives, internal SaaS embedding — all allowed.
- ⚠️ Retain the LICENSE file + copyright notice in your distribution.
- Third-party prompt templates under [`templates/community/`](templates/community/) carry their own (compatible) licenses — CC0 1.0 and MIT — aggregated verbatim in [`templates/community/LICENSE-NOTICES.md`](templates/community/LICENSE-NOTICES.md).

Common questions ("can I embed in closed-source", "do I have to attribute community templates", "is fork+rename allowed") are answered in [`docs/LICENSE-FAQ.md`](docs/LICENSE-FAQ.md).
