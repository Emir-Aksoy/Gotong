import { parse as parseYaml } from 'yaml'

import type { ManagedAgentSpec, McpServerSpec } from '@aipehub/core'

import { isEncryptedBlob, type EncryptedBlob } from './template-crypto.js'
import {
  ManifestError,
  TEAM_SCHEMA_V1,
  indentYaml,
  parseManifest,
  renderAgentManifest,
  stringifyYamlSafe,
  validateMcpServersArray,
  validateUseMcpServersArray,
  type BundleApiKeyPrompt,
  type ParsedAgent,
} from './manifest.js'

/**
 * `aipehub.template/v1` — the v5 Stream B template format (decision #4).
 *
 * A template is a single, human-readable, diffable manifest (YAML or JSON)
 * describing a reusable *architecture*: a set of agents, one-or-more
 * workflows, and — the new first-class piece — the **knowledge-base wiring**.
 *
 * The hard line that separates a template from a data dump (B.1 / decision
 * #4 / #5): a template carries **structure and references, never knowledge
 * CONTENT and never personnel info**. "Knowledge-base wiring" therefore means
 * *how an agent reaches a knowledge base* — an MCP server reference plus an
 * optional pointer to a packaged snapshot — NOT the documents/vectors inside
 * it. The importer (B-M4) lands the agents/workflows and then guides the user
 * to connect their *own* knowledge base to each declared slot.
 *
 * Shape:
 *
 *   schema: aipehub.template/v1
 *   template:
 *     name: 客服知识助手
 *     description: 一个客服 agent + 工单工作流 + 指向你自己 KB 的接线
 *     version: 1                       # optional integer, default 1
 *     agents:                          # same agent shape as aipehub.team/v1
 *       - { id, capabilities, kind, provider, model, system, useMcpServers, … }
 *     workflows:                       # 0..N — each an aipehub.workflow/v1 block
 *       - { id, trigger, steps, … }
 *     knowledgeBases:                  # 0..N addressable KB slots (the new bit)
 *       - name: kb-support             # addressable id — Stream C.1 links to this
 *         description: 公司客服知识库
 *         mcpServer:                   # the WIRING (inline MCP server reference)
 *           name: kb-support
 *           command: npx
 *           args: [-y, chroma-mcp]
 *         # …or instead: useMcpServer: kb-support   # a hub-registry MCP name
 *         presetData:                  # OPTIONAL pointer to a packaged snapshot (B.5)
 *           kind: url                  # url | artifact — a POINTER, never content
 *           ref: https://example.com/kb-support.tar.zst
 *     defaults:                        # optional UI hints (same as bundle)
 *       apiKeyPrompt: { provider, baseURL?, label? }
 *
 * Why a *new* schema rather than extending `aipehub.bundle/v1`: a bundle is
 * one team + one workflow + a key prompt — an import convenience. A template
 * is the export/share unit for a whole architecture (N workflows) and it makes
 * knowledge bases **addressable by name**, which is the dependency Stream C.1
 * declares ("per-link 契约扩一维 可调用知识库 — 依赖 B.1 知识库可寻址"). We don't
 * want to overload the bundle's single-workflow contract to carry that.
 *
 * The parser stays deliberately dumb about workflow internals — each workflow
 * block is re-serialized verbatim (the same opaque-blob trick `parseBundle`
 * uses) so the workflow runtime remains the one source of truth for
 * `aipehub.workflow/v1` validation. Agent validation is delegated wholesale to
 * `parseManifest` (the team path) so there is exactly one agent trust boundary.
 */
export const TEMPLATE_SCHEMA_V1 = 'aipehub.template/v1'

/** A pointer to a packaged knowledge-base snapshot. Never inline content. */
export interface TemplatePresetData {
  /** `url` = downloadable archive; `artifact` = a hub artifact id. */
  kind: 'url' | 'artifact'
  /** The pointer itself (a URL or an artifact id). */
  ref: string
  description?: string
}

/**
 * One addressable knowledge-base slot. The `name` is the link target Stream
 * C.1 grants against. Exactly one wiring form is present: `mcpServer` (inline
 * MCP server reference) XOR `useMcpServer` (a hub-registry MCP server name).
 */
export interface TemplateKnowledgeBase {
  name: string
  description?: string
  /** Inline MCP server wiring — how an agent reaches this KB. */
  mcpServer?: McpServerSpec
  /** …or a reference to a hub-registry MCP server by name. */
  useMcpServer?: string
  /** Optional pointer to a packaged snapshot for one-click templates (B.5). */
  presetData?: TemplatePresetData
}

/** A workflow shipped inside a template — kept as an opaque re-serialized yaml. */
export interface ParsedTemplateWorkflow {
  /** Workflow id (pulled out for listing + duplicate detection). */
  id: string
  /** Re-serialized `aipehub.workflow/v1` yaml the workflow importer consumes. */
  yaml: string
}

export interface ParsedTemplate {
  schema: typeof TEMPLATE_SCHEMA_V1
  name: string
  description?: string
  /** Monotonic template version; defaults to 1 when absent. */
  version: number
  agents: ParsedAgent[]
  workflows: ParsedTemplateWorkflow[]
  knowledgeBases: TemplateKnowledgeBase[]
  apiKeyPrompt?: BundleApiKeyPrompt
  /**
   * B-M3 sensitive sidecar (present iff the export opted into secrets/personnel).
   * Opaque AES-256-GCM blob; the importer (B-M4) decrypts it with the
   * separately-delivered key to recover `{ secrets?, personnel? }`. Structure
   * parsing ignores it entirely — it carries no structural meaning.
   */
  encrypted?: EncryptedBlob
}

// A KB slot name is a local, addressable identifier (the Stream C.1 link
// target). Same shape as an MCP server's own `name` — letters/digits/_/-,
// must start with a letter — so it round-trips cleanly into a wiring ref.
const KB_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/

/**
 * Parse a textual template manifest (YAML or JSON). Throws `ManifestError`
 * with a human-friendly message on any structural problem — the Web layer
 * surfaces these to the admin UI verbatim, same as the agent/bundle parsers.
 */
export function parseTemplate(raw: string): ParsedTemplate {
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new ManifestError('template is empty')

  let doc: unknown
  // Prefer JSON when the body clearly starts with `{`/`[` (stricter errors),
  // else YAML — identical heuristic to the agent/bundle parsers.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      doc = JSON.parse(trimmed)
    } catch (err) {
      throw new ManifestError(
        `template is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    try {
      doc = parseYaml(trimmed)
    } catch (err) {
      throw new ManifestError(
        `template is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  if (!doc || typeof doc !== 'object') {
    throw new ManifestError('template must be an object at the top level')
  }
  const root = doc as Record<string, unknown>
  if (root.schema !== TEMPLATE_SCHEMA_V1) {
    throw new ManifestError(
      `template.schema must be '${TEMPLATE_SCHEMA_V1}' — got '${String(root.schema)}'`,
    )
  }
  if (!root.template || typeof root.template !== 'object' || Array.isArray(root.template)) {
    throw new ManifestError(`template.template is required (object)`)
  }
  const t = root.template as Record<string, unknown>

  if (typeof t.name !== 'string' || t.name.trim().length === 0) {
    throw new ManifestError(`template.name is required (non-empty string)`)
  }

  let version = 1
  if (t.version !== undefined) {
    if (typeof t.version !== 'number' || !Number.isInteger(t.version) || t.version < 1) {
      throw new ManifestError(`template.version must be a positive integer when present`)
    }
    version = t.version
  }

  const agents = parseTemplateAgents(t.agents)
  const workflows = parseTemplateWorkflows(t.workflows)
  const knowledgeBases = parseTemplateKnowledgeBases(t.knowledgeBases)

  // A template with nothing in it is almost certainly a mistake — reject it
  // loudly rather than silently importing an empty architecture.
  if (agents.length === 0 && workflows.length === 0 && knowledgeBases.length === 0) {
    throw new ManifestError(
      `template must declare at least one of agents / workflows / knowledgeBases`,
    )
  }

  const out: ParsedTemplate = {
    schema: TEMPLATE_SCHEMA_V1,
    name: t.name,
    version,
    agents,
    workflows,
    knowledgeBases,
  }
  if (typeof t.description === 'string') out.description = t.description
  const apiKeyPrompt = parseTemplateDefaults(t.defaults)
  if (apiKeyPrompt) out.apiKeyPrompt = apiKeyPrompt
  // Carry the B-M3 encrypted sidecar through verbatim (B-M4 decrypts it). A
  // present-but-malformed blob is a corruption signal — fail visibly.
  if (t.encrypted !== undefined) {
    if (!isEncryptedBlob(t.encrypted)) {
      throw new ManifestError('template.encrypted is present but malformed (expected an aes-256-gcm blob)')
    }
    out.encrypted = t.encrypted
  }
  return out
}

/**
 * Validate `template.agents`. Delegates wholesale to `parseManifest`'s team
 * path by re-wrapping into an `aipehub.team/v1` document — one agent trust
 * boundary, no re-implemented agent rules. Absent / empty → no agents.
 */
function parseTemplateAgents(raw: unknown): ParsedAgent[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new ManifestError(`template.agents must be an array when present`)
  }
  if (raw.length === 0) return []
  const teamYaml =
    `schema: ${TEAM_SCHEMA_V1}\nteam:\n` +
    indentYaml(stringifyYamlSafe({ agents: raw }), 2)
  // parseManifest enforces id rules, provider whitelist, mcpServers/uses
  // shape, duplicate-id detection, etc. ManifestError messages bubble up
  // prefixed `team.agents[i]…` which is accurate enough for the admin UI.
  return parseManifest(teamYaml).agents
}

/**
 * Validate `template.workflows`. Each block must carry a string `id` (so we
 * can list + dedup) and is re-serialized verbatim as an `aipehub.workflow/v1`
 * yaml for the workflow importer — the parser never inspects steps/triggers.
 */
function parseTemplateWorkflows(raw: unknown): ParsedTemplateWorkflow[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new ManifestError(`template.workflows must be an array when present`)
  }
  const out: ParsedTemplateWorkflow[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const wf = raw[i]
    const path = `template.workflows[${i}]`
    if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
      throw new ManifestError(`${path} must be an object`)
    }
    const id = (wf as Record<string, unknown>).id
    if (typeof id !== 'string' || id.length === 0) {
      throw new ManifestError(`${path}.id is required (non-empty string)`)
    }
    if (seen.has(id)) {
      throw new ManifestError(`duplicate workflow id '${id}' inside template.workflows`)
    }
    seen.add(id)
    const yaml =
      `schema: aipehub.workflow/v1\nworkflow:\n` + indentYaml(stringifyYamlSafe(wf), 2)
    out.push({ id, yaml })
  }
  return out
}

/**
 * Validate `template.knowledgeBases` — the addressable KB slots. Each slot:
 *   - `name`: required, unique, KB_NAME_RE (the Stream C.1 link target)
 *   - exactly one wiring form: `mcpServer` (inline) XOR `useMcpServer` (name)
 *   - `presetData`: optional pointer to a packaged snapshot — never content
 */
function parseTemplateKnowledgeBases(raw: unknown): TemplateKnowledgeBase[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new ManifestError(`template.knowledgeBases must be an array when present`)
  }
  const out: TemplateKnowledgeBase[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    const path = `template.knowledgeBases[${i}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ManifestError(`${path} must be an object`)
    }
    const e = entry as Record<string, unknown>
    if (typeof e.name !== 'string' || e.name.length === 0) {
      throw new ManifestError(`${path}.name is required (non-empty string)`)
    }
    if (!KB_NAME_RE.test(e.name)) {
      throw new ManifestError(
        `${path}.name must match ${KB_NAME_RE} (letters/digits/_/-, start with a letter) — got '${e.name}'`,
      )
    }
    if (seen.has(e.name)) {
      throw new ManifestError(`duplicate knowledgeBase name '${e.name}' inside template.knowledgeBases`)
    }
    seen.add(e.name)

    const hasInline = e.mcpServer !== undefined
    const hasRef = e.useMcpServer !== undefined
    if (hasInline && hasRef) {
      throw new ManifestError(
        `${path} must declare exactly one of 'mcpServer' or 'useMcpServer', not both`,
      )
    }
    if (!hasInline && !hasRef) {
      throw new ManifestError(
        `${path} must declare its wiring: 'mcpServer' (inline) or 'useMcpServer' (a hub-registry MCP server name)`,
      )
    }

    const kb: TemplateKnowledgeBase = { name: e.name }
    if (typeof e.description === 'string') kb.description = e.description
    if (hasInline) {
      // Reuse the MCP server validator (wrap in a 1-element array, take [0]).
      kb.mcpServer = validateMcpServersArray([e.mcpServer], `${path}.mcpServer`)[0]!
    } else {
      // Reuse the useMcpServers name validator the same way.
      kb.useMcpServer = validateUseMcpServersArray([e.useMcpServer], `${path}.useMcpServer`)[0]!
    }
    if (e.presetData !== undefined) {
      kb.presetData = parsePresetData(e.presetData, `${path}.presetData`)
    }
    out.push(kb)
  }
  return out
}

/**
 * Validate an optional `presetData` pointer. It is deliberately a *pointer*
 * (url / artifact id), never inline knowledge — decision #5 keeps content out
 * of the structural template. One-click templates (B.5) point this at a
 * packaged snapshot the importer fetches as a separate, explicit step.
 */
function parsePresetData(raw: unknown, path: string): TemplatePresetData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError(`${path} must be an object when present`)
  }
  const p = raw as Record<string, unknown>
  if (p.kind !== 'url' && p.kind !== 'artifact') {
    throw new ManifestError(`${path}.kind must be 'url' or 'artifact' — got '${String(p.kind)}'`)
  }
  if (typeof p.ref !== 'string' || p.ref.length === 0) {
    throw new ManifestError(`${path}.ref is required (non-empty string)`)
  }
  const out: TemplatePresetData = { kind: p.kind, ref: p.ref }
  if (typeof p.description === 'string') out.description = p.description
  return out
}

// ── B-M2: structure export (the inverse of parseTemplate) ──────────────────

/** One agent to render — the same structural shape `renderAgentManifest` takes. */
export interface TemplateAgentInput {
  id: string
  allowedCapabilities: readonly string[]
  displayName?: string
  managed?: ManagedAgentSpec
}

/** One workflow to embed — the authored `workflow:` block (id/trigger/steps/…). */
export interface TemplateWorkflowInput {
  id: string
  /** The authored inner block, embedded verbatim under the template's workflows[]. */
  workflow: Record<string, unknown>
}

export interface RenderTemplateInput {
  name: string
  description?: string
  version?: number
  agents?: TemplateAgentInput[]
  /** Authored workflow blocks (the host hands these from `definitions/<id>.yaml`). */
  workflows?: TemplateWorkflowInput[]
  /** Addressable KB slots — raw template-shaped objects (validated by a re-parse gate). */
  knowledgeBases?: Array<Record<string, unknown>>
  apiKeyPrompt?: BundleApiKeyPrompt
}

export interface RenderTemplateResult {
  /**
   * The `aipehub.template/v1` manifest object — structure-safe and shareable
   * as-is: every literal MCP secret is replaced by a `${ENV_KEY}` placeholder.
   */
  template: Record<string, unknown>
  /**
   * The literal secrets that were scrubbed out, as `{ "${ENV_KEY}": "<value>" }`
   * keyed by the placeholder that replaced them. This is the *content* B-M3 may
   * encrypt into a separate, opt-in, audited sidecar (decision #5) — the
   * structure export itself never carries it. Empty when every value was
   * already a placeholder. Last-wins on a shared key, matching env-var-by-name
   * semantics (one env name resolves to one value at import time anyway).
   */
  secrets: Record<string, string>
}

/**
 * Render selected hub structure into an `aipehub.template/v1` manifest object
 * (v5 B-M2). This is the structure-safe DEFAULT export (decision #5):
 *
 *   - NO personnel info — by construction. The input carries no owner / grant /
 *     uploader fields, and `renderAgentManifest` emits only an agent's config
 *     (id, capabilities, provider, model, system, MCP wiring), never who owns it.
 *   - NO knowledge content — by construction. Only MCP-server *wiring* is
 *     emitted (commands / urls / env keys), never the documents inside a KB.
 *   - NO secrets in `template` — `scrubAgentSecrets` placeholder-izes any literal
 *     MCP env / header value so a template shared publicly can't leak a baked-in
 *     key. The scrubbed literals are returned *separately* as `secrets` for the
 *     caller (B-M3) to optionally encrypt; the default path discards them.
 *
 * The `template` round-trips through `parseTemplate`; callers should run that as
 * an integrity gate (it also validates operator-supplied `knowledgeBases`).
 */
export function renderTemplate(input: RenderTemplateInput): RenderTemplateResult {
  const secrets: Record<string, string> = {}
  const agents = (input.agents ?? [])
    // Externally-connected participants have no managed spec to export — skip them.
    .filter((a) => a.managed)
    .map((a) => scrubAgentSecrets(renderAgentManifest(a).agent as Record<string, unknown>, secrets))
  const workflows = (input.workflows ?? []).map((w) => w.workflow)
  const knowledgeBases = input.knowledgeBases ?? []

  const template: Record<string, unknown> = { name: input.name }
  if (input.description) template.description = input.description
  template.version = input.version ?? 1
  if (agents.length > 0) template.agents = agents
  if (workflows.length > 0) template.workflows = workflows
  if (knowledgeBases.length > 0) template.knowledgeBases = knowledgeBases
  if (input.apiKeyPrompt) template.defaults = { apiKeyPrompt: { ...input.apiKeyPrompt } }
  return { template: { schema: TEMPLATE_SCHEMA_V1, template }, secrets }
}

// An MCP env / header value is "safe" to export verbatim only when it's already
// an env-var placeholder like `${BRAVE_API_KEY}` — anything else might be a
// literal secret, so we replace it with a placeholder named after its key.
const ENV_PLACEHOLDER_RE = /^\$\{[^}]+\}$/

/**
 * Mutate a rendered agent object so no literal MCP secret rides along in the
 * export. We keep the *keys* (the importer still learns which env vars / headers
 * the server needs) but replace any non-placeholder value with `${KEY}`, and
 * record the displaced literal into `secrets` (keyed by that placeholder) so the
 * caller can optionally ship it encrypted. Safe to mutate: `renderAgentManifest`
 * already deep-copied env / headers off the record.
 */
function scrubAgentSecrets(
  agent: Record<string, unknown>,
  secrets: Record<string, string>,
): Record<string, unknown> {
  const servers = agent.mcpServers
  if (Array.isArray(servers)) {
    for (const s of servers) {
      if (!s || typeof s !== 'object') continue
      const srv = s as { env?: Record<string, unknown>; headers?: Record<string, unknown> }
      placeholderize(srv.env, (k) => `\${${k}}`, secrets)
      placeholderize(srv.headers, (k) => `\${${headerEnvName(k)}}`, secrets)
    }
  }
  // A service `uses[].config` is opaque to web (only `plugin.validateConfig`
  // knows its shape), so it can carry a literal credential — a hosted
  // datastore's apiKey, an external service's token — right next to structural
  // settings (scope, name, limits). We previously only scrubbed MCP env/headers,
  // so those config secrets leaked verbatim into the public structure export.
  // Scrub any credential-named value (recursively) into the sidecar, leaving
  // structural keys untouched so the shipped file services still export usefully.
  const uses = agent.uses
  if (Array.isArray(uses)) {
    for (const u of uses) {
      if (!u || typeof u !== 'object') continue
      const entry = u as { config?: unknown }
      if (entry.config && typeof entry.config === 'object') {
        // renderAgentManifest only shallow-copies config, so a nested object is
        // still shared with the live agents.json record — build a fresh value
        // rather than mutating in place.
        entry.config = scrubConfigValue(entry.config, false, secrets)
      }
    }
  }
  return agent
}

// Credential-ish config keys (case-insensitive substring). Errs BROAD on
// purpose: over-scrubbing a non-secret into the opt-in, encrypted sidecar is
// harmless (it round-trips on import); under-scrubbing a real secret into the
// public structure export is a leak. The shipped file services carry only
// structural keys (name/scope/maxBytes/kinds), none of which match — their
// config survives intact. A genuinely odd-named secret can still slip through;
// that's the honest limit of classifying an opaque config map.
function looksSecretKey(key: string): boolean {
  const k = key.toLowerCase()
  return (
    k === 'key' ||
    k === 'pass' ||
    k.includes('secret') ||
    k.includes('token') ||
    k.includes('password') ||
    k.includes('passwd') ||
    k.includes('apikey') ||
    k.includes('api_key') ||
    k.includes('accesskey') ||
    k.includes('access_key') ||
    k.includes('auth') ||
    k.includes('credential') ||
    k.includes('bearer') ||
    k.includes('privatekey') ||
    k.includes('private_key')
  )
}

/**
 * Recursively scrub literal secrets out of an opaque service-config value,
 * returning a FRESH structure (never mutates the input — config may be shared
 * with the live record). `forceSecret` carries down once a parent key looked
 * credential-ish, so `{ auth: { value: 'xyz' } }` scrubs `value` too. Every
 * scrubbed string is recorded into `secrets` under a fresh unique placeholder
 * (so two services' different apiKeys can't collide on one `${APIKEY}`), and an
 * existing `${…}` placeholder is preserved verbatim — same contract as the MCP
 * env/header scrub.
 */
function scrubConfigValue(
  value: unknown,
  forceSecret: boolean,
  secrets: Record<string, string>,
  keyHint = 'SECRET',
): unknown {
  if (typeof value === 'string') {
    if (!forceSecret || ENV_PLACEHOLDER_RE.test(value)) return value
    const placeholder = freshConfigPlaceholder(keyHint, secrets)
    secrets[placeholder] = value
    return placeholder
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubConfigValue(v, forceSecret, secrets, keyHint))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubConfigValue(v, forceSecret || looksSecretKey(k), secrets, k)
    }
    return out
  }
  // number / boolean / null — not a recoverable secret, pass through.
  return value
}

/** A `${CONFIG_<KEY>_<n>}` placeholder unique within the secrets map. */
function freshConfigPlaceholder(keyHint: string, secrets: Record<string, string>): string {
  const base =
    keyHint.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SECRET'
  let n = 0
  let placeholder = `\${CONFIG_${base}_${n}}`
  while (Object.prototype.hasOwnProperty.call(secrets, placeholder)) {
    n += 1
    placeholder = `\${CONFIG_${base}_${n}}`
  }
  return placeholder
}

function placeholderize(
  map: Record<string, unknown> | undefined,
  name: (key: string) => string,
  secrets: Record<string, string>,
): void {
  if (!map || typeof map !== 'object') return
  for (const k of Object.keys(map)) {
    const v = map[k]
    if (typeof v === 'string' && ENV_PLACEHOLDER_RE.test(v)) continue // already a placeholder
    if (typeof v === 'string') {
      // Pick a placeholder that won't collide with a DIFFERENT literal already
      // captured under the same env-var name (two MCP servers in one agent each
      // with their own `API_KEY`). The first keeps the clean `${KEY}`; a clash
      // gets `${KEY__2}`, … so distinct secrets survive into the sidecar.
      const placeholder = uniqueSecretPlaceholder(name(k), v, secrets)
      secrets[placeholder] = v
      map[k] = placeholder
    } else {
      // A non-string value can't be re-injected as an env var, so we
      // placeholder it (by bare key name) but don't record it.
      map[k] = name(k)
    }
  }
}

/**
 * Choose a placeholder for one scrubbed MCP secret. Prefers the natural
 * `${KEY}` so the common single-server case stays readable (and an importer can
 * still supply it by env-var name). But MCP `env` / `headers` maps are
 * PER-SERVER, so two servers in one agent can legitimately hold different
 * literals under the same key — keying the sidecar by name alone made the
 * second overwrite the first (last-wins), so on import BOTH servers received
 * the survivor's secret. On a name clash with a different value, allocate a
 * fresh `${KEY__2}`, `${KEY__3}`, … (a repeat of the SAME literal reuses the
 * existing placeholder — harmless dedup). The inject side is unchanged: it
 * looks the value up by the exact placeholder string stored in the slot.
 */
function uniqueSecretPlaceholder(
  preferred: string,
  value: string,
  secrets: Record<string, string>,
): string {
  const existing = secrets[preferred]
  if (existing === undefined || existing === value) return preferred
  const inner = preferred.slice(2, -1) // strip the `${` … `}` wrapper
  let n = 2
  let candidate = `\${${inner}__${n}}`
  while (
    Object.prototype.hasOwnProperty.call(secrets, candidate) &&
    secrets[candidate] !== value
  ) {
    n += 1
    candidate = `\${${inner}__${n}}`
  }
  return candidate
}

/** `Authorization` → `AUTHORIZATION`, `X-Api-Key` → `X_API_KEY` (env-var safe). */
function headerEnvName(header: string): string {
  return header.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

// ── B-M4: import-side secret re-injection (the inverse of scrubAgentSecrets) ──

/**
 * Re-inject decrypted secrets into a managed-agent spec on template import.
 * `scrubAgentSecrets` left every literal as a `${PLACEHOLDER}` reference; here
 * we replace any MCP env / header value that *is* one of those placeholders with
 * its real value from `secrets` (keyed by the same `${…}` string). Returns a
 * deep copy — the parsed template is never mutated. Values that aren't a known
 * placeholder (e.g. a `${SOME_OTHER_ENV}` the importer wants to supply via their
 * own environment) are left untouched.
 */
export function injectAgentSecrets(
  managed: ManagedAgentSpec,
  secrets: Record<string, string>,
): ManagedAgentSpec {
  let result = managed
  const servers = managed.mcpServers
  if (Array.isArray(servers) && servers.length > 0) {
    // McpServerSpec is a stdio|http union (env XOR headers). Treat each server
    // structurally — same escape hatch scrubAgentSecrets uses on the export
    // side — and clone+substitute whichever credential map is present.
    const cloned: McpServerSpec[] = servers.map((s) => {
      const src = s as { env?: Record<string, string>; headers?: Record<string, string> }
      const copy = { ...s } as McpServerSpec & { env?: Record<string, string>; headers?: Record<string, string> }
      if (src.env) copy.env = { ...src.env }
      if (src.headers) copy.headers = { ...src.headers }
      substituteSecrets(copy.env, secrets)
      substituteSecrets(copy.headers, secrets)
      return copy
    })
    result = { ...result, mcpServers: cloned }
  }
  // Mirror the export-side `uses[].config` scrub: put the decrypted literals
  // back where scrubConfigValue replaced them with `${CONFIG_…}` placeholders.
  // Deep-substitute so a nested credential is restored too; build fresh objects
  // (the parsed input is never mutated).
  const uses = result.uses
  if (Array.isArray(uses) && uses.some((u) => u && u.config !== undefined)) {
    const clonedUses = uses.map((u) =>
      u && u.config !== undefined
        ? { ...u, config: substituteConfigValue(u.config, secrets) as Record<string, unknown> }
        : u,
    )
    result = { ...result, uses: clonedUses }
  }
  return result
}

/**
 * Inverse of `scrubConfigValue` — recursively replace any string that is a known
 * `${…}` placeholder with its real value from `secrets`, returning a fresh
 * structure. Unknown placeholders are left untouched (the importer may supply
 * them via their own environment), matching `substituteSecrets`.
 */
function substituteConfigValue(value: unknown, secrets: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return Object.prototype.hasOwnProperty.call(secrets, value) ? secrets[value]! : value
  }
  if (Array.isArray(value)) return value.map((v) => substituteConfigValue(v, secrets))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = substituteConfigValue(v, secrets)
    return out
  }
  return value
}

function substituteSecrets(
  map: Record<string, string> | undefined,
  secrets: Record<string, string>,
): void {
  if (!map) return
  for (const k of Object.keys(map)) {
    const v = map[k]
    if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(secrets, v)) {
      map[k] = secrets[v]!
    }
  }
}

/**
 * Validate optional `template.defaults.apiKeyPrompt` — identical contract to
 * the bundle's, so a one-click template can ask "paste your <provider> key"
 * once and apply it across the imported agents (B.5).
 */
function parseTemplateDefaults(raw: unknown): BundleApiKeyPrompt | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ManifestError(`template.defaults must be an object when present`)
  }
  const d = raw as Record<string, unknown>
  if (d.apiKeyPrompt === undefined) return undefined
  if (!d.apiKeyPrompt || typeof d.apiKeyPrompt !== 'object') {
    throw new ManifestError(`template.defaults.apiKeyPrompt must be an object`)
  }
  const p = d.apiKeyPrompt as Record<string, unknown>
  if (typeof p.provider !== 'string' || p.provider.length === 0) {
    throw new ManifestError(`template.defaults.apiKeyPrompt.provider is required`)
  }
  const prompt: BundleApiKeyPrompt = { provider: p.provider }
  if (typeof p.baseURL === 'string') prompt.baseURL = p.baseURL
  if (typeof p.label === 'string') prompt.label = p.label
  return prompt
}
