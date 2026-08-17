/**
 * HANDS-M3b — one-time `/setkey` links on disk.
 *
 * What is load-bearing here, and therefore what these tests refuse to let rot:
 *
 *   1. **The token is never written down.** The filename is `sha256(token)`, so
 *      a reader of the directory learns a link exists and for whom, and cannot
 *      rebuild a working URL. Pinned by scanning every byte on disk.
 *   2. **Single use.** `consume` removes the file BEFORE reporting success, so
 *      two racing submits cannot both be told to go ahead.
 *   3. **Minting kills the member's older links** (same "new code kills the old"
 *      rule as the two pairing-code families) and leaves other members alone.
 *   4. **Expiry is enforced on both reads**, and a stale file cleans itself up.
 *   5. **`setKeyLinkBaseUrl` refuses rather than guesses** — no `host:port`
 *      fallback (a dead link in a chat window is worse than "no link here"),
 *      and no plaintext http off loopback (this token authorises a credential
 *      write, so it must not travel in the clear).
 *
 * Clock is injected everywhere, so nothing here sleeps.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SetKeyLinkStore, setKeyLinkBaseUrl, SETKEY_LINK_TTL_MS } from '../src/setkey-link-store.js'

describe('SetKeyLinkStore', () => {
  let dir: string
  let store: SetKeyLinkStore
  const T0 = 1_700_000_000_000
  const linkDir = () => join(dir, 'runtime', 'setkey-links')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-setkey-links-'))
    store = new SetKeyLinkStore(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('issue → peek names the member without spending the link', () => {
    const link = store.issue('u-alice', T0)
    expect(link.userId).toBe('u-alice')
    expect(link.expiresAt).toBe(T0 + SETKEY_LINK_TTL_MS)
    expect(store.peek(link.token, T0)).toEqual({ userId: 'u-alice', expiresAt: link.expiresAt })
    // Peeking twice is still a peek.
    expect(store.peek(link.token, T0)).not.toBeNull()
  })

  it('THE TOKEN IS NEVER WRITTEN DOWN — not in a filename, not in a body', () => {
    const link = store.issue('u-alice', T0)
    const names = readdirSync(linkDir())
    expect(names).toHaveLength(1)
    // Filename is the hash, not the token.
    expect(names[0]).not.toContain(link.token)
    expect(names[0]).toMatch(/^[0-9a-f]{64}\.json$/)
    const body = readFileSync(join(linkDir(), names[0]!), 'utf8')
    expect(body).not.toContain(link.token)
    expect(JSON.parse(body)).toEqual({ userId: 'u-alice', expiresAt: link.expiresAt, createdAt: T0 })
    // 0600 — the same posture as every other credential-adjacent file.
    expect(statSync(join(linkDir(), names[0]!)).mode & 0o777).toBe(0o600)
  })

  it('SINGLE USE — consume once wins, the second call gets nothing', () => {
    const link = store.issue('u-alice', T0)
    expect(store.consume(link.token, T0)).toEqual({ userId: 'u-alice' })
    expect(store.consume(link.token, T0)).toBeNull()
    // And a peek afterwards can't resurrect it.
    expect(store.peek(link.token, T0)).toBeNull()
    expect(readdirSync(linkDir())).toHaveLength(0)
  })

  it('minting again drops the member OWN older link, and only theirs', () => {
    const first = store.issue('u-alice', T0)
    const bob = store.issue('u-bob', T0)
    const second = store.issue('u-alice', T0 + 1000)

    expect(store.peek(first.token, T0 + 1000)).toBeNull() // walked-away-from link dies
    expect(store.peek(second.token, T0 + 1000)).not.toBeNull()
    expect(store.peek(bob.token, T0 + 1000)).toEqual({ userId: 'u-bob', expiresAt: bob.expiresAt })
  })

  it('expiry is enforced on BOTH reads, and the stale file cleans itself up', () => {
    const link = store.issue('u-alice', T0)
    const after = T0 + SETKEY_LINK_TTL_MS + 1
    expect(store.peek(link.token, after)).toBeNull()
    expect(readdirSync(linkDir())).toHaveLength(0) // peek swept it

    const other = store.issue('u-carol', T0)
    expect(store.consume(other.token, after)).toBeNull()
    expect(readdirSync(linkDir())).toHaveLength(0)
  })

  it('rubbish tokens are refused before they ever touch a path', () => {
    store.issue('u-alice', T0)
    for (const bad of [
      undefined,
      null,
      42,
      { token: 'x' },
      '',
      'short',
      '../../../../etc/passwd',
      'a'.repeat(129),
      'has spaces in it here',
      'has/slash/in/it/at/all',
    ]) {
      expect(store.peek(bad as unknown, T0)).toBeNull()
      expect(store.consume(bad as unknown, T0)).toBeNull()
    }
    // …and none of that disturbed the real link.
    expect(readdirSync(linkDir())).toHaveLength(1)
  })

  it('a corrupt record reads as "no link" and is swept, never as a usable one', () => {
    store.issue('u-alice', T0)
    const name = readdirSync(linkDir())[0]!
    writeFileSync(join(linkDir(), name), '{ this is not json', 'utf8')
    store.sweep(T0)
    expect(readdirSync(linkDir())).toHaveLength(0)
  })

  it('a missing directory is not an error — nothing minted yet means no links', () => {
    expect(store.peek('a'.repeat(32), T0)).toBeNull()
    expect(store.consume('a'.repeat(32), T0)).toBeNull()
    store.sweep(T0) // must not throw
  })
})

describe('setKeyLinkBaseUrl — refuses rather than guesses', () => {
  it('accepts https and trims the trailing slash', () => {
    expect(setKeyLinkBaseUrl('https://hub.example')).toBe('https://hub.example')
    expect(setKeyLinkBaseUrl('https://hub.example/')).toBe('https://hub.example')
    expect(setKeyLinkBaseUrl('  https://hub.example/gotong/  ')).toBe('https://hub.example/gotong')
  })

  it('absent / unparseable → null (no host:port fallback — a dead link is worse)', () => {
    expect(setKeyLinkBaseUrl(undefined)).toBeNull()
    expect(setKeyLinkBaseUrl(null)).toBeNull()
    expect(setKeyLinkBaseUrl('')).toBeNull()
    expect(setKeyLinkBaseUrl('   ')).toBeNull()
    expect(setKeyLinkBaseUrl('not a url')).toBeNull()
    expect(setKeyLinkBaseUrl('ftp://hub.example')).toBeNull()
  })

  it('plaintext http only on loopback — this token authorises a credential write', () => {
    expect(setKeyLinkBaseUrl('http://hub.example')).toBeNull()
    expect(setKeyLinkBaseUrl('http://192.168.1.20:3000')).toBeNull()
    // Deliberately set to loopback = a statement, not a guess.
    expect(setKeyLinkBaseUrl('http://localhost:3000')).toBe('http://localhost:3000')
    expect(setKeyLinkBaseUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(setKeyLinkBaseUrl('http://dev.localhost:3000')).toBe('http://dev.localhost:3000')
    expect(setKeyLinkBaseUrl('http://[::1]:3000')).toBe('http://[::1]:3000')
  })
})
