/**
 * Cross-version compatibility safety net (protocol v1.2).
 *
 * Newer features that depend on the server enforcing them — currently just
 * `ServiceUseDecl.methods` per-decl ACL narrowing — silently degrade when
 * the server is older (v1.0 / v1.1): the field is unknown, decoded but not
 * acted on, so the client thinks it has read-only access while the server
 * happily accepts every method. The SDK should warn the user when it spots
 * this scenario on WELCOME.
 *
 * We mock a raw ws server that returns a v1.1 WELCOME so we can verify the
 * warning fires (and conversely, that a same-or-newer server does NOT
 * produce a warning).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket as WsType } from 'ws'
import type { AddressInfo } from 'node:net'

import { AgentParticipant, type Task } from '@gotong/core'

import { connect, type Session } from '../src/index.js'

class NoopAgent extends AgentParticipant {
  constructor(id: string) {
    super({ id, capabilities: [] })
  }
  protected async handleTask(_task: Task): Promise<unknown> {
    return null
  }
}

/**
 * Stand up a one-shot mock server that returns the given WELCOME shape on
 * the first HELLO and then idles. Returns the connection URL and a stop fn.
 */
async function spawnMockServer(welcome: {
  protocolVersion: string
  heartbeatIntervalMs?: number
}): Promise<{ url: string; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0 })
  // Track every connection — a single-slot `let sock` lost references on
  // concurrent connections and leaked sockets between tests.
  const socks: WsType[] = []
  wss.on('connection', (ws) => {
    socks.push(ws)
    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(String(data)) as { type: string }
        if (frame.type === 'HELLO') {
          ws.send(
            JSON.stringify({
              type: 'WELCOME',
              sessionId: 's1',
              protocolVersion: welcome.protocolVersion,
              serverTime: Date.now(),
              heartbeatIntervalMs: welcome.heartbeatIntervalMs ?? 30_000,
            }),
          )
        }
      } catch {
        /* ignore malformed */
      }
    })
  })
  await new Promise<void>((resolve) => {
    wss.once('listening', () => resolve())
  })
  const port = (wss.address() as AddressInfo).port
  return {
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
      for (const s of socks) {
        try {
          s.close()
        } catch {
          /* ignore — already closed */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

describe('sdk-node — protocol version mismatch warning', () => {
  let session: Session | undefined
  let server: { url: string; close: () => Promise<void> } | undefined
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    if (session && session.state !== 'closed') {
      await session.close()
    }
    session = undefined
    if (server) await server.close()
    server = undefined
    warnSpy.mockRestore()
  })

  it('warns when server is v1.1 and client uses per-method narrowing', async () => {
    server = await spawnMockServer({ protocolVersion: '1.1' })
    session = await connect({
      url: server.url,
      agents: [new NoopAgent('a')],
      services: [
        {
          type: 'memory',
          impl: 'file',
          owner: { kind: 'agent', id: 'self' },
          // The narrowing the v1.1 server can't enforce.
          methods: ['recall'],
        },
      ],
      autoReconnect: false,
    })
    expect(session.state).toBe('ready')
    // At least one console.warn went out with the version warning text.
    const calls = warnSpy.mock.calls
      .map((args) => args.map((a) => String(a)).join(' '))
      .join('\n')
    expect(calls).toMatch(/protocol version 1\.1/)
    expect(calls).toMatch(/per-method ACL/i)
  })

  it('does NOT warn when client did not narrow, even on older server', async () => {
    server = await spawnMockServer({ protocolVersion: '1.1' })
    session = await connect({
      url: server.url,
      agents: [new NoopAgent('a')],
      services: [
        // No `methods` — narrowing is not in play, so the safety story is
        // unchanged from v1.1 and there is nothing to warn about.
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      autoReconnect: false,
    })
    expect(session.state).toBe('ready')
    const warnedAboutVersion = warnSpy.mock.calls.some((args) =>
      args.some((a) => String(a).includes('protocol version')),
    )
    expect(warnedAboutVersion).toBe(false)
  })

  it('does NOT warn when server is same/newer version', async () => {
    // The client is 1.2; the server returning 1.2 should be silent.
    server = await spawnMockServer({ protocolVersion: '1.2' })
    session = await connect({
      url: server.url,
      agents: [new NoopAgent('a')],
      services: [
        {
          type: 'memory',
          impl: 'file',
          owner: { kind: 'agent', id: 'self' },
          methods: ['recall'],
        },
      ],
      autoReconnect: false,
    })
    const warnedAboutVersion = warnSpy.mock.calls.some((args) =>
      args.some((a) => String(a).includes('protocol version')),
    )
    expect(warnedAboutVersion).toBe(false)
  })

  it('warns at most once per session (sticky)', async () => {
    server = await spawnMockServer({ protocolVersion: '1.1' })
    session = await connect({
      url: server.url,
      agents: [new NoopAgent('a')],
      services: [
        {
          type: 'memory',
          impl: 'file',
          owner: { kind: 'agent', id: 'self' },
          methods: ['recall'],
        },
      ],
      autoReconnect: false,
    })
    // No way to trigger a second WELCOME without forcing a reconnect, but
    // we can at least assert the warning fired exactly once at the version
    // boundary (no spam on the same connection).
    const versionWarnings = warnSpy.mock.calls.filter((args) =>
      args.some((a) => String(a).includes('protocol version')),
    )
    expect(versionWarnings.length).toBe(1)
  })

  it('recognises pre-release version tags like `"1.2-beta"`', async () => {
    // Older v1.2.2 bug: `Number('2-beta')` = NaN → fell back to 0, so a
    // `'1.2-beta'` server was treated as v1.0 and produced a spurious warning
    // for v1.2 clients. The parseVersion fix strips the suffix so 1.2-beta
    // counts as v1.2 — no warning even with narrowing in play.
    server = await spawnMockServer({ protocolVersion: '1.2-beta' })
    session = await connect({
      url: server.url,
      agents: [new NoopAgent('a')],
      services: [
        {
          type: 'memory',
          impl: 'file',
          owner: { kind: 'agent', id: 'self' },
          methods: ['recall'],
        },
      ],
      autoReconnect: false,
    })
    const warnedAboutVersion = warnSpy.mock.calls.some((args) =>
      args.some((a) => String(a).includes('protocol version')),
    )
    expect(warnedAboutVersion).toBe(false)
  })

  it('silent-return path does NOT flip the sticky flag (v1.2.3 regression guard)', async () => {
    // The v1.2.2 implementation set `versionMismatchWarned = true` right
    // after calling check(), regardless of whether check() actually warned.
    // The v1.2.3 fix moved the flag flip inside check() onto the path that
    // truly warns — so silent-return paths leave the flag at `false`.
    //
    // No realistic scenario lets a single session's silent-return turn into
    // a future warn (services/url/PROTOCOL_VERSION are all immutable per
    // SessionImpl), but the invariant is still worth pinning so future
    // refactors don't quietly regress it. White-box: peek at the private
    // field via cast.
    server = await spawnMockServer({ protocolVersion: '1.1' })
    session = await connect({
      url: server.url,
      agents: [new NoopAgent('a')],
      // No `methods` → check() takes the `usesNarrowing === false` early
      // return; warning is not emitted.
      services: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      autoReconnect: false,
    })
    expect(session.state).toBe('ready')
    // No warning fired …
    const versionWarnings = warnSpy.mock.calls.filter((args) =>
      args.some((a) => String(a).includes('protocol version')),
    )
    expect(versionWarnings.length).toBe(0)
    // …and the sticky flag stayed at the initial `false`. This is the
    // bit that v1.2.3 fixed.
    expect(
      (session as unknown as { versionMismatchWarned: boolean })
        .versionMismatchWarned,
    ).toBe(false)
  })

  it('handles dotted patch versions like `"1.2.3"`', async () => {
    server = await spawnMockServer({ protocolVersion: '1.2.3' })
    session = await connect({
      url: server.url,
      agents: [new NoopAgent('a')],
      services: [
        {
          type: 'memory',
          impl: 'file',
          owner: { kind: 'agent', id: 'self' },
          methods: ['recall'],
        },
      ],
      autoReconnect: false,
    })
    const warnedAboutVersion = warnSpy.mock.calls.some((args) =>
      args.some((a) => String(a).includes('protocol version')),
    )
    // 1.2.3 ≥ 1.2 — should be silent.
    expect(warnedAboutVersion).toBe(false)
  })

  // ---------------------------------------------------------------------
  // parseVersion boundary fuzz — Audit agent flagged the parser as
  // "accidentally safe" for several malformed protocolVersion strings.
  // Pin the behaviour: the SDK must neither crash nor emit a spurious
  // warning. We do not assert WHETHER a warning fires for malformed
  // inputs (that's an implementation detail) — only that connect()
  // returns ready and the process stays up.
  // ---------------------------------------------------------------------

  it('does not crash on malformed protocolVersion: empty string', async () => {
    server = await spawnMockServer({ protocolVersion: '' })
    session = await connect({
      url: server.url,
      agents: [new NoopAgent('a')],
      services: [
        {
          type: 'memory',
          impl: 'file',
          owner: { kind: 'agent', id: 'self' },
          methods: ['recall'],
        },
      ],
      autoReconnect: false,
    })
    expect(session.state).toBe('ready')
    // '' parses to [0, 0] — major mismatch vs client v1 → silent.
  })

  it('does not crash on malformed protocolVersion: negative-prefixed', async () => {
    // '-1.2' → regex /^\d+/ misses the leading '-', returns null → 0.
    // Falls into major-mismatch silent return.
    server = await spawnMockServer({ protocolVersion: '-1.2' })
    session = await connect({
      url: server.url,
      agents: [new NoopAgent('a')],
      services: [
        {
          type: 'memory',
          impl: 'file',
          owner: { kind: 'agent', id: 'self' },
          methods: ['recall'],
        },
      ],
      autoReconnect: false,
    })
    expect(session.state).toBe('ready')
  })

  it('does not crash on malformed protocolVersion: whitespace-padded', async () => {
    // '  1.2  ' → split('.') → ['  1', '2  '] → '/^\\d+/.exec("  1")'
    // returns null (leading space) → 0. Same silent-return path.
    server = await spawnMockServer({ protocolVersion: '  1.2  ' })
    session = await connect({
      url: server.url,
      agents: [new NoopAgent('a')],
      services: [
        {
          type: 'memory',
          impl: 'file',
          owner: { kind: 'agent', id: 'self' },
          methods: ['recall'],
        },
      ],
      autoReconnect: false,
    })
    expect(session.state).toBe('ready')
  })

  it('does not crash on multi-component protocolVersion: "1.2.3.4.5"', async () => {
    // parseVersion only reads parts[0] / parts[1]; later components are
    // discarded harmlessly.
    server = await spawnMockServer({ protocolVersion: '1.2.3.4.5' })
    session = await connect({
      url: server.url,
      agents: [new NoopAgent('a')],
      services: [
        {
          type: 'memory',
          impl: 'file',
          owner: { kind: 'agent', id: 'self' },
          methods: ['recall'],
        },
      ],
      autoReconnect: false,
    })
    expect(session.state).toBe('ready')
    // 1.2.3.4.5 ≥ 1.2 → silent.
    const warnedAboutVersion = warnSpy.mock.calls.some((args) =>
      args.some((a) => String(a).includes('protocol version')),
    )
    expect(warnedAboutVersion).toBe(false)
  })
})
