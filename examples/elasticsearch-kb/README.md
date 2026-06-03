# Elasticsearch index as a knowledge base — AipeHub Example

Wire your [Elasticsearch](https://www.elastic.co) indices into an AipeHub agent
so it can search them in natural language — via the official
[`@elastic/mcp-server-elasticsearch`](https://github.com/elastic/mcp-server-elasticsearch)
MCP server.

## How it works

AipeHub does not connect to your cluster or store its documents. The agent
declares the MCP server in its `mcpServers` config; the host spawns it as a
child process and exposes its tools to the agent's LLM tool-use loop. The
cluster URL and API key stay outside AipeHub.

```
  User question
       │
       ▼
  ┌──────────────┐   MCP tool call    ┌──────────────────────┐   ES HTTP    ┌──────────────┐
  │   LlmAgent   │ ─────────────────▶ │ mcp-server-elastic…  │ ───────────▶ │ Elasticsearch │
  │  (research)  │ ◀───────────────── │     (child proc)     │ ◀─────────── │   cluster     │
  └──────────────┘   search hits      └──────────────────────┘              └──────────────┘
```

## Quick start

```bash
# 1. Get an Elasticsearch API key (Kibana → Stack Management → API keys), and
#    the cluster URL. A read-only key scoped to the indices you want is best.

# 2. Set the credentials
export ES_URL=https://my-cluster.es.cloud:443
export ES_API_KEY=<base64 api key>
export DEEPSEEK_API_KEY=sk-...          # the agent's own LLM key

# 3. Initialize a workspace and start the host
#    (npx fetches @elastic/mcp-server-elasticsearch on first spawn — Node 18+)
aipehub init
npx @aipehub/host

# 4. Admin UI → Agents tab → Import YAML → paste agents/elasticsearch-researcher.yaml
#    The mcpServers config auto-spawns the ES MCP server alongside the agent.

# 5. Chat with the agent:
#    - "Which indices are available?"
#    - "Find orders over $1000 placed last week and summarize by region."
```

To preview the wiring without a live host: `pnpm demo:elasticsearch-kb`.

## Agent config

See [`agents/elasticsearch-researcher.yaml`](agents/elasticsearch-researcher.yaml).
The key section:

```yaml
mcpServers:
  - name: es
    command: npx
    args: [-y, "@elastic/mcp-server-elasticsearch"]
    env:
      ES_URL: ${ES_URL}
      ES_API_KEY: ${ES_API_KEY}
```

The host spawns the server when the agent starts. The agent sees tools
namespaced `es__*` (`es__list_indices`, `es__get_mappings`, `es__search`) in
its tool-use loop.

## Which Elastic MCP server?

| Option | When | How |
|--------|------|-----|
| `@elastic/mcp-server-elasticsearch` (this example) | self-hosted / classic clusters; simplest local stdio wiring | `npx -y @elastic/mcp-server-elasticsearch` child process |
| **Elastic Agent Builder MCP endpoint** | Elastic **9.2.0+** / Serverless; the going-forward path | a remote streamable-HTTP MCP endpoint — register it as a hub MCP server (URL + bearer) instead of a child process |

> Elastic has marked the standalone `@elastic/mcp-server-elasticsearch` package
> as **deprecated** (security fixes only) in favor of the Agent Builder MCP
> endpoint. This example uses the standalone server because it's the simplest
> stdio wiring and works against any cluster; if you're on 9.2.0+/Serverless,
> prefer the Agent Builder endpoint and wire it as a remote MCP server.

## Security notes

- **The cluster is reached only by the MCP server.** AipeHub never opens a
  connection to Elasticsearch; the child process does, using `ES_URL`.
- **Use a least-privilege API key.** Scope `ES_API_KEY` to read-only on just the
  indices the agent should see. The agent can run arbitrary query DSL — it
  cannot exceed what the key allows.
- **Credentials are `${VAR}` placeholders**, resolved from the host environment
  (or the encrypted vault) — never hard-code them in the YAML.
- **Cross-org sharing:** if you expose this agent's index search to a peer hub,
  use the per-link knowledge-base allowlist + data-class gates (see
  `docs/zh/KB-CONNECTORS.md`) so a partner can't search indices you didn't grant.

## See also

- [`docs/zh/KB-CONNECTORS.md`](../../docs/zh/KB-CONNECTORS.md) — knowledge-base
  connectors design rationale (Obsidian + Elasticsearch), credentials, quota,
  and how this ties into KB slots / peer KB gating.
- [`examples/obsidian-kb/`](../obsidian-kb/) — the same pattern for an Obsidian
  vault (document notes instead of a search index).
- [`docs/zh/RAG-VIA-MCP.md`](../../docs/zh/RAG-VIA-MCP.md) — vector-RAG via MCP
  (the original "AipeHub doesn't store knowledge" worked example).
