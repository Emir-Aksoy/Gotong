/**
 * Admin route for v5 Stream B template export (B-M2 structure + B-M3 sensitive).
 *
 *   POST /api/admin/templates/export
 *     body: { name, description?, version?, agentIds?, workflowIds?,
 *             knowledgeBases?, apiKeyPrompt?,
 *             includeSecrets?, includePersonnel? }   // B-M3 opt-ins, default off
 *     → { ok: true, template, encryptionKey? }       // key present iff sensitive
 *
 * The DEFAULT export is structure-safe (decision #5): it carries agent config +
 * workflow definitions + KB *wiring*, and by construction NO knowledge content,
 * NO personnel info, NO literal secrets (see `renderTemplate` / `scrubAgentSecrets`).
 *
 * B-M3 adds two opt-in flags. When either is set, the sensitive material —
 * literal MCP secrets (`includeSecrets`) and/or who-can-access each agent
 * (`includePersonnel`) — is gathered into a sidecar, AES-256-GCM encrypted, and
 * embedded as `template.template.encrypted`; the key is returned SEPARATELY as
 * `encryptionKey` (never inside the file). Every sensitive export is audited.
 * The structure stays identical either way (secrets remain `${PLACEHOLDER}`
 * references), so a sensitive export is a strict superset of the structure one.
 *
 * Agent records come from the Space; workflow structure from the host's
 * authored-YAML reader (`exportDefinitionText`) so an embedded workflow is
 * guaranteed to re-parse; personnel from identity's resource_grants. The
 * STRUCTURE is run back through `parseTemplate` as an integrity gate (before any
 * sidecar is attached) which also validates operator-supplied `knowledgeBases`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { parse as parseYaml } from 'yaml'

import type { AdminRecord } from '@aipehub/core'
import { createLogger } from '@aipehub/core'

import { BUILTIN_TEMPLATES } from './builtin-templates.js'
import { readJsonBody, sendJson } from './http-helpers.js'
import { ManifestError, type BundleApiKeyPrompt } from './manifest.js'
import { encryptJson } from './template-crypto.js'
import {
  parseTemplate,
  renderTemplate,
  type RenderTemplateInput,
  type TemplateAgentInput,
  type TemplateWorkflowInput,
} from './template-manifest.js'

const log = createLogger('template-routes')

/** Narrow agent source — the Space structurally satisfies this. */
export interface TemplateAgentSource {
  agents(): Promise<TemplateAgentInput[]>
}

/** Narrow workflow source — the host WorkflowController satisfies this. */
export interface TemplateWorkflowSource {
  exportDefinitionText(id: string): Promise<string | null>
}

/** One access-grant on an exported agent — the "personnel" B-M3 may export. */
export interface TemplatePersonnelEntry {
  /** The grantee, as a `principalKey` ("user:alice", "agent:x", …). */
  principal: string
  /** viewer | editor | owner. */
  perm: string
}

/**
 * Narrow personnel source (v5 B-M3). Returns who can access an agent — sourced
 * from identity's resource_grants. Wired only when identity is present, so an
 * `includePersonnel` request fails closed (503) on a hub without it.
 */
export interface TemplatePersonnelSource {
  ownersOfAgent(agentId: string): Promise<TemplatePersonnelEntry[]>
}

/**
 * Narrow audit sink (v5 B-M3). Structurally a subset of identity's
 * `writeAuditLog`, so the host injects `ctx.identity` directly. Only the
 * sensitive (opt-in) export path writes a row — a plain structure export is the
 * safe default and is not audited.
 */
export interface TemplateAuditSink {
  writeAuditLog?(input: {
    action: string
    actorSource: 'v4-session' | 'v4-bearer' | 'anonymous' | 'system' | 'federated'
    actorUserId?: string | null
    metadata?: Record<string, unknown> | null
    success?: boolean
  }): unknown
}

export interface TemplateRoutesCtx {
  agentSource: TemplateAgentSource
  workflows?: TemplateWorkflowSource
  /** v5 B-M3 — who-owns-what reader for `includePersonnel` (undefined → 503). */
  personnel?: TemplatePersonnelSource
  /** v5 B-M3 — audit sink for sensitive exports (best-effort). */
  audit?: TemplateAuditSink
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

const EXPORT_PATH = '/api/admin/templates/export'

// ── Track G: template gallery (one-click install of shipped templates) ───────
// The gallery surfaces the curated `aipehub.template/v1` manifests embedded at
// build time (src/builtin-templates.ts, single source of truth in examples/).
// `catalog` lists each one's INSTALL PREVIEW (what agents/workflows/KBs it would
// land); `catalog/:id` returns the raw yaml the frontend POSTs to the existing
// import route. No host injection — these templates are static, so the routes
// read the embedded constant directly.
const CATALOG_PATH = '/api/admin/templates/catalog'
const CATALOG_ITEM_PREFIX = '/api/admin/templates/catalog/'

/** One gallery entry's install preview — derived, never the raw yaml. */
export interface TemplateCatalogEntry {
  /** Stable gallery id (also the `catalog/:id` selector). */
  id: string
  /** Provenance: the example directory this manifest was bundled from. */
  sourceExample: string
  name: string
  description?: string
  version: number
  /** What lands on install — agents (id + capabilities, NO secrets). */
  agents: { id: string; displayName?: string; capabilities: string[] }[]
  /** Declarative workflows the template carries (ids only). */
  workflows: { id: string }[]
  /** Addressable KB slots (name + description; wiring/preset stay server-side). */
  knowledgeBases: { name: string; description?: string }[]
  /** One-click apiKeyPrompt hint, if the template declares one. */
  apiKeyPrompt?: BundleApiKeyPrompt
}

// Built once: BUILTIN_TEMPLATES is a static, build-time constant, so the
// projection through the real parseTemplate (zero drift vs install) is memoized.
let catalogCache: TemplateCatalogEntry[] | null = null

// Exported (WIZ-M4): the host's wizard catalog reuses the SAME projection the
// gallery install preview shows — the wizard can't advertise a template the
// gallery wouldn't install.
export function buildTemplateCatalog(): TemplateCatalogEntry[] {
  if (catalogCache) return catalogCache
  const out: TemplateCatalogEntry[] = []
  for (const t of BUILTIN_TEMPLATES) {
    try {
      // Same parser the install route runs → the preview can't drift from what
      // actually lands. (The anti-rot test guarantees every entry parses; the
      // per-entry guard just keeps one bad manifest from sinking the whole list.)
      const p = parseTemplate(t.yaml)
      out.push({
        id: t.id,
        sourceExample: t.sourceExample,
        name: p.name,
        ...(p.description !== undefined ? { description: p.description } : {}),
        version: p.version,
        agents: p.agents.map((a) => ({
          id: a.id,
          ...(a.displayName !== undefined ? { displayName: a.displayName } : {}),
          capabilities: a.capabilities,
        })),
        workflows: p.workflows.map((w) => ({ id: w.id })),
        knowledgeBases: p.knowledgeBases.map((k) => ({
          name: k.name,
          ...(k.description !== undefined ? { description: k.description } : {}),
        })),
        ...(p.apiKeyPrompt ? { apiKeyPrompt: p.apiKeyPrompt } : {}),
      })
    } catch (err) {
      log.error('builtin template failed to parse for catalog', {
        id: t.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  catalogCache = out
  return out
}

/**
 * Handle the template export route. Returns `true` if the request was handled.
 */
export async function handleTemplateRoute(
  ctx: TemplateRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  // Track G — gallery catalog (list the install previews of shipped templates).
  if (path === CATALOG_PATH) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (method !== 'GET') {
      sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
      return true
    }
    sendJson(res, { templates: buildTemplateCatalog() })
    return true
  }

  // Track G — fetch one template's raw yaml (the frontend POSTs it to import).
  if (path.startsWith(CATALOG_ITEM_PREFIX)) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (method !== 'GET') {
      sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
      return true
    }
    const id = decodeURIComponent(path.slice(CATALOG_ITEM_PREFIX.length))
    const entry = BUILTIN_TEMPLATES.find((t) => t.id === id)
    if (!entry) {
      sendJson(res, { error: `unknown template '${id}'` }, 404)
      return true
    }
    sendJson(res, { id: entry.id, yaml: entry.yaml })
    return true
  }

  if (path !== EXPORT_PATH) return false

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  if (method !== 'POST') {
    sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
    return true
  }

  let body: Record<string, unknown>
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>
  } catch {
    sendJson(res, { error: 'invalid JSON body' }, 400)
    return true
  }

  const name = body.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    sendJson(res, { error: 'name is required (non-empty string)' }, 400)
    return true
  }
  const agentIds = toStringArray(body.agentIds)
  const workflowIds = toStringArray(body.workflowIds)
  if (agentIds === null || workflowIds === null) {
    sendJson(res, { error: 'agentIds / workflowIds must be arrays of strings' }, 400)
    return true
  }

  // v5 B-M3 — sensitive opt-ins (decision #5). Default OFF: the plain export is
  // structure-only. requireAdmin above IS the hub's highest privilege for admin
  // routes, so the extra protection here is explicit opt-in + encryption + audit
  // rather than a separate auth tier (there is none above the admin operator).
  const includeSecrets = body.includeSecrets === true
  const includePersonnel = body.includePersonnel === true
  // Personnel reads identity's resource_grants — fail closed when that source
  // isn't wired rather than silently exporting an empty personnel block.
  if (includePersonnel && !ctx.personnel) {
    sendJson(res, { error: 'personnel export is not available on this hub' }, 503)
    return true
  }

  // Reject up front anything we can't faithfully export, so the operator never
  // gets a silently-partial template (an external agent has no spec; an unknown
  // / never-written workflow has no authored text).
  const missing: string[] = []

  const byId = new Map((await ctx.agentSource.agents()).map((a) => [a.id, a]))
  const agents: TemplateAgentInput[] = []
  for (const id of agentIds) {
    const rec = byId.get(id)
    if (!rec) missing.push(`agent:${id} (unknown)`)
    else if (!rec.managed) missing.push(`agent:${id} (externally-connected — nothing to export)`)
    else agents.push(rec)
  }

  const workflows: TemplateWorkflowInput[] = []
  for (const id of workflowIds) {
    const text = ctx.workflows ? await ctx.workflows.exportDefinitionText(id) : null
    if (text === null) {
      missing.push(`workflow:${id} (unknown or not on disk)`)
      continue
    }
    const inner = unwrapWorkflow(text)
    if (!inner) missing.push(`workflow:${id} (unreadable definition)`)
    else workflows.push({ id, workflow: inner })
  }

  if (missing.length > 0) {
    sendJson(res, { error: `cannot export: ${missing.join('; ')}` }, 404)
    return true
  }

  const input: RenderTemplateInput = { name: name.trim(), agents, workflows }
  if (typeof body.description === 'string') input.description = body.description
  if (typeof body.version === 'number') input.version = body.version
  if (Array.isArray(body.knowledgeBases)) {
    input.knowledgeBases = body.knowledgeBases as Array<Record<string, unknown>>
  }
  if (
    body.apiKeyPrompt &&
    typeof body.apiKeyPrompt === 'object' &&
    typeof (body.apiKeyPrompt as { provider?: unknown }).provider === 'string'
  ) {
    input.apiKeyPrompt = body.apiKeyPrompt as BundleApiKeyPrompt
  }

  const { template: rendered, secrets } = renderTemplate(input)
  // Integrity gate: the STRUCTURE must round-trip through the parser. This proves
  // structural soundness AND validates operator-supplied knowledgeBases — a bad
  // KB slot surfaces as a friendly 400 instead of a broken downloadable file. We
  // gate BEFORE attaching any encrypted sidecar, so the parser stays ignorant of
  // crypto (the sidecar is the importer's concern, B-M4).
  try {
    parseTemplate(JSON.stringify(rendered))
  } catch (err) {
    if (err instanceof ManifestError) {
      sendJson(res, { error: `export would be invalid: ${err.message}` }, 400)
      return true
    }
    log.error('template export integrity gate threw', {
      by: admin.id,
      err: err instanceof Error ? err.message : String(err),
    })
    sendJson(res, { error: 'template export failed' }, 500)
    return true
  }

  // v5 B-M3 — collect the opt-in sensitive material into a sidecar, kept OUT of
  // the shareable structure above. `secrets` are the literal MCP credentials
  // renderTemplate scrubbed (structure keeps the ${PLACEHOLDER} references);
  // `personnel` is who-can-access each exported agent.
  const sensitive: {
    secrets?: Record<string, string>
    personnel?: Record<string, TemplatePersonnelEntry[]>
  } = {}
  if (includeSecrets && Object.keys(secrets).length > 0) sensitive.secrets = secrets
  if (includePersonnel && ctx.personnel) {
    const personnel: Record<string, TemplatePersonnelEntry[]> = {}
    for (const a of agents) personnel[a.id] = await ctx.personnel.ownersOfAgent(a.id)
    sensitive.personnel = personnel
  }

  let encryptionKey: string | undefined
  if (sensitive.secrets || sensitive.personnel) {
    // Encrypt the sidecar and hand the key back SEPARATELY (decision #5): it rides
    // in the HTTP response, never inside the template the operator saves / shares.
    // Whoever receives the file still needs the out-of-band key to read it.
    const { blob, keyB64 } = encryptJson(sensitive)
    ;(rendered.template as Record<string, unknown>).encrypted = blob
    encryptionKey = keyB64
    // Audit the sensitive export (best-effort). A plain structure export is the
    // safe default and is intentionally NOT audited.
    ctx.audit?.writeAuditLog?.({
      action: 'template_export',
      actorSource: 'v4-session',
      actorUserId: admin.id,
      metadata: {
        name: name.trim(),
        agentIds,
        workflowIds,
        includeSecrets: !!sensitive.secrets,
        includePersonnel: !!sensitive.personnel,
      },
      success: true,
    })
  }

  const out: Record<string, unknown> = { ok: true, template: rendered }
  if (encryptionKey) out.encryptionKey = encryptionKey
  sendJson(res, out)
  return true
}

/** `undefined` → `[]`; an array of strings → itself; anything else → `null`. */
function toStringArray(raw: unknown): string[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') return null
    out.push(v)
  }
  return out
}

/** Pull the inner `workflow:` block out of an authored aipehub.workflow/v1 doc. */
function unwrapWorkflow(text: string): Record<string, unknown> | null {
  // parseYaml handles JSON too (YAML ⊇ JSON), so this covers both authored forms.
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch {
    return null
  }
  if (!doc || typeof doc !== 'object') return null
  const wf = (doc as Record<string, unknown>).workflow
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) return null
  return wf as Record<string, unknown>
}
