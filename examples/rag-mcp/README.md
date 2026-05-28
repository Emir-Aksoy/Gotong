# RAG via MCP — AipeHub Example

Demonstrates retrieval-augmented generation by wiring a knowledge MCP
server (chroma-mcp) into an AipeHub agent.

## How it works

AipeHub does not embed vectors or call embedding APIs. Instead, each
agent declares the MCP servers it needs in its `mcpServers` config.
The host spawns them as child processes and exposes their tools to the
agent's LLM tool-use loop.

```
  User question
       │
       ▼
  ┌─────────────┐     MCP tool call      ┌──────────────┐
  │  LlmAgent   │ ──────────────────────▶ │  chroma-mcp  │
  │  (research)  │ ◀────────────────────── │  (local DB)  │
  └─────────────┘     retrieved chunks    └──────────────┘
       │
       ▼
  LLM synthesizes answer from retrieved context
```

## Quick start

```bash
# 1. Install uv (needed for `uvx chroma-mcp`)
brew install uv         # or: pip install uv

# 2. Set your LLM API key
export DEEPSEEK_API_KEY=sk-...   # cheapest option with tool use
# or: export OPENAI_API_KEY=sk-...

# 3. Initialize a workspace and start the host
aipehub init
npx @aipehub/host

# 4. In the admin UI → Agents tab → Import YAML
#    Paste the contents of agents/rag-researcher.yaml
#    The mcpServers config will auto-spawn chroma-mcp

# 5. Chat with the agent:
#    - "Please learn this: AipeHub is an agent orchestration framework..."
#    - "What is AipeHub?"
```

## Agent config

See [`agents/rag-researcher.yaml`](agents/rag-researcher.yaml) for the
full agent manifest. The key section:

```yaml
mcpServers:
  - name: knowledge
    command: uvx
    args: [chroma-mcp, --persist-dir, .aipehub/knowledge/research]
```

This tells the host to spawn `uvx chroma-mcp` when the agent starts.
The agent sees tools like `knowledge__add_to_collection` and
`knowledge__query_collection` in its tool-use loop.

## Alternative RAG servers

| Server | Best for | Command |
|--------|----------|---------|
| chroma-mcp | Local / small team | `uvx chroma-mcp` |
| mcp-server-qdrant | Medium scale | `uvx mcp-server-qdrant` |
| pinecone-mcp | Large scale / managed | `npx -y pinecone-mcp` |

See [`docs/zh/RAG-VIA-MCP.md`](../../docs/zh/RAG-VIA-MCP.md) for the
full design rationale, credential management, quota integration, and
troubleshooting guide.
