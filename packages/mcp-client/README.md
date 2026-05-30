# `@aipehub/mcp-client`

> Attach a fleet of [Model Context Protocol](https://modelcontextprotocol.io)
> servers to an AipeHub agent so its tool-use loop can drive
> GitHub / Filesystem / Slack / Postgres / arbitrary stdio-MCP
> servers natively.

The complement to [`@aipehub/mcp-server`](../mcp-server). That package
lets an MCP **client** (Claude Desktop / Cursor / Cline / Continue)
drive your AipeHub Hub from the outside. This package lets your
AipeHub **agents** drive third-party MCP servers from the inside — so
your `writer-bot` can read repo files via the Filesystem MCP, open a
GitHub issue via the GitHub MCP, post a Slack notification via the
Slack MCP, all in one task.

The two together close the loop: anything that speaks MCP can plug
into your Hub from either end.

---

## Why this matters

AipeHub's Hub stays dumb on purpose — it routes tasks, it doesn't run
LLMs. Tool use lives inside individual agents. The MCP ecosystem
(hundreds of officially-maintained servers as of writing) is
how those agents get their tool surface.

Before this package an agent that wanted a GitHub tool had to hand-
roll a GitHub API client. With `@aipehub/mcp-client`, the agent
declares which MCP servers it wants and gets a unified, namespaced
tool list ready to hand to whatever LLM provider it uses:

```ts
const toolset = new McpToolset({
  servers: [
    { name: 'fs',     command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'] },
    { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
                      env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GH_TOKEN! } },
  ],
})

await toolset.connect()
const tools = await toolset.listTools()
//   [
//     { name: 'fs__read_file',      serverName: 'fs',     ... },
//     { name: 'fs__write_file',     serverName: 'fs',     ... },
//     { name: 'github__list_issues', serverName: 'github', ... },
//     ...
//   ]
const out = await toolset.callTool('github__create_issue', { repo: 'foo/bar', title: 'hi' })
```

Tool names are namespaced `<server>__<tool>` so two servers can both
declare e.g. `read` without colliding. The result is ready to pass
straight to the Anthropic / OpenAI / DeepSeek tool-use API.

---

## Install

```bash
pnpm add @aipehub/mcp-client
# also need a real MCP server to talk to, e.g.:
pnpm add -D @modelcontextprotocol/server-filesystem @modelcontextprotocol/server-github
```

You don't need to install the MCP servers themselves if you use
`npx -y` in the command — npx will fetch them on first run.

---

## Quick start

```ts
import { McpToolset } from '@aipehub/mcp-client'

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

const tools = await toolset.listTools()
console.log(tools.map((t) => t.name))
// → [ 'fs__read_file', 'fs__write_file', 'fs__list_directory', ... ]

const result = await toolset.callTool('fs__read_file', {
  path: './workspace/README.md',
})
console.log(result.content)
// → [{ type: 'text', text: '...' }]

await toolset.disconnect()
```

There's a `examples/mcp-tools-quickstart.mjs` in the repo root that
runs end-to-end against the in-tree fake server (no npm download).

---

## Wiring into an `LlmAgent` (the easy path)

`LlmAgent` (in `@aipehub/llm`, v0.3+) has a built-in multi-turn
tool-use loop. Hand it an `McpToolset` and Claude / GPT will decide
when to call tools, parse the results, and respond — all in one
`hub.dispatch(...)`:

```ts
import { Hub } from '@aipehub/core'
import { LlmAgent } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { McpToolset } from '@aipehub/mcp-client'

const toolset = new McpToolset({
  servers: [
    { name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'] },
  ],
})
await toolset.connect()

const agent = new LlmAgent({
  id: 'writer-bot',
  capabilities: ['draft'],
  provider: new AnthropicProvider({ defaultModel: 'claude-sonnet-4-6' }),
  tools: toolset,            // ← turns on the tool-use loop
  maxToolRounds: 8,          // safety cap (default 8)
})

const hub = Hub.inMemory()
await hub.start()
hub.register(agent)

const result = await hub.dispatch({
  from: 'system',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: 'Read the project README and summarize its opening section.',
})

const out = result.kind === 'ok' ? (result.output as { text: string; toolRounds?: number }) : null
console.log(`Answered after ${out?.toolRounds ?? 0} tool round(s):\n${out?.text}`)

await hub.stop()
await toolset.disconnect()
```

The agent does **not** own the toolset's lifecycle — connect /
disconnect is the caller's responsibility, so a single toolset can be
shared across many agents in the same host.

Provider coverage: **Anthropic** (`@aipehub/llm-anthropic`) and
**OpenAI / OpenAI-compatible** (`@aipehub/llm-openai`, also covers
DeepSeek / Qwen / Zhipu / Moonshot via `baseURL` override) both wire
through to their native tool-use APIs.

There's an end-to-end runnable demo at
[`examples/mcp-tools-llm-agent`](../../examples/mcp-tools-llm-agent/):

```bash
export ANTHROPIC_API_KEY=sk-ant-…
pnpm install
pnpm --filter @aipehub/example-mcp-tools-llm-agent start
```

## Wiring into a custom `AgentParticipant` (if you can't use `LlmAgent`)

If you've subclassed `AgentParticipant` directly and run your own LLM
driver, the canonical pattern is:

```ts
import { AgentParticipant, type Task } from '@aipehub/core'
import { McpToolset } from '@aipehub/mcp-client'

class WriterBot extends AgentParticipant {
  private readonly toolset = new McpToolset({
    servers: [
      { name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'] },
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
    // ... when the LLM emits a tool_use, call:
    //     await this.toolset.callTool(name, args)
    // ... feed the result back to the LLM
    // ... loop until the LLM stops requesting tools
    return { /* final output */ }
  }
}
```

`LlmAgent.handleTaskWithTools` is the canonical implementation of
this loop — read its source if you need to recreate it for a
specialized agent.

---

## API

### `new McpToolset(options)`

| Option | Type | Default | Notes |
|---|---|---|---|
| `servers` | `McpServerConfig[]` | (required, ≥1) | Each entry is a local `stdio` child process or a remote `http`/`sse` endpoint (see below). Names must be unique and match `/^[a-zA-Z][a-zA-Z0-9_-]*$/`. |
| `listToolsTimeoutMs` | `number` | `10_000` | Per-server `tools/list` timeout. |
| `callToolTimeoutMs` | `number` | `60_000` | Per-call `tools/call` timeout. Bump for long-running tools (DB queries, builds). |
| `clientInfo` | `{ name, version }` | `@aipehub/mcp-client / 0.1.0` | Identity advertised to the MCP server during handshake. |

#### Transports

`McpServerConfig` is a discriminated union over `transport` (default
`stdio`):

```ts
// stdio — local child process (transport optional; the common case)
{ name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }

// http — remote Streamable HTTP server (the hosted-MCP ecosystem)
{ name: 'hosted', transport: 'http', url: 'https://mcp.example.com/v1',
  headers: { Authorization: 'Bearer <token>' } }

// sse — legacy remote HTTP+SSE server
{ name: 'legacy', transport: 'sse', url: 'https://sse.example.com/stream' }
```

`http`/`sse` spawn no child process — `headers` is where a bearer token
goes. This package does **not** expand `${ENV}` placeholders; resolve
credentials before constructing the toolset (the AipeHub host expands
`${ENV}` refs in `env`/`headers` at agent-spawn time). A remote server
with a missing/invalid `url` is marked `dead` (`bad_config`) at
`connect()` rather than throwing — same graceful-degradation contract as
a stdio spawn failure.

### Methods

| Method | Returns | Notes |
|---|---|---|
| `connect()` | `Promise<void>` | Spawns every server in parallel. Idempotent. A server that fails to spawn becomes `dead` but doesn't tank the toolset. |
| `disconnect()` | `Promise<void>` | Shuts every live server down. Idempotent. |
| `addServer(config)` | `Promise<void>` | Add a server at runtime. If already connected, it starts immediately (one child/socket). Rejects a duplicate/malformed name. `listTools()` again to pick up its tools. |
| `removeServer(name)` | `Promise<void>` | Stop + drop a server at runtime. Idempotent (absent name → no-op). |
| `listTools()` | `Promise<NamespacedTool[]>` | Merged tool list across live servers; dead servers contribute nothing. |
| `callTool(name, args)` | `Promise<CallToolResult>` | Routes by `<server>__<tool>` prefix. Throws `McpClientError` with a discriminated `.kind` on failure. |
| `status()` | `ServerStatusReport[]` | Per-server liveness snapshot; use for healthz / monitoring. |
| `serverNames()` | `string[]` | Configured server names, in construction order. |

### `McpClientError`

Every failure path throws one of these, with `.kind` set to a stable
discriminant for typed branching:

| kind | When |
|---|---|
| `not_connected` | Used the toolset before `connect()` (or after `disconnect()`). |
| `server_crashed` | A previously-running server died; tools from it now throw. Other servers in the same toolset still work. |
| `unknown_tool` | `callTool('foo__bar')` but no server named `foo` is in the toolset. |
| `bad_tool_name` | Tool name doesn't match `<server>__<tool>`. |
| `duplicate_server` | Two servers declared with the same `name`. |
| `tool_call_failed` | Server returned `isError: true`. `.detail` carries the server's own error message. |
| `transport_error` | Underlying SDK transport threw. `.cause` carries the original. |

---

## Operational notes

### Server lifecycle

Servers are stdio child processes. The toolset spawns them at
`connect()` and `kill()`s them at `disconnect()`. If a server exits
on its own (e.g. crash, OOM, the server itself decides to die after
serving one request), the toolset notices via the `transport.onclose`
callback and marks it `dead` — subsequent calls to its tools throw
`server_crashed` instead of hanging.

Bringing a dead server back up requires `disconnect()` + a fresh
`connect()` on the toolset. The toolset doesn't auto-respawn on its
own, by design — a server that crashes once is much more likely to
crash again, and an auto-respawn loop would mask the real problem.

### Security

The toolset spawns whatever `command` you give it. **The supplied
`command` runs with the same privileges as your AipeHub host
process.** For an SDK worker running on a user's laptop this is fine
(it's their laptop); for a hosted Hub serving multiple admins,
treat the server commands as carefully as you'd treat any other
arbitrary-code-execution vector. In practice this means:

- Don't let untrusted users author the `command`/`args` strings. The
  toolset itself doesn't take strings from network input — but if
  you build a feature that does, you're on the hook for sanitisation.
- Pass credentials through `env`, not `args`. Anything in `args` is
  visible in `ps`.
- If you set `env` at all, only the keys you specify are passed
  through (the SDK's `getDefaultEnvironment()` default-inheritance is
  dropped). Spell `PATH` out explicitly when your server needs it.

### Debugging — the `server-stderr` event

`McpToolset` extends `EventEmitter`. Subscribe to `'server-stderr'`
to tail every line of stderr from every spawned MCP server:

```ts
import { McpToolset } from '@aipehub/mcp-client'

const toolset = new McpToolset({ servers: [/* … */] })

toolset.on('server-stderr', ({ serverName, line }) => {
  // serverName is the namespacing prefix (e.g. 'github'); line has
  // no trailing newline. Forward to your real logger:
  console.error(`[${serverName}] ${line}`)
})

await toolset.connect()
```

This is the right channel for:

- watching Slack MCP's auth errors during onboarding (`"token expired"`),
- catching Python-based servers' stack traces when a tool crashes,
- routing per-server logs into your structured logger (pino / winston / …).

Behaviour notes:

- One event per `\n`-terminated line. Partial trailing chunks are
  buffered until the next `\n` arrives, so a log line split across
  two `write()` calls still arrives as a single event.
- Blank lines are dropped (most servers emit a trailing `\n` after
  each log, which would otherwise become an empty event).
- The listener runs **synchronously** inside the stream's `'data'`
  handler. If your listener is slow (e.g. it pings a remote
  logger), wrap the body in `setImmediate(...)` so you don't apply
  backpressure to the child's stdio.
- The serverName matches the prefix used for namespaced tool names
  (`fs__read_file` → `serverName: 'fs'`).
- Stderr from servers that fail to spawn at all (ENOENT, etc.) is
  reflected via `toolset.status()[i].lastError` instead — there's
  no stream to listen to in that case.

If you'd rather not subscribe at all, the toolset still consumes
stderr internally (it has to, because the SDK pipes it). The events
just fall on the floor.

---

## Status

Pre-1.0 (`0.1.0`). The API may move before `1.0.0` if the upstream
MCP SDK introduces a breaking change. The discriminated-error model
and the `<server>__<tool>` namespacing convention are stable.

See [`CHANGELOG.md`](../../CHANGELOG.md) for version-to-version notes.
