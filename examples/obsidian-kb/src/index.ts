/**
 * Obsidian vault as a knowledge base — config-preview demo.
 *
 * AipeHub never reads your vault or stores its contents. An agent declares the
 * `mcp-obsidian` MCP server in its `mcpServers` config; the host spawns it as a
 * child process and exposes its tools (`obsidian__search`,
 * `obsidian__get_file_contents`, …) to the agent's LLM tool-use loop. The MCP
 * server talks to Obsidian's Local REST API plugin — so the vault, the plugin,
 * and the credentials all live outside AipeHub.
 *
 *   User question
 *        │
 *        ▼
 *   ┌──────────────┐   MCP tool call    ┌───────────────┐   Local REST    ┌──────────┐
 *   │   LlmAgent   │ ─────────────────▶ │  mcp-obsidian  │ ─────────────▶ │ Obsidian │
 *   │  (research)  │ ◀───────────────── │  (child proc)  │ ◀───────────── │  vault   │
 *   └──────────────┘   note contents    └───────────────┘                 └──────────┘
 *
 * This script just previews the wiring — it does NOT spawn the MCP server (that
 * needs a running Obsidian + the Local REST API plugin). Run a real host to use
 * it for real; see README.md.
 *
 * Run:  pnpm demo:obsidian-kb
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createLogger } from '@aipehub/core'

const log = createLogger('obsidian-kb')
const AGENT_YAML = fileURLToPath(new URL('../agents/obsidian-researcher.yaml', import.meta.url))

function main(): void {
  log.info('Obsidian vault as a knowledge base (via mcp-obsidian)')
  log.info('')
  log.info('AipeHub does not read your vault. The agent declares an MCP server;')
  log.info('the host spawns it and wires its tools into the tool-use loop.')
  log.info('')

  // Surface the credential the MCP server needs, without printing its value.
  const haveKey = Boolean(process.env.OBSIDIAN_API_KEY)
  log.info(`OBSIDIAN_API_KEY present: ${haveKey ? 'yes' : 'no (set it for a live run)'}`)
  log.info('')

  log.info('Agent manifest (import this via the admin UI → Agents → Import YAML):')
  log.info(`  ${AGENT_YAML}`)
  log.info('')
  for (const line of readFileSync(AGENT_YAML, 'utf8').trimEnd().split('\n')) {
    log.info(`  │ ${line}`)
  }
  log.info('')
  log.info('Quick start with a real host:')
  log.info('  1. Install + enable the "Local REST API" Obsidian community plugin')
  log.info('  2. export OBSIDIAN_API_KEY=<the plugin api key>')
  log.info('  3. export ANTHROPIC_API_KEY=sk-ant-...   # the agent\'s LLM key')
  log.info('  4. aipehub init && npx @aipehub/host')
  log.info('  5. Admin UI → Agents → Import YAML → paste the manifest above')
  log.info('  6. Chat: "What did I note about the AipeHub roadmap?"')
}

main()
