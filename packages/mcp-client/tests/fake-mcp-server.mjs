#!/usr/bin/env node
/**
 * A minimal MCP server, spawned by `toolset.test.ts` to exercise the
 * real stdio handshake without depending on `npx -y` (which hits the
 * network on the first run and is flaky in CI).
 *
 * Tools:
 *
 *   echo            — returns whatever string is in `text`.
 *   add             — returns the sum of `a` + `b`.
 *   fail            — always returns isError=true with a known
 *                     message; used to test tool_call_failed.
 *   crash           — exits the process; used to test
 *                     server_crashed-style behaviour.
 *
 * The server takes one optional flag:
 *
 *   --tool-name-suffix=foo  — appends `_foo` to every tool name. Used
 *                              by the namespace-collision test to
 *                              create two servers that expose the
 *                              "same" tool without actually colliding
 *                              at the SDK level.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const suffixArg = process.argv.find((a) => a.startsWith('--tool-name-suffix='))
const suffix = suffixArg ? '_' + suffixArg.slice('--tool-name-suffix='.length) : ''

const server = new McpServer({
  name: 'fake-mcp',
  version: '0.0.0-test',
})

server.tool(
  'echo' + suffix,
  'Echoes back the supplied text.',
  { text: z.string() },
  async ({ text }) => ({
    content: [{ type: 'text', text }],
  }),
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
