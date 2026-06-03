# Obsidian vault as a knowledge base — AipeHub Example

Wire your personal [Obsidian](https://obsidian.md) vault into an AipeHub agent
so it can search and read your notes — via the
[`mcp-obsidian`](https://github.com/MarkusPfundstein/mcp-obsidian) MCP server.

## How it works

AipeHub does not read your vault or store its contents. The agent declares the
MCP server in its `mcpServers` config; the host spawns it as a child process
and exposes its tools to the agent's LLM tool-use loop. `mcp-obsidian` talks to
the **Local REST API** Obsidian community plugin — so the vault, the plugin,
and the API key all stay outside AipeHub.

```
  User question
       │
       ▼
  ┌──────────────┐   MCP tool call    ┌───────────────┐   Local REST    ┌──────────┐
  │   LlmAgent   │ ─────────────────▶ │  mcp-obsidian  │ ─────────────▶ │ Obsidian │
  │  (research)  │ ◀───────────────── │  (child proc)  │ ◀───────────── │  vault   │
  └──────────────┘   note contents    └───────────────┘                 └──────────┘
```

## Quick start

```bash
# 1. In Obsidian: Settings → Community plugins → install + enable
#    "Local REST API" (coddingtonbear/obsidian-local-rest-api). Copy its API key.

# 2. Install uv (needed for `uvx mcp-obsidian`)
brew install uv          # or: pip install uv

# 3. Set the credentials
export OBSIDIAN_API_KEY=<the plugin's api key>
export ANTHROPIC_API_KEY=sk-ant-...     # the agent's own LLM key
# Optional (defaults shown): export OBSIDIAN_HOST=127.0.0.1 OBSIDIAN_PORT=27124

# 4. Initialize a workspace and start the host
aipehub init
npx @aipehub/host

# 5. Admin UI → Agents tab → Import YAML → paste agents/obsidian-researcher.yaml
#    The mcpServers config auto-spawns `uvx mcp-obsidian` alongside the agent.

# 6. Chat with the agent:
#    - "What did I note about the AipeHub roadmap?"
#    - "Find my notes mentioning Elasticsearch and summarize them."
```

To preview the wiring without a live host: `pnpm demo:obsidian-kb`.

## Agent config

See [`agents/obsidian-researcher.yaml`](agents/obsidian-researcher.yaml). The key
section:

```yaml
mcpServers:
  - name: obsidian
    command: uvx
    args: [mcp-obsidian]
    env:
      OBSIDIAN_API_KEY: ${OBSIDIAN_API_KEY}
```

The host spawns `uvx mcp-obsidian` when the agent starts. The agent sees tools
namespaced `obsidian__*` (`obsidian__search`, `obsidian__get_file_contents`,
`obsidian__list_files_in_vault`, …) in its tool-use loop.

## Tools the server exposes

| Tool | What it does |
|------|--------------|
| `obsidian__search` | full-text search across the vault |
| `obsidian__list_files_in_vault` / `obsidian__list_files_in_dir` | browse notes |
| `obsidian__get_file_contents` | read one note by vault path |
| `obsidian__append_content` / `obsidian__patch_content` / `obsidian__delete_file` | **write** tools — opt-in only |

The shipped agent prompt is read-oriented. If you want the agent to edit notes,
say so explicitly in the prompt — and consider gating destructive operations
(this is exactly what `governance` metadata + a human-in-the-loop step are for;
see `docs/zh/KB-CONNECTORS.md`).

## Security notes

- **The vault leaves your machine only as far as the MCP server.** `mcp-obsidian`
  runs locally and reads the vault through the Local REST API plugin over
  `https://127.0.0.1`. Nothing is uploaded to AipeHub.
- **The API key is a credential.** `${OBSIDIAN_API_KEY}` is resolved from the
  host environment (or the encrypted vault) — never hard-code it in the YAML.
- **Write tools are powerful.** `delete_file` / `patch_content` mutate your
  notes. Keep them out of the agent's workflow unless you mean it.

## See also

- [`docs/zh/KB-CONNECTORS.md`](../../docs/zh/KB-CONNECTORS.md) — knowledge-base
  connectors design rationale (Obsidian + Elasticsearch), credentials, quota,
  and how this ties into KB slots / peer KB gating.
- [`examples/elasticsearch-kb/`](../elasticsearch-kb/) — the same pattern for an
  Elasticsearch index.
- [`docs/zh/RAG-VIA-MCP.md`](../../docs/zh/RAG-VIA-MCP.md) — vector-RAG via MCP
  (the original "AipeHub doesn't store knowledge" worked example).
