/**
 * `gotong setting [<subcommand> [args]]` — the unified deterministic (NON-AI)
 * operations console, CLI face. One namespace stitching the whole lifecycle:
 * cold-start → crash-rescue (restore / rotate-master-key) → re-read definitions
 * (status / check) → other config management (list / inventory / fix-dirs).
 *
 * Two faces in one command:
 *
 *   - `gotong setting <subcmd>`   one-shot — run a single ops command and exit.
 *   - `gotong setting`            interactive sub-shell — read a line, run it,
 *                                  repeat, until `exit`.
 *
 * Like `start` / `check`, the deterministic engine lives in the SEPARATE
 * `@gotong/host` package (it needs `validateWorkspace`, the Space layout, the
 * backup scripts), so the tiny CLI does NOT depend on it. `setting` resolves the
 * host LAZILY and drives its non-booting `./ops` subpath (mirrors `check.ts`).
 *
 * ── The tier boundary is enforced by WHERE the code runs, not a flag ──────────
 *
 * Online ops (status / check / list / inventory / fix-dirs) funnel through the
 * host's SHARED `runOpsCommand`, which refuses destructive-offline commands for
 * EVERY surface by construction (it throws `OpsTierError`). The destructive trio
 * (cold-start / restore / rotate-master-key) is CLI-ONLY and runs through a
 * SEPARATE adapter here that invokes the real scripts / host subcommand directly
 * — BYPASSING `runOpsCommand`. That asymmetry is physics: these operations happen
 * when the hub is down or being replaced, so only the CLI can run them. The web /
 * IM surfaces (M4 / M5) drive the same `runOpsCommand` and therefore can never
 * reach a destructive op; they only LIST it and point here.
 *
 * Destructive commands require an explicit confirmation (`--yes` to skip) before
 * anything runs — the confirm + process-launch are injectable seams so the tests
 * assert that declining the prompt runs nothing at all.
 */

import { resolveModule } from './start.js'
import { doctor } from './doctor.js'
import { check } from './check.js'
import { start } from './start.js'
import { makeReadlineIo } from './repl.js'
import type { ReplIo } from '../repl/loop.js'

const HOST_PKG = '@gotong/host'
// A variable, not a string literal, on purpose: tsc only resolves
// `import("literal")` at build time, so this dynamic import does NOT make
// `@gotong/host` a build-time dependency of the CLI (same trick as `start`).
const OPS_PKG = '@gotong/host/ops'

// The destructive-offline trio. Named here (not derived from the catalog) so the
// dispatcher routes them to the CLI-only adapter BEFORE they could ever reach
// `runOpsCommand` (which would throw `OpsTierError` for them anyway).
const DESTRUCTIVE = new Set(['cold-start', 'restore', 'rotate-master-key'])

// ── Structural mirrors of the `@gotong/host/ops` surface ────────────────────
// Declared locally (NOT imported from the host) so the CLI keeps zero host
// build-time dependency. Only the slice `setting` actually consumes.

interface OpsCallerLite {
  surface: 'cli' | 'web' | 'im'
  allowConfigWrite: boolean
}
interface OpsResultLite {
  command: string
  tier: string
  lines: string[]
  data?: Record<string, unknown>
}
interface OpsCommandInfoLite {
  id: string
  tier: string
  title: string
  summary: string
  whereToRun?: string
  runnableHere: boolean
}
interface OpsDepsLite {
  spaceDir: string
  env?: Record<string, string | undefined>
}
interface OpsModule {
  runOpsCommand: (
    id: string,
    args: readonly string[],
    caller: OpsCallerLite,
    deps: OpsDepsLite,
  ) => Promise<OpsResultLite>
  listOpsCommands: (caller: OpsCallerLite) => OpsCommandInfoLite[]
}

const CLI_CALLER: OpsCallerLite = { surface: 'cli', allowConfigWrite: true }

// ── Injectable seams so both faces + every branch are testable hermetically ──

export interface SettingDeps {
  /** Probe whether `@gotong/host` is installed (its entry path/URL, or null). */
  resolveHost?: () => string | null
  /** Import the host's non-booting `./ops` module. */
  importOps?: () => Promise<OpsModule>
  /** Pre-flight env check used by `cold-start` (defaults to the real `doctor`). */
  runDoctor?: (args: readonly string[]) => Promise<number>
  /** Definition validation used by `cold-start` (defaults to the real `check`). */
  runCheck?: (args: readonly string[]) => Promise<number>
  /** Boot used by `cold-start` (defaults to the real `start`; boots in-process). */
  runStart?: (args: readonly string[]) => Promise<number>
  /** Launch an external process (defaults to `child_process.spawn`, stdio inherit). */
  runProcess?: (cmd: string, args: readonly string[]) => Promise<number>
  /** Ask the operator y/N (defaults to a one-shot readline prompt). */
  confirm?: (question: string) => Promise<boolean>
  /** Interactive IO for the sub-shell (defaults to readline). Injected in tests. */
  io?: ReplIo
  /** Env to read GOTONG_SPACE / GOTONG_* from (defaults to `process.env`). */
  env?: Record<string, string | undefined>
  /** stdout writer (defaults to `process.stdout.write`). */
  out?: (line: string) => void
  /** stderr writer (defaults to `console.error`). */
  err?: (line: string) => void
}

interface SettingCtx {
  out: (line: string) => void
  err: (line: string) => void
  env: Record<string, string | undefined>
  spaceDir: string
  resolveHost: () => string | null
  importOps: () => Promise<OpsModule>
  runDoctor: (args: readonly string[]) => Promise<number>
  runCheck: (args: readonly string[]) => Promise<number>
  runStart: (args: readonly string[]) => Promise<number>
  runProcess: (cmd: string, args: readonly string[]) => Promise<number>
  confirm: (question: string) => Promise<boolean>
  deps: SettingDeps
}

function makeCtx(deps: SettingDeps): SettingCtx {
  const env = deps.env ?? (process.env as Record<string, string | undefined>)
  const spaceDir = env.GOTONG_SPACE ?? '.gotong'
  return {
    out: deps.out ?? ((l: string) => { process.stdout.write(l) }),
    err: deps.err ?? ((l: string) => { console.error(l) }),
    env,
    spaceDir,
    resolveHost: deps.resolveHost ?? (() => resolveModule(HOST_PKG)),
    importOps: deps.importOps ?? (() => import(OPS_PKG) as Promise<OpsModule>),
    runDoctor: deps.runDoctor ?? ((a) => doctor(a)),
    runCheck: deps.runCheck ?? ((a) => check(a)),
    runStart: deps.runStart ?? ((a) => start(a)),
    runProcess: deps.runProcess ?? defaultRunProcess,
    confirm: deps.confirm ?? defaultConfirm,
    deps,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Pure parser for one sub-shell line (mirrors repl/parse.ts's discriminated
// union; tiny + explicit). Exported for the unit tests.
// ───────────────────────────────────────────────────────────────────────────

export type ParsedSetting =
  | { kind: 'empty' }
  | { kind: 'exit' }
  | { kind: 'help' }
  | { kind: 'command'; id: string; args: string[] }

export function parseSettingCommand(line: string): ParsedSetting {
  const tokens = line.trim().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return { kind: 'empty' }
  const head = tokens[0]!.toLowerCase()
  if (['exit', 'quit', 'q', ':q', ':quit', ':exit'].includes(head)) return { kind: 'exit' }
  if (['help', '?', ':help', ':h', 'h'].includes(head)) return { kind: 'help' }
  return { kind: 'command', id: tokens[0]!, args: tokens.slice(1) }
}

// ───────────────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────────────

export async function setting(args: readonly string[], deps: SettingDeps = {}): Promise<number> {
  const ctx = makeCtx(deps)

  if (args[0] === '--help' || args[0] === '-h') {
    ctx.out(SETTING_HELP)
    return 0
  }

  const [sub, ...rest] = args
  // Bare `gotong setting` → interactive sub-shell.
  if (!sub) return runSettingShell(deps)

  switch (sub) {
    case 'cold-start':
      return runColdStart(rest, ctx)
    case 'restore':
      return runRestore(rest, ctx)
    case 'rotate-master-key':
      return runRotateMasterKey(rest, ctx)
    default:
      // Everything else is an online ops command — forwarded VERBATIM to the
      // host's shared runner. Unknown ids surface its `unknown_command` error
      // (so M3's `config` lights up here with zero change once registered).
      return runOnlineOps(sub, rest, ctx)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Online ops: status / check / list / inventory / fix-dirs (+ future read/
// safe-mutate). Driven through the SHARED runner — the single tier chokepoint.
// ───────────────────────────────────────────────────────────────────────────

async function loadOps(ctx: SettingCtx): Promise<OpsModule | null> {
  if (!ctx.resolveHost()) {
    printHostAbsent(ctx.err)
    return null
  }
  try {
    return await ctx.importOps()
  } catch (e) {
    // Resolve said present but the import failed (corrupt install / partial
    // build). Treat as absent rather than crash with a stack trace.
    ctx.err(`[gotong setting] could not load @gotong/host/ops: ${e instanceof Error ? e.message : String(e)}`)
    printHostAbsent(ctx.err)
    return null
  }
}

async function runOnlineOps(id: string, args: readonly string[], ctx: SettingCtx): Promise<number> {
  const ops = await loadOps(ctx)
  if (!ops) return 1
  const opsDeps: OpsDepsLite = { spaceDir: ctx.spaceDir, env: ctx.env }
  try {
    const result = await ops.runOpsCommand(id, args, CLI_CALLER, opsDeps)
    ctx.out(result.lines.join('\n') + '\n')
    return 0
  } catch (e) {
    ctx.err(`[gotong setting] ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Destructive-offline adapter (CLI-ONLY). These BYPASS `runOpsCommand`: they
// invoke the real scripts / host subcommand directly, because they run when the
// hub is down. Each asks for confirmation first (— `--yes` to skip).
// ───────────────────────────────────────────────────────────────────────────

/** Resolve the installed `@gotong/host` package root from its `.` entry URL/path. */
function hostRootFrom(entry: string): string {
  // The `.` export resolves to `<root>/dist/index.js`; root is two dirs up.
  // Done with string ops on the resolved spec so it works for both a file URL
  // (`import.meta.resolve`) and a plain path.
  const path = entry.startsWith('file://') ? fileUrlToPath(entry) : entry
  const norm = path.replace(/\\/g, '/')
  const distIdx = norm.lastIndexOf('/dist/')
  if (distIdx >= 0) return norm.slice(0, distIdx)
  // Fallback: strip the last two path segments (…/dist/index.js → …).
  return norm.split('/').slice(0, -2).join('/')
}

function fileUrlToPath(u: string): string {
  try {
    // Lazy require to avoid a top-level node:url import in the common path.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return new URL(u).pathname
  } catch {
    return u.replace(/^file:\/\//, '')
  }
}

async function runColdStart(args: readonly string[], ctx: SettingCtx): Promise<number> {
  const force = args.includes('--force')
  ctx.out('cold start — pre-flight env check, validate definitions, then boot.\n\n')

  // Pre-flight gate. doctor + check are READ-ONLY (no boot, no mutation); their
  // verdict IS the gate. cold-start deliberately has NO y/N prompt: booting is
  // not destructive, and a clean pre-flight (or --force) is the real guard.
  const doctorCode = await ctx.runDoctor([])
  const checkCode = await ctx.runCheck([])
  const clean = doctorCode === 0 && checkCode === 0

  if (!clean && !force) {
    ctx.err('')
    ctx.err('[gotong setting cold-start] pre-flight found problems (doctor or check failed).')
    ctx.err('  Fix them, or re-run with --force to boot anyway:')
    ctx.err('      gotong setting cold-start --force')
    return 1
  }
  if (!clean && force) {
    ctx.out('\n--force: booting despite pre-flight findings.\n')
  }
  // Boots the host in THIS process (a top-level side-effect that keeps the event
  // loop alive); it does not return on success.
  return ctx.runStart([])
}

async function runRestore(args: readonly string[], ctx: SettingCtx): Promise<number> {
  const positional = args.filter((a) => !a.startsWith('-'))
  const force = args.includes('--force')
  const assumeYes = args.includes('--yes') || args.includes('-y')
  const backup = positional[0]
  const target = positional[1]
  if (!backup || !target) {
    ctx.err('usage: gotong setting restore <backup-file.tar.gz> <target-dir> [--force] [--yes]')
    return 2
  }

  const entry = ctx.resolveHost()
  if (!entry) {
    printHostAbsent(ctx.err)
    return 1
  }
  const script = `${hostRootFrom(entry)}/scripts/backup/restore.sh`

  ctx.out(`about to RESTORE '${backup}' into '${target}'${force ? ' (--force: an existing target is stashed aside, not deleted)' : ''}.\n`)
  ctx.out('this overwrites the target workspace — the hub must be stopped first.\n')
  if (!assumeYes && !(await ctx.confirm('proceed with restore? [y/N] '))) {
    ctx.out('aborted — nothing was changed.\n')
    return 1
  }
  return ctx.runProcess('bash', [script, backup, target, ...(force ? ['--force'] : [])])
}

async function runRotateMasterKey(args: readonly string[], ctx: SettingCtx): Promise<number> {
  const assumeYes = args.includes('--yes') || args.includes('-y')
  const entry = ctx.resolveHost()
  if (!entry) {
    printHostAbsent(ctx.err)
    return 1
  }
  // Delegate to the host's own `rotate-master-key` subcommand (it reads
  // GOTONG_SPACE / GOTONG_MASTER_KEY_* from the env, exactly like boot). Spawning the
  // host bin runs that subcommand WITHOUT booting the server (main.ts forks on
  // ARGV[0]). The new key is never printed — it stays the host's concern.
  const bin = `${hostRootFrom(entry)}/bin/gotong-host.js`

  ctx.out(`about to ROTATE the identity-vault master key (KEK) for GOTONG_SPACE='${ctx.spaceDir}'.\n`)
  ctx.out('the OLD key stops working; a running host adopts the new key on its next restart. local-file provider only.\n')
  if (!assumeYes && !(await ctx.confirm('rotate the master key now? [y/N] '))) {
    ctx.out('aborted — the key was not rotated.\n')
    return 1
  }
  return ctx.runProcess(process.execPath, [bin, 'rotate-master-key'])
}

// ───────────────────────────────────────────────────────────────────────────
// Interactive sub-shell — reuses the `ReplIo` + `makeReadlineIo` seam (NOT
// `runReplLoop`, which is hub.dispatch-shaped). Online ops only; destructive
// commands point the operator at the explicit one-shot form (clean confirmation,
// no in-shell boot).
// ───────────────────────────────────────────────────────────────────────────

export async function runSettingShell(deps: SettingDeps = {}): Promise<number> {
  const ctx = makeCtx(deps)
  const ops = await loadOps(ctx)
  if (!ops) return 1

  const opsDeps: OpsDepsLite = { spaceDir: ctx.spaceDir, env: ctx.env }

  // IO: injected in tests; otherwise a readline-backed `ReplIo` with SIGINT→abort.
  const ac = new AbortController()
  const onSigint = (): void => ac.abort()
  let io = deps.io
  const ownIo = !io
  if (!io) {
    process.on('SIGINT', onSigint)
    io = makeReadlineIo(ac.signal)
  }

  io.write(shellBanner(ops))

  try {
    for (;;) {
      const line = await io.read('setting> ')
      if (line === null) break
      const parsed = parseSettingCommand(line)
      if (parsed.kind === 'empty') continue
      if (parsed.kind === 'exit') break
      if (parsed.kind === 'help') {
        io.write(shellHelp(ops))
        continue
      }
      if (DESTRUCTIVE.has(parsed.id)) {
        io.write(
          `'${parsed.id}' is destructive — run it directly so it can confirm safely:\n` +
            `    gotong setting ${parsed.id}\n`,
        )
        continue
      }
      try {
        const result = await ops.runOpsCommand(parsed.id, parsed.args, CLI_CALLER, opsDeps)
        io.write(result.lines.join('\n') + '\n')
      } catch (e) {
        io.write(`${e instanceof Error ? e.message : String(e)}\n`)
      }
    }
  } finally {
    if (ownIo) {
      process.removeListener('SIGINT', onSigint)
      await io.close()
    }
  }
  return 0
}

function shellBanner(ops: OpsModule): string {
  const runnable = ops
    .listOpsCommands(CLI_CALLER)
    .filter((c) => c.tier === 'read' || c.tier === 'safe-mutate')
    .map((c) => c.id)
    .join(', ')
  return [
    'Gotong setting console — deterministic ops, no LLM.',
    `Online commands: ${runnable}.  Type \`help\` for the full list, \`exit\` to quit.`,
    '',
    '',
  ].join('\n')
}

function shellHelp(ops: OpsModule): string {
  const lines: string[] = ['setting commands:']
  for (const c of ops.listOpsCommands(CLI_CALLER)) {
    const inShell = c.tier === 'read' || c.tier === 'safe-mutate'
    const mark = inShell ? '•' : '×'
    lines.push(`  ${mark} ${c.id.padEnd(18)} [${c.tier}] ${c.title}`)
    if (!inShell) {
      lines.push(
        c.tier === 'destructive-offline'
          ? `      → run directly: gotong setting ${c.id}`
          : `      → owner-only (web admin / CLI): gotong setting ${c.id}`,
      )
    }
  }
  lines.push('  • exit / quit         leave the console', '')
  return lines.join('\n')
}

// ───────────────────────────────────────────────────────────────────────────
// Default seams (production) + shared messaging
// ───────────────────────────────────────────────────────────────────────────

async function defaultRunProcess(cmd: string, args: readonly string[]): Promise<number> {
  const { spawn } = await import('node:child_process')
  return new Promise<number>((resolve) => {
    const child = spawn(cmd, args as string[], { stdio: 'inherit' })
    child.on('error', (e: Error) => {
      console.error(`[gotong setting] failed to launch ${cmd}: ${e.message}`)
      resolve(1)
    })
    child.on('close', (code: number | null) => resolve(code ?? 0))
  })
}

async function defaultConfirm(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises')
  const { stdin, stdout } = await import('node:process')
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    // One-shot `question()` is safe here (the repeated-question pipe-mode caveat
    // in repl.ts does not apply to a single confirmation).
    const ans = (await rl.question(question)).trim().toLowerCase()
    return ans === 'y' || ans === 'yes'
  } finally {
    rl.close()
  }
}

function printHostAbsent(err: (line: string) => void): void {
  err('[gotong setting] @gotong/host is not installed.')
  err('')
  err('  `setting` drives the host\'s own deterministic ops engine, which ships')
  err('  in the SEPARATE @gotong/host package. Install it once:')
  err('')
  err('      npm i -g @gotong/host        # then: gotong setting status')
  err('')
  err('  …or just run the host directly (it does the same boot-time checks):')
  err('')
  err('      npx @gotong/host')
  err('')
}

const SETTING_HELP = `gotong setting [<subcommand> [args]]

The unified deterministic (NON-AI) operations console. One namespace over the
whole lifecycle — cold-start, crash-rescue, re-read definitions, config check.
With NO subcommand it opens an interactive sub-shell.

The ops engine ships in the SEPARATE @gotong/host package; \`setting\` resolves
it lazily and drives its non-booting ./ops entry, so the host must be installed.

Online commands (safe everywhere — also reachable from the admin web UI):
  status               Where is my hub right now (definition counts, config verdict,
                       live health when running).
  check [--strict]     Deterministic config + workflow + agent validation.
  list                 Every setting command, its tier, and where it can run.
  inventory            Backup recovery candidates (read-only, newest first).
  fix-dirs             Create missing workspace directories (mkdir -p; idempotent).

Destructive, offline — CLI ONLY (the hub is down or being replaced while they
run, so the web/IM surfaces physically can't). Each confirms first; --yes skips:
  cold-start [--force] Pre-flight (doctor) → validate definitions (check) → boot.
                       Aborts on pre-flight problems unless --force.
  restore <file> <target> [--force]
                       Extract a backup tarball into a target workspace (runs
                       verify.sh). Stop the hub first.
  rotate-master-key    Rotate the identity-vault master key (local-file provider).

Configuration is read from the same GOTONG_* env the host reads (GOTONG_SPACE,
default .gotong). Exit code 0 on success, non-zero on failure or a declined
confirmation.

Examples:
  gotong setting status
  gotong setting check --strict
  gotong setting                       # interactive sub-shell
  gotong setting restore gotong-prod-20260626T101530Z.tar.gz /opt/gotong --yes
  gotong setting rotate-master-key
`

export { SETTING_HELP }
