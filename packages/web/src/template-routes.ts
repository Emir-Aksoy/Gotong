/**
 * Admin route for v5 Stream B template export (B-M2).
 *
 *   POST /api/admin/templates/export
 *     body: { name, description?, version?, agentIds?, workflowIds?,
 *             knowledgeBases?, apiKeyPrompt? }
 *     → { ok: true, template }   // an aipehub.template/v1 manifest object
 *
 * The export is the structure-safe DEFAULT (decision #5): it carries agent
 * config + workflow definitions + KB *wiring*, and by construction NO knowledge
 * content, NO personnel info, NO literal secrets (see `renderTemplate` /
 * `scrubAgentSecrets`). Including content / personnel is B-M3's gated, audited
 * path — not reachable here.
 *
 * Agent records come from the Space; workflow structure from the host's
 * authored-YAML reader (`exportDefinitionText`) so an embedded workflow is
 * guaranteed to re-parse. The rendered manifest is run back through
 * `parseTemplate` as an integrity gate (which also validates any
 * operator-supplied `knowledgeBases`).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { parse as parseYaml } from 'yaml'

import type { AdminRecord } from '@aipehub/core'
import { createLogger } from '@aipehub/core'

import { readJsonBody, sendJson } from './http-helpers.js'
import { ManifestError, type BundleApiKeyPrompt } from './manifest.js'
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

export interface TemplateRoutesCtx {
  agentSource: TemplateAgentSource
  workflows?: TemplateWorkflowSource
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

const EXPORT_PATH = '/api/admin/templates/export'

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

  const rendered = renderTemplate(input)
  // Integrity gate: the export MUST round-trip through the parser. This proves
  // structural soundness AND validates operator-supplied knowledgeBases — a bad
  // KB slot surfaces as a friendly 400 instead of a broken downloadable file.
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

  sendJson(res, { ok: true, template: rendered })
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
