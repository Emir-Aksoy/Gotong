/**
 * runCliCommand — spawn engine tests.
 *
 * The "mock CLI" is the test runner's own Node binary (`process.execPath`) driven
 * with `-e <script>`: deterministic, cross-platform, no fixtures on disk. Each
 * case exercises one OS-level concern the runner owns — capture, stdin, live
 * streaming (observe seam), abort (terminate seam), timeout, env, spawn failure.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { detectFsJail } from '@gotong/core'
import { afterAll, describe, expect, it } from 'vitest'

import { runCliCommand, type CliChunk } from '../src/cli-runner.js'

const NODE = process.execPath

describe('runCliCommand — spawn engine', () => {
  it('captures stdout and a zero exit code', async () => {
    const r = await runCliCommand({ command: NODE, args: ['-e', "process.stdout.write('hello')"] })
    expect(r.stdout).toBe('hello')
    expect(r.exitCode).toBe(0)
    expect(r.aborted).toBe(false)
    expect(r.timedOut).toBe(false)
  })

  it('pipes input to the child stdin', async () => {
    const script =
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('got:'+d))"
    const r = await runCliCommand({ command: NODE, args: ['-e', script], input: 'abc' })
    expect(r.stdout).toBe('got:abc')
  })

  it('streams stdout to onChunk in real time (observe seam)', async () => {
    const chunks: CliChunk[] = []
    const r = await runCliCommand({
      command: NODE,
      args: ['-e', "process.stdout.write('streamed')"],
      onChunk: (c) => chunks.push(c),
    })
    expect(r.stdout).toBe('streamed')
    expect(chunks.some((c) => c.stream === 'stdout' && c.text.includes('streamed'))).toBe(true)
  })

  it('reports a non-zero exit code instead of throwing', async () => {
    const r = await runCliCommand({ command: NODE, args: ['-e', 'process.exit(3)'] })
    expect(r.exitCode).toBe(3)
    expect(r.timedOut).toBe(false)
    expect(r.aborted).toBe(false)
  })

  it('captures stderr separately from stdout', async () => {
    const r = await runCliCommand({ command: NODE, args: ['-e', "process.stderr.write('oops')"] })
    expect(r.stderr).toBe('oops')
    expect(r.stdout).toBe('')
    expect(r.exitCode).toBe(0)
  })

  it('abort kills the child — aborted=true, exitCode null (terminate seam)', async () => {
    const ac = new AbortController()
    const p = runCliCommand({
      command: NODE,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      signal: ac.signal,
    })
    setTimeout(() => ac.abort(), 50)
    const r = await p
    expect(r.aborted).toBe(true)
    expect(r.exitCode).toBeNull()
  })

  it('an already-aborted signal resolves without spawning', async () => {
    const ac = new AbortController()
    ac.abort()
    // A bogus command would surface ENOENT *if* spawned; asserting no throw +
    // aborted proves we short-circuited before spawn.
    const r = await runCliCommand({ command: 'gotong-no-such-cmd-xyz', signal: ac.signal })
    expect(r.aborted).toBe(true)
    expect(r.exitCode).toBeNull()
  })

  it('kills a wedged child on timeout — timedOut=true', async () => {
    const r = await runCliCommand({
      command: NODE,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      timeoutMs: 80,
    })
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).toBeNull()
  })

  it('settles after exit even when a grandchild holds the stdio pipes (audit B3)', async () => {
    // The child backgrounds a 5s grandchild with stdio:'inherit' (it keeps
    // OUR pipes open) and exits immediately. Settling on 'close' alone would
    // hang ~5s; the 'exit' drain-grace fallback settles well under that.
    const script =
      "const{spawn}=require('node:child_process');" +
      "spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:'inherit',detached:true}).unref();" +
      "console.log('hi')"
    const t0 = Date.now()
    const r = await runCliCommand({ command: NODE, args: ['-e', script] })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hi')
  })

  it('merges env overrides and inherits PATH', async () => {
    const script =
      "process.stdout.write(process.env.FOO + ':' + (process.env.PATH ? 'haspath' : 'nopath'))"
    const r = await runCliCommand({ command: NODE, args: ['-e', script], env: { FOO: 'bar' } })
    expect(r.stdout).toBe('bar:haspath')
  })

  it('deletes an env key when the override is undefined (scrub a secret)', async () => {
    process.env.GOTONG_CLI_TEST_DEL = 'present'
    const script =
      "process.stdout.write(process.env.GOTONG_CLI_TEST_DEL === undefined ? 'gone' : 'present')"
    const r = await runCliCommand({
      command: NODE,
      args: ['-e', script],
      env: { GOTONG_CLI_TEST_DEL: undefined },
    })
    delete process.env.GOTONG_CLI_TEST_DEL
    expect(r.stdout).toBe('gone')
  })

  it('throws "command not found" when the executable is missing', async () => {
    await expect(runCliCommand({ command: 'gotong-no-such-cmd-xyz', args: [] })).rejects.toThrow(
      /command not found/,
    )
  })
})

// Layer-2 FS jail — REAL-machine proof that the runner's `fsJail` plumbing
// confines a spawned child via the host enforcer (not just that wrapWithFsJail
// builds argv). HOME-based root/denied (NOT /tmp — that's essential-writable).
// Self-skips when no OS kernel jail is available.
const realCap = await detectFsJail({ noCache: true })
const jailBase = mkdtempSync(join(homedir(), '.gotong-cli-jail-'))
const jailRoot = join(jailBase, 'root')
mkdirSync(jailRoot)
afterAll(() => rmSync(jailBase, { recursive: true, force: true }))

const WRITE = "require('fs').writeFileSync(process.argv[1], 'x')"
const jailSuite = realCap.kind === 'none' ? describe.skip : describe

jailSuite(`runCliCommand fsJail (${realCap.kind})`, () => {
  it('confines the child: a write INSIDE the root succeeds', async () => {
    const ok = join(jailRoot, 'ok.txt')
    const r = await runCliCommand({
      command: NODE,
      args: ['-e', WRITE, ok],
      cwd: jailRoot,
      fsJail: { allowedRoots: [jailRoot], kind: realCap.kind },
    })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(existsSync(ok)).toBe(true)
  })

  it('confines the child: a write OUTSIDE the root is denied', async () => {
    const denied = join(jailBase, 'denied.txt') // sibling of root → not allowed
    const r = await runCliCommand({
      command: NODE,
      args: ['-e', WRITE, denied],
      cwd: jailRoot,
      fsJail: { allowedRoots: [jailRoot], kind: realCap.kind },
    })
    expect(r.exitCode).not.toBe(0)
    expect(existsSync(denied)).toBe(false)
  })
})
