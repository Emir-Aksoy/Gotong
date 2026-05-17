/**
 * Extra CLI black-box tests. The existing `cli.test.ts` covers the
 * happy paths for `new agent` / `new python-agent` and the most
 * obvious error branches. This file pins the remaining surface:
 *
 *   - `--version` / `-v` print a version string
 *   - `help <cmd>` prints the per-command help, not the shell help
 *   - `new` with no kind / unknown kind / missing name / unknown flag
 *   - `new --no-services` actually skips the services scaffolding
 *   - `new --id=` honours custom participant id
 *   - `ping` arg parsing (missing url / unknown option / negative timeout)
 *
 * No real WebSocket is opened — `ping` arg-parse failures return before
 * importing `ws`, so they're safe to run offline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../src/main.js'

describe('runCli — version + help', () => {
  it('--version prints something that looks like a semver', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = await runCli(['--version'])
    expect(code).toBe(0)
    expect(log).toHaveBeenCalledOnce()
    const printed = String(log.mock.calls[0]?.[0] ?? '')
    // Either a real semver or '?' if package.json read failed (allowed).
    expect(printed === '?' || /^\d+\.\d+\.\d+/.test(printed)).toBe(true)
    log.mockRestore()
  })

  it('-v is the short form', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = await runCli(['-v'])
    expect(code).toBe(0)
    log.mockRestore()
  })

  it('help new prints the new-command help (not shell help)', async () => {
    const writes: string[] = []
    const log = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    })
    const code = await runCli(['help', 'new'])
    expect(code).toBe(0)
    const out = writes.join('')
    expect(out).toContain('aipehub new')
    // Per-command help must mention the flag inventory.
    expect(out).toContain('--capabilities=')
    expect(out).toContain('--id=')
    expect(out).toContain('--no-services')
    log.mockRestore()
  })

  it('help ping prints the ping-command help', async () => {
    const writes: string[] = []
    const log = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    })
    const code = await runCli(['help', 'ping'])
    expect(code).toBe(0)
    const out = writes.join('')
    expect(out).toContain('aipehub ping')
    expect(out).toContain('--api-key=')
    expect(out).toContain('--timeout=')
    log.mockRestore()
  })

  it('help <unknown> falls back to the shell help (does not crash)', async () => {
    const writes: string[] = []
    const log = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    })
    const code = await runCli(['help', 'flarble'])
    expect(code).toBe(0)
    expect(writes.join('')).toContain('aipehub <command>')
    log.mockRestore()
  })

  it('-h is the short form of help', async () => {
    const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await runCli(['-h'])).toBe(0)
    log.mockRestore()
  })
})

describe('runCli — new with bad args', () => {
  let cwd: string | null = null
  let cwdBefore: string

  beforeEach(async () => {
    cwdBefore = process.cwd()
    cwd = await mkdtemp(join(tmpdir(), 'aipehub-cli-extra-'))
    process.chdir(cwd)
  })

  afterEach(async () => {
    if (cwd) {
      process.chdir(cwdBefore)
      await rm(cwd, { recursive: true, force: true })
      cwd = null
    }
  })

  it('`new` with no kind prints help + exits 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const code = await runCli(['new'])
    expect(code).toBe(2)
    err.mockRestore()
    out.mockRestore()
  })

  it('`new junk` (unknown kind) prints help + exits 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const code = await runCli(['new', 'junk', 'x'])
    expect(code).toBe(2)
    err.mockRestore()
    out.mockRestore()
  })

  it('`new agent` with no name exits 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['new', 'agent'])).toBe(2)
    err.mockRestore()
  })

  it('rejects unknown flag with code 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await runCli(['new', 'agent', 'x', '--bogus'])
    expect(code).toBe(2)
    err.mockRestore()
  })

  it('rejects names starting with digit / uppercase / underscore', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['new', 'agent', '1agent'])).toBe(2)
    expect(await runCli(['new', 'agent', 'Agent'])).toBe(2)
    expect(await runCli(['new', 'agent', '_agent'])).toBe(2)
    err.mockRestore()
  })

  it('--no-services strips services scaffolding from the generated source', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = await runCli([
      'new', 'agent', 'plain', '--capabilities=draft', '--no-services',
    ])
    expect(code).toBe(0)
    const src = await readFile(join(cwd!, 'plain', 'src', 'index.ts'), 'utf8')
    expect(src).not.toContain('services: [')
    expect(src).not.toContain('ServiceClient')
    log.mockRestore()
  })

  it('--id=<x> overrides the agent participant id', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = await runCli([
      'new', 'agent', 'plain', '--id=plain-custom', '--capabilities=x',
    ])
    expect(code).toBe(0)
    const src = await readFile(join(cwd!, 'plain', 'src', 'index.ts'), 'utf8')
    expect(src).toContain('id: "plain-custom"')
    log.mockRestore()
  })

  it('python --no-services drops ServiceUseRequest import', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = await runCli([
      'new', 'python-agent', 'plain-py', '--no-services', '--capabilities=x',
    ])
    expect(code).toBe(0)
    const src = await readFile(join(cwd!, 'plain-py', 'src', 'plain_py', 'agent.py'), 'utf8')
    expect(src).not.toContain('ServiceUseRequest')
    expect(src).not.toContain('services=[')
    log.mockRestore()
  })

  it('python rejects names with hyphens at the wrong place via the same regex', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['new', 'python-agent', '-bad'])).toBe(2)
    err.mockRestore()
  })
})

describe('runCli — ping arg parsing', () => {
  it('missing url exits 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['ping'])).toBe(2)
    err.mockRestore()
  })

  it('unknown ping flag exits 2 before opening a socket', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['ping', 'ws://x', '--bogus'])).toBe(2)
    err.mockRestore()
  })

  it('negative / non-numeric --timeout exits 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['ping', 'ws://x', '--timeout=-1'])).toBe(2)
    expect(await runCli(['ping', 'ws://x', '--timeout=abc'])).toBe(2)
    err.mockRestore()
  })

  it('rejects bare hostname (no ws:// prefix)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['ping', 'localhost:4000'])).toBe(2)
    err.mockRestore()
  })
})
