/**
 * `ops-config-write` — the deterministic (NON-AI) config-write tier behind the
 * unified `setting` console (M3). Owner-gated, validated BEFORE anything lands on
 * disk, and audited. It writes only the two things the host actually reads as
 * configuration files, plus a read-only effective view:
 *
 *   1. A managed env file `<space>/gotong.env` — a WHITELIST of non-secret
 *      deterministic knobs (mode / ports / open-browser). The launcher and a
 *      documented systemd `EnvironmentFile=` source it BEFORE the host starts,
 *      so the host still only ever reads `process.env` — the boot read path is
 *      byte-for-byte unchanged. Changes take effect on the NEXT restart (there
 *      is no runtime hot-reload, and we do not invent one).
 *   2. `<space>/pricing.json` — the one config file the host genuinely reads
 *      (the cost table). Validated through the SAME shape authority the boot path
 *      uses (`validatePricingTable`), so a bad price is refused here instead of
 *      blowing up at the next boot.
 *
 * Hard rule, mirroring the steward "env-name not value" discipline: SECRET-name
 * keys (`*_TOKEN`/`*_SECRET`/`*_KEY`/master-key) are REFUSED before any write.
 * Credentials never pass through this editor — they stay in the vault / setup
 * wizard / `rotate-master-key`. The effective-config read view shows secret env
 * vars as set/unset ONLY, never their values.
 *
 * Pure given its seams: every fs touch and the audit sink are injectable, so the
 * M3 acceptance tests run hermetically with fakes.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { type ModelPrice, validatePricingTable } from './pricing.js'
// `OpsError` is the subsystem's typed error. The import forms a cycle with
// ops-core (which imports this module's writers) — benign in ESM because
// `OpsError` is only ever referenced inside function bodies here, never at
// module-eval time, so the live binding is resolved by the time it is thrown.
import { OpsError } from './ops-core.js'

// ───────────────────────────────────────────────────────────────────────────
// Env-knob whitelist (the ONLY non-secret env vars writable via `setting`)
// ───────────────────────────────────────────────────────────────────────────

/** Validation outcome for a single env-knob value. */
export type KnobVerdict = { ok: true; value: string } | { ok: false; reason: string }

export interface EnvKnobSpec {
  key: string
  /** One-line human description (shown in the editor / read view). */
  summary: string
  /** Default the host falls back to when the knob is unset. */
  defaultValue: string
  /** Deterministic validator — normalises + accepts, or rejects with a reason. */
  validate(raw: string): KnobVerdict
}

function validatePort(raw: string): KnobVerdict {
  const t = raw.trim()
  if (!/^\d+$/.test(t)) return { ok: false, reason: 'must be an integer port number' }
  const n = Number(t)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return { ok: false, reason: 'must be a port in 1–65535' }
  }
  return { ok: true, value: String(n) }
}

function validateMode(raw: string): KnobVerdict {
  const t = raw.trim().toLowerCase()
  if (t !== 'personal' && t !== 'team') {
    return { ok: false, reason: "must be 'personal' or 'team'" }
  }
  return { ok: true, value: t }
}

// Mirrors host `parseOpenBrowserEnv`: 0/false/off/no → never, 1/true/on/yes →
// always, plus an explicit `auto`. Anything else is rejected (the host would
// silently treat it as `auto`, so refusing here is the honest, predictable move).
const OPEN_BROWSER_TOKENS = new Set(['0', '1', 'true', 'false', 'on', 'off', 'yes', 'no', 'auto'])
function validateOpenBrowser(raw: string): KnobVerdict {
  const t = raw.trim().toLowerCase()
  if (!OPEN_BROWSER_TOKENS.has(t)) {
    return { ok: false, reason: 'must be one of: auto, always(1/true/on/yes), never(0/false/off/no)' }
  }
  return { ok: true, value: t }
}

/**
 * The whitelist. Deliberately TINY and grounded: only env vars the host
 * genuinely reads, that are non-secret scalars, and that take effect on restart.
 * NOTE on the absent "IM bridge toggle": the host gates each IM bridge purely on
 * the PRESENCE of its credentials (`GOTONG_TELEGRAM_BOT_TOKEN`, etc.) — there is no
 * boolean toggle env it reads, and those creds are secret-name keys this editor
 * hard-refuses. So there is no honest knob to add; inventing one would write an
 * env the host never reads.
 */
export const ENV_KNOBS: readonly EnvKnobSpec[] = [
  { key: 'GOTONG_MODE', summary: 'Personal vs team mode (auto-detected when unset).', defaultValue: 'personal', validate: validateMode },
  { key: 'GOTONG_WEB_PORT', summary: 'Admin UI / API port.', defaultValue: '3000', validate: validatePort },
  { key: 'GOTONG_WS_PORT', summary: 'Agent WebSocket port.', defaultValue: '4000', validate: validatePort },
  { key: 'GOTONG_OPEN_BROWSER', summary: 'First-run browser auto-open behaviour.', defaultValue: 'auto', validate: validateOpenBrowser },
]

function knobSpec(key: string): EnvKnobSpec | undefined {
  return ENV_KNOBS.find((k) => k.key === key)
}

/**
 * Does `key` look like a secret? Belt-and-suspenders over the whitelist: a
 * config-set for a secret-name key is refused with a clear reason BEFORE the
 * whitelist lookup, so the operator is told "secrets never go here" rather than
 * a bare "unknown knob". Matches the `*_TOKEN`/`*_SECRET`/`*_KEY`/`*_PASSWORD`
 * suffixes plus any master-key / password mention.
 */
export function isSecretKey(key: string): boolean {
  const k = key.toUpperCase()
  return /_(TOKEN|SECRET|KEY|PASSWORD)$/.test(k) || k.includes('MASTER_KEY') || k.includes('PASSWORD')
}

// ───────────────────────────────────────────────────────────────────────────
// Managed env file (`<space>/gotong.env`) — parse / serialize
// ───────────────────────────────────────────────────────────────────────────

/**
 * Parse a managed `gotong.env` — simple `KEY=value` lines, `#` comments and
 * blanks ignored. We OWN this file (the editor writes it), so the grammar is
 * deliberately minimal; no shell expansion, no quoting games.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key) out.set(key, value)
  }
  return out
}

const ENV_FILE_HEADER = [
  '# Gotong managed environment — written by `setting config-set`.',
  '# Sourced by the launcher / systemd `EnvironmentFile=` BEFORE the host starts,',
  '# so the host still only reads process.env. Changes take effect on NEXT restart.',
  '# Only NON-SECRET knobs live here. Secrets (API keys, bridge tokens, the master',
  '# key) NEVER go here — use the vault / setup wizard / `setting rotate-master-key`.',
  '',
].join('\n')

/** Serialize a knob map back to `gotong.env`, keys sorted for a clean diff. */
export function serializeEnvFile(map: Map<string, string> | Record<string, string>): string {
  const entries = map instanceof Map ? [...map.entries()] : Object.entries(map)
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const body = entries.map(([k, v]) => `${k}=${v}`).join('\n')
  return `${ENV_FILE_HEADER}${body}${body ? '\n' : ''}`
}

/** A validated env template (all knobs commented out at their defaults). */
export function generateEnvTemplate(): string {
  const lines = ENV_KNOBS.map((k) => `# ${k.key}=${k.defaultValue}    # ${k.summary}`)
  return `${ENV_FILE_HEADER}${lines.join('\n')}\n`
}

// ───────────────────────────────────────────────────────────────────────────
// Shared write deps + audit seam
// ───────────────────────────────────────────────────────────────────────────

/**
 * Best-effort audit sink — the surface binds the actor context (CLI = system,
 * web owner = their session). ops-config-write only supplies the per-write
 * metadata; it NEVER blocks a (already-validated) write on an audit fault and
 * NEVER puts a secret value in `metadata`.
 */
export type ConfigWriteAuditSink = (metadata: Record<string, unknown>) => void

interface FsWriteSeams {
  readFileImpl?: (p: string) => Promise<string>
  writeFileImpl?: (p: string, data: string) => Promise<void>
  mkdirpImpl?: (p: string) => Promise<void>
}

async function readFileOr(path: string, fallback: string, seams: FsWriteSeams): Promise<string> {
  const impl = seams.readFileImpl ?? ((p: string) => readFile(p, 'utf8'))
  try {
    return await impl(path)
  } catch {
    // ENOENT / unreadable → treat as empty (first write creates it).
    return fallback
  }
}

async function writeFileAt(path: string, data: string, seams: FsWriteSeams): Promise<void> {
  const mkdirp = seams.mkdirpImpl ?? ((p: string) => mkdir(p, { recursive: true }).then(() => undefined))
  const write = seams.writeFileImpl ?? ((p: string, d: string) => writeFile(p, d, 'utf8'))
  await mkdirp(dirname(path))
  await write(path, data)
}

export interface ConfigWriteResult {
  lines: string[]
  data: Record<string, unknown>
}

// ───────────────────────────────────────────────────────────────────────────
// config-write: set a managed env knob
// ───────────────────────────────────────────────────────────────────────────

export interface EnvKnobWriteDeps extends FsWriteSeams {
  /** Absolute path to the managed env file (`<space>/gotong.env`). */
  envFilePath: string
  /** Surface label for the audit row (cli/web). */
  surface: string
  audit?: ConfigWriteAuditSink
}

/**
 * Set one whitelisted, non-secret env knob in `<space>/gotong.env`. Order is:
 * secret-name hard-refuse → whitelist lookup → deterministic validate → read-
 * merge-write the managed file → best-effort audit. Throws `OpsError` (no write,
 * no success audit) on any refusal.
 */
export async function applyEnvKnob(
  input: { key: string; value: string },
  deps: EnvKnobWriteDeps,
): Promise<ConfigWriteResult> {
  const key = (input.key ?? '').trim()
  if (!key) throw new OpsError('invalid_input', 'a config key is required.')

  // 1. Secret-name keys are refused outright — they never belong in this file.
  if (isSecretKey(key)) {
    throw new OpsError(
      'secret_key_refused',
      `'${key}' looks like a secret — secrets never go in the managed env file. Use the vault / setup wizard / \`setting rotate-master-key\`.`,
    )
  }
  // 2. Must be on the whitelist.
  const spec = knobSpec(key)
  if (!spec) {
    const allowed = ENV_KNOBS.map((k) => k.key).join(', ')
    throw new OpsError('unknown_knob', `'${key}' is not a settable config knob. Settable: ${allowed}.`)
  }
  // 3. Deterministic validation BEFORE any write.
  const verdict = spec.validate(input.value ?? '')
  if (!verdict.ok) {
    throw new OpsError('invalid_value', `'${key}': ${verdict.reason}; got ${JSON.stringify(input.value)}.`)
  }

  // 4. Read-merge-write the managed file.
  const current = parseEnvFile(await readFileOr(deps.envFilePath, '', deps))
  current.set(key, verdict.value)
  await writeFileAt(deps.envFilePath, serializeEnvFile(current), deps)

  // 5. Best-effort audit (never a secret value — just the key + new value, which
  //    for a whitelisted non-secret knob is safe to record).
  try {
    deps.audit?.({ kind: 'env', surface: deps.surface, key, value: verdict.value, takesEffectOnRestart: true })
  } catch {
    // never mask a succeeded write on an audit fault
  }

  return {
    lines: [
      `set ${key}=${verdict.value} in ${deps.envFilePath}`,
      'takes effect on the NEXT host restart (no hot-reload).',
    ],
    data: { kind: 'env', key, value: verdict.value, path: deps.envFilePath, takesEffectOnRestart: true },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// config-write: upsert a pricing.json override
// ───────────────────────────────────────────────────────────────────────────

export interface PricingWriteDeps extends FsWriteSeams {
  /** Absolute path to `<space>/pricing.json`. */
  pricingPath: string
  surface: string
  audit?: ConfigWriteAuditSink
}

/**
 * Upsert one model's price override in `<space>/pricing.json`. The new entry is
 * validated through `validatePricingTable` (the boot-path shape authority), then
 * merged into the existing OWN overrides and the WHOLE merged table is re-
 * validated, so a corrupt existing file or a bad new entry is refused BEFORE the
 * write. Throws `OpsError` on any refusal.
 */
export async function applyPricingUpsert(
  input: { model: string; price: unknown },
  deps: PricingWriteDeps,
): Promise<ConfigWriteResult> {
  const model = (input.model ?? '').trim()
  if (!model) throw new OpsError('invalid_input', 'a model id is required.')

  // Validate the single new entry first (clear per-entry error if it's bad).
  let entry: ModelPrice
  try {
    const validated = validatePricingTable({ [model]: input.price }, 'pricing.json')
    entry = validated[model]!
  } catch (e) {
    throw new OpsError('invalid_price', (e as Error).message)
  }

  // Read existing OWN overrides (ENOENT → empty object).
  const rawExisting = await readFileOr(deps.pricingPath, '{}', deps)
  let parsed: unknown
  try {
    parsed = JSON.parse(rawExisting)
  } catch (e) {
    throw new OpsError(
      'pricing_corrupt',
      `${deps.pricingPath} is not valid JSON (${(e as Error).message}); fix or remove it before editing prices here.`,
    )
  }
  // Re-validate the whole merged own-table so a pre-existing bad entry surfaces
  // now rather than at the next boot.
  let own: Record<string, ModelPrice>
  try {
    own = validatePricingTable(parsed, deps.pricingPath)
  } catch (e) {
    throw new OpsError('pricing_corrupt', (e as Error).message)
  }
  own[model] = entry

  await writeFileAt(deps.pricingPath, `${JSON.stringify(own, null, 2)}\n`, deps)

  try {
    deps.audit?.({ kind: 'pricing', surface: deps.surface, model, takesEffectOnRestart: true })
  } catch {
    // never mask a succeeded write
  }

  return {
    lines: [
      `upserted price for "${model}" in ${deps.pricingPath}`,
      `  inputPer1M=${entry.inputPer1M} outputPer1M=${entry.outputPer1M}`,
      'takes effect on the NEXT host restart (the table is read at boot).',
    ],
    data: { kind: 'pricing', model, price: entry, path: deps.pricingPath, takesEffectOnRestart: true },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// read: effective-config view (token-redacted)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Secret env vars the host genuinely reads — shown set/unset in the read view,
 * NEVER by value. Curated (not a scan of all env) so we surface exactly the
 * known secret knobs and don't dump unrelated env-var names.
 */
export const SECRET_ENV_VARS: readonly string[] = [
  'GOTONG_MASTER_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOTONG_TELEGRAM_BOT_TOKEN',
  'GOTONG_QQ_BOT_SECRET',
  'GOTONG_LARK_APP_SECRET',
  'GOTONG_SLACK_APP_TOKEN',
  'GOTONG_SLACK_BOT_TOKEN',
]

export interface EffectiveKnobView {
  key: string
  summary: string
  default: string
  /** Value in the managed `gotong.env` (null when not set there). */
  fileValue: string | null
  /** Value currently live in the process env (null when unset). */
  envValue: string | null
}

export interface EffectiveConfigView {
  /** The whitelisted knobs, file-vs-live so the operator sees pending-vs-active. */
  knobs: EffectiveKnobView[]
  /** Secret env vars: name + set/unset ONLY. */
  secrets: Array<{ key: string; set: boolean }>
  pricing: { path: string; present: boolean; overrideModels: number; corrupt?: boolean }
  /** A validated env template the operator can copy / apply manually. */
  envTemplate: string
}

export interface EffectiveConfigDeps extends FsWriteSeams {
  spaceDir: string
  env: Record<string, string | undefined>
  /** Defaults to `<space>/gotong.env`. */
  envFilePath?: string
  /** Defaults to `<space>/pricing.json`. */
  pricingPath?: string
}

/** Build the read-only effective-config view (read tier). */
export async function readEffectiveConfig(deps: EffectiveConfigDeps): Promise<EffectiveConfigView> {
  const envFilePath = deps.envFilePath ?? join(deps.spaceDir, 'gotong.env')
  const pricingPath = deps.pricingPath ?? join(deps.spaceDir, 'pricing.json')

  const fileMap = parseEnvFile(await readFileOr(envFilePath, '', deps))
  const knobs: EffectiveKnobView[] = ENV_KNOBS.map((k) => ({
    key: k.key,
    summary: k.summary,
    default: k.defaultValue,
    fileValue: fileMap.get(k.key) ?? null,
    envValue: deps.env[k.key] ?? null,
  }))

  const secrets = SECRET_ENV_VARS.map((key) => ({ key, set: !!deps.env[key]?.trim() }))

  // Pricing presence + override count (best-effort; corrupt is reported honestly).
  let pricing: EffectiveConfigView['pricing'] = { path: pricingPath, present: false, overrideModels: 0 }
  const rawPricing = await readFileOr(pricingPath, '', deps)
  if (rawPricing.trim()) {
    try {
      const own = validatePricingTable(JSON.parse(rawPricing), pricingPath)
      pricing = { path: pricingPath, present: true, overrideModels: Object.keys(own).length }
    } catch {
      pricing = { path: pricingPath, present: true, overrideModels: 0, corrupt: true }
    }
  }

  return { knobs, secrets, pricing, envTemplate: generateEnvTemplate() }
}
