import { parse as parseYaml } from 'yaml'

import type { McpServerSpec } from '@aipehub/core'

import {
  ManifestError,
  TEAM_SCHEMA_V1,
  indentYaml,
  parseManifest,
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
