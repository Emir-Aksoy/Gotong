# Cross-hub MCP federation (代理转发)

Two hubs in one process. **Hub A** owns an MCP server and shares it with
peers; an agent on **Hub B** calls that server's tools over the federation
link — and the tool's subprocess + credentials **never leave A**
(凭证各归各家). Hub B only ever learns the tool's *name* and *result*.

This is the consumer-facing payoff of `#2-M3`: install once on A, use
anywhere a peer link reaches.

```
hub-b / mathbot  (LlmAgent tool-use loop)
  → RemoteMcpToolset.listTools / callTool
    → federation link rpc  (mcp.listTools / mcp.callTool)
      → hub-a McpProxyHost   (ACL: shared===true, re-checked every call)
        → hub-a local calc toolset = real impl + real credentials
        ← result travels back; the spec / command / env never cross
```

The proxy classes used here (`McpProxyHost`, `RemoteMcpToolset`,
`fetchPeerSharedMcp`) are the **real host implementation**, imported via
`@gotong/host/mcp-proxy` — no reimplementation, no drift from production.

## Run

Examples resolve workspace deps from their built `dist/`, so build the deps
first (in particular `@gotong/host`, whose `./mcp-proxy` subpath this
example imports):

```sh
pnpm -C packages/core build
pnpm -C packages/llm build
pnpm -C packages/host build
pnpm --filter @gotong/example-cross-hub-mcp start
```

No API keys, no subprocess, no network — the demo uses `MockLlmProvider`
and an in-process tool.

## What you'll see (three acts)

1. **Discovery** — `fetchPeerSharedMcp(link)` lists what A shares. This is
   the exact call behind the admin agent-form's "shared by peers" browse
   list (`GET /api/admin/mcp-shared`). An admin picks `hub-a:calc` from it.
2. **An agent uses the remote tool** — `mathbot` on B is asked `21 + 21`;
   its tool-use loop calls `calc__add`, which executes on A and returns
   `42`. The `[hub-a/calc] computed …` line proves where the work ran.
3. **Per-call ACL** — A flips `calc.shared = false`. With no redeploy and
   no reconnect, B's next `listTools` degrades to `[]` and its next
   `callTool` comes back `isError` — the proxy re-checks the ACL on every
   call.

## Mapping to a real deployment

| Demo shortcut | Production |
|---|---|
| `createInprocHubLinkPair` | a WebSocket peer link wired by the peer registry (the rpc seam is identical) |
| `aRegistry` array + `space: { mcpServers }` | the persisted hub MCP registry (`Space.mcpServers()`) |
| inlined `calcToolset()` | a real `McpToolset` the proxy builds from the registry spec — a subprocess / http client opened with A's credentials |
| `MockLlmProvider` script | `AnthropicProvider` / `OpenAIProvider`; the model picks the tool itself |
| `new RemoteMcpToolset(...)` by hand | the host splits an agent's `useMcpServers: ["hub-a:calc"]` into local + `peer:server` refs at spawn |

See [`docs/zh/MCP.md`](../../docs/zh/MCP.md) §7 for the full write-up.
