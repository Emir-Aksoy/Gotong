/**
 * Elasticsearch index as a knowledge base — config-preview demo.
 *
 * Gotong never connects to your cluster or stores its documents. An agent
 * declares the `@elastic/mcp-server-elasticsearch` MCP server in its
 * `mcpServers` config; the host spawns it as a child process and exposes its
 * tools (`es__list_indices`, `es__get_mappings`, `es__search`) to the agent's
 * LLM tool-use loop. The cluster URL and API key live outside Gotong.
 *
 *   User question
 *        │
 *        ▼
 *   ┌──────────────┐   MCP tool call    ┌──────────────────────┐   ES HTTP    ┌──────────────┐
 *   │   LlmAgent   │ ─────────────────▶ │ mcp-server-elastic…  │ ───────────▶ │ Elasticsearch │
 *   │  (research)  │ ◀───────────────── │     (child proc)     │ ◀─────────── │   cluster     │
 *   └──────────────┘   search hits      └──────────────────────┘              └──────────────┘
 *
 * This script just previews the wiring — it does NOT spawn the MCP server (that
 * needs a reachable ES cluster + credentials). Run a real host to use it for
 * real; see README.md.
 *
 * Run:  pnpm demo:elasticsearch-kb
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createLogger } from '@gotong/core'

const log = createLogger('elasticsearch-kb')
const AGENT_YAML = fileURLToPath(new URL('../agents/elasticsearch-researcher.yaml', import.meta.url))

function main(): void {
  log.info('Elasticsearch index as a knowledge base (via @elastic/mcp-server-elasticsearch)')
  log.info('')
  log.info('Gotong does not connect to your cluster. The agent declares an MCP')
  log.info('server; the host spawns it and wires its tools into the tool-use loop.')
  log.info('')

  // Surface the credentials the MCP server needs, without printing values.
  log.info(`ES_URL present:     ${process.env.ES_URL ? 'yes' : 'no (set it for a live run)'}`)
  log.info(`ES_API_KEY present: ${process.env.ES_API_KEY ? 'yes' : 'no (set it for a live run)'}`)
  log.info('')

  log.info('Agent manifest (import this via the admin UI → Agents → Import YAML):')
  log.info(`  ${AGENT_YAML}`)
  log.info('')
  for (const line of readFileSync(AGENT_YAML, 'utf8').trimEnd().split('\n')) {
    log.info(`  │ ${line}`)
  }
  log.info('')
  log.info('Quick start with a real host:')
  log.info('  1. export ES_URL=https://my-cluster.es.cloud:443')
  log.info('  2. export ES_API_KEY=<base64 api key from Kibana>')
  log.info('  3. export DEEPSEEK_API_KEY=sk-...   # the agent\'s LLM key')
  log.info('  4. gotong init && npx @gotong/host')
  log.info('  5. Admin UI → Agents → Import YAML → paste the manifest above')
  log.info('  6. Chat: "How many orders shipped last week?" (the agent searches ES)')
}

main()
