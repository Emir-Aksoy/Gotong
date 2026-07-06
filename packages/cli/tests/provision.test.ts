/**
 * FDE-M3 — unit tests for `gotong provision`'s pure halves: arg parsing and
 * report cadence wording. The full loop (install → schedules → acceptance →
 * exit codes) is pinned end-to-end against a real hub in
 * host/tests/provision-e2e.test.ts — here we only cover what that rig can't
 * cheaply reach (every usage-error branch).
 */

import { describe, expect, it } from 'vitest'

import { cadenceText, parseProvisionArgs } from '../src/commands/provision.js'

describe('parseProvisionArgs', () => {
  it('parses the full flag set and strips trailing slashes off --url', () => {
    expect(
      parseProvisionArgs([
        'pack.yaml', '--url', 'http://h:3000///', '--token', 't', '--user', 'u-a', '--skip-acceptance',
      ]),
    ).toEqual({
      file: 'pack.yaml',
      url: 'http://h:3000',
      token: 't',
      user: 'u-a',
      skipAcceptance: true,
    })
  })

  it('minimal invocation: file + url + token, no user', () => {
    const f = parseProvisionArgs(['p.yaml', '--url', 'http://h', '--token', 't'])
    expect(f).toMatchObject({ file: 'p.yaml', skipAcceptance: false })
    expect((f as { user?: string }).user).toBeUndefined()
  })

  it('usage errors: missing pieces, unknown flag, valueless flag, second positional', () => {
    expect(parseProvisionArgs(['--url', 'u', '--token', 't'])).toMatch(/缺 pack 文件/)
    expect(parseProvisionArgs(['p.yaml', '--token', 't'])).toMatch(/--url/)
    expect(parseProvisionArgs(['p.yaml', '--url', 'u'])).toMatch(/--token/)
    expect(parseProvisionArgs(['p.yaml', '--url', 'u', '--token', 't', '--nope'])).toMatch(/不认识的旗标/)
    expect(parseProvisionArgs(['p.yaml', '--url', '--token'])).toMatch(/--url 需要一个值/)
    expect(parseProvisionArgs(['a.yaml', 'b.yaml', '--url', 'u', '--token', 't'])).toMatch(/第二个/)
    expect(parseProvisionArgs(['--help'])).toBe('help')
  })
})

describe('cadenceText', () => {
  it('renders the three cadence kinds and falls back to JSON for garbage', () => {
    expect(cadenceText({ kind: 'daily', hour: 8, tzOffsetMinutes: 480 })).toBe('每天 8:00')
    expect(cadenceText({ kind: 'weekly', weekday: 1, hour: 9 })).toBe('每周一 9:00')
    expect(cadenceText({ kind: 'interval', everyMs: 90_000 })).toBe('每隔 2 分钟')
    expect(cadenceText({ what: 'ever' })).toBe('{"what":"ever"}')
  })
})
