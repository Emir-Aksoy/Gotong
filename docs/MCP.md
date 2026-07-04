# MCP — bridging Gotong and the wider MCP ecosystem

Gotong speaks [Model Context Protocol](https://modelcontextprotocol.io)
in **both directions**:

- **Inbound** (`@gotong/mcp-server`) — any MCP-aware client
  (Claude Desktop, Cursor, Cline, Continue, …) can dispatch tasks
  into a Hub, browse the contribution leaderboard, and attach
  evaluations without touching the admin web UI. Chapters 1–5 below.

- **Outbound** (`@gotong/mcp-client`) — your Gotong agents can
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

> *"Use Gotong to dispatch a draft task to anyone with `draft`
> capability about 'why TypeScript', then evaluate the result with a
> 4.5 rating."*

> *"Show me the Gotong leaderboard for this week, who's leading?"*

> *"List Gotong participants. Are any humans online?"*

The LLM calls the right tools in sequence, the Hub does the work, you
see the result back in your chat. Useful for:

- driving a team room from inside your IDE
- running scripted "the AI delegates to its sub-agents" workflows
- letting Claude Desktop be the "admin's eye" on a running Hub without
  leaving the conversation

---

## 2. Setup

### 2a. Prerequisites

- A running Gotong host — either `pnpm host` (from source) or
  `docker compose up`. Both work; pick whichever fits your setup.
- Its admin Bearer token. Printed once at first launch (search the
  host stdout for `First-run admin URL`). Subsequent admins can be
  minted via [`POST /api/admin/admins`](DEPLOY.md#c8-onboard-more-admins).

> ⚠️ **`@gotong/mcp-server` is currently source-only.** The
> `"command": "npx", "args": ["-y", "@gotong/mcp-server"]` style
> shown in every client example below will start working once a JS
> registry is picked (see
> [RELEASE-CHECKLIST](../.github/RELEASE-CHECKLIST.md) "Distribution
> decision"). **Until then**, in every config block on this page
> substitute the `npx` line with:
>
> ```json
> "command": "node",
> "args": ["/absolute/path/to/Gotong/packages/mcp-server/bin/gotong-mcp.js"]
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
    "gotong": {
      "command": "npx",
      "args": ["-y", "@gotong/mcp-server"],
      "env": {
        "GOTONG_HUB_URL": "http://127.0.0.1:3000",
        "GOTONG_ADMIN_TOKEN": "<paste your bearer token here>"
      }
    }
  }
}
```

Restart Claude Desktop. Look for a 🔌 indicator next to the input box —
clicking it lists registered MCP servers; `gotong` should be there
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
API. The Bearer token in `GOTONG_ADMIN_TOKEN` authorises every call.

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
   gotong-mcp  (this package, started by the MCP client)
        │
        │ HTTP + Bearer admin token
        │
   Gotong host  (your already-running Hub)
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
| MCP client says "gotong server failed to start" | Wrong `GOTONG_HUB_URL` — `gotong-mcp` pings `/healthz` on startup. Check the URL and that the host is running. |
| Tools list shows up but every call errors `401` | `GOTONG_ADMIN_TOKEN` is wrong or expired. Re-mint an admin token via the admin UI. |
| `dispatch_task` always returns `no_participant` | No agent has the capability you asked for. Run `list_participants` first to see what's available, or use `direct` with a specific id. |
| Tools list is empty | The MCP client connected but `tools/list` returned `[]`. Usually means an older `@gotong/mcp-server` cached by `npx`. Try `npx -y @gotong/mcp-server@latest` in the client config. |
| Claude Desktop log shows `Cannot find module '@modelcontextprotocol/sdk'` | `npx -y` should fix this transient. If persistent, install globally: `npm i -g @gotong/mcp-server` and change `"command"` to `"gotong-mcp"`, drop the `args` array. |

For deeper debugging run the server directly in a terminal:

```bash
GOTONG_HUB_URL=http://127.0.0.1:3000 GOTONG_ADMIN_TOKEN=<token> gotong-mcp
```

Then type JSON-RPC messages by hand (`{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + Enter). Stderr shows what happened.

---

## 6. Outbound — using third-party MCP tools from your agent

`@gotong/mcp-client` lets your Gotong agents drive the MCP server
ecosystem from the inside. Where chapters 1–5 cover "Claude Desktop
controls my Hub", this chapter covers "my Hub's `writer-bot` reads
the repo via Filesystem MCP, opens a PR via GitHub MCP, posts a
notification via Slack MCP — in one task."

### 6a. Install

```bash
pnpm add @gotong/mcp-client
```

That's it for the client. The servers themselves are typically
fetched on-demand via `npx -y`, so they don't go in `package.json`.

### 6b. Quick start (no LLM, just the toolset)

```ts
import { McpToolset } from '@gotong/mcp-client'

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
pnpm --filter @gotong/example-mcp-tools-quickstart start
```

### 6c. Wiring into an `LlmAgent` (the easy path, v0.3+)

`LlmAgent` (in `@gotong/llm`) has a built-in multi-turn tool-use loop.
Pass an `McpToolset` (or anything satisfying `LlmAgentToolset`) as
`tools:` and it'll declare the tools to the LLM, execute every
`tool_use` block, feed the results back, and loop until the model is
done — all inside one `hub.dispatch(...)`.

```ts
import { Hub } from '@gotong/core'
import { LlmAgent } from '@gotong/llm'
import { AnthropicProvider } from '@gotong/llm-anthropic'
import { McpToolset } from '@gotong/mcp-client'

// 1) Spawn the MCP servers
const toolset = new McpToolset({
  servers: [
    {
      name: 'fs',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'],
    },
  ],
})
await toolset.connect()

// 2) Hand them to the agent
const agent = new LlmAgent({
  id: 'writer-bot',
  capabilities: ['draft'],
  provider: new AnthropicProvider({ defaultModel: 'claude-sonnet-4-6' }),
  tools: toolset,            // ← this is the only thing required
  maxToolRounds: 8,          // safety cap; default is 8
  system: 'You can read files via fs__read_text_file…',
})

const hub = Hub.inMemory()
await hub.start()
hub.register(agent)

const result = await hub.dispatch({
  from: 'system',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: 'Read the project README and quote its opening line verbatim.',
})

await hub.stop()
await toolset.disconnect()
```

The agent does **not** own the toolset's lifecycle (connect /
disconnect is your responsibility), so a single toolset can be shared
across many agents within the same host.

The output object carries a `toolRounds` count when at least one
tool was called, so dashboards can plot how often the model needed
the toolbox:

```ts
const out = result.output as { text: string; toolRounds?: number }
console.log(`Model answered after ${out.toolRounds ?? 0} tool call(s)`)
```

Provider support: **Anthropic** (`@gotong/llm-anthropic`) and
**OpenAI / OpenAI-compatible** (`@gotong/llm-openai`) both wire
through to their native tool-use APIs. Custom providers (DeepSeek,
Qwen, Zhipu via `baseURL` override) inherit OpenAI's tool-use shape
as long as the upstream supports `tool_calls`.

There's a runnable end-to-end demo at
[`examples/mcp-tools-llm-agent`](../examples/mcp-tools-llm-agent/) —
spawn the MCP filesystem server, hand its tools to Claude, watch it
read README.md unprompted:

```bash
export ANTHROPIC_API_KEY=sk-ant-…
pnpm install
pnpm --filter @gotong/example-mcp-tools-llm-agent start
```

#### Bring-your-own toolset

`LlmAgent` accepts any `LlmAgentToolset` (from `@gotong/llm`):

```ts
interface LlmAgentToolset {
  listTools(): Promise<LlmToolDefinition[]> | LlmToolDefinition[]
  callTool(name: string, args: Record<string, unknown>): Promise<{
    content: ReadonlyArray<unknown>
    isError?: boolean
  }>
}
```

…so you can plug in a hand-rolled function registry, an internal HTTP
API wrapper, etc., without depending on `@gotong/mcp-client`. The
MCP toolset already implements this shape — it's a drop-in.

### 6c-yaml. Declaring servers in an agent template (no code)

If your agent ships as a `gotong.agent/v1` manifest (host-managed via
the admin UI), drop the `mcpServers:` field into the agent block —
the host's `LocalAgentPool` will spawn the toolset at boot and inject
it into the `LlmAgent` for you. No code required.

```yaml
schema: gotong.agent/v1
agent:
  id: repo-reader
  displayName: 仓库阅读助手
  capabilities: [explain, summarize]
  kind: llm
  provider: anthropic
  model: claude-sonnet-4-6
  system: |
    You read repo files via fs__read_text_file. Don't guess contents;
    actually read.
  mcpServers:
    - name: fs
      command: npx
      args:
        - -y
        - '@modelcontextprotocol/server-filesystem'
        - /var/work/your-repo
    - name: github
      command: npx
      args: [-y, '@modelcontextprotocol/server-github']
      env:
        # ${GITHUB_TOKEN} is expanded against the host's environment at
        # spawn time. Credentials don't get persisted in agents.json.
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

Manifest-level validation enforced at parse time:

- `name` must match `/^[a-zA-Z][a-zA-Z0-9_-]*$/` and be unique within
  this agent's `mcpServers[]` list.
- `command` is required; `args` / `env` / `cwd` are optional.
- `env` values support `${ENV_VAR}` placeholders. Missing variables
  expand to `''` (with a warning in the host log) so a forgotten
  credential doesn't crash boot — the MCP server itself surfaces the
  auth error.

A runnable sample template ships at
[`templates/agents/repo-reader.yaml`](../templates/agents/repo-reader.yaml).

### 6c-alt. Wiring into a custom `AgentParticipant` (if you can't use `LlmAgent`)

If you've subclassed `AgentParticipant` directly and have your own
LLM driver, the pattern is: connect the toolset on agent start, hand
its tools to your LLM provider in `handleTask`, and call back into
`toolset.callTool` for each `tool_use` block. This is what
`LlmAgent.handleTaskWithTools` does for you — read its source for the
canonical loop.

### 6d. Server lifecycle, security, debugging

`@gotong/mcp-client`'s README covers operational details:

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
