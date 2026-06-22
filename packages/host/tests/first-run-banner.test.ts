import { describe, expect, it } from 'vitest'

import {
  firstRunSetupBanner,
  openUrl,
  parseOpenBrowserEnv,
  shouldOpenBrowser,
  type SpawnLike,
} from '../src/first-run-banner.js'

describe('parseOpenBrowserEnv', () => {
  it('maps falsy strings to never', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
      expect(parseOpenBrowserEnv(v)).toBe('never')
    }
  })
  it('maps truthy strings to always', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' On ']) {
      expect(parseOpenBrowserEnv(v)).toBe('always')
    }
  })
  it('defaults to auto for unset / unknown', () => {
    expect(parseOpenBrowserEnv(undefined)).toBe('auto')
    expect(parseOpenBrowserEnv('')).toBe('auto')
    expect(parseOpenBrowserEnv('auto')).toBe('auto')
    expect(parseOpenBrowserEnv('maybe')).toBe('auto')
  })
})

describe('shouldOpenBrowser', () => {
  it('never opens when network-exposed, regardless of mode', () => {
    for (const mode of ['auto', 'always', 'never'] as const) {
      expect(shouldOpenBrowser(mode, { loopback: false, firstRun: true })).toBe(false)
      expect(shouldOpenBrowser(mode, { loopback: false, firstRun: false })).toBe(false)
    }
  })
  it('never mode never opens on loopback either', () => {
    expect(shouldOpenBrowser('never', { loopback: true, firstRun: true })).toBe(false)
  })
  it('always mode opens on loopback for first run and restarts', () => {
    expect(shouldOpenBrowser('always', { loopback: true, firstRun: true })).toBe(true)
    expect(shouldOpenBrowser('always', { loopback: true, firstRun: false })).toBe(true)
  })
  it('auto mode opens only on first run', () => {
    expect(shouldOpenBrowser('auto', { loopback: true, firstRun: true })).toBe(true)
    expect(shouldOpenBrowser('auto', { loopback: true, firstRun: false })).toBe(false)
  })
})

describe('firstRunSetupBanner', () => {
  it('embeds the web URL and names the setup wizard bilingually', () => {
    const out = firstRunSetupBanner('http://localhost:4000')
    expect(out).toContain('http://localhost:4000')
    expect(out).toContain('设置向导')
    expect(out.toLowerCase()).toContain('setup')
  })
})

describe('openUrl', () => {
  function recordingSpawn() {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const state = { unrefs: 0 }
    const spawn: SpawnLike = (cmd, args, opts) => {
      // The detached/ignored-stdio contract matters: a foreground or
      // log-attached child would block or pollute host stdout.
      expect(opts).toEqual({ detached: true, stdio: 'ignore' })
      calls.push({ cmd, args })
      return { unref: () => { state.unrefs++ } }
    }
    return { spawn, calls, state }
  }

  it('uses `open` on macOS and unrefs the child', () => {
    const rec = recordingSpawn()
    const ok = openUrl('http://localhost:4000', { platform: 'darwin', spawn: rec.spawn })
    expect(ok).toBe(true)
    expect(rec.calls).toEqual([{ cmd: 'open', args: ['http://localhost:4000'] }])
    expect(rec.state.unrefs).toBe(1)
  })

  it('uses `cmd /c start` on Windows', () => {
    const rec = recordingSpawn()
    openUrl('http://localhost:4000', { platform: 'win32', spawn: rec.spawn })
    expect(rec.calls).toEqual([{ cmd: 'cmd', args: ['/c', 'start', '', 'http://localhost:4000'] }])
  })

  it('uses `xdg-open` on Linux', () => {
    const rec = recordingSpawn()
    openUrl('http://localhost:4000', { platform: 'linux', spawn: rec.spawn })
    expect(rec.calls).toEqual([{ cmd: 'xdg-open', args: ['http://localhost:4000'] }])
  })

  it('never throws when spawn fails — returns false and reports via onError', () => {
    let reported: unknown = null
    const boom: SpawnLike = () => {
      throw new Error('no opener on this box')
    }
    const ok = openUrl('http://localhost:4000', {
      platform: 'linux',
      spawn: boom,
      onError: (e) => { reported = e },
    })
    expect(ok).toBe(false)
    expect(reported).toBeInstanceOf(Error)
  })
})
