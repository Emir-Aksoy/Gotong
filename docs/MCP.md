# MCP — driving a Hub from Claude Desktop / Cursor / Cline

AipeHub ships a [Model Context Protocol](https://modelcontextprotocol.io)
server so any MCP-aware client can dispatch tasks into a Hub, read who's
online, browse the contribution leaderboard, and attach evaluations to
completed work — without touching the admin web UI.

This document covers:

1. What you can do
2. How to wire it into Claude Desktop / Cursor / Cline
3. Tool reference
4. Architecture (and why this design)
5. Troubleshooting

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
> "args": ["/absolute/path/to/AipeHub/packages/mcp-server/bin/server.js"]
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
