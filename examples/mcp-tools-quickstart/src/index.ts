/**
 * `@aipehub/mcp-client` stand-alone quickstart.
 *
 * No Hub, no LLM, no AipeHub agents — just the toolset. Spawns the
 * official filesystem MCP server (via `npx -y`) against the example
 * package's own directory, lists its tools, calls `read_file` on a
 * known file in this repo, and disconnects.
 *
 * Run:
 *
 *   pnpm install
 *   pnpm --filter @aipehub/example-mcp-tools-quickstart start
 *
 * Expected output (truncated):
 *
 *   → connecting to 2 server(s)…
 *   ✓ status: [ { name: 'fs', status: 'live' } ]
 *   ✓ 11 tools available:
 *       - fs__read_file
 *       - fs__write_file
 *       - fs__list_directory
 *       …
 *   ✓ called fs__read_file on package.json:
 *      { "name": "@aipehub/example-mcp-tools-quickstart", … }
 *   → disconnected
 */

import { McpToolset } from '@aipehub/mcp-client'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = dirname(HERE)            // examples/mcp-tools-quickstart/

async function main() {
  // The filesystem MCP server is restricted to whatever directory
  // it's invoked with as an argv — by handing it `PKG_ROOT`, anything
  // we ask it to read is sandboxed under this example.
  const toolset = new McpToolset({
    servers: [
      {
        name: 'fs',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', PKG_ROOT],
      },
    ],
  })

  console.log('→ connecting to', toolset.serverNames().length, 'server(s)…')
  await toolset.connect()
  console.log('✓ status:', toolset.status())

  const tools = await toolset.listTools()
  console.log(`✓ ${tools.length} tools available:`)
  for (const t of tools) {
    console.log(`    - ${t.name}`)
  }

  // Read this example's own package.json so the demo is self-contained.
  const target = join(PKG_ROOT, 'package.json')
  const out = await toolset.callTool('fs__read_text_file', { path: target })
  const block = out.content[0]
  if (block && block.type === 'text') {
    console.log(`✓ called fs__read_text_file on ${target}:`)
    // Print only the first 200 chars to keep the demo output tight.
    console.log('   ', block.text.slice(0, 200).trimEnd(), '…')
  }

  await toolset.disconnect()
  console.log('→ disconnected')
}

main().catch((err) => {
  console.error('✖ demo failed:', err)
  process.exitCode = 1
})
