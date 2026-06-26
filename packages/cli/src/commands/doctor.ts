/**
 * `aipehub doctor` — pre-flight environment check.
 *
 * Runs BEFORE the host boots and WITHOUT importing it (the CLI stays tiny —
 * same discipline as start.ts). It inspects the exact AIPE_* env the host
 * reads (host / web port / ws port / space / master-key) and reports, per
 * check, ✓ / ⚠ / ✖ with an actionable fix — so "it won't start and I don't
 * know why" becomes a list you can act on. It is the first thing to run on a
 * fresh box.
 *
 * With `--fix` it first applies the SAFE, REVERSIBLE repairs (today: `mkdir -p`
 * the data dir) and then re-checks. It never auto-changes anything risky — a
 * live port, directory permissions, a read-only mount, or the master key are
 * reported, not touched (see `applyFixes`).
 *
 * Privacy: it reports the NAMES of key env vars, never their values.
 *
 * Exit code: 0 when there are no ✖ blockers (⚠ warnings are advisory), 1 when
 * any blocker is present, 2 on a usage error.
 *
 * Every external effect (port bind, fs access, host-package probe, the Node
 * version, the env) is an injectable seam so the suite is hermetic and never
 * binds a real port — and the real probe mechanisms get their own focused test.
 */

import { access, mkdir, stat } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'

import { resolveModule } from './start.js'

const HOST_PKG = '@aipehub/host'
// A variable, not a string literal, on purpose: tsc only resolves
// `import("literal")` at build time, so this dynamic import does NOT make
// `@aipehub/host` a build-time dependency of the tiny CLI (same trick as
// `start` / `check`). The deep definitions check runs the host's own
// validators via its non-booting `./check` subpath.
const CHECK_PKG = '@aipehub/host/check'

/** Repo `engines.node` floor — keep in sync with the workspace package.json. */
const MIN_NODE_MAJOR = 20

export type CheckLevel = 'ok' | 'warn' | 'error'

export interface DoctorCheck {
  level: CheckLevel
  label: string
  detail: string
  /** One-line, imperative remedy. Printed only for ⚠ / ✖. */
  fix?: string
}

export type PortProbe =
  | { status: 'free' }
  | { status: 'in-use' }
  | { status: 'error'; code: string }

export type PathProbe =
  | 'writable' // dir exists and is writable
  | 'creatable' // doesn't exist, but the parent is writable → first run will mkdir it
  | 'exists-readonly' // dir exists but is not writable
  | 'not-a-dir' // path exists but is a file
  | 'blocked' // doesn't exist and the parent isn't writable either

/** Injectable seams: defaults hit the real OS, tests pass fakes. */
export interface DoctorDeps {
  env?: Record<string, string | undefined>
  /** e.g. process.versions.node — injected so the Node check is deterministic. */
  nodeVersion?: string
  resolveHost?: () => string | null
  probePort?: (host: string, port: number) => Promise<PortProbe>
  probePath?: (path: string) => Promise<PathProbe>
  /** `--fix` seam: create AIPE_SPACE (recursive). Defaults to a real `mkdir -p`. */
  mkdirp?: (path: string) => Promise<void>
  /**
   * Deep definitions-check seam: validate the workspace's loaded workflows +
   * agents (the host-owned validators). Defaults to importing
   * `@aipehub/host/check` and running `validateWorkspace`. Tests inject a fake.
   */
  runWorkspaceCheck?: (
    spaceDir: string,
    env: Record<string, string | undefined>,
  ) => Promise<WorkspaceCheckSummary>
  out?: (line: string) => void
  err?: (line: string) => void
}

/**
 * Just the definitions counts the doctor needs from a workspace check —
 * structural so the CLI takes NO build-time type dependency on `@aipehub/host`.
 * (The detailed per-file report is what `aipehub check` prints; the doctor only
 * summarises "do they load".)
 */
export interface WorkspaceCheckSummary {
  workflows: { ok: number; bad: number }
  agents: { ok: number; bad: number }
}

/** Default deep-check: run the host's `validateWorkspace` via its `./check` subpath. */
async function defaultRunWorkspaceCheck(
  spaceDir: string,
  env: Record<string, string | undefined>,
): Promise<WorkspaceCheckSummary> {
  const mod = (await import(CHECK_PKG)) as {
    validateWorkspace: (o: {
      spaceDir: string
      env: Record<string, string | undefined>
    }) => Promise<WorkspaceCheckSummary>
  }
  const r = await mod.validateWorkspace({ spaceDir, env })
  // Take ONLY the definitions counts — the config 体检 inside validateWorkspace
  // overlaps the doctor's own env checks (ports/space/master key), so we don't
  // re-surface it here and risk double-reporting.
  return { workflows: r.workflows, agents: r.agents }
}

/** Bind-and-release probe: the only honest way to know a port is actually free. */
export function probePortReal(host: string, port: number): Promise<PortProbe> {
  return new Promise((res) => {
    const srv = createServer()
    srv.once('error', (e: NodeJS.ErrnoException) => {
      res(e.code === 'EADDRINUSE' ? { status: 'in-use' } : { status: 'error', code: e.code ?? 'UNKNOWN' })
    })
    srv.once('listening', () => {
      srv.close(() => res({ status: 'free' }))
    })
    srv.listen(port, host)
  })
}

/** Distinguish writable / creatable / read-only / not-a-dir / blocked for AIPE_SPACE. */
export async function probePathReal(p: string): Promise<PathProbe> {
  const abs = resolve(p)
  try {
    const s = await stat(abs)
    if (!s.isDirectory()) return 'not-a-dir'
    try {
      await access(abs, FS.W_OK)
      return 'writable'
    } catch {
      return 'exists-readonly'
    }
  } catch {
    // Doesn't exist — first run will create it iff the parent is writable.
    try {
      await access(dirname(abs), FS.W_OK)
      return 'creatable'
    } catch {
      return 'blocked'
    }
  }
}

/** The real `--fix` mkdir: create the dir and any missing parents. */
export function mkdirpReal(p: string): Promise<void> {
  return mkdir(resolve(p), { recursive: true }).then(() => undefined)
}

/** What `--fix` did (or refused to do) for one repairable item. */
export type FixOutcome = 'fixed' | 'skipped' | 'failed'

export interface FixAction {
  outcome: FixOutcome
  text: string
}

/**
 * Apply the SAFE, REVERSIBLE auto-fixes for `--fix`. Today that is exactly one
 * thing: create the data directory (AIPE_SPACE) when it's missing — `mkdir -p`,
 * which an operator can trivially undo (`rmdir`) and which the host would do on
 * first boot anyway; doing it here lets `doctor` confirm it's writable BEFORE
 * you start, instead of trusting "will be created on first run".
 *
 * Deliberately NOT auto-fixed (they're a live process or a permission/security
 * change we won't make for you — only advise):
 *   • a port already in use            (might be your running hub)
 *   • a read-only / not-a-dir space    (chmod or rm is destructive)
 *   • master key / privileged ports    (security; surfaced by the checks)
 *
 * Pure given its seams (`probePath` / `mkdirp`) — returns what it did, prints
 * nothing. A `blocked` space is still ATTEMPTED (mkdir -p can create a whole
 * missing chain if some ancestor is writable) and reported honestly if it can't.
 */
export async function applyFixes(deps: DoctorDeps = {}): Promise<FixAction[]> {
  const env = deps.env ?? process.env
  const probePath = deps.probePath ?? probePathReal
  const mkdirp = deps.mkdirp ?? mkdirpReal
  const space = env.AIPE_SPACE?.trim() || '.aipehub'

  const probe = await probePath(space)
  switch (probe) {
    case 'writable':
      return [{ outcome: 'skipped', text: `Data dir ${space} already exists and is writable — nothing to fix.` }]
    case 'creatable':
    case 'blocked':
      try {
        await mkdirp(space)
        return [{ outcome: 'fixed', text: `Created data dir ${space}.` }]
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? 'UNKNOWN'
        return [
          {
            outcome: 'failed',
            text: `Could not create ${space} (${code}) — create it with write access manually, or point AIPE_SPACE somewhere writable.`,
          },
        ]
      }
    case 'exists-readonly':
      return [{ outcome: 'skipped', text: `Data dir ${space} exists but is not writable — fix its permissions manually (not auto-changed).` }]
    case 'not-a-dir':
      return [{ outcome: 'skipped', text: `${space} is a file, not a directory — move it aside manually (not auto-changed).` }]
  }
}

function intOr(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? '').trim())
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function portCheck(label: string, host: string, port: number, envVar: string, probe: PortProbe): DoctorCheck {
  const where = `${host}:${port}`
  if (probe.status === 'free') return { level: 'ok', label, detail: `${where} is free` }
  if (probe.status === 'in-use') {
    return {
      level: 'warn',
      label,
      detail: `${where} is already in use`,
      fix: `If AipeHub is already running this is expected. Otherwise stop whatever holds ${where}, or set ${envVar} to a free port.`,
    }
  }
  return {
    level: 'error',
    label,
    detail: `cannot bind ${where} (${probe.code})`,
    fix:
      probe.code === 'EACCES'
        ? `Ports below 1024 need privilege — set ${envVar} to a port >= 1024 (and reverse-proxy 80/443 in front).`
        : `Check the bind address / permissions, or set ${envVar} to a usable port.`,
  }
}

function spaceCheck(space: string, probe: PathProbe): DoctorCheck {
  const label = 'Data dir (AIPE_SPACE)'
  switch (probe) {
    case 'writable':
      return { level: 'ok', label, detail: `${space} exists and is writable` }
    case 'creatable':
      return { level: 'ok', label, detail: `${space} will be created on first run` }
    case 'exists-readonly':
      return { level: 'error', label, detail: `${space} exists but is not writable`, fix: 'Grant write to the directory, or point AIPE_SPACE somewhere writable.' }
    case 'not-a-dir':
      return { level: 'error', label, detail: `${space} exists but is a file, not a directory`, fix: 'Point AIPE_SPACE at a directory path.' }
    case 'blocked':
      return { level: 'error', label, detail: `${space} can't be created (parent directory not writable)`, fix: 'Create the parent with write access, or point AIPE_SPACE somewhere writable.' }
  }
}

function masterKeyCheck(provider: string, masterKey: string): DoctorCheck {
  const label = 'Master key'
  if (provider === 'env') {
    return masterKey.trim()
      ? { level: 'ok', label, detail: 'provider=env, AIPE_MASTER_KEY is set' }
      : {
          level: 'error',
          label,
          detail: 'AIPE_MASTER_KEY_PROVIDER=env but AIPE_MASTER_KEY is empty',
          fix: 'Set AIPE_MASTER_KEY (32+ random bytes, base64), or unset the provider to use the auto-generated file key.',
        }
  }
  // Default / file: the key file is auto-generated under the space — fine for
  // personal / home use. Validating an arbitrary custom provider needs boot, so
  // the doctor stays advisory here rather than over-failing.
  return { level: 'ok', label, detail: provider ? `provider=${provider}` : 'file-based default (auto-generated under AIPE_SPACE)' }
}

function llmKeyCheck(env: Record<string, string | undefined>): DoctorCheck {
  const label = 'LLM provider key'
  // The two env vars the host honors as a fallback (DeepSeek rides the
  // OpenAI-compatible path → OPENAI_API_KEY). Report NAMES only, never values.
  const present = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].filter((k) => (env[k] ?? '').trim())
  if (present.length) return { level: 'ok', label, detail: `found in env: ${present.join(', ')}` }
  return {
    level: 'warn',
    label,
    detail: 'no provider key in the environment',
    fix: 'Optional here — set one in the first-run setup wizard (stored encrypted in the vault), or export ANTHROPIC_API_KEY / OPENAI_API_KEY.',
  }
}

/** Run every check. Pure given its seams — returns results, prints nothing. */
export async function collectChecks(deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const env = deps.env ?? process.env
  const nodeVersion = deps.nodeVersion ?? process.versions.node
  const nodeMajor = Number(nodeVersion.split('.')[0])
  const resolveHost = deps.resolveHost ?? (() => resolveModule(HOST_PKG))
  const probePort = deps.probePort ?? probePortReal
  const probePath = deps.probePath ?? probePathReal

  const host = env.AIPE_HOST?.trim() || '127.0.0.1'
  const webPort = intOr(env.AIPE_WEB_PORT, 3000)
  const wsPort = intOr(env.AIPE_WS_PORT, 4000)
  const space = env.AIPE_SPACE?.trim() || '.aipehub'
  const provider = env.AIPE_MASTER_KEY_PROVIDER?.trim() || ''
  const masterKey = env.AIPE_MASTER_KEY ?? ''

  return [
    Number.isFinite(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR
      ? { level: 'ok', label: 'Node.js', detail: `v${nodeVersion} (need >= ${MIN_NODE_MAJOR})` }
      : { level: 'error', label: 'Node.js', detail: `v${nodeVersion} is older than the required ${MIN_NODE_MAJOR}`, fix: `Install Node ${MIN_NODE_MAJOR}+ (https://nodejs.org) and re-run.` },
    resolveHost()
      ? { level: 'ok', label: '@aipehub/host', detail: 'installed and resolvable' }
      : { level: 'warn', label: '@aipehub/host', detail: 'not resolvable in this context', fix: 'Fine if you run `npx @aipehub/host` or from a source checkout; else `npm i -g @aipehub/host`.' },
    portCheck('Web port', host, webPort, 'AIPE_WEB_PORT', await probePort(host, webPort)),
    portCheck('Agent WS port', host, wsPort, 'AIPE_WS_PORT', await probePort(host, wsPort)),
    spaceCheck(space, await probePath(space)),
    masterKeyCheck(provider, masterKey),
    llmKeyCheck(env),
  ]
}

/** Map definitions counts to doctor ✓/✖ lines (summary; details are `aipehub check`). */
function definitionChecks(s: WorkspaceCheckSummary): DoctorCheck[] {
  const out: DoctorCheck[] = []
  const wTotal = s.workflows.ok + s.workflows.bad
  out.push(
    s.workflows.bad > 0
      ? {
          level: 'error',
          label: 'Workflow definitions',
          detail: `${s.workflows.bad} of ${wTotal} won't parse`,
          fix: 'Run `aipehub check` for the details, fix the YAML, or set AIPE_STRICT_DEFINITIONS=1 to refuse to boot on a broken file.',
        }
      : {
          level: 'ok',
          label: 'Workflow definitions',
          detail: wTotal ? `${s.workflows.ok} file(s) parse` : 'none yet',
        },
  )
  out.push(
    s.agents.bad > 0
      ? {
          level: 'error',
          label: 'Agents (agents.json)',
          detail: `${s.agents.bad} broken row(s)`,
          fix: 'Run `aipehub check` for the details, then fix agents.json.',
        }
      : {
          level: 'ok',
          label: 'Agents (agents.json)',
          detail: s.agents.ok ? `${s.agents.ok} row(s) loadable` : 'none yet',
        },
  )
  return out
}

/**
 * Deep check of the workspace's loaded definitions (workflows + agents) — the
 * same deterministic validators the host runs at boot, surfaced in the
 * pre-flight. Gated, and best-effort:
 *
 *   - Definitions live UNDER AIPE_SPACE, so there's nothing to check until the
 *     directory exists — on a fresh box (space `creatable`/`blocked`/not-a-dir)
 *     this returns [] and the section is omitted entirely.
 *   - The validators ship in `@aipehub/host`; without it resolvable we skip
 *     (the env section already warns the host isn't installed here).
 *   - A probe error never breaks the pre-flight — it degrades to one ⚠ that
 *     points at `aipehub check`.
 *
 * Pure given its seams (`probePath` / `resolveHost` / `runWorkspaceCheck`).
 */
export async function collectDefinitionChecks(deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const env = deps.env ?? process.env
  const resolveHost = deps.resolveHost ?? (() => resolveModule(HOST_PKG))
  const probePath = deps.probePath ?? probePathReal
  const runCheck = deps.runWorkspaceCheck ?? defaultRunWorkspaceCheck
  const space = env.AIPE_SPACE?.trim() || '.aipehub'

  const probe = await probePath(space)
  if (probe !== 'writable' && probe !== 'exists-readonly') return []
  if (!resolveHost()) return []

  let summary: WorkspaceCheckSummary
  try {
    summary = await runCheck(space, env)
  } catch (e) {
    return [
      {
        level: 'warn',
        label: 'Definitions',
        detail: `could not check workflows/agents (${e instanceof Error ? e.message : String(e)})`,
        fix: 'Run `aipehub check` directly to see why.',
      },
    ]
  }
  return definitionChecks(summary)
}

const MARK: Record<CheckLevel, string> = { ok: '✓', warn: '⚠', error: '✖' }
const FIX_MARK: Record<FixOutcome, string> = { fixed: '✓', skipped: '•', failed: '✖' }

export async function doctor(args: readonly string[], deps: DoctorDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => { process.stdout.write(l) })
  const err = deps.err ?? ((l: string) => { console.error(l) })

  if (args.includes('--help') || args.includes('-h')) {
    out(DOCTOR_HELP)
    return 0
  }
  const fix = args.includes('--fix')
  const stray = args.find((a) => a !== '--help' && a !== '-h' && a !== '--fix')
  if (stray) {
    err(`[aipehub doctor] unexpected argument: ${stray}`)
    err('Run `aipehub doctor --help`.')
    return 2
  }

  out('aipehub doctor — pre-flight check\n\n')

  // `--fix` runs BEFORE the checks so the re-probe below reflects anything it
  // just created (e.g. a freshly mkdir'd AIPE_SPACE shows up ✓ writable).
  if (fix) {
    const actions = await applyFixes(deps)
    out('Applying safe fixes (--fix):\n')
    for (const a of actions) out(`  ${FIX_MARK[a.outcome]} ${a.text}\n`)
    out('\n')
  }

  const checks = await collectChecks(deps)
  for (const c of checks) {
    out(`  ${MARK[c.level]} ${c.label} — ${c.detail}\n`)
    if (c.fix && c.level !== 'ok') out(`      → ${c.fix}\n`)
  }
  out('\n')

  // Deep definitions check — runs the host's own validators against the loaded
  // workflows + agents when the host + a seeded AIPE_SPACE are present (skipped,
  // not failed, on a fresh box). Printed as its own section under the env checks.
  const defChecks = await collectDefinitionChecks(deps)
  if (defChecks.length) {
    out('Definitions (workflows + agents):\n')
    for (const c of defChecks) {
      out(`  ${MARK[c.level]} ${c.label} — ${c.detail}\n`)
      if (c.fix && c.level !== 'ok') out(`      → ${c.fix}\n`)
    }
    out('\n')
  }

  const all = [...checks, ...defChecks]
  const errors = all.filter((c) => c.level === 'error').length
  const warns = all.filter((c) => c.level === 'warn').length
  if (errors > 0) {
    out(`✖ ${errors} blocker${errors > 1 ? 's' : ''}${warns ? `, ${warns} warning${warns > 1 ? 's' : ''}` : ''} — fix the ✖ items above, then re-run.\n`)
    return 1
  }
  out(
    warns > 0
      ? `✓ no blockers, ${warns} warning${warns > 1 ? 's' : ''} (advisory). Start with:  aipehub start\n`
      : `✓ all checks passed. Start with:  aipehub start\n`,
  )
  return 0
}

const DOCTOR_HELP = `aipehub doctor

Pre-flight check for a fresh box. Inspects the same environment the host
reads — WITHOUT booting it — and prints, per check, ✓ / ⚠ / ✖ with a fix:

  - Node.js >= ${MIN_NODE_MAJOR}
  - @aipehub/host resolvable (or how to get it)
  - AIPE_WEB_PORT / AIPE_WS_PORT actually free to bind
  - AIPE_SPACE writable (or creatable on first run)
  - master key: AIPE_MASTER_KEY present when provider=env
  - an LLM provider key in the env (optional — the setup wizard can set one)
  - workflow + agent definitions parse — when @aipehub/host and a seeded
    AIPE_SPACE are present (same validators as \`aipehub check\`; skipped on a
    fresh box where there's nothing loaded yet)

It reports the NAMES of key env vars, never their values. Exit code is 0 when
there are no ✖ blockers (⚠ are advisory), 1 otherwise.

With --fix it FIRST applies the safe, reversible repairs, then re-checks:
  - creates AIPE_SPACE (mkdir -p) when it's missing
It will NOT auto-change anything risky — a port already in use, directory
permissions, a read-only mount, or the master key are reported, not touched.

Configuration it reads (12-factor, same as \`aipehub start\`):
  AIPE_HOST=127.0.0.1   AIPE_WEB_PORT=3000   AIPE_WS_PORT=4000
  AIPE_SPACE=.aipehub   AIPE_MASTER_KEY_PROVIDER   AIPE_MASTER_KEY

Examples:
  aipehub doctor
  aipehub doctor --fix
  AIPE_WEB_PORT=8080 aipehub doctor
`
