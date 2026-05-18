#!/usr/bin/env node
/**
 * AipeHub MCP server — stdio bridge that lets any MCP client
 * (Claude Desktop, Cursor, Cline, …) operate on a running AipeHub Hub.
 *
 * Connection model: MCP server is a **client** of the Hub's HTTP admin
 * API. It never holds a WebSocket. Configuration is a base URL + a
 * Bearer admin token, both passed via CLI flags or environment variables
 * (env wins, so MCP client configs that hardcode args can still be
 * overridden in CI).
 *
 *   aipehub-mcp --hub http://127.0.0.1:3000 --token <BEARER>
 *
 * Or:
 *
 *   AIPE_HUB_URL=http://127.0.0.1:3000 \
 *   AIPE_ADMIN_TOKEN=<BEARER> \
 *   aipehub-mcp
 *
 * Operational notes:
 *   - stdio is reserved for MCP protocol traffic. ALL logs go to stderr.
 *   - On startup we ping /healthz to fail fast on bad config.
 *   - The Hub's admin Bearer endpoint already enforces rate limits and
 *     allowed-hosts; we don't reimplement either here.
 */

import { readFileSync } from 'node:fs'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { HubClient, redactError } from './hub-client.js'
import { registerTools } from './tools.js'

const ARGV = process.argv.slice(2)

if (ARGV.includes('--help') || ARGV.includes('-h')) {
  printUsage()
  process.exit(0)
}
if (ARGV.includes('--version') || ARGV.includes('-V')) {
  process.stdout.write(`${pkgVersion()}\n`)
  process.exit(0)
}

function pkgVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function flag(name: string): string | undefined {
  const i = ARGV.indexOf(name)
  if (i === -1 || i === ARGV.length - 1) return undefined
  return ARGV[i + 1]
}

function printUsage(): void {
  process.stdout.write(`Usage: aipehub-mcp [options]

AipeHub MCP (Model Context Protocol) bridge. Lets MCP clients —
Claude Desktop, Cursor, Cline, etc. — operate on a running AipeHub
Hub: list participants, dispatch tasks, read the contribution
leaderboard, evaluate completed work.

OPTIONS
  --hub <URL>        Hub base URL (e.g. http://127.0.0.1:3000). Required.
                     Or set AIPE_HUB_URL.
  --token <BEARER>   Admin token. Required.
                     Or set AIPE_ADMIN_TOKEN.
  -h, --help         Show this help.
  -V, --version      Print version.

CLAUDE DESKTOP / CURSOR CONFIG (~/Library/Application Support/Claude/claude_desktop_config.json):
  {
    "mcpServers": {
      "aipehub": {
        "command": "npx",
        "args": ["-y", "@aipehub/mcp-server"],
        "env": {
          "AIPE_HUB_URL": "http://127.0.0.1:3000",
          "AIPE_ADMIN_TOKEN": "<your-bearer-token>"
        }
      }
    }
  }

TOOLS PROVIDED
  list_participants  — who's online (agents + humans, capability tags)
  dispatch_task      — fire a task into the Hub and wait for the result
  list_tasks         — recent tasks with status
  get_leaderboard    — contribution leaderboard for today / 7d / 30d / all
  evaluate_task      — attach a rating + comment to a completed task

DOCS
  https://github.com/Emir-Aksoy/AipeHub/blob/main/docs/MCP.md
`)
}

async function main(): Promise<void> {
  const hubUrl = (flag('--hub') ?? process.env.AIPE_HUB_URL ?? '').replace(/\/+$/, '')
  const token = flag('--token') ?? process.env.AIPE_ADMIN_TOKEN ?? ''
  if (!hubUrl || !token) {
    process.stderr.write(
      '[aipehub-mcp] Missing config: pass --hub <URL> --token <BEARER> ' +
        'or set AIPE_HUB_URL / AIPE_ADMIN_TOKEN. Run --help for details.\n',
    )
    process.exit(2)
  }

  const client = new HubClient({ baseUrl: hubUrl, adminToken: token })

  // Quick reachability check — fail before opening stdio so the MCP
  // client sees a clean exit code rather than a stuck initialisation.
  const ok = await client.ping()
  if (!ok) {
    process.stderr.write(
      `[aipehub-mcp] Hub at ${hubUrl} did not answer /healthz. ` +
        `Check the URL and that the host is running.\n`,
    )
    process.exit(3)
  }

  const server = new McpServer({
    name: 'aipehub-mcp-server',
    version: pkgVersion(),
  })

  registerTools(server, client)

  const transport = new StdioServerTransport()
  await server.connect(transport)

  process.stderr.write(`[aipehub-mcp] connected to ${hubUrl} (5 tools registered)\n`)
}

main().catch((err) => {
  // H3 — top-level catch must NOT leak the admin Bearer token to stderr.
  // The HubClient already redacts errors it produces, but this catch
  // also fires for errors from McpServer, transport, or process-level
  // failures whose stack may have visited code that saw the token.
  // Take a defensive second pass here keyed off the token literal from
  // env / args (the same source the HubClient was built with). When no
  // token is configured (the early --help / --version paths exit
  // before this catch fires), `redactError(err, '')` is a no-op except
  // for the generic `Bearer …` regex, which is also harmless.
  //
  // See AUDIT-v3.3.md finding H3.
  const token = process.env.AIPE_ADMIN_TOKEN ?? flag('--token') ?? ''
  const safe = redactError(err, token)
  process.stderr.write(
    `[aipehub-mcp] fatal: ${safe.stack ?? safe.message}\n`,
  )
  process.exit(1)
})
