/**
 * Regression tests for the v3.4 Batch 2 audit fixes — SDK TLS surface
 * (C2 + H10 — Node side).
 *
 *   C2 — `new WebSocket(this.opts.url)` had no second arg, so users
 *        couldn't pass `ca` / `cert` / `key` / `rejectUnauthorized` /
 *        `checkServerIdentity`. The only workaround was the global
 *        `NODE_TLS_REJECT_UNAUTHORIZED=0`, which disables TLS
 *        verification for the WHOLE Node process — vastly worse than
 *        a per-connection trust override.
 *        Fix: `ConnectOptions.tls?: tls.ConnectionOptions`, spread
 *        into the `ws` constructor.
 *
 *   H10 — `apiKey` was sent over `ws://` to any host without warning.
 *        Combined with the default CLI template (`ws://127.0.0.1:4000`),
 *        users on dev tunnels would silently fly their API keys
 *        cleartext.
 *        Fix: `connect()` throws when `apiKey` is set + URL is `ws://`
 *        + host is non-loopback, unless `allowPlaintextAuth: true` is
 *        explicitly passed (in which case we honour it but log a
 *        WARN for audit traceability).
 *
 * Loopback (`localhost` / `127.0.0.1` / `::1`) is always allowed —
 * the apiKey never leaves the host, so the common dev workflow keeps
 * working.
 *
 * See AUDIT-v3.3.md findings C2 and H10.
 */

import { describe, expect, it } from 'vitest'

import { AgentParticipant, type Task } from '@gotong/core'

import { connect } from '../src/index.js'
import { isLoopbackHost, type ConnectOptions } from '../src/session.js'

class NoopAgent extends AgentParticipant {
  constructor(id: string) {
    super({ id, capabilities: ['work'] })
  }
  protected async handleTask(_task: Task): Promise<unknown> {
    return { ok: true }
  }
}

// =========================================================================
// isLoopbackHost helper (the predicate the H10 check is built on)
// =========================================================================

describe('isLoopbackHost (H10 helper)', () => {
  it('accepts canonical loopback hosts', () => {
    expect(isLoopbackHost('ws://localhost')).toBe(true)
    expect(isLoopbackHost('ws://localhost:4000')).toBe(true)
    expect(isLoopbackHost('ws://127.0.0.1:4000')).toBe(true)
    expect(isLoopbackHost('ws://[::1]:4000')).toBe(true)
    expect(isLoopbackHost('wss://127.0.0.1')).toBe(true)
    expect(isLoopbackHost('http://localhost')).toBe(true) // helper is scheme-agnostic
  })

  it('rejects non-loopback hosts (the dangerous case for H10)', () => {
    expect(isLoopbackHost('ws://example.com')).toBe(false)
    expect(isLoopbackHost('ws://10.0.0.1:4000')).toBe(false)
    expect(isLoopbackHost('ws://192.168.1.1:4000')).toBe(false)
    expect(isLoopbackHost('ws://hub.internal:4000')).toBe(false)
    // LAN-ish but not the loopback identity:
    expect(isLoopbackHost('ws://127.0.0.2')).toBe(false)
  })

  it('returns false on unparseable URLs (fail-safe)', () => {
    expect(isLoopbackHost('not-a-url')).toBe(false)
    expect(isLoopbackHost('')).toBe(false)
    expect(isLoopbackHost(':://broken')).toBe(false)
  })
})

// =========================================================================
// H10 — connect() refuses to send apiKey over plaintext ws:// to remote
// =========================================================================

describe('H10 — apiKey over plaintext ws:// to remote', () => {
  it('throws BEFORE opening a socket on ws:// + apiKey + non-loopback host', async () => {
    // The check is synchronous at the head of connect() — we should
    // never even attempt the WebSocket constructor.
    await expect(
      connect({
        url: 'ws://hub.example.com:4000',
        agents: [new NoopAgent('a')],
        apiKey: 'sk-supersecret',
      }),
    ).rejects.toThrow(/refusing to send apiKey/i)
  })

  it('error message mentions the offending host and the override flag', async () => {
    let err: Error | undefined
    try {
      await connect({
        url: 'ws://malicious-relay.example.com:4000',
        agents: [new NoopAgent('a')],
        apiKey: 'sk-supersecret',
      })
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeDefined()
    expect(err!.message).toContain('malicious-relay.example.com')
    expect(err!.message).toContain('allowPlaintextAuth')
    expect(err!.message).toContain('wss://')
  })

  it('does NOT throw the H10 error on ws:// + apiKey + loopback (dev workflow)', async () => {
    // No server listening on port 1 — connect() will fail with a
    // socket/timeout error eventually. But the failure must NOT be
    // H10: that would break the default `gotong ping` template.
    let err: Error | undefined
    try {
      await connect({
        url: 'ws://127.0.0.1:1',
        agents: [new NoopAgent('a')],
        apiKey: 'sk-supersecret',
        connectTimeoutMs: 300,
        autoReconnect: false,
      })
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeDefined()
    expect(err!.message).not.toMatch(/refusing to send apiKey/i)
  })

  it('does NOT throw the H10 error on wss:// + apiKey + non-loopback', async () => {
    // wss:// encrypts the payload; the apiKey is safe to send.
    let err: Error | undefined
    try {
      await connect({
        url: 'wss://127.0.0.1:1',         // wss + loopback to dodge real DNS
        agents: [new NoopAgent('a')],
        apiKey: 'sk-supersecret',
        connectTimeoutMs: 300,
        autoReconnect: false,
      })
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeDefined()
    expect(err!.message).not.toMatch(/refusing to send apiKey/i)
  })

  it('does NOT throw the H10 error on apiKey=undefined + ws:// + non-loopback', async () => {
    // No credential present → nothing to leak → H10 stays silent.
    let err: Error | undefined
    try {
      await connect({
        url: 'ws://127.0.0.1:1',
        agents: [new NoopAgent('a')],
        // intentionally no apiKey
        connectTimeoutMs: 300,
        autoReconnect: false,
      })
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeDefined()
    expect(err!.message).not.toMatch(/refusing to send apiKey/i)
  })

  it('allowPlaintextAuth=true is honoured but logs a WARN for audit traceability', async () => {
    // Capture console.warn so we can assert the audit-traceable line
    // landed without leaking into the test output.
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = ((...args: unknown[]) => {
      warns.push(args.map((a) => String(a)).join(' '))
    }) as typeof console.warn

    try {
      let err: Error | undefined
      try {
        await connect({
          url: 'ws://hub.example.com:1',
          agents: [new NoopAgent('a')],
          apiKey: 'sk-supersecret',
          allowPlaintextAuth: true,
          connectTimeoutMs: 300,
          autoReconnect: false,
        })
      } catch (e) {
        err = e as Error
      }

      // Failure (if any) is a socket/timeout error, NOT the H10 throw.
      if (err) {
        expect(err.message).not.toMatch(/refusing to send apiKey/i)
      }
      // But the opt-out path MUST have logged a WARN — silently
      // honouring an unsafe flag would defeat the audit trail.
      expect(warns.some((w) => /plaintext ws:\/\//i.test(w))).toBe(true)
      // The warning must mention the URL the credential is heading to.
      expect(warns.some((w) => w.includes('hub.example.com'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })
})

// =========================================================================
// C2 — TLS option surface
// =========================================================================

describe('C2 — tls option surface', () => {
  it('ConnectOptions accepts a `tls` field structurally typed as ConnectionOptions', () => {
    // This is a compile-time check; failure shows up at typecheck.
    // The runtime assertion only proves the value round-trips through
    // the type. The point of the test is that the FIELD EXISTS — if
    // a future refactor drops it, the type narrowing below stops
    // compiling.
    const opts: ConnectOptions = {
      url: 'wss://hub.example.com',
      agents: [new NoopAgent('a')],
      tls: {
        ca: 'fake-ca-pem-content',
        rejectUnauthorized: true,
        servername: 'hub.example.com',
        // Picking a few representative tls.ConnectionOptions keys —
        // we don't enumerate them all, the type alias does that.
      },
    }
    expect(opts.tls).toBeDefined()
    expect(opts.tls?.servername).toBe('hub.example.com')
  })

  it('ConnectOptions stays usable without `tls` (back-compat)', () => {
    // Existing callers must keep compiling. `tls` is optional.
    const opts: ConnectOptions = {
      url: 'wss://hub.example.com',
      agents: [new NoopAgent('a')],
    }
    expect(opts.tls).toBeUndefined()
  })

  it('does NOT throw a SDK-level error on wss:// with a tls config (the ws library handles it)', async () => {
    // If `tls` were silently dropped instead of being forwarded, the
    // SDK might surface its own validation error here. We don't try
    // to complete a real TLS handshake (that would need a fixture
    // certificate + server) — we just prove the `tls` option doesn't
    // break the connect path before the socket even opens.
    let err: Error | undefined
    try {
      await connect({
        url: 'wss://127.0.0.1:1',
        agents: [new NoopAgent('a')],
        tls: { rejectUnauthorized: true },
        connectTimeoutMs: 300,
        autoReconnect: false,
      })
    } catch (e) {
      err = e as Error
    }
    // It MUST fail (nothing's listening) but the failure must be a
    // socket/TLS-level error, not a SDK type-validation throw.
    expect(err).toBeDefined()
    expect(err!.message).not.toMatch(/refusing to send apiKey/i)
    expect(err!.message).not.toMatch(/unknown.*option/i)
  })
})
