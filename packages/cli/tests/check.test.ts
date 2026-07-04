/**
 * `gotong check` tests — the delegating workspace validator.
 *
 * Like `start`, `check` never imports `@gotong/host` at build time (it's not a
 * CLI dep); it resolves the host lazily and delegates to the host's NON-booting
 * `./check` subpath export. So the two branches — host present → run the
 * validator, host absent → install hint + non-zero — are driven through INJECTED
 * seams (`resolveHost` / `importCheck`) so the suite stays hermetic and never
 * touches a real workspace or the host package.
 *
 * The presence-probe MECHANISM (`resolveModule`) is shared with `start` and is
 * exercised in start.test.ts; here we only verify `check`'s own delegation: that
 * it forwards the args VERBATIM to the host's `runCheckCli` (the host owns
 * `--strict` / `--help`, so a single source of help truth) and returns its code.
 */

import { describe, expect, it, vi } from 'vitest'

import { check } from '../src/commands/check.js'
import { runCli } from '../src/main.js'

describe('check — host present', () => {
  it('imports the host validator, forwards argv, and returns its exit code', async () => {
    const runCheckCli = vi.fn(async () => 0)
    const importCheck = vi.fn(async () => ({ runCheckCli }))
    const err: string[] = []

    const code = await check(['--strict'], {
      resolveHost: () => '/fake/node_modules/@gotong/host/dist/index.js',
      importCheck,
      err: (l) => err.push(l),
    })

    expect(code).toBe(0)
    expect(importCheck).toHaveBeenCalledTimes(1)
    // The CLI is a pass-through: every flag belongs to the host's runCheckCli.
    expect(runCheckCli).toHaveBeenCalledWith({ argv: ['--strict'] })
    // Nothing printed on the happy path — the host owns stdout from here.
    expect(err.join('')).toBe('')
  })

  it('propagates the validator exit code unchanged (errors → 1)', async () => {
    const runCheckCli = vi.fn(async () => 1)
    const code = await check([], {
      resolveHost: () => '/fake/host',
      importCheck: async () => ({ runCheckCli }),
    })
    expect(code).toBe(1)
  })

  it('forwards the args array verbatim, sans the `check` token', async () => {
    const seen: unknown[] = []
    const runCheckCli = vi.fn(async (deps?: { argv?: readonly string[] }) => {
      seen.push(deps?.argv)
      return 0
    })

    await check(['--strict', '--help'], {
      resolveHost: () => '/fake/host',
      importCheck: async () => ({ runCheckCli }),
    })

    // The dispatcher already stripped `check`; the wrapper must not re-parse
    // or re-order what's left — the host's CLI body is the only flag authority.
    expect(seen).toEqual([['--strict', '--help']])
  })
})

describe('check — host absent', () => {
  it('prints an install hint to stderr and exits non-zero (never imports)', async () => {
    const importCheck = vi.fn(async () => ({ runCheckCli: vi.fn(async () => 0) }))
    const err: string[] = []

    const code = await check(['--strict'], {
      resolveHost: () => null,
      importCheck,
      err: (l) => err.push(l),
    })

    expect(code).toBe(1)
    // The validators are the host's; with no host there is nothing meaningful
    // the tiny CLI can check on its own — so it must NOT pretend to.
    expect(importCheck).not.toHaveBeenCalled()
    const text = err.join('\n')
    expect(text).toContain('@gotong/host is not installed')
    // Points the user at both the install-once and run-directly paths.
    expect(text).toContain('npm i -g @gotong/host')
    expect(text).toContain('npx @gotong/host')
  })
})

describe('runCli check wiring', () => {
  it('routes `check` through the dispatcher (not "unknown command")', async () => {
    // Under Vitest `import.meta.resolve` is unavailable, so the real
    // `resolveModule('@gotong/host')` returns null → host-absent branch →
    // exit 1 with the install hint. The point of THIS test is wiring: the
    // dispatcher reaches `check` (returns 1), not the default arm (returns 2).
    const errs: string[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation((l: unknown) => {
      errs.push(String(l))
    })
    const code = await runCli(['check'])
    errSpy.mockRestore()

    expect(code).toBe(1)
    expect(errs.join('\n')).toContain('@gotong/host is not installed')
  })

  it('`help check` documents the command', () => {
    const writes: string[] = []
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    runCli(['help', 'check'])
    out.mockRestore()
    const text = writes.join('')
    expect(text).toContain('gotong check')
    expect(text).toContain('--strict')
  })
})
