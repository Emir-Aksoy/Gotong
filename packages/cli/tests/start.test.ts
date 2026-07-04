/**
 * `gotong start` tests — the delegating launcher.
 *
 * `start` never imports `@gotong/host` at build time (it's not a CLI dep);
 * it resolves it lazily and only boots it if present. So the two branches —
 * host present → launch, host absent → install hint + non-zero — are driven
 * through INJECTED seams (`resolveHost` / `importHost`) so the suite stays
 * hermetic and never stands up a real server.
 *
 * The presence-probe MECHANISM (`resolveModule`) needs a real-Node check too:
 * the injected seams bypass it, and a regression there (e.g. reverting to a
 * CJS `createRequire().resolve`) would mis-report the ESM-only host as ABSENT
 * so `gotong start` would NEVER launch an installed host. `resolveModule`
 * uses `import.meta.resolve`, which Vitest's module context does NOT implement
 * — so we exercise the REAL `resolveModule` in a Node subprocess (via tsx)
 * where `import.meta.resolve` is available, plus the env-independent
 * "bogus name → null" invariant in-process.
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { start, resolveModule } from '../src/commands/start.js'
import { runCli } from '../src/main.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const START_TS = resolve(HERE, '..', 'src', 'commands', 'start.ts')

// `import.meta.resolve` works under real Node but not under Vitest, so the
// POSITIVE resolution is verified out-of-process. tsx is a root devDep; skip
// only if it's genuinely absent (minimal install) rather than failing red.
let tsxAvailable = true
try {
  createRequire(import.meta.url).resolve('tsx')
} catch {
  tsxAvailable = false
}

// Drives the ACTUAL exported `resolveModule` (imported from start.ts via tsx)
// against a present ESM-only workspace dep and a bogus name.
const PROBE_SCRIPT = `
const { resolveModule } = await import(process.env.PROBE_TARGET)
const present = resolveModule('@gotong/core')
const absent = resolveModule('@gotong/definitely-not-a-real-package-xyz')
process.stdout.write(JSON.stringify({
  presentLooksRight: typeof present === 'string' && present.startsWith('file:') && present.includes('core'),
  absentIsNull: absent === null,
}))
`

describe('resolveModule (presence probe)', () => {
  it('returns null for a package that is not installed', () => {
    // Env-independent invariant: an unresolvable spec is always null (the
    // import.meta.resolve throw is swallowed), so this holds under Vitest too.
    expect(resolveModule('@gotong/definitely-not-a-real-package-xyz')).toBeNull()
  })

  it.skipIf(!tsxAvailable)(
    'in real Node, resolves a present ESM-only dep to its entry URL (guards vs the createRequire always-absent bug)',
    () => {
      const raw = execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', PROBE_SCRIPT],
        {
          cwd: resolve(HERE, '..'),
          env: { ...process.env, PROBE_TARGET: pathToFileURL(START_TS).href },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      const out = JSON.parse(raw) as { presentLooksRight: boolean; absentIsNull: boolean }
      // @gotong/host is ESM-only (its `exports` map has only `import`). The
      // old CJS createRequire probe threw ERR_PACKAGE_PATH_NOT_EXPORTED on such
      // packages → "absent" → start would never launch the installed host.
      // import.meta.resolve honors the `import` condition → present.
      expect(out.presentLooksRight).toBe(true)
      expect(out.absentIsNull).toBe(true)
    },
  )
})

describe('start — host present', () => {
  it('imports (boots) the host and exits 0, without re-probing twice', async () => {
    const importHost = vi.fn(async () => undefined)
    const out: string[] = []
    const err: string[] = []

    const code = await start([], {
      resolveHost: () => '/fake/node_modules/@gotong/host/dist/index.js',
      importHost,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    })

    expect(code).toBe(0)
    expect(importHost).toHaveBeenCalledTimes(1)
    // Nothing printed on the happy path — the host owns stdout from here.
    expect(out.join('')).toBe('')
    expect(err.join('')).toBe('')
  })
})

describe('start — host absent', () => {
  it('prints an install hint to stderr and exits non-zero (never imports)', async () => {
    const importHost = vi.fn(async () => undefined)
    const err: string[] = []

    const code = await start([], {
      resolveHost: () => null,
      importHost,
      err: (l) => err.push(l),
    })

    expect(code).toBe(1)
    expect(importHost).not.toHaveBeenCalled()
    const text = err.join('\n')
    expect(text).toContain('@gotong/host is not installed')
    // Points the user at both the run-directly and install-once paths.
    expect(text).toContain('npx @gotong/host')
    expect(text).toContain('npm i -g @gotong/host')
  })
})

describe('start — flags', () => {
  it('--help prints usage to stdout and exits 0 (never imports)', async () => {
    const importHost = vi.fn(async () => undefined)
    const out: string[] = []

    const code = await start(['--help'], {
      importHost,
      out: (l) => out.push(l),
    })

    expect(code).toBe(0)
    expect(importHost).not.toHaveBeenCalled()
    expect(out.join('')).toContain('gotong start')
  })

  it('rejects a stray argument with code 2 (env is the only knob, never imports)', async () => {
    const importHost = vi.fn(async () => undefined)
    const resolveHost = vi.fn(() => '/fake/host')
    const err: string[] = []

    const code = await start(['--space-dir=foo'], {
      resolveHost,
      importHost,
      err: (l) => err.push(l),
    })

    expect(code).toBe(2)
    // fail-closed: a typo must not silently boot the host with default config.
    expect(importHost).not.toHaveBeenCalled()
    expect(resolveHost).not.toHaveBeenCalled()
    expect(err.join('\n')).toContain('unexpected argument: --space-dir=foo')
  })
})

describe('runCli start wiring', () => {
  it('routes `start --help` through the dispatcher (exit 0)', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await runCli(['start', '--help'])).toBe(0)
    out.mockRestore()
  })

  it('`help start` documents the command', () => {
    const writes: string[] = []
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    runCli(['help', 'start'])
    out.mockRestore()
    expect(writes.join('')).toContain('gotong start')
    expect(writes.join('')).toContain('@gotong/host')
  })
})
