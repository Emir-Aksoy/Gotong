/**
 * `aipehub mint-peer-token` tests — exercise the pure helpers directly
 * (token format / entropy, pairing-hint wording) plus runCli smoke
 * checks for the command wiring and output discipline.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  generatePeerToken,
  renderPairingHint,
} from '../src/commands/mint-peer-token.js'
import { runCli } from '../src/main.js'

const BASE64URL = /^[A-Za-z0-9_-]+$/

describe('generatePeerToken', () => {
  it('mints a base64url token with 32 bytes of entropy by default', () => {
    const tok = generatePeerToken()
    expect(tok).toMatch(BASE64URL)
    // base64url has no padding; decode back to assert the byte length.
    expect(Buffer.from(tok, 'base64url')).toHaveLength(32)
  })

  it('honours a custom byte length', () => {
    expect(Buffer.from(generatePeerToken(16), 'base64url')).toHaveLength(16)
    expect(Buffer.from(generatePeerToken(64), 'base64url')).toHaveLength(64)
  })

  it('is non-deterministic across calls (real CSPRNG)', () => {
    const a = generatePeerToken()
    const b = generatePeerToken()
    expect(a).not.toEqual(b)
  })
})

describe('renderPairingHint', () => {
  it('explains the symmetric two-sided setup', () => {
    const hint = renderPairingHint()
    expect(hint).toContain('对称')
    expect(hint).toContain('出站')
    expect(hint).toContain('入站')
    // secret-handling warning is always present
    expect(hint).toContain('secret')
  })

  it('slots a supplied peerId / endpoint into the snippet', () => {
    const hint = renderPairingHint({ peerId: 'partner-hub', endpoint: 'wss://partner/fed' })
    expect(hint).toContain('partner-hub')
    expect(hint).toContain('wss://partner/fed')
    expect(hint).not.toContain('<peer-id>')
  })

  it('falls back to obvious placeholders when unset', () => {
    const hint = renderPairingHint()
    expect(hint).toContain('<peer-id>')
    expect(hint).toContain('<wss://their-hub/federation>')
  })
})

describe('runCli mint-peer-token', () => {
  it('prints just the token to stdout and the hint to stderr (exit 0)', async () => {
    const writes: string[] = []
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    const errs: string[] = []
    const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(' '))
    })

    expect(await runCli(['mint-peer-token'])).toBe(0)

    // Exactly one stdout write: the token + newline, nothing else.
    expect(writes).toHaveLength(1)
    const line = writes[0]!.trim()
    expect(line).toMatch(BASE64URL)
    expect(Buffer.from(line, 'base64url')).toHaveLength(32)
    // The pairing hint went to stderr, never stdout.
    expect(errs.join('\n')).toContain('对称')

    out.mockRestore()
    err.mockRestore()
  })

  it('honours --bytes', async () => {
    const writes: string[] = []
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(await runCli(['mint-peer-token', '--bytes=48'])).toBe(0)
    expect(Buffer.from(writes[0]!.trim(), 'base64url')).toHaveLength(48)

    out.mockRestore()
    err.mockRestore()
  })

  it('--help prints usage (exit 0)', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await runCli(['mint-peer-token', '--help'])).toBe(0)
    out.mockRestore()
  })

  it('rejects an out-of-range --bytes with code 2 (and emits no token)', async () => {
    const writes: string[] = []
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(await runCli(['mint-peer-token', '--bytes=8'])).toBe(2)
    // fail-closed: a bad arg must NOT leak a half-considered token.
    expect(writes).toHaveLength(0)

    out.mockRestore()
    err.mockRestore()
  })

  it('rejects an unknown option with code 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['mint-peer-token', '--wat'])).toBe(2)
    err.mockRestore()
  })

  it('rejects a stray positional with code 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['mint-peer-token', 'oops'])).toBe(2)
    err.mockRestore()
  })
})
