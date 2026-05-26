/**
 * Phase 6 #12 — FixedWindowLimiter unit tests.
 *
 * The limiter lives inline in peer-registry.ts (no external dep on
 * @aipehub/web's RateLimiter — that would create a dep cycle), so we
 * test it directly here. PeerRegistry wires it via the
 * onConnectionAttempt hook on acceptHubLinks; the gate is exercised
 * in transport-ws's hub-link-rate-limit.test.ts.
 */

import { describe, expect, it } from 'vitest'

import { FixedWindowLimiter } from '../src/peer-registry.js'

describe('FixedWindowLimiter (Phase 6 #12)', () => {
  it('allows up to max attempts per window then rejects', () => {
    const lim = new FixedWindowLimiter(3, 60_000)
    const t = 1_000_000
    expect(lim.attempt('a', t)).toBe(true)
    expect(lim.attempt('a', t + 1)).toBe(true)
    expect(lim.attempt('a', t + 2)).toBe(true)
    expect(lim.attempt('a', t + 3)).toBe(false) // 4th in window
    expect(lim.attempt('a', t + 4)).toBe(false)
  })

  it('per-key isolation: different IPs have independent budgets', () => {
    const lim = new FixedWindowLimiter(2, 60_000)
    const t = 2_000_000
    expect(lim.attempt('192.168.1.1', t)).toBe(true)
    expect(lim.attempt('192.168.1.1', t + 1)).toBe(true)
    expect(lim.attempt('192.168.1.1', t + 2)).toBe(false)
    // Different IP — fresh budget.
    expect(lim.attempt('192.168.1.2', t + 3)).toBe(true)
    expect(lim.attempt('192.168.1.2', t + 4)).toBe(true)
    expect(lim.attempt('192.168.1.2', t + 5)).toBe(false)
  })

  it('window rolls over: attempts past window reset the bucket', () => {
    const lim = new FixedWindowLimiter(2, 1_000) // 1s window
    const t = 3_000_000
    expect(lim.attempt('x', t)).toBe(true)
    expect(lim.attempt('x', t + 500)).toBe(true)
    expect(lim.attempt('x', t + 800)).toBe(false) // over within window
    // Roll past windowMs — bucket resets.
    expect(lim.attempt('x', t + 1_500)).toBe(true)
    expect(lim.attempt('x', t + 1_600)).toBe(true)
    expect(lim.attempt('x', t + 1_700)).toBe(false)
  })

  it('max=0 disables the limiter (every attempt allowed)', () => {
    const lim = new FixedWindowLimiter(0, 60_000)
    for (let i = 0; i < 100; i++) {
      expect(lim.attempt('flood', 1 + i)).toBe(true)
    }
  })

  it('windowMs=0 disables the limiter (every attempt allowed)', () => {
    const lim = new FixedWindowLimiter(5, 0)
    for (let i = 0; i < 100; i++) {
      expect(lim.attempt('flood', 1 + i)).toBe(true)
    }
  })

  it('current() returns the current bucket snapshot', () => {
    const lim = new FixedWindowLimiter(10, 60_000)
    expect(lim.current('absent')).toBeUndefined()
    lim.attempt('here', 100)
    lim.attempt('here', 101)
    const snap = lim.current('here')
    expect(snap?.hits).toBe(2)
    expect(snap?.windowStart).toBe(100)
  })

  it('handles bursts within a single window correctly', () => {
    // Defense: a tight loop of attempts shouldn't accidentally let
    // some through past max.
    const lim = new FixedWindowLimiter(5, 60_000)
    const allowed = Array.from({ length: 20 }, (_, i) =>
      lim.attempt('burst', 4_000_000 + i),
    )
    expect(allowed.slice(0, 5).every((v) => v === true)).toBe(true)
    expect(allowed.slice(5).every((v) => v === false)).toBe(true)
  })
})
