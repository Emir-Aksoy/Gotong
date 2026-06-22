/**
 * ease-of-use ⑥-M2 — friendly boot-failure hints.
 *
 * `friendlyBootError` is a PURE function, so the whole behaviour is pinned
 * hermetically here (the top-level boot catch in main.ts is a 3-line glue
 * around it). Covers: EADDRINUSE on the web port → names AIPE_WEB_PORT, on the
 * ws port → names AIPE_WS_PORT, custom ports from the env, the unknown/unmatched
 * fallback that names both, and the null pass-through for any other error (so
 * the caller keeps its default `log.fatal` path).
 */

import { describe, expect, it } from 'vitest'

import { bootPortsFromEnv, friendlyBootError } from '../src/boot-error.js'

/** A realistic Node listen-time EADDRINUSE (optionally carrying the colliding port). */
function eaddrinuse(port?: number): NodeJS.ErrnoException {
  const e = new Error('listen EADDRINUSE: address already in use') as NodeJS.ErrnoException & {
    port?: number
  }
  e.code = 'EADDRINUSE'
  e.syscall = 'listen'
  if (port !== undefined) e.port = port
  return e
}

describe('bootPortsFromEnv', () => {
  it('defaults to 3000 / 4000', () => {
    expect(bootPortsFromEnv({})).toEqual({ webPort: 3000, wsPort: 4000 })
  })

  it('reads AIPE_WEB_PORT / AIPE_WS_PORT', () => {
    expect(bootPortsFromEnv({ AIPE_WEB_PORT: '8080', AIPE_WS_PORT: '9090' })).toEqual({
      webPort: 8080,
      wsPort: 9090,
    })
  })

  it('falls back on a garbage / non-positive value', () => {
    expect(bootPortsFromEnv({ AIPE_WEB_PORT: 'nope', AIPE_WS_PORT: '0' })).toEqual({
      webPort: 3000,
      wsPort: 4000,
    })
  })
})

describe('friendlyBootError', () => {
  it('returns null for anything that is not EADDRINUSE (caller keeps default path)', () => {
    expect(friendlyBootError(new Error('boom'))).toBeNull()
    const eacces = new Error('x') as NodeJS.ErrnoException
    eacces.code = 'EACCES'
    expect(friendlyBootError(eacces)).toBeNull()
    expect(friendlyBootError(null)).toBeNull()
    expect(friendlyBootError(undefined)).toBeNull()
  })

  it('names AIPE_WEB_PORT (only) when the web port collides', () => {
    const msg = friendlyBootError(eaddrinuse(3000), {})!
    expect(msg).toContain('3000')
    expect(msg).toContain('admin UI / API')
    expect(msg).toContain('AIPE_WEB_PORT')
    expect(msg).not.toContain('AIPE_WS_PORT') // don't muddy a web collision with the ws var
    expect(msg).toContain('aipehub doctor')
  })

  it('names AIPE_WS_PORT (only) when the ws port collides', () => {
    const msg = friendlyBootError(eaddrinuse(4000), {})!
    expect(msg).toContain('4000')
    expect(msg).toContain('agent WebSocket')
    expect(msg).toContain('AIPE_WS_PORT')
    expect(msg).not.toContain('AIPE_WEB_PORT')
  })

  it('honours custom ports from the env when matching the colliding port', () => {
    const env = { AIPE_WEB_PORT: '8080', AIPE_WS_PORT: '9090' }
    expect(friendlyBootError(eaddrinuse(8080), env)).toContain('AIPE_WEB_PORT')
    expect(friendlyBootError(eaddrinuse(9090), env)).toContain('AIPE_WS_PORT')
  })

  it('names BOTH ports when the colliding port is unknown or matches neither', () => {
    const noPort = friendlyBootError(eaddrinuse(), {})!
    expect(noPort).toContain('AIPE_WEB_PORT')
    expect(noPort).toContain('AIPE_WS_PORT')

    const other = friendlyBootError(eaddrinuse(5555), {})!
    expect(other).toContain('5555')
    expect(other).toContain('AIPE_WEB_PORT')
    expect(other).toContain('AIPE_WS_PORT')
  })

  it('always opens with the ✖ banner and points at aipehub doctor', () => {
    for (const m of [friendlyBootError(eaddrinuse(3000), {}), friendlyBootError(eaddrinuse(), {})]) {
      expect(m).toContain('✖ AipeHub could not start')
      expect(m).toContain('Run `aipehub doctor`')
    }
  })
})
