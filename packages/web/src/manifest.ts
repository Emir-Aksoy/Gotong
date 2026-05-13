import { parse as parseYaml } from 'yaml'

import type { ManagedAgentSpec } from '@aipehub/core'

/**
 * Agent / team manifests are the file format the public template library
 * (and the admin "Import" button) work in. Both YAML and JSON are
 * accepted on input — YAML is easier for humans to write and PR-review;
 * JSON is what the export endpoint always returns so round-trip is
 * lossless.
 *
 * Two top-level shapes:
 *
 *   schema: aipehub.agent/v1     # one agent
 *   agent: { id, capabilities, kind: 'llm', provider, model, system, weightDefault? }
 *
 *   schema: aipehub.team/v1      # N agents shipped together
 *   team:
 *     name: ...
 *     description: ...
 *     agents:
 *       - { id, capabilities, kind: 'llm', provider, model, system, weightDefault? }
 *
 * Anything else is rejected loudly. The parser deliberately doesn't try
 * to be clever — better to tell a non-technical user "your file says
 * `schema: aipehub.agent` but expected `aipehub.agent/v1`" than to
 * accept a malformed file and have an agent spawn fail at runtime.
 */

export const AGENT_SCHEMA_V1 = 'aipehub.agent/v1'
export const TEAM_SCHEMA_V1 = 'aipehub.team/v1'

export interface ParsedAgent {
  id: string
  capabilities: string[]
  displayName?: string
  managed: ManagedAgentSpec
}

export interface ParsedManifest {
  schema: typeof AGENT_SCHEMA_V1 | typeof TEAM_SCHEMA_V1
  teamName?: string
  teamDescription?: string
  agents: ParsedAgent[]
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

/**
 * Parse a textual manifest (YAML or JSON; the parser tries JSON first
 * since it's strict, then falls back to YAML). Throws `ManifestError`
 * with a human-friendly message on any structural problem — the Web
 * layer surfaces these to the admin UI verbatim.
 */
export function parseManifest(raw: string): ParsedManifest {
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new ManifestError('manifest is empty')

  let doc: unknown
  // Prefer JSON when the body clearly starts with `{` or `[` — YAML
  // would happily parse it too but JSON errors are easier to relay.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      doc = JSON.parse(trimmed)
    } catch (err) {
      throw new ManifestError(
        `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    try {
      doc = parseYaml(trimmed)
    } catch (err) {
      throw new ManifestError(
        `not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  if (!doc || typeof doc !== 'object') {
    throw new ManifestError('manifest must be an object at the top level')
  }
  const root = doc as Record<string, unknown>
  const schema = root.schema
  if (typeof schema !== 'string') {
    throw new ManifestError(
      `manifest missing 'schema' field — expected '${AGENT_SCHEMA_V1}' or '${TEAM_SCHEMA_V1}'`,
    )
  }
  if (schema === AGENT_SCHEMA_V1) {
    const a = root.agent
    if (!a || typeof a !== 'object') {
      throw new ManifestError(`schema '${AGENT_SCHEMA_V1}' requires an 'agent' object`)
    }
    return {
      schema,
      agents: [validateAgent(a as Record<string, unknown>, 'agent')],
    }
  }
  if (schema === TEAM_SCHEMA_V1) {
    const team = root.team
    if (!team || typeof team !== 'object') {
      throw new ManifestError(`schema '${TEAM_SCHEMA_V1}' requires a 'team' object`)
    }
    const t = team as Record<string, unknown>
    const list = t.agents
    if (!Array.isArray(list) || list.length === 0) {
      throw new ManifestError(`team.agents must be a non-empty array`)
    }
    const ids = new Set<string>()
    const agents: ParsedAgent[] = []
    for (let i = 0; i < list.length; i++) {
      const a = validateAgent(list[i] as Record<string, unknown>, `team.agents[${i}]`)
      if (ids.has(a.id)) {
        throw new ManifestError(`duplicate agent id '${a.id}' inside team.agents`)
      }
      ids.add(a.id)
      agents.push(a)
    }
    const out: ParsedManifest = { schema, agents }
    if (typeof t.name === 'string') out.teamName = t.name
    if (typeof t.description === 'string') out.teamDescription = t.description
    return out
  }
  throw new ManifestError(
    `unknown schema '${schema}' — expected '${AGENT_SCHEMA_V1}' or '${TEAM_SCHEMA_V1}'`,
  )
}

/** Validate one agent dict in either schema. `path` is for error messages. */
function validateAgent(a: Record<string, unknown>, path: string): ParsedAgent {
  if (typeof a.id !== 'string' || a.id.length === 0) {
    throw new ManifestError(`${path}.id is required (non-empty string)`)
  }
  if (a.id.length > 80) {
    throw new ManifestError(`${path}.id is too long (max 80 chars)`)
  }
  // ids must be URL- and JSON-safe; keeps query params + cookie payloads sane
  if (!/^[a-zA-Z0-9_.:-]+$/.test(a.id)) {
    throw new ManifestError(
      `${path}.id may only contain letters, digits, '_', '.', ':', '-' — got '${a.id}'`,
    )
  }
  const caps = a.capabilities
  if (!Array.isArray(caps)) {
    throw new ManifestError(`${path}.capabilities must be an array`)
  }
  const capabilities: string[] = []
  for (const c of caps) {
    if (typeof c !== 'string' || c.length === 0) {
      throw new ManifestError(`${path}.capabilities must contain non-empty strings`)
    }
    capabilities.push(c)
  }
  const kind = a.kind ?? 'llm'
  if (kind !== 'llm') {
    throw new ManifestError(`${path}.kind: only 'llm' is supported today, got '${String(kind)}'`)
  }
  const provider = a.provider
  if (
    provider !== 'anthropic' &&
    provider !== 'openai' &&
    provider !== 'openai-compatible' &&
    provider !== 'mock'
  ) {
    throw new ManifestError(
      `${path}.provider must be 'anthropic', 'openai', 'openai-compatible', or 'mock' — got '${String(provider)}'`,
    )
  }
  const system = a.system
  if (typeof system !== 'string' || system.length === 0) {
    throw new ManifestError(`${path}.system is required (non-empty string)`)
  }
  // openai-compatible needs a baseURL or it can't be spawned at all.
  // Fail at parse time rather than letting it slip through to a runtime
  // throw on the next host restart.
  if (provider === 'openai-compatible') {
    if (typeof a.baseURL !== 'string' || a.baseURL.length === 0) {
      throw new ManifestError(
        `${path}.baseURL is required when provider is 'openai-compatible' (e.g. 'https://api.deepseek.com/v1')`,
      )
    }
  }
  const managed: ManagedAgentSpec = {
    kind: 'llm',
    provider,
    system,
  }
  if (typeof a.model === 'string' && a.model.length > 0) managed.model = a.model
  if (typeof a.weightDefault === 'number' && Number.isFinite(a.weightDefault)) {
    managed.weightDefault = a.weightDefault
  }
  // openai-compatible-only optional fields. Carrying baseURL when the
  // provider is something else would be confusing in agents.json — so
  // we gate strictly on the provider string.
  if (provider === 'openai-compatible') {
    managed.baseURL = a.baseURL as string
    if (typeof a.providerLabel === 'string' && a.providerLabel.length > 0) {
      managed.providerLabel = a.providerLabel
    }
  }
  const out: ParsedAgent = { id: a.id, capabilities, managed }
  if (typeof a.displayName === 'string') out.displayName = a.displayName
  return out
}

/**
 * Render a single AgentRecord back into a v1 agent manifest. Used by the
 * `GET /api/admin/agents/export/:id` endpoint so a user can grab a
 * working agent's config, edit it elsewhere, and re-import.
 */
export function renderAgentManifest(rec: {
  id: string
  allowedCapabilities: readonly string[]
  displayName?: string
  managed?: ManagedAgentSpec
}): Record<string, unknown> {
  if (!rec.managed) {
    throw new Error(`renderAgentManifest: '${rec.id}' has no managed spec to export`)
  }
  const agent: Record<string, unknown> = {
    id: rec.id,
    capabilities: [...rec.allowedCapabilities],
    kind: rec.managed.kind,
    provider: rec.managed.provider,
    system: rec.managed.system,
  }
  if (rec.managed.model) agent.model = rec.managed.model
  if (rec.managed.weightDefault != null) agent.weightDefault = rec.managed.weightDefault
  // Echo openai-compatible-specific fields so a round-trip export →
  // edit → re-import doesn't drop the connection details.
  if (rec.managed.baseURL) agent.baseURL = rec.managed.baseURL
  if (rec.managed.providerLabel) agent.providerLabel = rec.managed.providerLabel
  if (rec.displayName) agent.displayName = rec.displayName
  return {
    schema: AGENT_SCHEMA_V1,
    agent,
  }
}
