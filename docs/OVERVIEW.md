# AipeHub Overview · 5-minute map

> Looking for the Chinese version? → [`docs/zh/OVERVIEW.md`](./zh/OVERVIEW.md)
>
> This is the project's **single-page map**. By the end you'll know what
> AipeHub is, what sits under what, how participants plug in, where templates
> come from, how a few people work together, and how organizations federate
> without giving up their keys. Each section ends with a → link to the next
> read when you want to go deeper.

---

## In one sentence

**AipeHub** is a **self-hosted collaboration workspace for TypeScript and
Python**: people and AI agents share one "room", and a deliberately dumb Hub
dispatches tasks, collects results, and records the whole run.

It is **not an agent framework** (it doesn't run the LLM) — it's a **substrate
for multi-participant collaboration**, where organizations can federate
**without handing over their keys, data, or billing**.

---

## What it is — and what it sits *under*

Most "agent" projects are an agent, or a framework for writing one agent's loop
(LangGraph, CrewAI, AutoGen). AipeHub is **neither** — it's the layer they plug
*into*. A LangGraph graph, a CrewAI crew, a CLI coding agent (Claude Code,
Codex), an external A2A agent, and a human all join the same room as the same
`Participant`. The Hub routes their messages, dispatches tasks, records the
transcript, and enforces the boundaries — it **never runs the LLM**, so every
decision stays with the participant.

Three things make it more than a message bus:

- **Equal participants** — a human is a `Participant`, exactly like an agent.
  There's no "request-human-input tool"; people and agents collaborate through
  the same tasks + transcript, and the same async / long-running primitives.
- **Governance** — sensitive and cross-organization actions don't just fire.
  They can require a human to approve them from an inbox (propose → review →
  confirm), with a full audit trail.
- **Sovereignty** — every workspace is a directory on disk that you own. When
  two organizations federate, credentials, data, and billing each stay home;
  what crosses the line is constrained by a **per-link trust contract**.

That combination — not any single clever protocol — is what AipeHub is. It's the
first substrate to put human-agent equality, governed cross-org federation, and
self-hosted sovereignty into one runnable, file-first package.

---

## One picture

```
        ┌──────────────────────────────────────────────────────────┐
        │                       One Space (.aipehub/)              │
        │  ─────────────────────────────────────────────────────── │
        │                                                          │
        │   👤 admin       👤 worker      👤 worker                │
        │      Alice          Bob            Carol                 │
        │       │              │              │                    │
        │       │              │              │                    │
        │   ┌───┴──────────────┴──────────────┴───┐                │
        │   │       Hub  (routing only)            │                │
        │   │  · dispatch                          │                │
        │   │  · transcript (append-only)          │                │
        │   │  · scheduler (3 strategies)          │                │
        │   │  · governance gates (approval ·       │                │
        │   │    trust contracts · audit)           │                │
        │   └───┬──────────────┬──────────────┬───┘                │
        │       │              │              │                    │
        │   🤖 host-managed   🤖 external SDK  🪢 another Hub         │
        │      LLM agent       (Node / Py)     (HubLink federation) │
        │   (templates/      (your code)      (its keys stay home) │
        │    community/)                                            │
        └──────────────────────────────────────────────────────────┘
                                  ↑
                          all state is files
                       (.aipehub/transcript.jsonl
                        .aipehub/agents.json
                        .aipehub/secrets.enc.json …)
```

…and the three columns shown are just examples. The same `Participant` slot also
holds **CLI / ACP coding agents** (Claude Code, Codex), **external A2A agents**,
and **LangGraph / CrewAI adapters** — all transparent to the scheduler.

---

## The four edges — how AipeHub connects to the world

AipeHub reaches the rest of the ecosystem over four edges. It **speaks open
protocols where they exist** — it doesn't reinvent them:

| Edge | Protocol | Direction | What it carries |
|---|---|---|---|
| Tools & data | **MCP** | both | Agents call external MCP tools; external clients (Claude Desktop, Cursor) drive the Hub. |
| Agent ↔ agent | **A2A** | both | An inbound `message/send` becomes a dispatch; an outbound call drives a remote A2A agent. |
| Coding agents | **ACP** | outbound | The Hub spawns and holds a session with Claude Code / Codex and drives it turn by turn. |
| Hub ↔ hub | **HubLink** | both | AipeHub's own federation link between two hubs — where the per-link trust contracts, cross-org task forwarding, and approval gates live. |

The first three are ecosystem standards AipeHub implements. HubLink is the one
piece it owns — **not** as a clever wire format (it's WebSocket + bearer token +
JSON-RPC underneath) but as the **contract for what two governed hubs exchange**:
a capability manifest, ancestry-preserving task forwarding, and the per-link
trust contract below.

→ Deeper: [`MCP.md`](./MCP.md) · [`FEDERATION.md`](./FEDERATION.md) · [`PROTOCOL.md`](./PROTOCOL.md)

---

## Getting started — which one are you?

| You are… | First step | Read more |
|---|---|---|
| **Solo developer / want it running in 5 min** | `docker compose up` (or from source: `pnpm install && pnpm build && pnpm host`) → open the first-run admin URL in your browser | [`README.md` Quick start](../README.md#quick-start) |
| **Just want to *try a real hub*** | Import a ready-made personal / team / cross-org hub and run it | [`zh/HANDS-ON-HUBS.md`](./zh/HANDS-ON-HUBS.md) (zh) |
| **Small-team operator / opening a hub for a team** | LAN mode (bind `0.0.0.0`) or VPS + Caddy + systemd | [`DEPLOY.md`](./DEPLOY.md) |
| **A regular user invited into a room** | Open the invite URL → pick a nickname → check your capabilities → you're in | [`HUMAN.md`](./HUMAN.md) |
| **Want to understand the whole design** | This page → `ARCHITECTURE.md` → `PROTOCOL.md` | [`ARCHITECTURE.md`](./ARCHITECTURE.md) |

---

## License — MIT, commercial-friendly

The whole project is **MIT-licensed**. Short answer:

- ✅ **Commercial use** is fine, including closed-source SaaS / internal tools / resale
- ✅ You may **modify** the source, rename it, and re-publish
- ⚠️ You must **keep the LICENSE file + copyright line**

The third-party prompt-adapted templates under `templates/community/` carry
their own upstream licenses (CC0 / MIT), all compatible with MIT and **all
permit commercial use**.

Full FAQ in [`LICENSE-FAQ.md`](./LICENSE-FAQ.md) — it answers the typical
questions: "Can I embed AipeHub in my own closed-source product? / Do I have to
attribute these templates when I use them commercially? / Can I change the
LICENSE and repackage?"

---

## How participants plug in

The headline path is **two ways to add an LLM agent**:

| Path A · Host-managed | Path B · External SDK |
|---|---|
| Fill in a form / import YAML / paste a template in the admin UI → the host spawns an `LlmAgent` inside its own process | Write code (Node / Python) implementing `AgentParticipant.handleTask`, then `connect(url, agents)` to the Hub's WebSocket port |
| **0 lines of code** | You write code |
| LLM agents only (wrapped Anthropic / OpenAI / Mock) | **Any kind** (LLMs, scrapers, local tools, private logic, Python ML models) |
| Provider key is encrypted on disk in `secrets.enc.json` (per-agent or workspace default), or read from env | You manage the API key; the agent runs on your own machine |
| Auto-respawned when the host restarts | You own its lifecycle; the SDK has built-in auto-reconnect |
| Best for: regular users / standard LLM roles / live in 60 seconds | Best for: developers / private data / not exposing your code |

→ Path A: [`HUMAN.md §1 Agents`](./HUMAN.md#1-智能体v21) + [`TEMPLATES.md`](./TEMPLATES.md)
→ Path B: [`AGENT.md`](./AGENT.md)

…and because everything is the same `Participant`, the same room also takes:

- **CLI / ACP coding agents** — the Hub drives Claude Code / Codex over a held
  ACP session (real-machine verified), with a danger-action gate that can park
  destructive commands for human approval.
- **External A2A agents** — register a remote agent under a capability; a
  workflow step routes to it like any other.
- **Framework adapters** — wrap a LangGraph graph or a CrewAI crew as a
  `Participant` via the Python SDK; the framework itself is never imported by
  the Hub.

They all **mix freely** — one room can hold a host-managed `writer-zh`, your own
SDK-connected `rag-agent`, and a Codex coding session, fully transparent to the
scheduler.

---

## Where templates come from

```
                  templates/
                  ├── agents/           original official templates
                  ├── teams/            original official teams
                  └── community/        adapted from third parties (CC0 + MIT)
```

Three ways to get them, pick by taste:

1. **Template gallery, one click** — the admin UI ships a gallery of ready-made
   hubs (personal / org / cross-org); pick one → install → it lands its agents +
   workflows + KB slots in your Space.
2. **Copy-paste** — on GitHub, hit **Raw** on a `.yaml` → copy → admin UI
   "Agents → Import", paste.
3. **Download the file** — save the `.yaml` locally → admin UI "Upload file".

Every file has a `# Source` / `# Upstream` / `# License` / `# Adapted` header
comment, so **upstream provenance is never lost**. The full text of third-party
licenses lives in
[`../templates/community/LICENSE-NOTICES.md`](../templates/community/LICENSE-NOTICES.md).

> **Templates and the framework are separate by design.** A template carries
> *structure and references* — agents, workflows, KB slots — never the knowledge
> *content* itself, and never your people or secrets. Installing one wires up
> connections; it never restores another org's data.

→ Full flow: [`TEMPLATES.md`](./TEMPLATES.md)
→ Ready-made hubs to install: [`zh/HANDS-ON-HUBS.md`](./zh/HANDS-ON-HUBS.md) (zh)

---

## A few people in one room

AipeHub models a "team" as **one room** = one `.aipehub/` directory. Three role
tiers:

| Role | URL | What you can do in this room |
|---|---|---|
| **admin** | `/admin` | Configure the room, approve/reject agent requests, dispatch tasks, evaluate work, invite other admins |
| **worker** | `/` (the `/me` workbench) | Pick a nickname + the work you can do, run member-facing workflows for yourself, handle your inbox, complete or decline tasks |
| **agent** | WS port | Automatically receive dispatched tasks, return results |

### A typical small-team workflow (scripted)

```
0  Alice (admin) starts the hub → on launch the browser shows a one-time
   admin URL; she stores it in 1Password.
1  Alice configures a provider key in the admin UI → the workspace default
   key is encrypted to disk.
2  Alice installs a template (or imports storyteller.yaml) → the host
   immediately spawns an LLM agent, shown as online.
3  Alice sends invite URLs to Bob and Carol. They pick nicknames, check the
   capabilities they can do (draft / review) → they're in the room.
4  Alice dispatches a task: "write a children's story about perseverance",
   strategy = capability:[story] → the host-managed storyteller claims it
   → 30s later a 600-word story comes back.
5  A workflow step needs sign-off → it parks in Bob's inbox; Bob approves it
   from his /me workbench, and the run resumes — a human in the loop, not a
   tool call.
6  Alice evaluates the work; the contribution leaderboard refreshes; every
   event is in transcript.jsonl, so a crash + restart recovers fully.
```

**Key concepts** (details in HUMAN.md):

- **Three dispatch strategies**: `direct` (by name), `capability` (by skill), `broadcast` (first to claim wins)
- **Human-in-the-loop**: a workflow step can dispatch to a person's inbox and wait for approve / choose / edit before continuing
- **The `/me` workbench**: members run their own member-facing workflows, see their recent runs, manage their own agents (BYO key), all scoped to themselves
- **API key, three tiers**: per-agent private → workspace default → environment variable

→ Full write-up: [`HUMAN.md`](./HUMAN.md)

---

## Across organizations — governed federation

**Two different "multi-team" meanings — don't conflate them:**

### One room, many roles (= the section above)

Everyone is in the same `.aipehub/` directory, the same hub process. This is the
default.

### Many rooms, federated (= true cross-org)

Each org runs its own independent hub (its own `.aipehub/`, its own people and
agents, **its own API keys and its own billing**). Two hubs connect over
**HubLink**, and what one may ask of the other is fixed by a **per-link trust
contract**:

- **capability allowlist** — exactly which capabilities the peer may invoke
- **data-class gate** — which classes of data are allowed to cross the link (fail-closed)
- **quota** — a rate / budget ceiling per link, kept across reconnects
- **revocation** — cut the link at any time
- **knowledge-base allowlist** — which shared KBs the peer can reach

The simplest pattern is `TeamBridgeAgent`: a whole sub-hub appears upstream as a
**single agent**, its internal members / keys / sub-tasks invisible to the
parent.

```
   Company Hub (Bob is admin)
       │
       ├── agent · alice-team   ←─┐
       │                          │  TeamBridgeAgent  (over HubLink)
       │                  ┌───────┴────────┐
       │                  │ Alice's Hub    │ (Alice is admin)
       │                  │  · writer-bot  │   keys / people / billing
       │                  │  · reviewer-bot│   all stay on Alice's hub
       │                  └────────────────┘
       └── agent · david-team   ←── another team, same idea
```

Beyond bridging, a **workflow on one hub can take a step on another hub's
capability**. If that peer requires approval, the step parks in a human's inbox
until someone approves it — the cross-org call is governed, two-step, and fully
auditable, and the workflow YAML never even names the peer (it just names a
capability; the link is runtime configuration).

**Why this matters — sovereignty stays intact:**

- The upstream sees *aggregated results* ("alice-team completed N tasks"), never the peer's keys or raw data
- Each hub keeps its **own credential vault** and its **own usage / cost ledger** — billing is per-hub
- Want a private internal PoC? Run a local hub — zero onboarding cost
- Want the whole company to collaborate? Hang a governed link on top — **without touching existing team structure**

→ One machine: [`FEDERATION.md`](./FEDERATION.md)
→ Two machines / two orgs, step by step: [`zh/FEDERATION-RUNBOOK.md`](./zh/FEDERATION-RUNBOOK.md) (zh)

---

## Further reading — pick a path

Pick whichever "what I most want to figure out right now" applies:

| I want to… | Read this |
|---|---|
| Get running in five minutes | [`README.md` Quick start](../README.md#quick-start) |
| Try a ready-made hub (personal / org / cross-org) | [`zh/HANDS-ON-HUBS.md`](./zh/HANDS-ON-HUBS.md) (zh) |
| Be an admin / be a worker | [`HUMAN.md`](./HUMAN.md) |
| Write an external agent | [`AGENT.md`](./AGENT.md) |
| Bring up an LLM agent without code | [`HUMAN.md §1`](./HUMAN.md#1-智能体v21) + [`TEMPLATES.md`](./TEMPLATES.md) |
| Give your agents the MCP tool ecosystem | [`MCP.md`](./MCP.md) |
| Federate two hubs (one machine) | [`FEDERATION.md`](./FEDERATION.md) |
| Federate across two machines / orgs | [`zh/FEDERATION-RUNBOOK.md`](./zh/FEDERATION-RUNBOOK.md) (zh) |
| Deploy for a team / go live | [`DEPLOY.md`](./DEPLOY.md) + [`zh/GO-LIVE.md`](./zh/GO-LIVE.md) (zh) |
| The whole architecture / why it's designed this way | [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| The wire protocol / writing an SDK in another language | [`PROTOCOL.md`](./PROTOCOL.md) |
| Commercial use / derivatives / license boundaries | [`LICENSE-FAQ.md`](./LICENSE-FAQ.md) |
| Report a security issue | [`SECURITY.md`](../SECURITY.md) |
| Contribute code | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
