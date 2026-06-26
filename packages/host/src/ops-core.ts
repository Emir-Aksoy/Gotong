/**
 * `ops-core` — the single deterministic (NON-AI) operations engine behind the
 * unified `setting` console. One source of truth; three thin surfaces (CLI,
 * admin web, IM command-mode) consume it. Mirrors the discipline already shipped
 * twice: `@aipehub/host/check` (the workspace validators) and the steward
 * surface (one host service, many transports). Nothing here boots a server — it
 * is exported from `@aipehub/host` under the non-booting `./ops` subpath, so the
 * tiny CLI can drive it without becoming the host (same trick as `./check`).
 *
 * Why this exists: the deterministic ops capabilities ALL already exist, but as
 * three unrelated entry points — `aipehub doctor` (pre-flight), `aipehub check`
 * (definition syntax), and the boot banner (broken-defs notice). There is no one
 * line stitching "cold-start → crash-rescue → re-read definitions → other config
 * management", and no shared web/IM entry. `ops-core` aggregates them under one
 * `setting` namespace, reached three ways, with ZERO LLM dependency.
 *
 * ── The tier model is the spine of the whole design ──────────────────────────
 *
 * Every command carries an `OpsTier`. The tier IS the cross-surface boundary:
 *
 *   read                 status / check / list / inventory / (config-view, M3)
 *                        — safe everywhere (CLI, web, IM).
 *   safe-mutate          fix-dirs — create missing workspace dirs (idempotent,
 *                        reversible). Safe everywhere.
 *   config-write         deterministic config writes (M3) — owner-gated +
 *                        audited. CLI + web(owner); NEVER IM.
 *   destructive-offline  cold-start / restore / rotate-master-key — CLI ONLY.
 *
 * The asymmetry is not mere policy, it is PHYSICS: cold-start / restore /
 * rotate-master-key happen when the hub is DOWN or being REPLACED, so the
 * web/IM process that would run them is itself not up (or is the thing being
 * swapped). Hence `runOpsCommand` — the SHARED online runner that CLI(online),
 * web and IM all funnel through — NEVER executes a destructive-offline command:
 * it throws `OpsTierError`. The CLI's destructive paths (M2) invoke the real
 * scripts/host-subcommands DIRECTLY, bypassing this runner, so the chokepoint
 * is unbypassable from web/IM by construction.
 *
 * `listOpsCommands(caller)` still LISTS every tier (destructive + config-write
 * included, annotated with where to run them) so all three surfaces can DISPLAY
 * the full lifecycle and point the operator to the right place.
 */

import { access, mkdir, readdir, stat } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  validateWorkspace,
  formatCheckReport,
  definitionsReport,
  type WorkspaceCheckReport,
  type CheckFinding,
} from './workspace-check.js'
import type { AdminHealthSurface, HealthSnapshot } from './admin-health.js'

// Re-export the read-tier validators so `@aipehub/host/ops` is a one-stop
// import — a consumer can reach the same deterministic validators the boot path
// and `aipehub check` use, without also importing `./check`. (Imported locally
// above so the handlers below can call them directly.)
export { validateWorkspace, formatCheckReport, definitionsReport }
export type { WorkspaceCheckReport, CheckFinding, AdminHealthSurface, HealthSnapshot }

// ───────────────────────────────────────────────────────────────────────────
// Tier model + caller context
// ───────────────────────────────────────────────────────────────────────────

export type OpsTier = 'read' | 'safe-mutate' | 'config-write' | 'destructive-offline'

export type OpsSurface = 'cli' | 'web' | 'im'

/**
 * Who is invoking — drives the per-surface display gate AND the config-write
 * gate. The destructive-offline chokepoint does NOT depend on this (the shared
 * runner refuses destructive for everyone); `surface` only colours messaging
 * and the listing's `runnableHere`.
 */
export interface OpsCaller {
  surface: OpsSurface
  /**
   * May this caller execute config-write commands? CLI: true; web: only when
   * the actor is the owner (the host surface resolves that); IM: always false.
   * Read + safe-mutate ignore this; destructive-offline ignores it too (always
   * refused by the runner).
   */
  allowConfigWrite: boolean
}

/** Stable, machine-readable ops error. */
export class OpsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OpsError'
  }
}

/**
 * A tier-boundary violation — the single chokepoint that makes the asymmetry
 * unbypassable. Thrown when the shared runner is asked to run a
 * destructive-offline command (always) or a config-write command from a caller
 * that may not write config.
 */
export class OpsTierError extends OpsError {
  constructor(
    code: 'destructive_offline_cli_only' | 'config_write_not_permitted',
    readonly tier: OpsTier,
    message: string,
  ) {
    super(code, message)
    this.name = 'OpsTierError'
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Results
// ───────────────────────────────────────────────────────────────────────────

/**
 * The outcome of running one ops command. `lines` are rendered by the terminal /
 * IM surfaces; `data` is the structured payload the web surface renders richly.
 * Both come from the same run so the surfaces never disagree.
 */
export interface OpsResult {
  command: string
  tier: OpsTier
  lines: string[]
  data?: Record<string, unknown>
}

// ───────────────────────────────────────────────────────────────────────────
// Dependencies (injectable seams — pure + unit-testable)
// ───────────────────────────────────────────────────────────────────────────

/** Path classification for `fix-dirs` (mirrors the doctor's `PathProbe`). */
export type OpsPathProbe =
  | 'writable'
  | 'creatable'
  | 'exists-readonly'
  | 'not-a-dir'
  | 'blocked'

export interface OpsDeps {
  /** Workspace root (AIPE_SPACE). */
  spaceDir: string
  /** Env to read AIPE_* from. Defaults to process.env. */
  env?: Record<string, string | undefined>
  /**
   * Live hub health snapshot — present only when a RUNNING host injected it
   * (web / IM). Absent in the CLI pre-boot path, where `status` falls back to
   * the file-based checks alone (there is no live hub to probe).
   */
  health?: AdminHealthSurface
  /**
   * Directory scanned by `inventory`. Defaults to env.AIPE_BACKUP_DIR (unset →
   * no inventory dir, reported honestly rather than guessed).
   */
  backupDir?: string
  // ── seams (tests inject fakes; defaults hit the real fs / validators) ──
  validate?: typeof validateWorkspace
  readdirImpl?: (dir: string) => Promise<string[]>
  statSizeImpl?: (p: string) => Promise<number | undefined>
  probePathImpl?: (p: string) => Promise<OpsPathProbe>
  mkdirpImpl?: (p: string) => Promise<void>
}

// ── default fs seams (host-side; mirror the doctor's probe/mkdir) ────────────

async function probePathReal(p: string): Promise<OpsPathProbe> {
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
    try {
      await access(join(abs, '..'), FS.W_OK)
      return 'creatable'
    } catch {
      return 'blocked'
    }
  }
}

function mkdirpReal(p: string): Promise<void> {
  return mkdir(resolve(p), { recursive: true }).then(() => undefined)
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    // A missing backup dir means "no backups yet", not an error.
    return []
  }
}

async function statSizeSafe(p: string): Promise<number | undefined> {
  try {
    return (await stat(p)).size
  } catch {
    return undefined
  }
}

// ───────────────────────────────────────────────────────────────────────────
// safe-mutate: fix missing workspace directories
// ───────────────────────────────────────────────────────────────────────────

export interface FixDirOutcome {
  dir: string
  outcome: 'created' | 'exists' | 'failed'
  detail?: string
}

/**
 * The standard writable workspace directories `fix-dirs` ensures. Deliberately
 * SMALL and security-agnostic: the space root (what the doctor already fixes)
 * and the workflows dir operators drop YAML into — the common "I made the folder
 * structure wrong" case. The host's secured `runtime/` (master key, sessions) is
 * intentionally OMITTED: the host manages its 0700 perms, and we won't create it
 * with default perms here.
 */
export function workspaceFixDirs(
  spaceDir: string,
  env: Record<string, string | undefined> = {},
): string[] {
  const workflowsDir =
    env.AIPE_WORKFLOWS_DIR ?? join(spaceDir, 'workflows', 'definitions')
  return [spaceDir, workflowsDir]
}

/**
 * Ensure each given directory exists — `mkdir -p`, idempotent and reversible.
 * Mirrors the doctor's `applyFixes` switch: already-writable → no-op; missing →
 * attempt to create; read-only / a-file → reported, never auto-changed. Pure
 * given its seams; returns what it did, prints nothing.
 */
export async function fixMissingDirs(
  dirs: readonly string[],
  deps: Pick<OpsDeps, 'probePathImpl' | 'mkdirpImpl'> = {},
): Promise<FixDirOutcome[]> {
  const probePath = deps.probePathImpl ?? probePathReal
  const mkdirp = deps.mkdirpImpl ?? mkdirpReal
  const out: FixDirOutcome[] = []
  for (const dir of dirs) {
    const probe = await probePath(dir)
    switch (probe) {
      case 'writable':
        out.push({ dir, outcome: 'exists' })
        break
      case 'creatable':
      case 'blocked':
        try {
          await mkdirp(dir)
          out.push({ dir, outcome: 'created' })
        } catch (e) {
          out.push({
            dir,
            outcome: 'failed',
            detail: `could not create (${(e as NodeJS.ErrnoException).code ?? 'UNKNOWN'}) — create it with write access manually.`,
          })
        }
        break
      case 'exists-readonly':
        out.push({ dir, outcome: 'exists', detail: 'exists but is not writable — fix its permissions manually (not auto-changed).' })
        break
      case 'not-a-dir':
        out.push({ dir, outcome: 'failed', detail: 'a file exists at this path — move it aside manually (not auto-changed).' })
        break
    }
  }
  return out
}

// ───────────────────────────────────────────────────────────────────────────
// read: backup inventory (recovery candidates)
// ───────────────────────────────────────────────────────────────────────────

export interface BackupInventoryItem {
  /** Bare filename. */
  file: string
  /** Parsed workspace label (the leaf dir name baked into the filename). */
  label: string
  /** Parsed sortable UTC stamp, e.g. `20260626T101530Z`. */
  timestamp: string
  /** Size in bytes, best-effort (omitted on a stat fault). */
  sizeBytes?: number
}

export interface BackupInventory {
  dir: string | null
  /** Matching archives, NEWEST FIRST (the filename stamp is lexicographically sortable). */
  items: BackupInventoryItem[]
  /** Files in the dir that did not match the `aipehub-*.tar.gz` pattern. */
  ignored: number
}

// backup.sh names archives `aipehub-<label>-<YYYYMMDDThhmmssZ>.tar.gz`; the
// label may itself contain dashes, so anchor the timestamp at the tail and let
// the label be the greedy remainder.
const BACKUP_NAME_RE = /^aipehub-(.+)-(\d{8}T\d{6}Z)\.tar\.gz$/

/**
 * List the recovery candidates in a backup directory — read-only: readdir +
 * parse the sortable filenames produced by `backup.sh`, newest first. A missing
 * or unset dir yields an empty inventory (no backups yet), never an error, so
 * the surfaces can show "none" honestly.
 */
export async function readBackupInventory(
  dir: string | undefined,
  deps: Pick<OpsDeps, 'readdirImpl' | 'statSizeImpl'> = {},
): Promise<BackupInventory> {
  if (!dir || !dir.trim()) return { dir: null, items: [], ignored: 0 }
  const readdirImpl = deps.readdirImpl ?? readdirSafe
  const statSize = deps.statSizeImpl ?? statSizeSafe

  const names = await readdirImpl(dir)
  const items: BackupInventoryItem[] = []
  let ignored = 0
  for (const name of names) {
    const m = BACKUP_NAME_RE.exec(name)
    if (!m) {
      ignored++
      continue
    }
    const sizeBytes = await statSize(join(dir, name))
    items.push({ file: name, label: m[1]!, timestamp: m[2]!, ...(sizeBytes !== undefined ? { sizeBytes } : {}) })
  }
  // Descending by the sortable stamp = chronological, newest first.
  items.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
  return { dir, items, ignored }
}

// ───────────────────────────────────────────────────────────────────────────
// The command catalog
// ───────────────────────────────────────────────────────────────────────────

interface OpsCommandDef {
  id: string
  tier: OpsTier
  /** Short human title (shown in lists). */
  title: string
  /** One-line description of what it does. */
  summary: string
  /** When a surface can't run it — where to go instead. */
  whereToRun?: string
  /**
   * Handler. ABSENT for destructive-offline commands: those are display-only in
   * ops-core (the CLI adapter runs the real scripts directly). The shared runner
   * refuses them, so they never need a handler here.
   */
  run?: (args: readonly string[], caller: OpsCaller, deps: OpsDeps) => Promise<OpsResult>
}

/** Public, caller-aware view of one command for listing. */
export interface OpsCommandInfo {
  id: string
  tier: OpsTier
  title: string
  summary: string
  whereToRun?: string
  /** Can the CURRENT caller's surface execute this? false → display-only here. */
  runnableHere: boolean
}

/** Is `tier` executable on `caller`'s surface (for the catalog's display flag)? */
function runnableOnSurface(tier: OpsTier, caller: OpsCaller): boolean {
  switch (tier) {
    case 'read':
    case 'safe-mutate':
      return true
    case 'config-write':
      return caller.allowConfigWrite
    case 'destructive-offline':
      // CLI offers these directly (bypassing the shared runner). Web/IM cannot.
      return caller.surface === 'cli'
  }
}

const CLI_HINT = 'Run it from the server CLI: the hub is down (or being replaced) during this operation, so only the CLI can.'
const OWNER_HINT = 'A hub owner makes this change from the admin web UI or the server CLI.'

// The catalog. M1 ships read + safe-mutate + the destructive-offline listings;
// config-write commands are ADDED to this array in M3.
const COMMANDS: OpsCommandDef[] = [
  {
    id: 'status',
    tier: 'read',
    title: 'Status snapshot',
    summary: 'Where is my hub right now — definition counts, config check verdict, and (when the hub is running) live health.',
    run: runStatus,
  },
  {
    id: 'check',
    tier: 'read',
    title: 'Validate workspace',
    summary: 'Deterministic config + workflow + agent validation (the same checks as `aipehub check` and boot).',
    run: runCheck,
  },
  {
    id: 'list',
    tier: 'read',
    title: 'List ops commands',
    summary: 'Every setting command, its tier, and where it can run.',
    run: runList,
  },
  {
    id: 'inventory',
    tier: 'read',
    title: 'Backup inventory',
    summary: 'Recovery candidates in the backup directory (read-only listing, newest first).',
    run: runInventory,
  },
  {
    id: 'fix-dirs',
    tier: 'safe-mutate',
    title: 'Create missing dirs',
    summary: 'Ensure the workspace directories exist (mkdir -p; idempotent, reversible).',
    run: runFixDirs,
  },
  // ── destructive-offline: listed for display, run ONLY from the CLI adapter ──
  {
    id: 'cold-start',
    tier: 'destructive-offline',
    title: 'Cold start',
    summary: 'Pre-flight → validate definitions → boot the host. CLI-only.',
    whereToRun: CLI_HINT,
  },
  {
    id: 'restore',
    tier: 'destructive-offline',
    title: 'Restore from backup',
    summary: 'Extract a backup tarball into a fresh workspace (runs verify.sh). CLI-only.',
    whereToRun: CLI_HINT,
  },
  {
    id: 'rotate-master-key',
    tier: 'destructive-offline',
    title: 'Rotate master key',
    summary: 'Rotate the identity-vault master key. CLI-only.',
    whereToRun: CLI_HINT,
  },
]

/** Hint for a config-write command a given caller may not run (M3 uses this). */
export function configWriteHint(): string {
  return OWNER_HINT
}

function byId(id: string): OpsCommandDef | undefined {
  return COMMANDS.find((c) => c.id === id)
}

/**
 * The full ops catalog, annotated for `caller`'s surface. Always lists every
 * tier so the surface can DISPLAY the whole lifecycle; `runnableHere` says
 * whether this surface can actually execute each one.
 */
export function listOpsCommands(caller: OpsCaller): OpsCommandInfo[] {
  return COMMANDS.map((c) => ({
    id: c.id,
    tier: c.tier,
    title: c.title,
    summary: c.summary,
    ...(c.whereToRun ? { whereToRun: c.whereToRun } : {}),
    runnableHere: runnableOnSurface(c.tier, caller),
  }))
}

/**
 * Run one ops command through the SHARED online runner. This is the single
 * chokepoint that enforces the tier boundary:
 *
 *   - destructive-offline  → ALWAYS throws OpsTierError. The shared runner never
 *     runs them; the CLI adapter invokes the real scripts directly. Web/IM thus
 *     can never reach a destructive op through here, by construction.
 *   - config-write         → throws OpsTierError unless caller.allowConfigWrite.
 *   - read / safe-mutate    → run.
 *
 * `deps.spaceDir` is required; everything else has a default or is optional.
 */
export async function runOpsCommand(
  id: string,
  args: readonly string[],
  caller: OpsCaller,
  deps: OpsDeps,
): Promise<OpsResult> {
  const def = byId(id)
  if (!def) {
    throw new OpsError('unknown_command', `unknown setting command: '${id}'. Run \`setting list\` to see them.`)
  }
  if (def.tier === 'destructive-offline') {
    throw new OpsTierError(
      'destructive_offline_cli_only',
      def.tier,
      `'${id}' is a destructive, offline operation — it can only run from the server CLI (the hub is down or being replaced while it runs). ${CLI_HINT}`,
    )
  }
  if (def.tier === 'config-write' && !caller.allowConfigWrite) {
    throw new OpsTierError(
      'config_write_not_permitted',
      def.tier,
      `'${id}' writes configuration and is not permitted from this surface. ${OWNER_HINT}`,
    )
  }
  if (!def.run) {
    // Only reachable if a non-destructive command lacks a handler — a coding bug.
    throw new OpsError('not_executable', `'${id}' has no runner.`)
  }
  return def.run(args, caller, deps)
}

// ───────────────────────────────────────────────────────────────────────────
// read-tier handlers
// ───────────────────────────────────────────────────────────────────────────

async function runStatus(_args: readonly string[], _caller: OpsCaller, deps: OpsDeps): Promise<OpsResult> {
  const validate = deps.validate ?? validateWorkspace
  const report = await validate({ spaceDir: deps.spaceDir, env: deps.env })

  // Live health is present only when a running host injected it. Best-effort:
  // a probe fault degrades to "no live health", never a thrown status.
  let health: HealthSnapshot | undefined
  if (deps.health) {
    try {
      health = await deps.health.snapshot()
    } catch {
      health = undefined
    }
  }

  const lines: string[] = []
  lines.push(`workspace : ${deps.spaceDir}`)
  lines.push(
    `defns     : ${report.workflows.ok} workflow(s)${report.workflows.bad ? `, ${report.workflows.bad} BAD` : ''}` +
      ` · ${report.agents.ok} agent(s)${report.agents.bad ? `, ${report.agents.bad} BAD` : ''}`,
  )
  lines.push(
    report.errors > 0
      ? `config    : ${report.errors} error(s), ${report.warnings} warning(s) — run \`setting check\` for details`
      : report.warnings > 0
        ? `config    : ${report.warnings} warning(s), 0 errors`
        : `config    : ok`,
  )
  if (health) {
    lines.push(
      `hub       : ${health.onlineCount}/${health.managedCount} agent(s) online` +
        `${health.agentsMissingKey ? `, ${health.agentsMissingKey} missing key` : ''}` +
        `${health.mcpUnwired ? `, ${health.mcpUnwired} MCP unused` : ''}` +
        `${health.spaceWritable ? '' : ', SPACE NOT WRITABLE'}`,
    )
  } else {
    lines.push('hub       : not running (file checks only)')
  }

  return {
    command: 'status',
    tier: 'read',
    lines,
    data: {
      spacePath: deps.spaceDir,
      check: {
        errors: report.errors,
        warnings: report.warnings,
        workflows: report.workflows,
        agents: report.agents,
      },
      ...(health ? { health } : {}),
    },
  }
}

async function runCheck(_args: readonly string[], _caller: OpsCaller, deps: OpsDeps): Promise<OpsResult> {
  const validate = deps.validate ?? validateWorkspace
  const report: WorkspaceCheckReport = await validate({ spaceDir: deps.spaceDir, env: deps.env })
  return {
    command: 'check',
    tier: 'read',
    lines: formatCheckReport(report).split('\n'),
    data: {
      errors: report.errors,
      warnings: report.warnings,
      workflows: report.workflows,
      agents: report.agents,
      findings: report.findings,
    },
  }
}

async function runList(_args: readonly string[], caller: OpsCaller, _deps: OpsDeps): Promise<OpsResult> {
  const cmds = listOpsCommands(caller)
  const lines: string[] = ['setting commands:']
  for (const c of cmds) {
    const mark = c.runnableHere ? '•' : '×'
    lines.push(`  ${mark} ${c.id.padEnd(18)} [${c.tier}] ${c.title}`)
    if (!c.runnableHere && c.whereToRun) lines.push(`      → ${c.whereToRun}`)
  }
  return { command: 'list', tier: 'read', lines, data: { commands: cmds } }
}

async function runInventory(_args: readonly string[], _caller: OpsCaller, deps: OpsDeps): Promise<OpsResult> {
  const backupDir = deps.backupDir ?? deps.env?.AIPE_BACKUP_DIR
  const inv = await readBackupInventory(backupDir, deps)
  const lines: string[] = []
  if (!inv.dir) {
    lines.push('backup dir: not set (set AIPE_BACKUP_DIR, or pass a backup directory).')
  } else if (inv.items.length === 0) {
    lines.push(`backup dir: ${inv.dir} — no backups found.`)
  } else {
    lines.push(`backups in ${inv.dir} (newest first):`)
    for (const it of inv.items) {
      const size = it.sizeBytes !== undefined ? ` (${humanSize(it.sizeBytes)})` : ''
      lines.push(`  ${it.timestamp}  ${it.file}${size}`)
    }
  }
  return { command: 'inventory', tier: 'read', lines, data: { ...inv } }
}

async function runFixDirs(_args: readonly string[], _caller: OpsCaller, deps: OpsDeps): Promise<OpsResult> {
  const dirs = workspaceFixDirs(deps.spaceDir, deps.env ?? {})
  const outcomes = await fixMissingDirs(dirs, deps)
  const lines = outcomes.map((o) => {
    const mark = o.outcome === 'created' ? '✓ created' : o.outcome === 'exists' ? '• exists ' : '✖ failed '
    return `  ${mark}  ${o.dir}${o.detail ? ` — ${o.detail}` : ''}`
  })
  return { command: 'fix-dirs', tier: 'safe-mutate', lines: ['ensure workspace directories:', ...lines], data: { outcomes } }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
