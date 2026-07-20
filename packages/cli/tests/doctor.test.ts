/**
 * `gotong doctor` tests — the pre-flight environment check.
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
  collectDefinitionChecks,
  doctor,
  isExposedDeployment,
  mkdirpReal,
  perimeterChecks,
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
    resolveHost: () => '/fake/node_modules/@gotong/host/dist/index.js',
    probePort: async () => ({ status: 'free' }),
    probePath: async () => 'writable',
    // The deep definitions check needs the host package; in CLI tests that's
    // injected so the default (which imports @gotong/host/check, unavailable
    // here) never runs. Clean by default — individual tests dirty one knob.
    runWorkspaceCheck: async () => ({ workflows: { ok: 1, bad: 0 }, agents: { ok: 1, bad: 0 } }),
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
      '@gotong/host',
      'Web port',
      'Agent WS port',
      'Data dir (GOTONG_SPACE)',
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
    expect(levelOf(checks, '@gotong/host')).toBe('warn')
  })

  it('port in-use is a warning (may be the running hub); EACCES is a blocker', async () => {
    const busy = await collectChecks(greenDeps({ probePort: async () => ({ status: 'in-use' }) }))
    expect(levelOf(busy, 'Web port')).toBe('warn')
    expect(busy.find((c) => c.label === 'Web port')?.fix).toContain('GOTONG_WEB_PORT')

    const eacces = await collectChecks(greenDeps({ probePort: async () => ({ status: 'error', code: 'EACCES' }) }))
    expect(levelOf(eacces, 'Web port')).toBe('error')
    expect(eacces.find((c) => c.label === 'Web port')?.fix).toContain('1024')
  })

  it('space verdicts: writable/creatable ok, read-only/not-a-dir/blocked are blockers', async () => {
    expect(levelOf(await collectChecks(greenDeps({ probePath: async () => 'writable' })), 'Data dir (GOTONG_SPACE)')).toBe('ok')
    expect(levelOf(await collectChecks(greenDeps({ probePath: async () => 'creatable' })), 'Data dir (GOTONG_SPACE)')).toBe('ok')
    expect(levelOf(await collectChecks(greenDeps({ probePath: async () => 'exists-readonly' })), 'Data dir (GOTONG_SPACE)')).toBe('error')
    expect(levelOf(await collectChecks(greenDeps({ probePath: async () => 'not-a-dir' })), 'Data dir (GOTONG_SPACE)')).toBe('error')
    expect(levelOf(await collectChecks(greenDeps({ probePath: async () => 'blocked' })), 'Data dir (GOTONG_SPACE)')).toBe('error')
  })

  it('master key: provider=env without GOTONG_MASTER_KEY is a blocker; with it, or file default, is ok', async () => {
    expect(levelOf(await collectChecks(greenDeps({ env: { GOTONG_MASTER_KEY_PROVIDER: 'env' } })), 'Master key')).toBe('error')
    expect(levelOf(await collectChecks(greenDeps({ env: { GOTONG_MASTER_KEY_PROVIDER: 'env', GOTONG_MASTER_KEY: 'k' } })), 'Master key')).toBe('ok')
    expect(levelOf(await collectChecks(greenDeps({ env: {} })), 'Master key')).toBe('ok') // file-based default
  })

  it('LLM key: present in env → ok, absent → advisory warning', async () => {
    expect(levelOf(await collectChecks(greenDeps({ env: { OPENAI_API_KEY: 'x' } })), 'LLM provider key')).toBe('ok')
    expect(levelOf(await collectChecks(greenDeps({ env: {} })), 'LLM provider key')).toBe('warn')
  })

  it('reads the configured ports/host into the check detail', async () => {
    const checks = await collectChecks(greenDeps({ env: { ANTHROPIC_API_KEY: 'x', GOTONG_HOST: '0.0.0.0', GOTONG_WEB_PORT: '8080' } }))
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
    expect(text).toContain('gotong start')
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
    expect(out.join('')).toContain('gotong doctor')
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

  it('prints the Definitions section with ✓ when the host + a seeded space load clean', async () => {
    const out: string[] = []
    const code = await doctor(
      [],
      greenDeps({ env: { ANTHROPIC_API_KEY: 'x', GOTONG_SPACE: '/x/.gotong' }, out: (l) => out.push(l) }),
    )
    const text = out.join('')
    expect(text).toContain('Definitions (workflows + agents):')
    expect(text).toContain('✓ Workflow definitions')
    expect(text).toContain('✓ Agents (agents.json)')
    expect(code).toBe(0)
  })

  it('a broken definition is a blocker → exit 1 with a ✖ in the Definitions section', async () => {
    const out: string[] = []
    const code = await doctor(
      [],
      greenDeps({
        env: { ANTHROPIC_API_KEY: 'x', GOTONG_SPACE: '/x/.gotong' },
        runWorkspaceCheck: async () => ({ workflows: { ok: 0, bad: 1 }, agents: { ok: 1, bad: 0 } }),
        out: (l) => out.push(l),
      }),
    )
    const text = out.join('')
    expect(text).toContain('✖ Workflow definitions')
    expect(text).toContain('blocker')
    expect(code).toBe(1)
  })

  it('omits the Definitions section on a fresh box (space not created yet)', async () => {
    const out: string[] = []
    // 'creatable' = space doesn't exist yet → nothing loaded → section skipped,
    // and a creatable space is itself ok, so the run stays green.
    await doctor([], greenDeps({ probePath: async () => 'creatable', out: (l) => out.push(l) }))
    expect(out.join('')).not.toContain('Definitions (workflows + agents):')
  })
})

describe('collectDefinitionChecks — deep workspace check (gated, best-effort)', () => {
  const present = () => '/fake/node_modules/@gotong/host/dist/index.js'
  const clean = async (): Promise<{ workflows: { ok: number; bad: number }; agents: { ok: number; bad: number } }> => ({
    workflows: { ok: 1, bad: 0 },
    agents: { ok: 1, bad: 0 },
  })

  // Definitions live UNDER GOTONG_SPACE: on a fresh box there's nothing to parse
  // yet, so the check skips entirely (and never even runs the validators).
  it.each(['creatable', 'blocked', 'not-a-dir'] as const)(
    'returns [] when the space probe is %s (fresh box — nothing loaded)',
    async (probe) => {
      const ran = vi.fn(clean)
      const checks = await collectDefinitionChecks({
        env: { GOTONG_SPACE: '/x/.gotong' },
        probePath: async () => probe,
        resolveHost: present,
        runWorkspaceCheck: ran,
      })
      expect(checks).toEqual([])
      expect(ran).not.toHaveBeenCalled()
    },
  )

  it('returns [] when @gotong/host is not resolvable here', async () => {
    const ran = vi.fn(clean)
    const checks = await collectDefinitionChecks({
      env: { GOTONG_SPACE: '/x/.gotong' },
      probePath: async () => 'writable',
      resolveHost: () => null,
      runWorkspaceCheck: ran,
    })
    expect(checks).toEqual([])
    expect(ran).not.toHaveBeenCalled()
  })

  it('two ✓ checks when the seeded space loads clean', async () => {
    const checks = await collectDefinitionChecks({
      env: { GOTONG_SPACE: '/x/.gotong' },
      probePath: async () => 'writable',
      resolveHost: present,
      runWorkspaceCheck: clean,
    })
    expect(checks.map((c) => [c.level, c.label])).toEqual([
      ['ok', 'Workflow definitions'],
      ['ok', 'Agents (agents.json)'],
    ])
  })

  it('a broken workflow file → a ✖ on "Workflow definitions" pointing at `gotong check`', async () => {
    const checks = await collectDefinitionChecks({
      env: { GOTONG_SPACE: '/x/.gotong' },
      probePath: async () => 'writable',
      resolveHost: present,
      runWorkspaceCheck: async () => ({ workflows: { ok: 2, bad: 1 }, agents: { ok: 1, bad: 0 } }),
    })
    const wf = checks.find((c) => c.label === 'Workflow definitions')!
    expect(wf.level).toBe('error')
    expect(wf.detail).toContain("1 of 3 won't parse")
    expect(wf.fix).toContain('gotong check')
    // one bad domain does NOT taint the other — a clean agents file stays ✓.
    expect(checks.find((c) => c.label === 'Agents (agents.json)')?.level).toBe('ok')
  })

  it('a broken agents row → a ✖ on "Agents (agents.json)", workflows "none yet"', async () => {
    const checks = await collectDefinitionChecks({
      env: { GOTONG_SPACE: '/x/.gotong' },
      probePath: async () => 'writable',
      resolveHost: present,
      runWorkspaceCheck: async () => ({ workflows: { ok: 0, bad: 0 }, agents: { ok: 1, bad: 2 } }),
    })
    const ag = checks.find((c) => c.label === 'Agents (agents.json)')!
    expect(ag.level).toBe('error')
    expect(ag.detail).toContain('2 broken row(s)')
    expect(checks.find((c) => c.label === 'Workflow definitions')?.detail).toBe('none yet')
  })

  it('degrades to one ⚠ (never throws) when the validator run blows up', async () => {
    const checks = await collectDefinitionChecks({
      env: { GOTONG_SPACE: '/x/.gotong' },
      probePath: async () => 'writable',
      resolveHost: present,
      runWorkspaceCheck: async () => {
        throw new Error('host check exploded')
      },
    })
    expect(checks).toHaveLength(1)
    expect(checks[0].level).toBe('warn')
    expect(checks[0].label).toBe('Definitions')
    expect(checks[0].detail).toContain('host check exploded')
    expect(checks[0].fix).toContain('gotong check')
  })

  it('still runs on an exists-readonly space (a seeded read-only mount still parses)', async () => {
    const ran = vi.fn(clean)
    await collectDefinitionChecks({
      env: { GOTONG_SPACE: '/x/.gotong' },
      probePath: async () => 'exists-readonly',
      resolveHost: present,
      runWorkspaceCheck: ran,
    })
    expect(ran).toHaveBeenCalledOnce()
  })
})

describe('applyFixes — safe, reversible repairs only (--fix)', () => {
  it('creates a missing data dir (creatable) and reports it fixed', async () => {
    const mkdirp = vi.fn(async () => {})
    const actions = await applyFixes({ env: { GOTONG_SPACE: '/data/.gotong' }, probePath: async () => 'creatable', mkdirp })
    expect(mkdirp).toHaveBeenCalledWith('/data/.gotong')
    expect(actions).toEqual([{ outcome: 'fixed', text: expect.stringContaining('Created data dir /data/.gotong') }])
  })

  it('attempts a blocked dir too (mkdir -p can build a missing chain) and reports failure honestly', async () => {
    const mkdirp = vi.fn(async () => {
      const e = new Error('denied') as NodeJS.ErrnoException
      e.code = 'EACCES'
      throw e
    })
    const actions = await applyFixes({ env: { GOTONG_SPACE: '/root/.gotong' }, probePath: async () => 'blocked', mkdirp })
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
    const dir = await mkdtemp(join(tmpdir(), 'gotong-doctor-'))
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
    const base = await mkdtemp(join(tmpdir(), 'gotong-fix-'))
    tmps.push(base)
    const nested = join(base, 'a', 'b', '.gotong')

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
    expect(writes.join('')).toContain('gotong doctor')
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
    expect(writes.join('')).toContain('gotong doctor')
    expect(writes.join('')).toContain('Pre-flight')
  })
})

/**
 * Perimeter section — the checks that only apply once a box faces a network.
 *
 * The load-bearing property is the GATE, not the individual verdicts: a home
 * hub on loopback must see ZERO extra lines (otherwise every laptop user is
 * nagged about TLS they don't need), while a VPS must not be told "all checks
 * passed" while serving session cookies in the clear.
 */
describe('perimeterChecks — network-facing only', () => {
  it('a loopback home box is not "exposed" and gets no perimeter lines', () => {
    for (const env of [
      {},
      { GOTONG_HOST: '127.0.0.1' },
      { GOTONG_HOST: 'localhost', GOTONG_SPACE: '.gotong' },
      { GOTONG_HOST: '::1' },
    ]) {
      expect(isExposedDeployment(env)).toBe(false)
      expect(perimeterChecks(env)).toEqual([])
    }
  })

  it('each of the three exposure signals flips the section on', () => {
    // A public bind is obvious; the other two are how a T3-behind-Caddy box
    // looks (bind stays loopback, but the operator declared a real domain
    // and/or demanded Secure cookies).
    expect(isExposedDeployment({ GOTONG_HOST: '0.0.0.0' })).toBe(true)
    expect(isExposedDeployment({ GOTONG_ALLOWED_HOSTS: 'hub.example.com' })).toBe(true)
    expect(isExposedDeployment({ GOTONG_COOKIE_SECURE: '1' })).toBe(true)
  })

  it('a correctly hardened T3 box passes with no blockers', () => {
    const checks = perimeterChecks({
      GOTONG_HOST: '127.0.0.1',
      GOTONG_COOKIE_SECURE: '1',
      GOTONG_ALLOWED_HOSTS: 'hub.example.com,hub-ws.example.com',
      GOTONG_TRUST_PROXY: '1',
      GOTONG_GATING: 'admin-approval',
      GOTONG_MASTER_KEY_PROVIDER: 'env',
    })
    expect(checks.length).toBeGreaterThan(0)
    expect(checks.filter((c) => c.level !== 'ok')).toEqual([])
  })

  it('flags plaintext cookies, an empty allow-list, open gating and the insecure override', () => {
    const checks = perimeterChecks({
      GOTONG_HOST: '0.0.0.0',
      GOTONG_GATING: 'open',
      GOTONG_ALLOW_INSECURE: '1',
    })
    const errors = checks.filter((c) => c.level === 'error').map((c) => c.label)
    expect(errors).toContain('Cookie security')
    expect(errors).toContain('Host allow-list')
    expect(errors).toContain('Agent gating')
    expect(errors).toContain('Insecure override')
    // Every non-ok line carries an imperative remedy — a finding with no fix
    // is a dead end for the operator who just hit it.
    for (const c of checks.filter((x) => x.level !== 'ok')) expect(c.fix).toBeTruthy()
  })

  it('warns (not fails) on the softer perimeter items', () => {
    const checks = perimeterChecks({
      GOTONG_HOST: '0.0.0.0',
      GOTONG_COOKIE_SECURE: '1',
      GOTONG_ALLOWED_HOSTS: 'hub.example.com',
    })
    const warns = checks.filter((c) => c.level === 'warn').map((c) => c.label)
    expect(warns).toContain('Bind address')       // non-loopback: works, but prefer a proxy
    expect(warns).toContain('Proxy trust')        // rate-limit accuracy, not a hole
    expect(warns).toContain('Master key location') // file KEK: fine at home, weak on a VPS
    expect(checks.filter((c) => c.level === 'error')).toEqual([])
  })

  it('perimeter blockers make `doctor` exit non-zero and print the harden pointer', () => {
    const writes: string[] = []
    const deps: DoctorDeps = {
      env: { GOTONG_HOST: '0.0.0.0', GOTONG_SPACE: '.gotong' },
      nodeVersion: '20.0.0',
      resolveHost: () => '/x',
      probePort: async () => ({ status: 'free' }),
      probePath: async () => 'writable',
      runWorkspaceCheck: async () => { throw new Error('no host') },
      out: (l) => writes.push(l),
      err: () => {},
    }
    return doctor([], deps).then((code) => {
      const text = writes.join('')
      expect(code).toBe(1)
      expect(text).toContain('Perimeter')
      expect(text).toContain('cloud-harden.sh')
    })
  })

  it('a home box never sees the perimeter section at all', () => {
    const writes: string[] = []
    const deps: DoctorDeps = {
      env: { GOTONG_SPACE: '.gotong' },
      nodeVersion: '20.0.0',
      resolveHost: () => '/x',
      probePort: async () => ({ status: 'free' }),
      probePath: async () => 'writable',
      runWorkspaceCheck: async () => { throw new Error('no host') },
      out: (l) => writes.push(l),
      err: () => {},
    }
    return doctor([], deps).then((code) => {
      expect(code).toBe(0)
      expect(writes.join('')).not.toContain('Perimeter')
    })
  })
})
