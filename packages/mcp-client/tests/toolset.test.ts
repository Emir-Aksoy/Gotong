/**
 * `McpToolset` end-to-end tests — spawn a real fake MCP server child
 * process via stdio, drive the toolset against it, assert behaviour.
 *
 * Why a real spawn + real handshake instead of mocking the SDK?
 *
 *   1. The SDK API surface is moving (every minor release adds
 *      capabilities). Mocks calcify against a snapshot and drift.
 *      A real spawn validates against whatever the linked SDK
 *      actually does.
 *   2. The interesting failure modes (spawn ENOENT, crash mid-call,
 *      partial JSON-RPC framing) only manifest with a real child
 *      process. Unit-mocking them is theatre.
 *
 * The fake server (`fake-mcp-server.mjs`) declares four tools:
 * echo / add / fail / crash. Tests below thread real handshakes
 * through it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import { McpToolset, McpClientError } from '../src/index.js'

const FAKE_SERVER = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url))

function makeFakeServerConfig(name: string, suffix?: string) {
  return {
    name,
    command: process.execPath,                              // current `node` binary
    args: suffix ? [FAKE_SERVER, `--tool-name-suffix=${suffix}`] : [FAKE_SERVER],
  }
}

// =============================================================================
// Construction-time validation — no spawn, pure config sanity.
// =============================================================================

describe('McpToolset — construction validation', () => {
  it('rejects an empty servers list', () => {
    // The error.kind reuse of `duplicate_server` is documented in
    // errors.ts; we intentionally don't introduce a new kind for
    // this one-off rejection.
    expect(() => new McpToolset({ servers: [] })).toThrowError(McpClientError)
  })

  it('rejects two servers with the same name', () => {
    expect(() =>
      new McpToolset({
        servers: [
          makeFakeServerConfig('fs'),
          makeFakeServerConfig('fs'),
        ],
      }),
    ).toThrowError(/declared twice/)
  })

  it('rejects a server name with invalid characters', () => {
    // Tool-name regex used by the LLM APIs accepts only
    // [a-zA-Z0-9_-]; a name with a space or dot would produce an
    // un-namespaceable tool. Catch it early.
    expect(() =>
      new McpToolset({ servers: [{ name: 'has space', command: 'whatever' }] }),
    ).toThrowError(/must match/)
    expect(() =>
      new McpToolset({ servers: [{ name: 'has.dot', command: 'whatever' }] }),
    ).toThrowError(/must match/)
    expect(() =>
      new McpToolset({ servers: [{ name: '1starts-digit', command: 'whatever' }] }),
    ).toThrowError(/must match/)
  })

  it('accepts names with underscores, hyphens, mixed case', () => {
    // Sanity: these should all be legal prefixes.
    expect(
      () =>
        new McpToolset({
          servers: [
            { name: 'a', command: 'x' },
            { name: 'A', command: 'x' },
            { name: 'fs', command: 'x' },
            { name: 'my-server', command: 'x' },
            { name: 'my_server2', command: 'x' },
            { name: 'GitHub', command: 'x' },
          ],
        }),
    ).not.toThrow()
  })

  it('serverNames() reflects construction order', () => {
    const ts = new McpToolset({
      servers: [
        { name: 'first', command: 'x' },
        { name: 'second', command: 'x' },
        { name: 'third', command: 'x' },
      ],
    })
    expect(ts.serverNames()).toEqual(['first', 'second', 'third'])
  })
})

// =============================================================================
// Pre-connect API behaviour — no spawn yet.
// =============================================================================

describe('McpToolset — pre-connect guards', () => {
  it('listTools() throws not_connected before connect()', async () => {
    const ts = new McpToolset({ servers: [makeFakeServerConfig('fs')] })
    await expect(ts.listTools()).rejects.toMatchObject({
      kind: 'not_connected',
    })
  })

  it('callTool() throws not_connected before connect()', async () => {
    const ts = new McpToolset({ servers: [makeFakeServerConfig('fs')] })
    await expect(ts.callTool('fs__echo', { text: 'x' })).rejects.toMatchObject({
      kind: 'not_connected',
    })
  })

  it('status() reports idle for every server before connect()', () => {
    const ts = new McpToolset({
      servers: [makeFakeServerConfig('a'), makeFakeServerConfig('b')],
    })
    const s = ts.status()
    expect(s).toHaveLength(2)
    expect(s.every((r) => r.status === 'idle')).toBe(true)
  })
})

// =============================================================================
// Happy path — single server, full lifecycle.
// =============================================================================

describe('McpToolset — single server happy path', () => {
  let ts: McpToolset
  beforeEach(() => {
    ts = new McpToolset({ servers: [makeFakeServerConfig('fs')] })
  })
  afterEach(async () => {
    await ts.disconnect()
  })

  it('connect() spawns and reaches `live` status', async () => {
    await ts.connect()
    const s = ts.status()
    expect(s).toEqual([{ name: 'fs', status: 'live' }])
  })

  it('connect() is idempotent — second call is a no-op', async () => {
    await ts.connect()
    await ts.connect()
    expect(ts.status()[0]?.status).toBe('live')
  })

  it('listTools() returns the namespaced fake tools', async () => {
    await ts.connect()
    const tools = await ts.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['fs__add', 'fs__crash', 'fs__echo', 'fs__fail'])
    // Every tool carries provenance for ops attribution.
    expect(tools.every((t) => t.serverName === 'fs')).toBe(true)
    // The serverToolName is the un-prefixed original.
    const echo = tools.find((t) => t.serverToolName === 'echo')
    expect(echo?.name).toBe('fs__echo')
    expect(echo?.serverName).toBe('fs')
    // Schema field survives — the LLM provider needs it intact.
    expect(echo?.inputSchema).toBeTruthy()
  })

  it('callTool() routes the call to the right server tool', async () => {
    await ts.connect()
    const r1 = await ts.callTool('fs__echo', { text: 'hello' })
    expect(r1.content[0]).toMatchObject({ type: 'text', text: 'hello' })

    const r2 = await ts.callTool('fs__add', { a: 7, b: 35 })
    expect(r2.content[0]).toMatchObject({ type: 'text', text: '42' })
  })

  it('callTool() with default args object is allowed', async () => {
    await ts.connect()
    // `fail` takes no args. Verify the second arg is genuinely optional
    // at the type level + behaviour level.
    await expect(ts.callTool('fs__fail')).rejects.toMatchObject({
      kind: 'tool_call_failed',
    })
  })
})

// =============================================================================
// Error path — typed errors for every failure surface.
// =============================================================================

describe('McpToolset — error surfaces', () => {
  let ts: McpToolset
  beforeEach(() => {
    ts = new McpToolset({ servers: [makeFakeServerConfig('fs')] })
  })
  afterEach(async () => {
    await ts.disconnect()
  })

  it('bad_tool_name when the name has no separator', async () => {
    await ts.connect()
    await expect(ts.callTool('echo', { text: 'x' })).rejects.toMatchObject({
      kind: 'bad_tool_name',
    })
  })

  it('bad_tool_name when the name starts with the separator', async () => {
    await ts.connect()
    await expect(ts.callTool('__echo', { text: 'x' })).rejects.toMatchObject({
      kind: 'bad_tool_name',
    })
  })

  it('unknown_tool when the server prefix is not in the toolset', async () => {
    await ts.connect()
    await expect(ts.callTool('github__list_issues', {})).rejects.toMatchObject({
      kind: 'unknown_tool',
      serverName: 'github',
    })
  })

  it('tool_call_failed when the server returns isError', async () => {
    await ts.connect()
    try {
      await ts.callTool('fs__fail')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(McpClientError)
      expect((err as McpClientError).kind).toBe('tool_call_failed')
      // The server's own error message is preserved verbatim in `.detail`.
      expect((err as McpClientError).detail).toContain('deliberate test failure')
    }
  })

  it('a server that fails to spawn is marked dead; others stay live', async () => {
    // Two-server toolset: one good, one with a non-existent command.
    // The bad one ends up `dead`; the good one stays `live`.
    const mixed = new McpToolset({
      servers: [
        makeFakeServerConfig('good'),
        { name: 'bad', command: '/no/such/binary/path' },
      ],
    })
    try {
      await mixed.connect()
      const report = mixed.status()
      const good = report.find((r) => r.name === 'good')
      const bad = report.find((r) => r.name === 'bad')
      expect(good?.status).toBe('live')
      expect(bad?.status).toBe('dead')
      expect(bad?.lastError).toBeTruthy()

      // listTools still works — the dead server contributes nothing,
      // the live one contributes its four tools.
      const tools = await mixed.listTools()
      expect(tools.every((t) => t.serverName === 'good')).toBe(true)
      expect(tools).toHaveLength(4)

      // callTool against the dead server raises server_crashed.
      await expect(mixed.callTool('bad__whatever', {})).rejects.toMatchObject({
        kind: 'server_crashed',
        serverName: 'bad',
      })
    } finally {
      await mixed.disconnect()
    }
  })
})

// =============================================================================
// Multi-server — namespacing + merge semantics.
// =============================================================================

describe('McpToolset — multi-server namespacing', () => {
  let ts: McpToolset
  beforeEach(() => {
    // Two fake servers; the second one suffixes its tool names so
    // we can tell them apart on the un-prefixed side, but on the
    // namespaced side both have a `__echo*` series.
    ts = new McpToolset({
      servers: [
        makeFakeServerConfig('alpha'),
        makeFakeServerConfig('beta', 'v2'),
      ],
    })
  })
  afterEach(async () => {
    await ts.disconnect()
  })

  it('listTools() merges results from every live server', async () => {
    await ts.connect()
    const tools = await ts.listTools()
    // Server `alpha` contributes 4 tools, server `beta` contributes 4
    // (echo_v2 / add_v2 / fail_v2 / crash_v2).
    expect(tools).toHaveLength(8)
    const alphaTools = tools.filter((t) => t.serverName === 'alpha')
    const betaTools = tools.filter((t) => t.serverName === 'beta')
    expect(alphaTools).toHaveLength(4)
    expect(betaTools).toHaveLength(4)
    expect(alphaTools.find((t) => t.name === 'alpha__echo')).toBeTruthy()
    expect(betaTools.find((t) => t.name === 'beta__echo_v2')).toBeTruthy()
  })

  it('callTool() routes to the right server even with overlapping tool names', async () => {
    await ts.connect()
    const a = await ts.callTool('alpha__echo', { text: 'A' })
    const b = await ts.callTool('beta__echo_v2', { text: 'B' })
    expect(a.content[0]).toMatchObject({ text: 'A' })
    expect(b.content[0]).toMatchObject({ text: 'B' })
  })

  it('disconnect() shuts down every server', async () => {
    await ts.connect()
    await ts.disconnect()
    const s = ts.status()
    expect(s.every((r) => r.status === 'idle')).toBe(true)
  })
})

// =============================================================================
// status() — observability surface.
// =============================================================================

describe('McpToolset — status reporting', () => {
  it('status() omits lastError when a server has never errored', async () => {
    const ts = new McpToolset({ servers: [makeFakeServerConfig('clean')] })
    try {
      await ts.connect()
      const r = ts.status()[0]!
      expect(r.status).toBe('live')
      expect(r.lastError).toBeUndefined()
    } finally {
      await ts.disconnect()
    }
  })

  it('status() includes lastError when a server failed to spawn', async () => {
    const ts = new McpToolset({
      servers: [{ name: 'broken', command: '/no/such/path' }],
    })
    try {
      await ts.connect()
      const r = ts.status()[0]!
      expect(r.status).toBe('dead')
      expect(r.lastError).toBeTruthy()
    } finally {
      await ts.disconnect()
    }
  })
})

// =============================================================================
// `'server-stderr'` event — diagnostic channel for spawned MCP servers.
//
// We exercise three paths through the line buffer:
//   1. Single-line banner emitted at startup (--stderr-banner flag).
//   2. Multi-line + mid-line chunk split (--stderr-multiline flag).
//   3. On-demand via the echo tool's `stderr:…` shortcut, so the test
//      controls timing and asserts ordering relative to a tool call.
// =============================================================================

describe('McpToolset — server-stderr events', () => {
  it('emits one event per line of startup stderr', async () => {
    const events: Array<{ serverName: string; line: string }> = []
    const ts = new McpToolset({
      servers: [
        {
          name: 'noisy',
          command: process.execPath,
          args: [FAKE_SERVER, '--stderr-banner=hello-from-stderr'],
        },
      ],
    })
    ts.on('server-stderr', (e) => events.push(e))
    try {
      await ts.connect()
      // Give the OS a moment to flush the child's startup stderr.
      // The MCP handshake already round-tripped before connect()
      // resolved, so anything printed pre-handshake should already
      // be in the pipe; this 50ms is to drain it to our 'data' handler.
      await new Promise((r) => setTimeout(r, 50))
    } finally {
      await ts.disconnect()
    }
    const banners = events.filter((e) => e.line === 'hello-from-stderr')
    expect(banners.length).toBeGreaterThanOrEqual(1)
    expect(banners[0]!.serverName).toBe('noisy')
  })

  it('reassembles a line split across two stderr chunks', async () => {
    const events: Array<{ serverName: string; line: string }> = []
    const ts = new McpToolset({
      servers: [
        {
          name: 'chunked',
          command: process.execPath,
          args: [FAKE_SERVER, '--stderr-multiline'],
        },
      ],
    })
    ts.on('server-stderr', (e) => events.push(e))
    try {
      await ts.connect()
      await new Promise((r) => setTimeout(r, 50))
    } finally {
      await ts.disconnect()
    }
    const lines = events.map((e) => e.line)
    expect(lines).toContain('alpha')
    // This is the crucial assertion: the line `beta-partial` arrived
    // split across two write() calls. If line-buffering breaks, the
    // listener will see two distinct (truncated) lines instead.
    expect(lines).toContain('beta-partial')
    expect(lines).toContain('gamma')
  })

  it('emits events triggered by tool calls (stderr after handshake)', async () => {
    const events: Array<{ serverName: string; line: string }> = []
    const ts = new McpToolset({ servers: [makeFakeServerConfig('live')] })
    ts.on('server-stderr', (e) => events.push(e))
    try {
      await ts.connect()
      const before = events.length
      const out = await ts.callTool('live__echo', { text: 'stderr:mid-session-log' })
      // Echo returns `wrote-stderr` for the stderr: prefix path.
      expect(
        (out.content[0] as { type: string; text: string }).text,
      ).toBe('wrote-stderr')
      // Drain whatever the data handler is still scheduling.
      await new Promise((r) => setTimeout(r, 50))
      const after = events.slice(before)
      const matching = after.filter((e) => e.line === 'mid-session-log')
      expect(matching.length).toBe(1)
      expect(matching[0]!.serverName).toBe('live')
    } finally {
      await ts.disconnect()
    }
  })

  it('off() removes the listener so no further events arrive', async () => {
    const events: Array<{ serverName: string; line: string }> = []
    const ts = new McpToolset({ servers: [makeFakeServerConfig('detachable')] })
    const handler = (e: { serverName: string; line: string }) => events.push(e)
    ts.on('server-stderr', handler)
    try {
      await ts.connect()
      await ts.callTool('detachable__echo', { text: 'stderr:first-log' })
      await new Promise((r) => setTimeout(r, 50))
      ts.off('server-stderr', handler)
      await ts.callTool('detachable__echo', { text: 'stderr:second-log' })
      await new Promise((r) => setTimeout(r, 50))
    } finally {
      await ts.disconnect()
    }
    const lines = events.map((e) => e.line)
    expect(lines).toContain('first-log')
    expect(lines).not.toContain('second-log')
  })

  it('forwards stderr lines per-server (events carry the right serverName)', async () => {
    const events: Array<{ serverName: string; line: string }> = []
    const ts = new McpToolset({
      servers: [
        {
          name: 'alpha',
          command: process.execPath,
          args: [FAKE_SERVER, '--tool-name-suffix=a', '--stderr-banner=from-alpha'],
        },
        {
          name: 'beta',
          command: process.execPath,
          args: [FAKE_SERVER, '--tool-name-suffix=b', '--stderr-banner=from-beta'],
        },
      ],
    })
    ts.on('server-stderr', (e) => events.push(e))
    try {
      await ts.connect()
      await new Promise((r) => setTimeout(r, 50))
    } finally {
      await ts.disconnect()
    }
    const alpha = events.find((e) => e.line === 'from-alpha')
    const beta = events.find((e) => e.line === 'from-beta')
    expect(alpha?.serverName).toBe('alpha')
    expect(beta?.serverName).toBe('beta')
  })
})

// =============================================================================
// Transport union (R4) — http / sse remote configs alongside stdio.
//
// We can't spin a real remote MCP server in-process, so these tests cover
// the routing + graceful-degradation guarantees that DON'T need one: a
// malformed remote config marks just that server dead (bad_config), and a
// remote server failing never takes the local stdio servers down with it.
// =============================================================================

describe('McpToolset — transport union (R4)', () => {
  it('an explicit transport:"stdio" config spawns + lists tools like the default', async () => {
    const ts = new McpToolset({
      servers: [{ name: 'fs', transport: 'stdio', command: process.execPath, args: [FAKE_SERVER] }],
    })
    try {
      await ts.connect()
      expect(ts.status()[0]?.status).toBe('live')
      const tools = await ts.listTools()
      expect(tools.length).toBeGreaterThan(0)
      expect(tools.every((t) => t.serverName === 'fs')).toBe(true)
    } finally {
      await ts.disconnect()
    }
  })

  it('an http server with an unparseable url is marked dead (bad_config), not thrown', async () => {
    const ts = new McpToolset({
      servers: [{ name: 'remote', transport: 'http', url: 'not a url' }],
    })
    try {
      // connect() resolves — one server's bad config never rejects the
      // whole toolset (same contract as a spawn ENOENT).
      await ts.connect()
      const r = ts.status()[0]!
      expect(r.status).toBe('dead')
      expect(r.lastError).toMatch(/invalid url/)
      await expect(ts.callTool('remote__anything', {})).rejects.toMatchObject({
        kind: 'server_crashed',
        serverName: 'remote',
      })
    } finally {
      await ts.disconnect()
    }
  })

  it('an sse server with an empty url is marked dead (bad_config)', async () => {
    const ts = new McpToolset({
      servers: [{ name: 'legacy', transport: 'sse', url: '' }],
    })
    try {
      await ts.connect()
      const r = ts.status()[0]!
      expect(r.status).toBe('dead')
      expect(r.lastError).toMatch(/no url/)
    } finally {
      await ts.disconnect()
    }
  })

  it('a dead remote server does not take down a live stdio server', async () => {
    const mixed = new McpToolset({
      servers: [
        makeFakeServerConfig('local'),
        { name: 'remote', transport: 'http', url: 'http://[bad' },
      ],
    })
    try {
      await mixed.connect()
      const report = mixed.status()
      expect(report.find((r) => r.name === 'local')?.status).toBe('live')
      expect(report.find((r) => r.name === 'remote')?.status).toBe('dead')
      // listTools degrades gracefully to just the live server's tools.
      const tools = await mixed.listTools()
      expect(tools.length).toBeGreaterThan(0)
      expect(tools.every((t) => t.serverName === 'local')).toBe(true)
    } finally {
      await mixed.disconnect()
    }
  })
})

// =============================================================================
// Runtime add/remove (R5) — mutate a toolset's server set after construction,
// the seam that makes "install an integration" a live action.
// =============================================================================

describe('McpToolset — runtime addServer / removeServer (R5)', () => {
  it('addServer before connect() joins the set + comes up on connect()', async () => {
    const ts = new McpToolset({ servers: [makeFakeServerConfig('a')] })
    await ts.addServer(makeFakeServerConfig('b'))
    expect(ts.serverNames()).toEqual(['a', 'b'])
    try {
      await ts.connect()
      expect(ts.status().every((r) => r.status === 'live')).toBe(true)
    } finally {
      await ts.disconnect()
    }
  })

  it('addServer after connect() starts the child immediately + its tools appear', async () => {
    const ts = new McpToolset({ servers: [makeFakeServerConfig('a')] })
    try {
      await ts.connect()
      expect((await ts.listTools()).every((t) => t.serverName === 'a')).toBe(true)

      await ts.addServer(makeFakeServerConfig('b'))
      expect(ts.status().find((r) => r.name === 'b')?.status).toBe('live')

      // The new server's tools show up on the next listTools().
      const tools = await ts.listTools()
      expect(tools.some((t) => t.serverName === 'b')).toBe(true)
      // And it's callable.
      const res = await ts.callTool('b__echo', { text: 'hi' })
      expect(res.isError).toBeFalsy()
    } finally {
      await ts.disconnect()
    }
    // This is the only case that spawns TWO real child servers in one test
    // (connect()'s child + addServer()'s child, each with its own stdio
    // handshake). On a cold Windows runner each node spawn + handshake is
    // ~3s (sibling single-spawn cases already clock ~2.9s), so two of them
    // overrun vitest's 5s default. Give this one a generous budget — it's
    // environmental spawn latency, not a hang.
  }, 20_000)

  it('addServer rejects a duplicate name', async () => {
    const ts = new McpToolset({ servers: [makeFakeServerConfig('a')] })
    await expect(ts.addServer(makeFakeServerConfig('a'))).rejects.toMatchObject({
      kind: 'duplicate_server',
      serverName: 'a',
    })
  })

  it('addServer rejects a malformed name', async () => {
    const ts = new McpToolset({ servers: [makeFakeServerConfig('a')] })
    await expect(
      ts.addServer({ name: '1bad', command: 'x' }),
    ).rejects.toMatchObject({ kind: 'bad_tool_name' })
  })

  it('removeServer stops the child + drops it from the set', async () => {
    const ts = new McpToolset({
      servers: [makeFakeServerConfig('a'), makeFakeServerConfig('b')],
    })
    try {
      await ts.connect()
      await ts.removeServer('b')
      expect(ts.serverNames()).toEqual(['a'])
      // The remaining server still works.
      expect((await ts.listTools()).every((t) => t.serverName === 'a')).toBe(true)
      // Calling the removed server now raises unknown_tool.
      await expect(ts.callTool('b__echo', {})).rejects.toMatchObject({
        kind: 'unknown_tool',
      })
    } finally {
      await ts.disconnect()
    }
  })

  it('removeServer is idempotent — removing an absent name is a no-op', async () => {
    const ts = new McpToolset({ servers: [makeFakeServerConfig('a')] })
    try {
      await ts.connect()
      await expect(ts.removeServer('ghost')).resolves.toBeUndefined()
      expect(ts.serverNames()).toEqual(['a'])
    } finally {
      await ts.disconnect()
    }
  })

  it('addServer of a dead remote does not disturb the live servers', async () => {
    const ts = new McpToolset({ servers: [makeFakeServerConfig('a')] })
    try {
      await ts.connect()
      await ts.addServer({ name: 'remote', transport: 'http', url: 'not a url' })
      expect(ts.status().find((r) => r.name === 'a')?.status).toBe('live')
      expect(ts.status().find((r) => r.name === 'remote')?.status).toBe('dead')
    } finally {
      await ts.disconnect()
    }
  })
})
