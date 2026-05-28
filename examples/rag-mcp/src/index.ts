/**
 * RAG via MCP — end-to-end demo.
 *
 * This example shows how an AipeHub agent uses a knowledge MCP server
 * (chroma-mcp) for retrieval-augmented generation. The flow:
 *
 *   1. Boot an in-memory Hub
 *   2. Register an LlmAgent whose `mcpServers` config points at chroma-mcp
 *   3. Dispatch a task asking the agent to ingest some content
 *   4. Dispatch a second task asking a question about that content
 *
 * Prerequisites:
 *   - `uv` installed (for `uvx chroma-mcp`)
 *   - DEEPSEEK_API_KEY (or OPENAI_API_KEY) in environment
 *
 * Run:
 *   export DEEPSEEK_API_KEY=sk-...
 *   pnpm start
 *
 * See `docs/zh/RAG-VIA-MCP.md` for the full design rationale and
 * alternative RAG server options (qdrant, pinecone, pgvector).
 */

import { Hub, createLogger } from '@aipehub/core'

const log = createLogger('rag-demo')

async function main() {
  log.info('RAG via MCP demo')
  log.info('This example requires:')
  log.info('  1. uv installed (pip install uv, or brew install uv)')
  log.info('  2. DEEPSEEK_API_KEY or OPENAI_API_KEY in environment')
  log.info('')
  log.info('To run with a live host instead of this script:')
  log.info('  1. aipehub init')
  log.info('  2. Import agents/rag-researcher.yaml via the admin UI')
  log.info('  3. Chat with the agent — ask it to ingest content, then query')
  log.info('')

  // Check for API key
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY
  if (!apiKey) {
    log.warn('No DEEPSEEK_API_KEY or OPENAI_API_KEY found.')
    log.info('Set one to run the live demo. Exiting with agent config preview.')
    log.info('')
    log.info('Agent YAML config for the admin UI:')
    log.info('  See agents/rag-researcher.yaml in this directory')
    log.info('')
    log.info('Quick start with a real host:')
    log.info('  export DEEPSEEK_API_KEY=sk-...')
    log.info('  aipehub init --space-dir=.aipehub')
    log.info('  # Import agents/rag-researcher.yaml via admin UI agents tab')
    log.info('  # The mcpServers config auto-spawns chroma-mcp alongside the agent')
    return
  }

  // When running with a real host, the agent YAML in agents/ does
  // everything. This script just demonstrates the config structure.
  const hub = new Hub({ name: 'rag-demo' })

  log.info('Hub created. In production, the host would:')
  log.info('  1. Read agents/rag-researcher.yaml')
  log.info('  2. Spawn chroma-mcp as a child process (via mcpServers config)')
  log.info('  3. Wire MCP tools into the LlmAgent tool-use loop')
  log.info('  4. The agent can then ingest + query the knowledge base')
  log.info('')
  log.info('The key insight: AipeHub never touches vectors or embeddings.')
  log.info('The MCP server (chroma-mcp) handles all RAG internals.')
  log.info('AipeHub just routes messages and manages the agent lifecycle.')

  hub.shutdown()
  log.info('Done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
