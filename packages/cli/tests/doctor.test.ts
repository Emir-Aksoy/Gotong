/**
 * `aipehub doctor` tests — the pre-flight environment check.
 *
 * The CHECK LOGIC (Node version, port/space/master-key/LLM-key verdicts, exit
 * codes) is driven through INJECTED seams (`env` / `nodeVersion` / `resolveHost`
 * / `probePort` / `probePath`) so the suite is hermetic and never binds a real
 * port or touches the real filesystem.
 *
 * The probe MECHANISMS (`probePortReal` / `probePathReal`) get their own
 * in-process check — they're plain `node:net` / `node:fs`, so (unlike start's
 * `import.meta.resolve`) they run under Vitest directly. A regression there
 * (e.g. always reporting a port free) would make the whole doctor lie, so we
 * bind a real ephemeral port + use a real tmpdir to pin the true behaviour.
 *
 * Privacy invariant: the doctor reports the NAMES of key env vars, never their
 * VALUES — asserted explicitly so a future "helpfully print the key" never lands.
 */

import { createServer } from 'node:net'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  applyFixes,
  collectChecks,
  doctor,
  mkdirpReal,
  probePortReal,
  probePathReal,
  type DoctorDeps,
} from '../src/commands/doctor.js'
import { runCli } from '../src/main.js'

/** A deps bundle where everything passes — individual tests override one knob. */
function greenDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    env: { ANTHROPIC_API_KEY: 'present' },
    nodeVersion: '20.11.0',
    resolveHost: () => '/fake/node_modules/@aipehub/host/dist/index.js',
    probePort: async () => ({ status: 'free' }),
    probePath: async () => 'writable',
    ...over,
  }
}

function levelOf(checks: Awaited<ReturnType<typeof collectChecks>>, label: string): string {
  const c = checks.find((x) => x.label === label)
  if (!c) throw new Error(`no check labelled ${label}`)
  return c.level
}

describe('collectChecks — verdicts', () => {
  it('all green when env/node/ports/space/key are fine', async () => {
    const checks = await collectChecks(greenDeps())
    expect(checks.every((c) => c.level === 'ok')).toBe(true)
    // The full check set is present and labelled.
    const labels = checks.map((c) => c.label)
    expect(labels).toEqual([
      'Node.js',
      '@aipehub/host',
      'Web port',
      'Agent WS port',
      'Data dir (AIPE_SPACE)',
      'Master key',
      'LLM provider key',
    ])
  })

  it('flags an old Node as a blocker', async () => {
    const checks = await collectChecks(greenDeps({ nodeVersion: '18.20.0' }))
    expect(levelOf(checks, 'Node.js')).toBe('error')
    expect(checks.find((c) => c.label === 'Node.js')?.detail).toContain('older than')
  })

  it('host absent is a warning (npx still works), not a blocker', async () => {
    const checks = await collectChecks(greenDeps({ resolveHost: () => null }))
    expect(levelOf(checks, '@aipehub/host')).toBe('warn')
  })

  it('port in-use is a warning (may be the running hub); EACCES is a blocker', async () => {
    const busy = await collectChecks(greenDeps({ probePort: async () => ({ status: 'in-use' }) }))
    expect(levelOf(busy, 'Web port')).toBe('warn')
    expect(busy.find((c) => c.label === 'Web port')?.fix).toContain('AIPE_WEB_PORT')

    const eacces = await collectChecks(greenDeps({ probePort: async () => ({ status: 'error', code: 'EACCES' }) }))
    expect(levelOf(eacces, 'Web port')).toBe('error')
    expect(eacces.find((c) => c.label === 'Web port')?.fix).toContain('1024')
  })

  it('space verdicts: writable/creatable ok, read-only/not-a-dir/blocked are blockers', async () => {
    expect(levelOf(await collectChecks(greenDeps({ probePath: async () => 'writable' })), 'Data dir (AIPE_SPACE)')).toBe('ok')
    expect(levelOf(await collectChecks(greenDeps({ probePath: async () => 'creatable' })), 'Data dir (AIPE_SPACE)')).toBe('ok')
    expect(levelOf(await collectChecks(greenDeps({ probePath: async () => 'exists-readonly' })), 'Data dir (AIPE_SPACE)')).toBe('error')
    expect(levelOf(await collectChecks(greenDeps({ probePath: async () => 'not-a-dir' })), 'Data dir (AIPE_SPACE)')).toBe('error')
    expect(levelOf(await collectChecks(greenDeps({ probePath: async () => 'blocked' })), 'Data dir (AIPE_SPACE)')).toBe('error')
  })

  it('master key: provider=env without AIPE_MASTER_KEY is a blocker; with it, or file default, is ok', async () => {
    expect(levelOf(await collectChecks(greenDeps({ env: { AIPE_MASTER_KEY_PROVIDER: 'env' } })), 'Master key')).toBe('error')
    expect(levelOf(await collectChecks(greenDeps({ env: { AIPE_MASTER_KEY_PROVIDER: 'env', AIPE_MASTER_KEY: 'k' } })), 'Master key')).toBe('ok')
    expect(levelOf(await collectChecks(greenDeps({ env: {} })), 'Master key')).toBe('ok') // file-based default
  })

  it('LLM key: present in env → ok, absent → advisory warning', async () => {
    expect(levelOf(await collectChecks(greenDeps({ env: { OPENAI_API_KEY: 'x' } })), 'LLM provider key')).toBe('ok')
    expect(levelOf(await collectChecks(greenDeps({ env: {} })), 'LLM provider key')).toBe('warn')
  })

  it('reads the configured ports/host into the check detail', async () => {
    const checks = await collectChecks(greenDeps({ env: { ANTHROPIC_API_KEY: 'x', AIPE_HOST: '0.0.0.0', AIPE_WEB_PORT: '8080' } }))
    expect(checks.find((c) => c.label === 'Web port')?.detail).toContain('0.0.0.0:8080')
  })
})

describe('doctor — exit codes + output', () => {
  it('all green → exit 0, "all checks passed", points at start', async () => {
    const out: string[] = []
    const code = await doctor([], greenDeps({ out: (l) => out.push(l) }))
    expect(code).toBe(0)
    const text = out.join('')
    expect(text).toContain('✓ all checks passed')
    expect(text).toContain('aipehub start')
  })

  it('warnings only → exit 0 (advisory)', async () => {
    const out: string[] = []
    const code = await doctor([], greenDeps({ env: {}, out: (l) => out.push(l) })) // no LLM key → warn
    expect(code).toBe(0)
    expect(out.join('')).toContain('advisory')
  })

  it('any blocker → exit 1 with a ✖ summary', async () => {
    const out: string[] = []
    const code = await doctor([], greenDeps({ nodeVersion: '18.0.0', out: (l) => out.push(l) }))
    expect(code).toBe(1)
    const text = out.join('')
    expect(text).toContain('✖')
    expect(text).toContain('blocker')
  })

  it('--help → exit 0, prints the doctor usage', async () => {
    const out: string[] = []
    const code = await doctor(['--help'], greenDeps({ out: (l) => out.push(l) }))
    expect(code).toBe(0)
    expect(out.join('')).toContain('aipehub doctor')
  })

  it('rejects a stray argument with code 2', async () => {
    const err: string[] = []
    const code = await doctor(['--space-dir=foo'], greenDeps({ err: (l) => err.push(l) }))
    expect(code).toBe(2)
    expect(err.join('\n')).toContain('unexpected argument: --space-dir=foo')
  })

  it('PRIVACY: prints the env var NAME, never its value', async () => {
    const out: string[] = []
    await doctor([], greenDeps({ env: { ANTHROPIC_API_KEY: 'sk-super-secret-do-not-leak' }, out: (l) => out.push(l) }))
    const text = out.join('')
    expect(text).toContain('ANTHROPIC_API_KEY')
    expect(text).not.toContain('sk-super-secret-do-not-leak')
  })
})

describe('applyFixes — safe, reversible repairs only (--fix)', () => {
  it('creates a missing data dir (creatable) and reports it fixed', async () => {
    const mkdirp = vi.fn(async () => {})
    const actions = await applyFixes({ env: { AIPE_SPACE: '/data/.aipehub' }, probePath: async () => 'creatable', mkdirp })
    expect(mkdirp).toHaveBeenCalledWith('/data/.aipehub')
    expect(actions).toEqual([{ outcome: 'fixed', text: expect.stringContaining('Created data dir /data/.aipehub') }])
  })

  it('attempts a blocked dir too (mkdir -p can build a missing chain) and reports failure honestly', async () => {
    const mkdirp = vi.fn(async () => {
      const e = new Error('denied') as NodeJS.ErrnoException
      e.code = 'EACCES'
      throw e
    })
    const actions = await applyFixes({ env: { AIPE_SPACE: '/root/.aipehub' }, probePath: async () => 'blocked', mkdirp })
    expect(mkdirp).toHaveBeenCalledOnce()
    expect(actions[0].outcome).toBe('failed')
    expect(actions[0].text).toContain('EACCES')
  })

  it('does NOT touch an already-writable dir', async () => {
    const mkdirp = vi.fn(async () => {})
    const actions = await applyFixes({ probePath: async () => 'writable', mkdirp })
    expect(mkdirp).not.toHaveBeenCalled()
    expect(actions[0].outcome).toBe('skipped')
  })

  it('refuses to chmod a read-only dir or remove a file in the way — advises only', async () => {
    for (const probe of ['exists-readonly', 'not-a-dir'] as const) {
      const mkdirp = vi.fn(async () => {})
      const actions = await applyFixes({ probePath: async () => probe, mkdirp })
      expect(mkdirp).not.toHaveBeenCalled()
      expect(actions[0].outcome).toBe('skipped')
      expect(actions[0].text).toContain('not auto-changed')
    }
  })
})

describe('doctor --fix', () => {
  it('runs the fix section before the checks and accepts --fix (not a stray arg)', async () => {
    const out: string[] = []
    const mkdirp = vi.fn(async () => {})
    const code = await doctor(['--fix'], greenDeps({ probePath: async () => 'creatable', mkdirp, out: (l) => out.push(l) }))
    const text = out.join('')
    expect(text).toContain('Applying safe fixes (--fix)')
    expect(text).toContain('Created data dir')
    expect(mkdirp).toHaveBeenCalledOnce()
    expect(code).toBe(0) // creatable space is ok → no blockers
  })

  it('without --fix never calls mkdirp (report-only)', async () => {
    const mkdirp = vi.fn(async () => {})
    await doctor([], greenDeps({ probePath: async () => 'creatable', mkdirp, out: () => {} }))
    expect(mkdirp).not.toHaveBeenCalled()
  })

  it('still rejects a stray argument even alongside --fix', async () => {
    const err: string[] = []
    const code = await doctor(['--fix', '--bogus'], greenDeps({ err: (l) => err.push(l) }))
    expect(code).toBe(2)
    expect(err.join('\n')).toContain('unexpected argument: --bogus')
  })
})

describe('probePortReal (real mechanism)', () => {
  it('reports in-use while a server holds the port, free after it closes', async () => {
    const srv = createServer()
    const port: number = await new Promise((res) => {
      srv.listen(0, '127.0.0.1', () => res((srv.address() as { port: number }).port))
    })

    expect(await probePortReal('127.0.0.1', port)).toEqual({ status: 'in-use' })

    await new Promise<void>((res) => srv.close(() => res()))
    expect(await probePortReal('127.0.0.1', port)).toEqual({ status: 'free' })
  })
})

describe('probePathReal (real mechanism)', () => {
  const tmps: string[] = []
  afterEach(async () => {
    for (const p of tmps.splice(0)) await rm(p, { recursive: true, force: true })
  })

  it('writable for an existing dir, creatable under it, not-a-dir for a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aipe-doctor-'))
    tmps.push(dir)

    expect(await probePathReal(dir)).toBe('writable')
    expect(await probePathReal(join(dir, 'will-be-made'))).toBe('creatable')

    const file = join(dir, 'a-file')
    await writeFile(file, 'x')
    expect(await probePathReal(file)).toBe('not-a-dir')
  })
})

describe('mkdirpReal (real mechanism)', () => {
  const tmps: string[] = []
  afterEach(async () => {
    for (const p of tmps.splice(0)) await rm(p, { recursive: true, force: true })
  })

  it('creates a missing dir AND its missing parents, idempotently', async () => {
    const base = await mkdtemp(join(tmpdir(), 'aipe-fix-'))
    tmps.push(base)
    const nested = join(base, 'a', 'b', '.aipehub')

    expect(await probePathReal(nested)).toBe('blocked') // whole parent chain absent
    await mkdirpReal(nested)
    expect(await probePathReal(nested)).toBe('writable') // now exists + writable
    await mkdirpReal(nested) // idempotent — re-creating must not throw
  })
})

describe('runCli doctor wiring', () => {
  it('routes `doctor --help` through the dispatcher (exit 0)', async () => {
    // --help short-circuits before any probe, so this touches no real port/fs.
    const writes: string[] = []
    const orig = process.stdout.write.bind(process.stdout)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stdout as any).write = (chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }
    try {
      expect(await runCli(['doctor', '--help'])).toBe(0)
    } finally {
      ;(process.stdout as unknown as { write: typeof orig }).write = orig
    }
    expect(writes.join('')).toContain('aipehub doctor')
  })

  it('`help doctor` documents the command', () => {
    const writes: string[] = []
    const orig = process.stdout.write.bind(process.stdout)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stdout as any).write = (chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }
    try {
      runCli(['help', 'doctor'])
    } finally {
      ;(process.stdout as unknown as { write: typeof orig }).write = orig
    }
    expect(writes.join('')).toContain('aipehub doctor')
    expect(writes.join('')).toContain('Pre-flight')
  })
})
