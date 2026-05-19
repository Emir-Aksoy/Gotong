# MCP — bridging AipeHub and the wider MCP ecosystem

AipeHub speaks [Model Context Protocol](https://modelcontextprotocol.io)
in **both directions**:

- **Inbound** (`@aipehub/mcp-server`) — any MCP-aware client
  (Claude Desktop, Cursor, Cline, Continue, …) can dispatch tasks
  into a Hub, browse the contribution leaderboard, and attach
  evaluations without touching the admin web UI. Chapters 1–5 below.

- **Outbound** (`@aipehub/mcp-client`) — your AipeHub agents can
  attach a fleet of third-party MCP servers (Filesystem, GitHub,
  Slack, Postgres, …) and use their tools natively from inside
  `handleTask`. Chapter 6 at the bottom.

The two together close the loop: anything that speaks MCP can plug
into your Hub from either end.

This document covers:

1. What you can do (inbound)
2. How to wire it into Claude Desktop / Cursor / Cline
3. Inbound tool reference
4. Architecture (and why this design)
5. Inbound troubleshooting
6. **Outbound — using third-party MCP tools from your agent**

> Looking for a 中文 quickstart? The English flow is identical — every
> setting key is in Latin characters. Translation to `docs/zh/MCP.md`
> is in the queue.

---

## 1. What you can do

Once configured, your MCP client gets five new tools next to whatever
else is already installed. Example prompts:

> *"Use AipeHub to dispatch a draft task to anyone with `draft`
> capability about 'why TypeScript', then evaluate the result with a
> 4.5 rating."*

> *"Show me the AipeHub leaderboard for this week, who's leading?"*

> *"List AipeHub participants. Are any humans online?"*

The LLM calls the right tools in sequence, the Hub does the work, you
see the result back in your chat. Useful for:

- driving a team room from inside your IDE
- running scripted "the AI delegates to its sub-agents" workflows
- letting Claude Desktop be the "admin's eye" on a running Hub without
  leaving the conversation

---

## 2. Setup

### 2a. Prerequisites

- A running AipeHub host — either `pnpm host` (from source) or
  `docker compose up`. Both work; pick whichever fits your setup.
- Its admin Bearer token. Printed once at first launch (search the
  host stdout for `First-run admin URL`). Subsequent admins can be
  minted via [`POST /api/admin/admins`](DEPLOY.md#c8-onboard-more-admins).

> ⚠️ **`@aipehub/mcp-server` is currently source-only.** The
> `"command": "npx", "args": ["-y", "@aipehub/mcp-server"]` style
> shown in every client example below will start working once a JS
> registry is picked (see
> [RELEASE-CHECKLIST](../.github/RELEASE-CHECKLIST.md) "Distribution
> decision"). **Until then**, in every config block on this page
> substitute the `npx` line with:
>
> ```json
> "command": "node",
> "args": ["/absolute/path/to/AipeHub/packages/mcp-server/bin/aipehub-mcp.js"]
> ```
>
> The substitution applies in Claude Desktop, Cursor, Cline, and any
> generic MCP client — only the `command`/`args` change, the `env`
> block stays identical.

### 2b. Claude Desktop

Edit your Claude Desktop config:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "aipehub": {
      "command": "npx",
      "args": ["-y", "@aipehub/mcp-server"],
      "env": {
        "AIPE_HUB_URL": "http://127.0.0.1:3000",
        "AIPE_ADMIN_TOKEN": "<paste your bearer token here>"
      }
    }
  }
}
```

Restart Claude Desktop. Look for a 🔌 indicator next to the input box —
clicking it lists registered MCP servers; `aipehub` should be there
with **5 tools available**.

### 2c. Cursor

Cursor reads MCP servers from `~/.cursor/mcp.json` (per-user) or
`<project>/.cursor/mcp.json` (per-project). Same JSON shape as Claude
Desktop. Reload after editing.

### 2d. Cline (VS Code extension)

Cline's MCP marketplace UI accepts the same config. Or hand-edit
`<vscode-storage>/cline_mcp_settings.json`.

### 2e. Generic clients

Any MCP-spec-compliant client works — pass the `command` /  `args` /
`env` triple to whichever launcher the client uses.

---

## 3. Tools

All tools translate one-to-one to HTTP calls against the Hub's admin
API. The Bearer token in `AIPE_ADMIN_TOKEN` authorises every call.

### `list_participants`

> Returns every participant currently in the Hub registry.

**Input:**

```json
{ "kind": "agent" | "human" | "any" }    // optional, defaults to "any"
```

**Output (example):**

```json
{
  "count": 3,
  "participants": [
    { "id": "writer-zh",   "kind": "agent", "capabilities": ["draft"],  "load": 0 },
    { "id": "reviewer-zh", "kind": "agent", "capabilities": ["review"], "load": 1 },
    { "id": "alice",       "kind": "human", "capabilities": ["approve"], "load": 0 }
  ]
}
```

### `dispatch_task`

> Fire a task into the Hub using one of three strategies. **Synchronous** —
> waits for the result up to `timeoutMs` (default 60s).

**Input:**

```json
{
  "strategy": "direct" | "capability" | "broadcast",
  "recipient": "writer-zh",                  // required when strategy=direct
  "capabilities": ["draft"],                 // required for capability/broadcast-with-filter
  "payload": { "topic": "why TypeScript" },  // free-form
  "title": "draft about TS",                 // optional
  "weight": 2.0,                             // contribution weight, default 1.0
  "priority": 5,                             // scheduler priority hint
  "countContribution": true,                 // include in leaderboard?
  "timeoutMs": 60000                         // wait timeout
}
```

**Output:** `TaskResult` shape from the Hub —

```json
{
  "kind": "ok",
  "taskId": "8b1c…",
  "by": "writer-zh",
  "ts": 1715567890123,
  "output": { "text": "TypeScript is …" }
}
```

`kind` may also be `failed` / `cancelled` / `no_participant`. The
client raises an error on `wait timeout` so the LLM can retry or fall
back.

### `list_tasks`

> Recent tasks with status. Useful before evaluating.

**Input:**

```json
{ "status": "done" | "pending" | "failed" | "cancelled" | "any", "limit": 50 }
```

**Output:** array of `TaskView` rows (id, status, who-did-it, weight, rating, …).

### `get_leaderboard`

> Contribution leaderboard for a time window. Visible to admins **and**
> workers via the Hub's `/api/leaderboard` endpoint.

**Input:**

```json
{ "window": "today" | "7d" | "30d" | "all", "limit": 20 }
```

**Output:**

```json
{
  "window": { "from": 1714963200000, "to": 1715568000000 },
  "totalTaskCount": 42,
  "unratedTaskCount": 3,
  "rows": [
    { "participantId": "writer-zh", "totalContribution": 38.5,
      "taskCount": 19, "averageRating": 4.05, "lastActivityTs": 1715567890123,
      "byCapability": { "draft": { "count": 19, "contribution": 38.5 } } }
  ]
}
```

### `evaluate_task`

> Attach an evaluation to a completed task. Rating × weight = contribution.

**Input:**

```json
{ "taskId": "<id from list_tasks>", "rating": 4.5, "comment": "tight prose" }
```

Omit `rating` to update only the comment. Omit `comment` to update only
the rating. The Hub clamps `rating` to `[0, 5]`.

**Output:** `{ "ok": true, "taskId": "..." }`

---

## 4. Architecture

```
   Claude Desktop / Cursor / Cline / …
        │
        │ stdio (JSON-RPC 2.0 / MCP spec)
        │
   aipehub-mcp  (this package, started by the MCP client)
        │
        │ HTTP + Bearer admin token
        │
   AipeHub host  (your already-running Hub)
        │
   ├── Hub state (transcript, agents.json, secrets.enc.json, …)
   ├── LocalAgentPool (host-managed LLM agents)
   └── ws:// (remote SDK-connected agents)
```

**Design choices and why:**

- **HTTP, not WebSocket.** The Hub already exposes a complete admin API
  with Bearer auth, rate limiting, and `ALLOWED_HOSTS` enforcement.
  Reusing it means the MCP bridge inherits all of that for free and has
  no daemon state to manage.

- **Stateless.** Each tool call is one HTTP round-trip. Restart the MCP
  server, no replay needed. Multiple MCP clients can share one Hub.

- **Stdio transport.** Required by Claude Desktop / Cursor / Cline.
  The SDK's `StdioServerTransport` handles JSON-RPC framing; we just
  register tools and connect.

- **5 tools, not 15.** The Hub has lots of endpoints — agent imports,
  channel publishing, admin invites. The MCP surface is intentionally
  narrow: "operate on the room", not "configure the room". Things like
  importing a template or rotating an API key still go through the
  admin UI, where they belong.

---

## 5. Troubleshooting

| Symptom | Likely cause |
|---|---|
| MCP client says "aipehub server failed to start" | Wrong `AIPE_HUB_URL` — `aipehub-mcp` pings `/healthz` on startup. Check the URL and that the host is running. |
| Tools list shows up but every call errors `401` | `AIPE_ADMIN_TOKEN` is wrong or expired. Re-mint an admin token via the admin UI. |
| `dispatch_task` always returns `no_participant` | No agent has the capability you asked for. Run `list_participants` first to see what's available, or use `direct` with a specific id. |
| Tools list is empty | The MCP client connected but `tools/list` returned `[]`. Usually means an older `@aipehub/mcp-server` cached by `npx`. Try `npx -y @aipehub/mcp-server@latest` in the client config. |
| Claude Desktop log shows `Cannot find module '@modelcontextprotocol/sdk'` | `npx -y` should fix this transient. If persistent, install globally: `npm i -g @aipehub/mcp-server` and change `"command"` to `"aipehub-mcp"`, drop the `args` array. |

For deeper debugging run the server directly in a terminal:

```bash
AIPE_HUB_URL=http://127.0.0.1:3000 AIPE_ADMIN_TOKEN=<token> aipehub-mcp
```

Then type JSON-RPC messages by hand (`{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + Enter). Stderr shows what happened.

---

## 6. Outbound — using third-party MCP tools from your agent

`@aipehub/mcp-client` lets your AipeHub agents drive the MCP server
ecosystem from the inside. Where chapters 1–5 cover "Claude Desktop
controls my Hub", this chapter covers "my Hub's `writer-bot` reads
the repo via Filesystem MCP, opens a PR via GitHub MCP, posts a
notification via Slack MCP — in one task."

### 6a. Install

```bash
pnpm add @aipehub/mcp-client
```

That's it for the client. The servers themselves are typically
fetched on-demand via `npx -y`, so they don't go in `package.json`.

### 6b. Quick start (no LLM, just the toolset)

```ts
import { McpToolset } from '@aipehub/mcp-client'

const toolset = new McpToolset({
  servers: [
    {
      name: 'fs',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'],
    },
    {
      name: 'github',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GH_TOKEN! },
    },
  ],
})

await toolset.connect()                          // spawn + handshake in parallel

const tools = await toolset.listTools()
//   [
//     { name: 'fs__read_file',       serverName: 'fs',     ... },
//     { name: 'fs__write_file',      serverName: 'fs',     ... },
//     { name: 'github__list_issues', serverName: 'github', ... },
//     ...
//   ]

const out = await toolset.callTool('github__create_issue', {
  owner: 'foo', repo: 'bar', title: 'hi',
})

await toolset.disconnect()
```

Tool names are namespaced `<server>__<tool>` so two servers can both
declare e.g. `read` without colliding. The result is already in the
shape Anthropic / OpenAI / DeepSeek tool-use APIs expect — pass it
straight through.

There's a runnable demo at
[`examples/mcp-tools-quickstart`](../examples/mcp-tools-quickstart/):

```bash
pnpm install
pnpm --filter @aipehub/example-mcp-tools-quickstart start
```

### 6c. Wiring into an `AgentParticipant`

The natural lifecycle: connect on agent start, disconnect on agent
stop, hand the tool list to the LLM provider in `handleTask`.

```ts
import { AgentParticipant, type Task } from '@aipehub/core'
import { McpToolset } from '@aipehub/mcp-client'

class WriterBot extends AgentParticipant {
  private readonly toolset = new McpToolset({
    servers: [
      {
        name: 'fs',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'],
      },
    ],
  })

  async onStart() {
    await this.toolset.connect()
  }

  async onStop() {
    await this.toolset.disconnect()
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const tools = await this.toolset.listTools()
    // ... pass `tools` to your LLM provider's tool-use API
    // ... on each tool_use from the LLM, call:
    //     await this.toolset.callTool(name, args)
    // ... feed the result back, loop until the LLM stops requesting tools
    return { /* final output */ }
  }
}
```

`LlmAgent` (the base class in `@aipehub/llm`) does **not yet** have a
built-in multi-turn tool-use loop — that's planned for a follow-up.
For now, an agent that wants to use MCP tools writes its own loop in
`handleTask`. The provider abstraction (`LlmProvider.complete`) is
the thing the loop drives.

### 6d. Server lifecycle, security, debugging

`@aipehub/mcp-client`'s README covers operational details:

- **Lifecycle** — servers spawn at `connect()`, get `kill()`-ed at
  `disconnect()`. A server that crashes mid-session is marked `dead`;
  its tools throw `server_crashed` until the toolset is fully
  disconnected and reconnected.
- **Security** — `command` runs with your host process's privileges.
  Don't take server commands from untrusted input. Credentials go in
  `env`, not `args` (so they don't appear in `ps`).
- **Debugging** — subscribe to `'server-stderr'` events for a
  per-line tail of every spawned server's stderr:

  ```ts
  toolset.on('server-stderr', ({ serverName, line }) => {
    console.error(`[${serverName}] ${line}`)
  })
  ```

  Useful for catching Slack MCP auth failures, Python server stack
  traces, etc. See
  [`packages/mcp-client/README.md`](../packages/mcp-client/README.md#debugging--the-server-stderr-event)
  for the full behaviour contract (line buffering, backpressure
  notes).

See [`packages/mcp-client/README.md`](../packages/mcp-client/README.md)
for the full API reference + the discriminated `McpClientError.kind`
table.

### 6e. Common servers worth attaching

Drawn from the [official MCP servers repo](https://github.com/modelcontextprotocol/servers):

| Server | Use case | Credentials |
|---|---|---|
| `@modelcontextprotocol/server-filesystem` | Read / write files in a sandboxed directory | None — args restrict access |
| `@modelcontextprotocol/server-github` | Issues, PRs, code search across GitHub | `GITHUB_PERSONAL_ACCESS_TOKEN` |
| `@modelcontextprotocol/server-slack` | Post / read messages, list channels | `SLACK_BOT_TOKEN`, `SLACK_TEAM_ID` |
| `@modelcontextprotocol/server-postgres` | Query a Postgres database read-only | Connection URL in args |
| `@modelcontextprotocol/server-brave-search` | Web search | `BRAVE_API_KEY` |
| `@modelcontextprotocol/server-puppeteer` | Browser automation | None |
| `@modelcontextprotocol/server-memory` | Knowledge-graph memory across runs | None |

…plus several hundred community servers. Pattern is identical: drop
into the `servers:` array, pass credentials via `env`, the namespaced
tools appear in `listTools()`.
