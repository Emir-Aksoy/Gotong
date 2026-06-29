/**
 * Layer 2 of the lightweight FS sandbox — the OS kernel jail (the real
 * boundary). Pure builders are deterministic; `detectFsJail` is exercised with
 * an injected probe + platform override, so no test spawns a real child. A
 * functional real-machine probe (Mac Seatbelt / Linux bwrap) is a JAIL-M3
 * deliverable, not a unit test.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  MAC_ESSENTIAL_WRITABLE,
  buildBwrapArgs,
  buildSeatbeltProfile,
  detectFsJail,
  resetFsJailCache,
  wrapWithFsJail,
  type JailProbe,
} from '../src/index.js'

const ROOT = '/work'

describe('buildSeatbeltProfile', () => {
  it('allows by default, denies writes, then re-allows the given subpaths', () => {
    const p = buildSeatbeltProfile(['/work', '/data'])
    expect(p).toContain('(version 1)')
    expect(p).toContain('(allow default)')
    expect(p).toContain('(deny file-write*)')
    // re-allow block lists each writable root as a quoted subpath
    expect(p).toContain('(allow file-write*')
    expect(p).toContain('(subpath "/work")')
    expect(p).toContain('(subpath "/data")')
    // the deny precedes the re-allow (last-match-wins in SBPL → roots win)
    expect(p.indexOf('(deny file-write*)')).toBeLessThan(p.indexOf('(allow file-write*'))
  })

  it('deduplicates repeated roots', () => {
    const p = buildSeatbeltProfile(['/work', '/work'])
    expect(p.match(/\(subpath "\/work"\)/g)).toHaveLength(1)
  })

  it('escapes quotes and backslashes in a path literal', () => {
    const p = buildSeatbeltProfile(['/a"b\\c'])
    expect(p).toContain('(subpath "/a\\"b\\\\c")')
  })
})

describe('buildBwrapArgs', () => {
  it('binds / read-only, re-binds each root read-write, fresh dev/proc/tmp', () => {
    const args = buildBwrapArgs(['/work', '/data'], '/work')
    const joined = args.join(' ')
    expect(joined).toContain('--ro-bind / /')
    expect(joined).toContain('--dev /dev')
    expect(joined).toContain('--proc /proc')
    expect(joined).toContain('--tmpfs /tmp')
    expect(joined).toContain('--die-with-parent')
    expect(joined).toContain('--bind /work /work')
    expect(joined).toContain('--bind /data /data')
    expect(joined).toContain('--chdir /work')
  })

  it('the rw re-bind comes AFTER the ro-bind (later bind overrides the subtree)', () => {
    const args = buildBwrapArgs(['/work'], '/work')
    expect(args.indexOf('--ro-bind')).toBeLessThan(args.indexOf('--bind'))
  })

  it('deduplicates repeated roots', () => {
    const args = buildBwrapArgs(['/work', '/work'], '/work')
    expect(args.filter((a) => a === '--bind')).toHaveLength(1)
  })
})

describe('wrapWithFsJail', () => {
  it('wraps a command under sandbox-exec with a profile carrying the roots + essentials', () => {
    const w = wrapWithFsJail({
      command: 'codex',
      args: ['exec', '--sandbox', 'workspace-write'],
      allowedRoots: [ROOT],
      cwd: ROOT,
      kind: 'sandbox-exec',
    })
    expect(w).toMatchObject({ command: 'sandbox-exec', jailed: true, kind: 'sandbox-exec' })
    expect(w.args[0]).toBe('-p')
    const profile = w.args[1]!
    expect(profile).toContain('(subpath "/work")')
    for (const ess of MAC_ESSENTIAL_WRITABLE) expect(profile).toContain(`(subpath "${ess}")`)
    // original command + its args trail the profile, in order
    expect(w.args.slice(2)).toEqual(['codex', 'exec', '--sandbox', 'workspace-write'])
  })

  it('wraps a command under bwrap with rw binds for the roots and the original command last', () => {
    const w = wrapWithFsJail({
      command: 'claude-code',
      args: ['--print'],
      allowedRoots: [ROOT],
      cwd: ROOT,
      kind: 'bwrap',
    })
    expect(w).toMatchObject({ command: 'bwrap', jailed: true, kind: 'bwrap' })
    expect(w.args).toContain('--bind')
    // the original command + args are the tail
    expect(w.args.slice(-2)).toEqual(['claude-code', '--print'])
  })

  it('resolves relative roots against cwd before binding', () => {
    const w = wrapWithFsJail({
      command: 'tool',
      args: [],
      allowedRoots: ['proj'],
      cwd: '/home/me',
      kind: 'bwrap',
    })
    expect(w.args.join(' ')).toContain('--bind /home/me/proj /home/me/proj')
  })

  it('folds extraWritableRoots into the writable set', () => {
    const w = wrapWithFsJail({
      command: 'tool',
      args: [],
      allowedRoots: [ROOT],
      cwd: ROOT,
      kind: 'sandbox-exec',
      extraWritableRoots: ['/cache'],
    })
    expect(w.args[1]).toContain('(subpath "/cache")')
  })

  it('passes through unchanged for kind "none" (caller degrades + warns)', () => {
    const w = wrapWithFsJail({
      command: 'codex',
      args: ['exec'],
      allowedRoots: [ROOT],
      cwd: ROOT,
      kind: 'none',
    })
    expect(w).toEqual({ command: 'codex', args: ['exec'], jailed: false, kind: 'none' })
  })
})

describe('detectFsJail', () => {
  const okProbe: JailProbe = async () => ({ ok: true })
  const failProbe: JailProbe = async () => ({ ok: false, detail: 'no userns' })

  it('darwin + working sandbox-exec → kind sandbox-exec', async () => {
    const cap = await detectFsJail({ platform: 'darwin', probe: okProbe, noCache: true })
    expect(cap).toEqual({ kind: 'sandbox-exec' })
  })

  it('darwin + failing probe → none with a fallback reason', async () => {
    const cap = await detectFsJail({ platform: 'darwin', probe: failProbe, noCache: true })
    expect(cap.kind).toBe('none')
    expect(cap.reason).toContain('sandbox-exec')
    expect(cap.reason).toContain('human gate')
  })

  it('linux + working bwrap → kind bwrap', async () => {
    const cap = await detectFsJail({ platform: 'linux', probe: okProbe, noCache: true })
    expect(cap).toEqual({ kind: 'bwrap' })
  })

  it('linux + missing/blocked bwrap → none mentioning bubblewrap + userns', async () => {
    const cap = await detectFsJail({ platform: 'linux', probe: failProbe, noCache: true })
    expect(cap.kind).toBe('none')
    expect(cap.reason).toContain('bubblewrap')
    expect(cap.reason).toContain('user namespaces')
  })

  it('probes functionally — runs the enforcer, not a which lookup', async () => {
    const probe = vi.fn<JailProbe>(async () => ({ ok: true }))
    await detectFsJail({ platform: 'linux', probe, noCache: true })
    expect(probe).toHaveBeenCalledTimes(1)
    const [command, args] = probe.mock.calls[0]!
    expect(command).toBe('bwrap')
    expect(args).toContain('--ro-bind') // a real bwrap invocation over `true`
    expect(args).toContain('true')
  })

  it('an unsupported platform (win32) → none, Windows deferred', async () => {
    const cap = await detectFsJail({ platform: 'win32', probe: okProbe, noCache: true })
    expect(cap.kind).toBe('none')
    expect(cap.reason).toContain('win32')
  })

  it('caches the result and reset clears it', async () => {
    resetFsJailCache()
    const probe = vi.fn<JailProbe>(async () => ({ ok: true }))
    const a = await detectFsJail({ platform: 'linux', probe })
    const b = await detectFsJail({ platform: 'linux', probe })
    expect(a).toEqual(b)
    expect(probe).toHaveBeenCalledTimes(1) // second call served from cache
    resetFsJailCache()
    await detectFsJail({ platform: 'linux', probe })
    expect(probe).toHaveBeenCalledTimes(2) // probed again after reset
    resetFsJailCache()
  })
})
