/**
 * Layer 1 of the lightweight FS sandbox — the portable argv path jail
 * (用户 2026-06-29「不用 Docker 的轻量文件围栏」). Pure + lexical, so every case
 * is deterministic with no filesystem access. Layer 2 (OS kernel jail) is the
 * real boundary; this proves the policy-gate + fail-closed UX.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_INTERPRETERS, isInsideRoots, jailArgv } from '../src/index.js'

const ROOT = '/work'
const base = { allowedRoots: [ROOT], cwd: ROOT } as const

describe('jailArgv — allow', () => {
  it('allows a non-interpreter command with an in-root path argument', () => {
    expect(jailArgv({ ...base, command: 'cp', args: ['/work/a.txt', '/work/b.txt'] })).toEqual({
      allow: true,
    })
  })

  it('allows an agent CLI (codex / claude-code) — not an interpreter', () => {
    expect(jailArgv({ ...base, command: 'codex', args: ['exec', '--sandbox', 'workspace-write'] })).toEqual(
      { allow: true },
    )
    expect(jailArgv({ ...base, command: '/usr/local/bin/claude-code', args: ['--print'] })).toEqual({
      allow: true,
    })
  })

  it('allows a bare filename — it resolves inside cwd, never climbs out', () => {
    expect(jailArgv({ ...base, command: 'cat', args: ['notes.txt'] })).toEqual({ allow: true })
  })

  it('allows --flag=PATH when the value is inside a root', () => {
    expect(jailArgv({ ...base, command: 'tool', args: ['--out=/work/sub/out.json'] })).toEqual({
      allow: true,
    })
  })

  it('ignores short flags and valueless long flags (not paths)', () => {
    expect(jailArgv({ ...base, command: 'tool', args: ['-rf', '--verbose', '--force'] })).toEqual({
      allow: true,
    })
  })

  it('treats a whitespace-bearing token as prose, not a path (layer 2 confines it)', () => {
    // A single arg carrying prose with a slash isn't structured argv; layer 1
    // intentionally skips it (documented non-goal) — layer 2 is the boundary.
    expect(jailArgv({ ...base, command: 'agent', args: ['summarize the file /etc/passwd'] })).toEqual(
      { allow: true },
    )
  })

  it('resolves relative roots against cwd', () => {
    expect(
      jailArgv({ command: 'cp', args: ['proj/a', 'proj/b'], allowedRoots: ['proj'], cwd: '/home/me' }),
    ).toEqual({ allow: true })
  })

  it('allows a path equal to the root itself', () => {
    expect(jailArgv({ ...base, command: 'ls', args: ['/work'] })).toEqual({ allow: true })
  })
})

describe('jailArgv — park (fail-closed)', () => {
  it('parks when no allowed roots are configured', () => {
    expect(jailArgv({ command: 'cp', args: ['a', 'b'], allowedRoots: [] })).toMatchObject({
      park: true,
      code: 'no_allowed_roots',
    })
    // whitespace-only roots collapse to none
    expect(jailArgv({ command: 'cp', args: ['a'], allowedRoots: ['  '] })).toMatchObject({
      code: 'no_allowed_roots',
    })
  })

  it('parks an interpreter / shell command regardless of its args', () => {
    for (const cmd of ['bash', 'sh', '/bin/zsh', 'python', 'node', 'ruby', 'sudo']) {
      const v = jailArgv({ ...base, command: cmd, args: ['/work/x'] })
      expect(v).toMatchObject({ park: true, code: 'interpreter_command' })
    }
  })

  it('parks a versioned interpreter (python3, python3.11, node20)', () => {
    for (const cmd of ['python3', 'python3.11', 'node20']) {
      expect(jailArgv({ ...base, command: cmd, args: [] })).toMatchObject({
        code: 'interpreter_command',
      })
    }
  })

  it('honors extraInterpreters', () => {
    expect(
      jailArgv({ ...base, command: 'my-shell', args: [], extraInterpreters: ['my-shell'] }),
    ).toMatchObject({ code: 'interpreter_command' })
  })

  it('parks a shell metacharacter in the command', () => {
    expect(jailArgv({ ...base, command: 'cp;rm', args: [] })).toMatchObject({
      code: 'shell_metacharacter',
    })
  })

  it('parks each kind of shell metacharacter in an argument', () => {
    for (const bad of ['a;b', 'a|b', 'a&b', '$(whoami)', '`id`', 'out>f', 'in<f', 'a\nb']) {
      expect(jailArgv({ ...base, command: 'tool', args: [bad] })).toMatchObject({
        code: 'shell_metacharacter',
      })
    }
  })

  it('parks an absolute path argument outside the roots', () => {
    expect(jailArgv({ ...base, command: 'cat', args: ['/etc/passwd'] })).toMatchObject({
      park: true,
      code: 'path_escape',
    })
  })

  it('parks a relative path that climbs out with ..', () => {
    expect(jailArgv({ ...base, command: 'cat', args: ['../etc/passwd'] })).toMatchObject({
      code: 'path_escape',
    })
    // bare `..` climbs to the parent of cwd → escape
    expect(jailArgv({ ...base, command: 'ls', args: ['..'] })).toMatchObject({ code: 'path_escape' })
  })

  it('catches a lexical .. escape even when it passes through a root prefix', () => {
    expect(jailArgv({ ...base, command: 'cat', args: ['/work/../etc/passwd'] })).toMatchObject({
      code: 'path_escape',
    })
  })

  it('parks --flag=PATH when the value escapes the roots', () => {
    expect(jailArgv({ ...base, command: 'tool', args: ['--out=/etc/cron.d/x'] })).toMatchObject({
      code: 'path_escape',
    })
  })
})

describe('jailArgv — ordering (first failure wins)', () => {
  it('reports interpreter before metacharacter or path escape', () => {
    // command is both an interpreter AND has a metachar-laden / escaping arg —
    // interpreter is the most fundamental reason, checked first.
    expect(jailArgv({ ...base, command: 'bash', args: ['/etc/x;rm'] })).toMatchObject({
      code: 'interpreter_command',
    })
  })

  it('reports metacharacter before path escape', () => {
    expect(jailArgv({ ...base, command: 'tool', args: ['/etc/passwd;ok'] })).toMatchObject({
      code: 'shell_metacharacter',
    })
  })
})

describe('isInsideRoots', () => {
  it('is true for a sub-path, the root itself; false for an outside path', () => {
    expect(isInsideRoots('/work/a/b', ['/work'])).toBe(true)
    expect(isInsideRoots('/work', ['/work'])).toBe(true)
    expect(isInsideRoots('/etc/passwd', ['/work'])).toBe(false)
    // a sibling that shares a name prefix is NOT inside (/work vs /work-evil)
    expect(isInsideRoots('/work-evil/x', ['/work'])).toBe(false)
  })

  it('accepts any of several roots', () => {
    expect(isInsideRoots('/data/x', ['/work', '/data'])).toBe(true)
  })
})

describe('DEFAULT_INTERPRETERS', () => {
  it('covers the common shells and interpreters', () => {
    for (const name of ['bash', 'sh', 'python', 'node', 'sudo', 'env', 'find']) {
      expect(DEFAULT_INTERPRETERS).toContain(name)
    }
  })
})
