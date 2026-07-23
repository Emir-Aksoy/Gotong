/**
 * Perf audit B② — opt-in new-version probe.
 *
 * Pins the load-bearing contract:
 *   1. Knob unset ⇒ arm() is null — zero timers, zero network (a throwing
 *      fetch stub would fail the test if it were ever called).
 *   2. Honest tri-state: undefined before any successful probe; null when
 *      current is latest; row when newer. A failed probe KEEPS the previous
 *      answer (a release doesn't un-exist on a network blip).
 *   3. Semver triple parse/compare table (prerelease compares by triple).
 *   4. stop() freezes further probes.
 */

import { describe, expect, it, vi } from 'vitest'

import type { Logger } from '@gotong/core'

import {
  armVersionCheck,
  compareSemverTriple,
  parseSemverTriple,
  versionCheckEnabled,
} from '../src/version-check.js'

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLog,
} as unknown as Logger

const ON = { GOTONG_UPDATE_CHECK: '1' }

async function tick(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('version check (perf audit B②)', () => {
  it('semver triple: parse + compare table', () => {
    expect(parseSemverTriple('4.0.0')).toEqual([4, 0, 0])
    expect(parseSemverTriple('v4.1.2')).toEqual([4, 1, 2])
    expect(parseSemverTriple('4.1.0-rc.1')).toEqual([4, 1, 0])
    expect(parseSemverTriple('4.0')).toBeNull()
    expect(parseSemverTriple('not-a-version')).toBeNull()
    expect(parseSemverTriple('4.0.0.0')).toBeNull()

    expect(compareSemverTriple([4, 0, 1], [4, 0, 0])).toBeGreaterThan(0)
    expect(compareSemverTriple([4, 1, 0], [4, 0, 9])).toBeGreaterThan(0)
    expect(compareSemverTriple([5, 0, 0], [4, 9, 9])).toBeGreaterThan(0)
    expect(compareSemverTriple([4, 0, 0], [4, 0, 0])).toBe(0)
    expect(compareSemverTriple([3, 9, 9], [4, 0, 0])).toBeLessThan(0)
  })

  it('knob off ⇒ arm() is null and the fetch stub is never touched', () => {
    expect(versionCheckEnabled({})).toBe(false)
    expect(versionCheckEnabled({ GOTONG_UPDATE_CHECK: '0' })).toBe(false)
    expect(versionCheckEnabled(ON)).toBe(true)
    const handle = armVersionCheck({
      env: {},
      current: '4.0.0',
      log: silentLog,
      fetchLatest: () => {
        throw new Error('must not be called')
      },
    })
    expect(handle).toBeNull()
  })

  it('probes on the initial delay: newer ⇒ row + info log, equal ⇒ null', async () => {
    const info = vi.fn()
    const log = { ...silentLog, info } as unknown as Logger
    const newer = armVersionCheck({
      env: ON,
      current: '4.0.0',
      log,
      fetchLatest: async () => '4.2.0',
      initialDelayMs: 5,
      intervalMs: 60_000,
    })!
    expect(newer.latest()).toBeUndefined() // honest unknown before the first probe
    await tick()
    expect(newer.latest()).toEqual({ current: '4.0.0', latest: '4.2.0' })
    expect(info).toHaveBeenCalledWith(
      'a newer gotong release is available',
      expect.objectContaining({ current: '4.0.0', latest: '4.2.0' }),
    )
    newer.stop()

    const equal = armVersionCheck({
      env: ON,
      current: '4.0.0',
      log: silentLog,
      fetchLatest: async () => '4.0.0',
      initialDelayMs: 5,
      intervalMs: 60_000,
    })!
    await tick()
    expect(equal.latest()).toBeNull()
    equal.stop()

    // A local dev checkout AHEAD of the registry is "current", not "behind".
    const ahead = armVersionCheck({
      env: ON,
      current: '5.0.0',
      log: silentLog,
      fetchLatest: async () => '4.0.0',
      initialDelayMs: 5,
      intervalMs: 60_000,
    })!
    await tick()
    expect(ahead.latest()).toBeNull()
    ahead.stop()
  })

  it('a failed probe keeps the previous answer; a later success updates it', async () => {
    let calls = 0
    const warn = vi.fn()
    const log = { ...silentLog, warn } as unknown as Logger
    const handle = armVersionCheck({
      env: ON,
      current: '4.0.0',
      log,
      fetchLatest: async () => {
        calls++
        if (calls === 1) throw new Error('registry down')
        if (calls === 2) return '4.1.0'
        throw new Error('registry down again')
      },
      initialDelayMs: 5,
      intervalMs: 25,
    })!

    await tick(15) // after probe #1 (failed)
    expect(handle.latest()).toBeUndefined() // unknown, NOT "up to date"
    expect(warn).toHaveBeenCalledWith('version check probe failed', expect.anything())

    await vi.waitFor(() => {
      expect(handle.latest()).toEqual({ current: '4.0.0', latest: '4.1.0' }) // probe #2
    })
    await vi.waitFor(() => {
      expect(calls).toBeGreaterThanOrEqual(3) // probe #3 failed…
    })
    expect(handle.latest()).toEqual({ current: '4.0.0', latest: '4.1.0' }) // …answer kept
    handle.stop()
  })

  it('an unparseable registry answer keeps the previous state and warns', async () => {
    const warn = vi.fn()
    const log = { ...silentLog, warn } as unknown as Logger
    const handle = armVersionCheck({
      env: ON,
      current: '4.0.0',
      log,
      fetchLatest: async () => 'garbage',
      initialDelayMs: 5,
      intervalMs: 60_000,
    })!
    await tick()
    expect(handle.latest()).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      'version check: unparseable version string',
      expect.objectContaining({ latest: 'garbage' }),
    )
    handle.stop()
  })

  it('stop() freezes further probes', async () => {
    let calls = 0
    const handle = armVersionCheck({
      env: ON,
      current: '4.0.0',
      log: silentLog,
      fetchLatest: async () => {
        calls++
        return '4.0.0'
      },
      initialDelayMs: 5,
      intervalMs: 20,
    })!
    await vi.waitFor(() => {
      expect(calls).toBeGreaterThanOrEqual(2)
    })
    handle.stop()
    const after = calls
    await tick(50)
    expect(calls).toBe(after)
  })
})
