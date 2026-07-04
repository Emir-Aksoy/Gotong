/**
 * `workspace-check` — deterministic, NON-AI validation of a host's on-disk
 * workspace + runtime config.
 *
 * This is the "主机配置体检 + 载入定义正确性审核" the operator asked for: a
 * settings checker that uses fixed rules — never an LLM — to answer three
 * questions before (or instead of) booting:
 *
 *   1. config 体检   — is the runtime config self-consistent and safe?
 *                      (exposure security, gating/lang enums, ports, master key)
 *   2. workflow 文件 — does every `*.yaml`/`*.json` under workflows/definitions
 *                      parse into a valid `WorkflowDefinition`? (syntax/schema)
 *   3. agents.json   — is `<space>/agents.json` valid JSON of the right shape,
 *                      with loadable agent rows? (syntax/schema)
 *
 * It REUSES the real validators rather than re-deriving them, so a green check
 * means the same thing the boot path means:
 *   - `auditBootSecurity` (boot-security.ts) for the exposure self-check,
 *   - `loadWorkflows` (workflow-loader.ts → `parseWorkflow`) for workflows,
 *   - JSON.parse + a structural shape check for agents (there is no standalone
 *     object validator — `parseManifest` validates TEXT, not the persisted
 *     `agents.json` array — so we narrow the parsed JSON against the loadable
 *     contract: a row that breaks `LocalAgentPool` construction is an error).
 *
 * Pure + injectable so the policy is unit-tested; the only side effects live in
 * `runCheckCli`'s default file seams. NOTHING here boots a server — this module
 * is exported from `@gotong/host` under the non-booting `./check` subpath so
 * the CLI's `gotong check` can import it without becoming the host.
 *
 * Honest scope: "syntax/schema correctness", per the operator's "只审核文件是
 * 否有语法错误". Deeper cross-reference checks (does a dispatch target a
 * registered agent? — still NON-AI) live in `@gotong/evals`
 * `checkWorkflowStructure` and stay opt-in; this checker answers "will the file
 * even load", which is the question that keeps a live hub healthy.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  auditBootSecurity,
  isLoopbackHost,
  type BootSecurityViolation,
} from './boot-security.js'
import {
  loadWorkflows,
  type LoadReport,
} from './workflow-loader.js'

// ───────────────────────────────────────────────────────────────────────────
// Result shapes
// ───────────────────────────────────────────────────────────────────────────

export type CheckLevel = 'error' | 'warn' | 'info'
export type CheckDomain = 'config' | 'workflow' | 'agent'

export interface CheckFinding {
  domain: CheckDomain
  level: CheckLevel
  /** Stable machine code, e.g. `config.bad_gating`, `workflow.parse_failed`. */
  code: string
  /** One-line human statement of what's wrong. */
  message: string
  /** Concrete remediation, when there is an obvious one. */
  fix?: string
  /** The file the finding is about (workflow / agents path), when applicable. */
  file?: string
}

export interface WorkspaceCheckReport {
  findings: CheckFinding[]
  /** Count of error-level findings (the gate signal). */
  errors: number
  /** Count of warn-level findings. */
  warnings: number
  /** Workflow files: how many parsed vs failed. */
  workflows: { ok: number; bad: number }
  /** Agent rows in agents.json: how many are loadable vs broken. */
  agents: { ok: number; bad: number }
}

// ───────────────────────────────────────────────────────────────────────────
// 1. config 体检
// ───────────────────────────────────────────────────────────────────────────

/** Pre-resolved runtime config the host config check evaluates. */
export interface HostConfigCheckInput {
  /** Bind address (SpaceConfig.host). */
  host: string
  /** Secure cookie flag (SpaceConfig.cookieSecure). */
  cookieSecure: boolean
  /** SpaceConfig.gating — must be 'open' | 'admin-approval'. */
  gating: string
  /** SpaceConfig.defaultLang — must be 'zh' | 'en'. */
  defaultLang: string
  /** SpaceConfig.webPort. */
  webPort: number
  /** SpaceConfig.wsPort. */
  wsPort: number
  /** Parsed GOTONG_ALLOWED_HOSTS (undefined/empty = unset). */
  allowedHosts: string[] | undefined
  /** GOTONG_ALLOW_INSECURE — downgrade exposure fatals to warnings. */
  allowInsecure: boolean
  /** GOTONG_MASTER_KEY_PROVIDER ('' = file-based default). */
  masterKeyProvider: string
  /** Whether GOTONG_MASTER_KEY is non-empty. Presence ONLY — never the value. */
  masterKeyPresent: boolean
}

const GATING_VALUES = new Set(['open', 'admin-approval'])
const LANG_VALUES = new Set(['zh', 'en'])

/**
 * Deterministic config audit. Pure: same input → same findings, no I/O, no LLM.
 * Reuses `auditBootSecurity` so the exposure verdict is byte-identical to the
 * real boot gate (main.ts already fails-closed on its fatals).
 */
export function checkHostConfig(input: HostConfigCheckInput): CheckFinding[] {
  const out: CheckFinding[] = []

  // (a) Network-exposure self-check — reuse the real boot auditor verbatim.
  const sec: BootSecurityViolation[] = auditBootSecurity({
    host: input.host,
    cookieSecure: input.cookieSecure,
    allowedHosts: input.allowedHosts,
    allowInsecure: input.allowInsecure,
  })
  for (const v of sec) {
    out.push({
      domain: 'config',
      level: v.severity === 'fatal' ? 'error' : 'warn',
      code: `config.${v.code}`,
      message: v.message,
      fix: v.remediation,
    })
  }

  // (b) Enum sanity — main.ts throws on a bad GOTONG_GATING / GOTONG_DEFAULT_LANG,
  // but a hand-edited config.json can hold a bad value the env path never saw.
  if (!GATING_VALUES.has(input.gating)) {
    out.push({
      domain: 'config',
      level: 'error',
      code: 'config.bad_gating',
      message: `gating is '${input.gating}' — must be 'open' or 'admin-approval'.`,
      fix: `set GOTONG_GATING (or config.json gating) to 'open' or 'admin-approval'.`,
    })
  }
  if (!LANG_VALUES.has(input.defaultLang)) {
    out.push({
      domain: 'config',
      level: 'error',
      code: 'config.bad_lang',
      message: `defaultLang is '${input.defaultLang}' — must be 'zh' or 'en'.`,
      fix: `set GOTONG_DEFAULT_LANG (or config.json defaultLang) to 'zh' or 'en'.`,
    })
  }

  // (c) Ports — valid range + no collision (both can't share one port).
  for (const [label, port, envVar] of [
    ['web', input.webPort, 'GOTONG_WEB_PORT'],
    ['ws', input.wsPort, 'GOTONG_WS_PORT'],
  ] as const) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      out.push({
        domain: 'config',
        level: 'error',
        code: `config.bad_${label}_port`,
        message: `${label} port is ${port} — must be an integer in 1..65535.`,
        fix: `set ${envVar} to a valid port.`,
      })
    }
  }
  if (
    Number.isInteger(input.webPort) &&
    input.webPort === input.wsPort
  ) {
    out.push({
      domain: 'config',
      level: 'error',
      code: 'config.port_collision',
      message: `web and agent-WS ports are both ${input.webPort} — they must differ.`,
      fix: `set GOTONG_WEB_PORT and GOTONG_WS_PORT to two different ports.`,
    })
  }

  // (d) Master key — provider=env requires the material to be present.
  if (input.masterKeyProvider === 'env' && !input.masterKeyPresent) {
    out.push({
      domain: 'config',
      level: 'error',
      code: 'config.master_key_missing',
      message: `GOTONG_MASTER_KEY_PROVIDER=env but GOTONG_MASTER_KEY is empty.`,
      fix: `set GOTONG_MASTER_KEY (64 hex chars), or unset the provider to use the auto-generated file key.`,
    })
  }

  // (e) Advisory — open gating on a network-exposed host means anyone who can
  // reach the port can use the hub with no admin approval. Not fatal (an
  // operator may want this behind an upstream gate), but worth surfacing.
  if (input.gating === 'open' && !isLoopbackHost(input.host)) {
    out.push({
      domain: 'config',
      level: 'warn',
      code: 'config.open_gating_exposed',
      message: `gating='open' on a network-exposed host (${input.host}) — anyone who can reach it joins without admin approval.`,
      fix: `set GOTONG_GATING=admin-approval, or ensure an upstream gate restricts who can reach the port.`,
    })
  }

  return out
}

// ───────────────────────────────────────────────────────────────────────────
// 2. workflow 文件
// ───────────────────────────────────────────────────────────────────────────

export interface WorkflowCheckResult {
  findings: CheckFinding[]
  ok: number
  bad: number
}

/**
 * Map a workflow loader `LoadReport` to check findings — one error per file the
 * loader couldn't parse. Shared by `checkWorkflowFiles` (the CLI path, which
 * re-loads) and the host boot banner (which ALREADY holds a `LoadReport` from
 * its own load and must NOT re-read), so "what `gotong check` flags" and "what
 * boot flags" can never drift.
 */
export function workflowFindingsFromReport(report: LoadReport): CheckFinding[] {
  return report.failed.map((f) => ({
    domain: 'workflow' as const,
    level: 'error' as const,
    code: 'workflow.parse_failed',
    message: f.error,
    fix: 'fix the YAML/JSON so it parses as gotong.workflow/v1, or remove the file.',
    file: f.file,
  }))
}

/**
 * Validate every workflow file under `dir` by reusing `loadWorkflows` — so a
 * file passes here iff the host would actually parse it at boot. Each
 * `report.failed` row becomes an error finding; a clean directory (or a missing
 * one) yields no findings.
 */
export async function checkWorkflowFiles(
  dir: string,
  loadImpl: typeof loadWorkflows = loadWorkflows,
): Promise<WorkflowCheckResult> {
  const report: LoadReport = await loadImpl({ dir })
  return {
    findings: workflowFindingsFromReport(report),
    ok: report.loaded.length,
    bad: report.failed.length,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 3. agents.json
// ───────────────────────────────────────────────────────────────────────────

export interface AgentsCheckResult {
  findings: CheckFinding[]
  ok: number
  bad: number
}

const AGENT_KINDS = new Set(['llm', 'personal-growth'])
const AGENT_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'openai-compatible',
  'mock',
])

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Validate `<space>/agents.json` to the "will it load" bar.
 *
 * No file → no findings (a hub with zero managed agents is valid). Otherwise:
 * JSON must parse, the top level must be `{ agents: [...] }`, and each row must
 * have a usable `id`; managed rows must carry a known provider/kind and (for
 * `openai-compatible`) a `baseURL`, since those are the deterministic
 * preconditions `LocalAgentPool` needs to construct the agent. Unknown extra
 * fields are tolerated (forward-compatible — we flag what BREAKS loading, not
 * everything that's unfamiliar).
 */
export async function checkAgentsFile(
  agentsPath: string,
  readImpl: (p: string) => Promise<string> = (p) => readFile(p, 'utf8'),
  existsImpl: (p: string) => boolean = existsSync,
): Promise<AgentsCheckResult> {
  if (!existsImpl(agentsPath)) {
    return { findings: [], ok: 0, bad: 0 }
  }

  let raw: string
  try {
    raw = await readImpl(agentsPath)
  } catch (err) {
    return {
      findings: [
        {
          domain: 'agent',
          level: 'error',
          code: 'agent.read_failed',
          message: `cannot read agents file: ${err instanceof Error ? err.message : String(err)}`,
          file: agentsPath,
        },
      ],
      ok: 0,
      bad: 0,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      findings: [
        {
          domain: 'agent',
          level: 'error',
          code: 'agent.invalid_json',
          message: `agents.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          fix: 'fix the JSON syntax (trailing comma, unquoted key, …).',
          file: agentsPath,
        },
      ],
      ok: 0,
      bad: 0,
    }
  }

  if (!isObject(parsed) || !Array.isArray((parsed as { agents?: unknown }).agents)) {
    return {
      findings: [
        {
          domain: 'agent',
          level: 'error',
          code: 'agent.bad_shape',
          message: `agents.json must be an object with an "agents" array.`,
          fix: 'wrap the rows as { "agents": [ … ] }.',
          file: agentsPath,
        },
      ],
      ok: 0,
      bad: 0,
    }
  }

  const rows = (parsed as { agents: unknown[] }).agents
  const findings: CheckFinding[] = []
  const seenIds = new Set<string>()
  let bad = 0

  rows.forEach((row, i) => {
    const where = `agents[${i}]`
    let rowBad = false
    const fail = (code: string, message: string, fix?: string) => {
      rowBad = true
      findings.push({ domain: 'agent', level: 'error', code, message, fix, file: agentsPath })
    }

    if (!isObject(row)) {
      fail('agent.bad_row', `${where} is not an object.`)
      bad++
      return
    }

    const id = row.id
    if (typeof id !== 'string' || id.trim() === '') {
      fail('agent.missing_id', `${where} has no non-empty string "id".`, 'every agent row needs a unique string id.')
    } else if (seenIds.has(id)) {
      fail('agent.duplicate_id', `${where} repeats id '${id}' — ids must be unique.`, 'rename or remove the duplicate row.')
    } else {
      seenIds.add(id)
    }

    if (row.allowedCapabilities !== undefined && !Array.isArray(row.allowedCapabilities)) {
      fail('agent.bad_capabilities', `${where} (${idLabel(id)}) has a non-array "allowedCapabilities".`, 'allowedCapabilities must be an array of capability strings.')
    }

    const managed = row.managed
    if (managed !== undefined) {
      if (!isObject(managed)) {
        fail('agent.bad_managed', `${where} (${idLabel(id)}) has a non-object "managed".`)
      } else {
        if (managed.kind !== undefined && !AGENT_KINDS.has(managed.kind as string)) {
          fail('agent.bad_kind', `${where} (${idLabel(id)}) managed.kind='${String(managed.kind)}' — must be ${[...AGENT_KINDS].map((k) => `'${k}'`).join(' or ')}.`)
        }
        if (managed.provider !== undefined && !AGENT_PROVIDERS.has(managed.provider as string)) {
          fail('agent.bad_provider', `${where} (${idLabel(id)}) managed.provider='${String(managed.provider)}' — must be one of ${[...AGENT_PROVIDERS].map((p) => `'${p}'`).join(', ')}.`)
        }
        if (managed.provider === 'openai-compatible') {
          const baseURL = managed.baseURL
          if (typeof baseURL !== 'string' || baseURL.trim() === '') {
            fail('agent.missing_base_url', `${where} (${idLabel(id)}) provider='openai-compatible' but managed.baseURL is missing.`, 'set managed.baseURL to the OpenAI-compatible endpoint.')
          }
        }
      }
    }

    if (rowBad) bad++
  })

  return { findings, ok: rows.length - bad, bad }
}

function idLabel(id: unknown): string {
  return typeof id === 'string' && id.trim() !== '' ? id : '?'
}

// ───────────────────────────────────────────────────────────────────────────
// Aggregate
// ───────────────────────────────────────────────────────────────────────────

export interface ValidateWorkspaceOptions {
  /** Workspace root (GOTONG_SPACE). */
  spaceDir: string
  /** Environment to read GOTONG_* from (defaults to process.env). */
  env?: Record<string, string | undefined>
  /**
   * Pre-resolved live SpaceConfig — boot passes this so the check sees exactly
   * what the host resolved. Omitted in standalone `gotong check`, where we read
   * `<space>/config.json` + env overrides + defaults ourselves.
   */
  config?: {
    host: string
    cookieSecure: boolean
    gating: string
    defaultLang: string
    webPort: number
    wsPort: number
  }
  /** Override the workflows dir (defaults to GOTONG_WORKFLOWS_DIR or <space>/workflows/definitions). */
  workflowsDir?: string
  /** Override the agents.json path (defaults to <space>/agents.json). */
  agentsPath?: string
  // ── injectable seams (tests) ──
  loadWorkflowsImpl?: typeof loadWorkflows
  readFileImpl?: (p: string) => Promise<string>
  existsImpl?: (p: string) => boolean
}

/**
 * Run all three checks against a workspace and aggregate into one report.
 * Never throws: a malformed config.json becomes a finding, not a crash.
 */
export async function validateWorkspace(
  opts: ValidateWorkspaceOptions,
): Promise<WorkspaceCheckReport> {
  const env = opts.env ?? process.env
  const existsImpl = opts.existsImpl ?? existsSync
  const readFileImpl = opts.readFileImpl ?? ((p: string) => readFile(p, 'utf8'))

  const findings: CheckFinding[] = []

  // ── config 体检 ──
  const { input: cfgInput, findings: cfgResolveFindings } = await resolveConfigInput(
    opts.spaceDir,
    env,
    opts.config,
    { existsImpl, readFileImpl },
  )
  findings.push(...cfgResolveFindings)
  findings.push(...checkHostConfig(cfgInput))

  // ── workflow 文件 ──
  const workflowsDir =
    opts.workflowsDir ??
    env.GOTONG_WORKFLOWS_DIR ??
    join(opts.spaceDir, 'workflows', 'definitions')
  const wf = await checkWorkflowFiles(workflowsDir, opts.loadWorkflowsImpl ?? loadWorkflows)
  findings.push(...wf.findings)

  // ── agents.json ──
  const agentsPath = opts.agentsPath ?? join(opts.spaceDir, 'agents.json')
  const ag = await checkAgentsFile(agentsPath, readFileImpl, existsImpl)
  findings.push(...ag.findings)

  const errors = findings.filter((f) => f.level === 'error').length
  const warnings = findings.filter((f) => f.level === 'warn').length

  return {
    findings,
    errors,
    warnings,
    workflows: { ok: wf.ok, bad: wf.bad },
    agents: { ok: ag.ok, bad: ag.bad },
  }
}

/**
 * Build a `WorkspaceCheckReport` covering ONLY the loaded definitions (workflows
 * + agents), from data the host already holds at boot — a workflow loader
 * `LoadReport` and an `AgentsCheckResult` — WITHOUT re-reading anything. The
 * host boot path uses this for its loud "these files won't load" banner: the
 * config 体检 is enforced separately at boot (`auditBootSecurity` fails closed
 * on its fatals), so this subset deliberately omits the `config` domain.
 * `formatCheckReport` renders it.
 */
export function definitionsReport(
  workflowReport: LoadReport,
  agentsCheck: AgentsCheckResult,
): WorkspaceCheckReport {
  const findings: CheckFinding[] = [
    ...workflowFindingsFromReport(workflowReport),
    ...agentsCheck.findings,
  ]
  return {
    findings,
    errors: findings.filter((f) => f.level === 'error').length,
    warnings: findings.filter((f) => f.level === 'warn').length,
    workflows: { ok: workflowReport.loaded.length, bad: workflowReport.failed.length },
    agents: { ok: agentsCheck.ok, bad: agentsCheck.bad },
  }
}

/**
 * Resolve the `HostConfigCheckInput` for the config 体检. When `liveConfig` is
 * provided (boot), use it for the SpaceConfig fields; otherwise read
 * `<space>/config.json` and apply env precedence (env > persisted > default),
 * mirroring main.ts. A malformed config.json yields a config finding (and we
 * fall back to env+defaults so the rest of the audit still runs).
 */
async function resolveConfigInput(
  spaceDir: string,
  env: Record<string, string | undefined>,
  liveConfig: ValidateWorkspaceOptions['config'],
  seams: { existsImpl: (p: string) => boolean; readFileImpl: (p: string) => Promise<string> },
): Promise<{ input: HostConfigCheckInput; findings: CheckFinding[] }> {
  const findings: CheckFinding[] = []

  let host: string
  let cookieSecure: boolean
  let gating: string
  let defaultLang: string
  let webPort: number
  let wsPort: number

  if (liveConfig) {
    ;({ host, cookieSecure, gating, defaultLang, webPort, wsPort } = liveConfig)
  } else {
    let persisted: Record<string, unknown> = {}
    const configPath = join(spaceDir, 'config.json')
    if (seams.existsImpl(configPath)) {
      try {
        const parsed = JSON.parse(await seams.readFileImpl(configPath))
        if (isObject(parsed)) persisted = parsed
      } catch (err) {
        findings.push({
          domain: 'config',
          level: 'error',
          code: 'config.bad_config_json',
          message: `config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          fix: 'fix the JSON syntax in <space>/config.json.',
          file: configPath,
        })
      }
    }
    host = pickStr(env.GOTONG_HOST, persisted.host, '127.0.0.1')
    cookieSecure = pickBool(env.GOTONG_COOKIE_SECURE, persisted.cookieSecure, false)
    gating = pickStr(env.GOTONG_GATING, persisted.gating, 'admin-approval')
    defaultLang = pickStr(env.GOTONG_DEFAULT_LANG, persisted.defaultLang, 'zh')
    webPort = pickInt(env.GOTONG_WEB_PORT, persisted.webPort, 3000)
    wsPort = pickInt(env.GOTONG_WS_PORT, persisted.wsPort, 4000)
  }

  const input: HostConfigCheckInput = {
    host,
    cookieSecure,
    gating,
    defaultLang,
    webPort,
    wsPort,
    allowedHosts: parseList(env.GOTONG_ALLOWED_HOSTS),
    allowInsecure: parseBoolEnv(env.GOTONG_ALLOW_INSECURE),
    masterKeyProvider: (env.GOTONG_MASTER_KEY_PROVIDER ?? '').trim(),
    masterKeyPresent: (env.GOTONG_MASTER_KEY ?? '').trim() !== '',
  }
  return { input, findings }
}

function pickStr(envVal: string | undefined, persisted: unknown, def: string): string {
  if (envVal !== undefined) return envVal
  if (typeof persisted === 'string') return persisted
  return def
}
function pickBool(envVal: string | undefined, persisted: unknown, def: boolean): boolean {
  if (envVal !== undefined) return parseBoolEnv(envVal)
  if (typeof persisted === 'boolean') return persisted
  return def
}
function pickInt(envVal: string | undefined, persisted: unknown, def: number): number {
  if (envVal !== undefined) {
    const n = Number(envVal.trim())
    return Number.isInteger(n) ? n : def
  }
  if (typeof persisted === 'number' && Number.isInteger(persisted)) return persisted
  return def
}
function parseBoolEnv(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}
function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return items.length ? items : undefined
}

// ───────────────────────────────────────────────────────────────────────────
// Formatting
// ───────────────────────────────────────────────────────────────────────────

const MARK: Record<CheckLevel, string> = { error: '✖', warn: '⚠', info: 'ℹ' }
const DOMAIN_LABEL: Record<CheckDomain, string> = {
  config: '主机配置 (config)',
  workflow: '工作流文件 (workflows)',
  agent: '智能体 (agents.json)',
}

/**
 * Render the report for a terminal / boot banner. Groups findings by domain and
 * ends with a one-line verdict. `compact` drops the per-finding fix lines (used
 * for the boot banner where space is tight).
 */
export function formatCheckReport(
  report: WorkspaceCheckReport,
  opts: { compact?: boolean } = {},
): string {
  const lines: string[] = []
  if (report.findings.length === 0) {
    lines.push('✓ workspace check passed — config, workflows and agents look good.')
    lines.push(
      `  (${report.workflows.ok} workflow file(s), ${report.agents.ok} agent row(s), 0 problems)`,
    )
    return lines.join('\n')
  }

  for (const domain of ['config', 'workflow', 'agent'] as const) {
    const inDomain = report.findings.filter((f) => f.domain === domain)
    if (inDomain.length === 0) continue
    lines.push(`${DOMAIN_LABEL[domain]}:`)
    for (const f of inDomain) {
      const at = f.file ? ` (${f.file})` : ''
      lines.push(`  ${MARK[f.level]} [${f.code}]${at} ${f.message}`)
      if (!opts.compact && f.fix) lines.push(`      fix: ${f.fix}`)
    }
  }

  lines.push('')
  lines.push(
    report.errors > 0
      ? `✖ ${report.errors} error(s), ${report.warnings} warning(s) — fix the errors above.`
      : `⚠ ${report.warnings} warning(s), 0 errors — safe to run, review the warnings.`,
  )
  return lines.join('\n')
}

// ───────────────────────────────────────────────────────────────────────────
// CLI entry (non-booting) — exported via @gotong/host/check
// ───────────────────────────────────────────────────────────────────────────

export interface RunCheckDeps {
  argv?: readonly string[]
  env?: Record<string, string | undefined>
  out?: (line: string) => void
  err?: (line: string) => void
  /** Injectable validator (tests). */
  validate?: typeof validateWorkspace
}

/**
 * `gotong check` body. Validates the workspace pointed at by GOTONG_SPACE and
 * prints the report. Exit code:
 *   - 0   no errors  (warnings allowed)
 *   - 1   any error  — OR any warning when `--strict`
 *
 * Never boots a server; safe to import from the CLI.
 */
export async function runCheckCli(deps: RunCheckDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2)
  const env = deps.env ?? process.env
  const out = deps.out ?? ((l: string) => { process.stdout.write(l + '\n') })
  const err = deps.err ?? ((l: string) => { console.error(l) })
  const validate = deps.validate ?? validateWorkspace

  if (argv.includes('--help') || argv.includes('-h')) {
    out(CHECK_HELP)
    return 0
  }
  const strict = argv.includes('--strict')
  const stray = argv.find((a) => a !== '--strict' && a !== '--help' && a !== '-h')
  if (stray) {
    err(`[gotong check] unexpected argument: ${stray}`)
    err('  Run `gotong check --help` for usage.')
    return 2
  }

  const spaceDir = (env.GOTONG_SPACE ?? '.gotong').trim() || '.gotong'
  const report = await validate({ spaceDir, env })
  out(formatCheckReport(report))

  if (report.errors > 0) return 1
  if (strict && report.warnings > 0) {
    err('[gotong check] --strict: treating warnings as failures.')
    return 1
  }
  return 0
}

const CHECK_HELP = `gotong check [--strict]

Deterministic (non-AI) self-check of the workspace GOTONG_SPACE points at:

  1. 主机配置体检 — exposure security, gating/lang enums, ports, master key
  2. 工作流文件   — every workflows/definitions/*.yaml|json parses
  3. 智能体        — agents.json is valid JSON of the loadable shape

Reads, never writes; never boots the server. Exit 0 if no errors (warnings
allowed); exit 1 on any error, or on any warning with --strict.

Configured via the same GOTONG_* environment variables as the host, e.g.:

  GOTONG_SPACE=.gotong          workspace directory to check
  GOTONG_WORKFLOWS_DIR=…         override the workflows directory

Run it before \`gotong start\`, or wire \`GOTONG_STRICT_DEFINITIONS=1\` into the
host to refuse to boot when a definition file is broken.
`
