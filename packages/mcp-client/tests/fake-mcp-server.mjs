#!/usr/bin/env node
/**
 * A minimal MCP server, spawned by `toolset.test.ts` to exercise the
 * real stdio handshake without depending on `npx -y` (which hits the
 * network on the first run and is flaky in CI).
 *
 * Tools:
 *
 *   echo            — returns whatever string is in `text`. If `text`
 *                     starts with `stderr:`, writes the rest to stderr
 *                     before returning — handy for testing the
 *                     toolset's `server-stderr` event.
 *   add             — returns the sum of `a` + `b`.
 *   fail            — always returns isError=true with a known
 *                     message; used to test tool_call_failed.
 *   crash           — exits the process; used to test
 *                     server_crashed-style behaviour.
 *
 * Flags:
 *
 *   --tool-name-suffix=foo  — appends `_foo` to every tool name. Used
 *                              by the namespace-collision test to
 *                              create two servers that expose the
 *                              "same" tool without actually colliding
 *                              at the SDK level.
 *
 *   --stderr-banner=line     — writes `line\n` to stderr immediately
 *                              after startup, before the MCP handshake.
 *                              Used to test that the toolset captures
 *                              early stderr output.
 *
 *   --stderr-multiline       — writes a 3-line stderr blurb at startup,
 *                              with the second chunk split mid-line so
 *                              the test exercises the toolset's line-
 *                              buffering logic. Mutually compatible
 *                              with `--stderr-banner`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const suffixArg = process.argv.find((a) => a.startsWith('--tool-name-suffix='))
const suffix = suffixArg ? '_' + suffixArg.slice('--tool-name-suffix='.length) : ''

// Banner: one line to stderr right at startup.
const bannerArg = process.argv.find((a) => a.startsWith('--stderr-banner='))
if (bannerArg) {
  process.stderr.write(bannerArg.slice('--stderr-banner='.length) + '\n')
}

// Multi-line + chunked stderr: two writes, with the first split mid-
// line. Tests the toolset's line-buffering (the partial chunk must
// be held until the trailing newline arrives in the second write).
if (process.argv.includes('--stderr-multiline')) {
  process.stderr.write('alpha\nbeta-par')
  process.stderr.write('tial\ngamma\n')
}

const server = new McpServer({
  name: 'fake-mcp',
  version: '0.0.0-test',
})

server.tool(
  'echo' + suffix,
  'Echoes back the supplied text.',
  { text: z.string() },
  async ({ text }) => {
    // Special-case: `stderr:<rest>` writes <rest> to stderr (with a
    // trailing newline) and echoes back "wrote-stderr". Lets tests
    // trigger a deterministic stderr emission via a tool call.
    if (text.startsWith('stderr:')) {
      process.stderr.write(text.slice('stderr:'.length) + '\n')
      return { content: [{ type: 'text', text: 'wrote-stderr' }] }
    }
    return { content: [{ type: 'text', text }] }
  },
)

server.tool(
  'add' + suffix,
  'Returns the sum of a + b.',
  { a: z.number(), b: z.number() },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  }),
)

server.tool(
  'fail' + suffix,
  'Always returns isError=true.',
  {},
  async () => ({
    isError: true,
    content: [{ type: 'text', text: 'deliberate test failure' }],
  }),
)

server.tool(
  'crash' + suffix,
  'Exits the server process.',
  {},
  async () => {
    // Send back the response THEN exit, so the client sees a
    // close-after-response rather than an in-flight hang. (The
    // `server_crashed` test path uses a different vehicle — we just
    // shouldn't deadlock if a tool exits its own server.)
    setImmediate(() => process.exit(0))
    return { content: [{ type: 'text', text: 'goodbye' }] }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
