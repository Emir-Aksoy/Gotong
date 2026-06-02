/**
 * Route handlers for managed-agent CRUD + bundle import.
 *
 * Extracted from server.ts in the P3 audit cleanup. Mirrors the
 * pattern of identity-routes.ts / workflow-routes.ts:
 *   - narrow ctx projection (AgentsRoutesCtx)
 *   - single entry point handleAgentsRoute()
 *   - shared HTTP helpers (sendJson, readJsonBody, readTextBody) from ./http-helpers.js
 *
 * Routes handled:
 *   GET    /api/admin/agents              list agents
 *   GET    /api/admin/agents/providers    available providers
 *   POST   /api/admin/agents              create one
 *   POST   /api/admin/agents/import       bulk import from manifest
 *   PUT    /api/admin/agents/:id          edit one
 *   DELETE /api/admin/agents/:id          remove one
 *   GET    /api/admin/agents/:id/export   download as manifest
 *   POST   /api/admin/bundles/import      import bundle (agents + workflow)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, readTextBody, sendJson } from './http-helpers.js'
import type {
  AdminRecord,
  AgentRecord,
  Hub,
  ManagedAgentLifecycle,
  ManagedAgentSpec,
  Space,
} from '@aipehub/core'
import { createLogger } from '@aipehub/core'
import {
  AGENT_SCHEMA_V1,
  BUNDLE_SCHEMA_V1,
  TEAM_SCHEMA_V1,
  ManifestError,
  parseBundle,
  parseManifest,
  renderAgentManifest,
  validateUsesArray,
  validateUseMcpServersArray,
  validateHeartbeatSpec,
  type ParsedAgent,
} from './manifest.js'

const log = createLogger('agents-routes')

// -- types ----------------------------------------------------------------

/** Duck-typed workflow surface — only the method the bundle importer needs. */
export interface AgentsWorkflowSurface {
  importFromText(yaml: string): Promise<unknown>
}

export interface AgentsRoutesCtx {
  hub: Hub
  space: Space
  lifecycle?: ManagedAgentLifecycle
  workflows?: AgentsWorkflowSurface
  /**
   * v5 D-M4 — optional host callback to re-seed / prune proactive-heartbeat
   * rows after a managed-agent create / edit / delete. The host wires this to
   * its HeartbeatScheduler (lazily spinning up the engine on first opt-in).
   * Absent → heartbeat config still persists and takes effect on next boot,
   * just not live. Best-effort: a failure here never fails the agent write.
   */
  reconcileHeartbeats?: () => Promise<void>
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

// -- validation -----------------------------------------------------------

function validateAgentBody(body: Record<string, unknown>): ParsedAgent {
  if (typeof body.id !== 'string' || body.id.length === 0) {
    throw new ManifestError('id is required')
  }
  if (body.id.length > 80) throw new ManifestError('id too long')
  if (!/^[a-zA-Z0-9_.:-]+$/.test(body.id)) {
    throw new ManifestError("id may only contain letters, digits, '_', '.', ':', '-'")
  }
  const caps = body.capabilities
  if (!Array.isArray(caps)) throw new ManifestError('capabilities must be an array')
  const capabilities: string[] = []
  for (const c of caps) {
    if (typeof c !== 'string' || c.length === 0) throw new ManifestError('capabilities must contain non-empty strings')
    capabilities.push(c)
  }
  const provider = body.provider
  if (
    provider !== 'anthropic' &&
    provider !== 'openai' &&
    provider !== 'openai-compatible' &&
    provider !== 'mock'
  ) {
    throw new ManifestError("provider must be 'anthropic', 'openai', 'openai-compatible' or 'mock'")
  }
  const system = body.system
  if (typeof system !== 'string' || system.length === 0) throw new ManifestError('system is required')
  if (provider === 'openai-compatible') {
    if (typeof body.baseURL !== 'string' || body.baseURL.length === 0) {
      throw new ManifestError("baseURL is required when provider is 'openai-compatible'")
    }
  }
  const managed: ManagedAgentSpec = { kind: 'llm', provider, system }
  if (typeof body.model === 'string' && body.model.length > 0) managed.model = body.model
  if (typeof body.weightDefault === 'number' && Number.isFinite(body.weightDefault)) {
    managed.weightDefault = body.weightDefault
  }
  if (provider === 'openai-compatible') {
    managed.baseURL = body.baseURL as string
    if (typeof body.providerLabel === 'string' && body.providerLabel.length > 0) {
      managed.providerLabel = body.providerLabel
    }
  }
  if (body.uses !== undefined) {
    managed.uses = validateUsesArray(body.uses, 'uses')
  }
  // Opt-in names of hub-registry MCP servers (#2-M1). The names point at
  // entries in mcp-servers.json; LocalAgentPool resolves them at spawn.
  // Empty array = "use none" (lets the edit form clear a prior opt-in).
  if (body.useMcpServers !== undefined) {
    managed.useMcpServers = validateUseMcpServersArray(body.useMcpServers, 'useMcpServers')
  }
  // v5 Stream D — optional proactive heartbeat. The host reconciles parked
  // wake-up rows from this on create/edit (see ctx.reconcileHeartbeats).
  if (body.heartbeat !== undefined) {
    managed.heartbeat = validateHeartbeatSpec(body.heartbeat, 'heartbeat')
  }
  const out: ParsedAgent = { id: body.id, capabilities, managed }
  if (typeof body.displayName === 'string') out.displayName = body.displayName
  return out
}

function publicAgent(rec: AgentRecord, hub: Hub) {
  return {
    id: rec.id,
    allowedCapabilities: rec.allowedCapabilities,
    displayName: rec.displayName,
    managed: rec.managed,
    createdAt: rec.createdAt,
    lastSeen: rec.lastSeen,
    online: hub.participant(rec.id) != null,
  }
}

// -- route handler --------------------------------------------------------

/**
 * Handle `/api/admin/agents/*` and `/api/admin/bundles/import` routes.
 * Returns `true` if the request was handled, `false` otherwise.
 */
export async function handleAgentsRoute(
  ctx: AgentsRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  // v5 D-M4 — re-seed/prune heartbeat rows after an agent-set change.
  // Best-effort: a reconcile failure is logged but never fails the write.
  const reconcileHeartbeats = (at: string): Promise<void> =>
    ctx.reconcileHeartbeats
      ? ctx.reconcileHeartbeats().catch((err) => log.warn('heartbeat reconcile failed', { at, err }))
      : Promise.resolve()

  // --- list agents ---
  if (method === 'GET' && path === '/api/admin/agents') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const agents = await ctx.space.agents()
    const liveIds = new Set(ctx.hub.participants().map((p) => p.id))
    sendJson(res, {
      agents: agents.map((a) => ({
        id: a.id,
        allowedCapabilities: a.allowedCapabilities,
        displayName: a.displayName,
        managed: a.managed,
        createdAt: a.createdAt,
        lastSeen: a.lastSeen,
        online: liveIds.has(a.id),
      })),
    })
    return true
  }

  // --- available providers ---
  if (method === 'GET' && path === '/api/admin/agents/providers') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const providers = ctx.lifecycle ? await ctx.lifecycle.availableProviders() : []
    sendJson(res, { providers })
    return true
  }

  // --- create one ---
  if (method === 'POST' && path === '/api/admin/agents') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
    let parsed: ParsedAgent
    try {
      parsed = validateAgentBody(body)
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400)
      return true
    }
    if ((await ctx.space.agents()).some((a) => a.id === parsed.id)) {
      sendJson(res, { error: `agent '${parsed.id}' already exists; use PUT to edit` }, 409)
      return true
    }
    if (ctx.lifecycle) {
      const avail = new Set(await ctx.lifecycle.availableProviders())
      const hasApiKey = typeof (body as { apiKey?: unknown }).apiKey === 'string' && (body as { apiKey?: string }).apiKey!.length > 0
      if (!avail.has(parsed.managed.provider) && !hasApiKey) {
        sendJson(res, { error: `provider '${parsed.managed.provider}' has no API key (set a workspace default or attach one to this agent)` }, 400)
        return true
      }
      if (parsed.managed.provider === 'openai-compatible' && !hasApiKey) {
        sendJson(res, { error: "provider 'openai-compatible' requires a per-agent apiKey (workspace keys don't apply)" }, 400)
        return true
      }
    }
    const record = await ctx.space.upsertAgent({
      id: parsed.id,
      allowedCapabilities: parsed.capabilities,
      displayName: parsed.displayName,
      managed: parsed.managed,
    })
    const inlineKey = (body as { apiKey?: string }).apiKey
    if (typeof inlineKey === 'string' && inlineKey.length > 0) {
      await ctx.space.setAgentApiKey(parsed.id, inlineKey)
    }
    if (ctx.lifecycle) {
      try {
        await ctx.lifecycle.start(record)
      } catch (err) {
        sendJson(res, { ok: false, warning: 'persisted but failed to spawn', error: err instanceof Error ? err.message : String(err) }, 500)
        return true
      }
    }
    await reconcileHeartbeats('create')
    sendJson(res, { ok: true, agent: publicAgent(record, ctx.hub) })
    return true
  }

  // --- bulk import from manifest ---
  if (method === 'POST' && path === '/api/admin/agents/import') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const raw = await readTextBody(req).catch(() => '')
    if (!raw) { sendJson(res, { error: 'empty body' }, 400); return true }
    let manifest
    try {
      manifest = parseManifest(raw)
    } catch (err) {
      const msg = err instanceof ManifestError ? err.message : (err instanceof Error ? err.message : String(err))
      sendJson(res, { error: msg }, 400)
      return true
    }
    const existing = new Set((await ctx.space.agents()).map((a) => a.id))
    const skipped: string[] = []
    const created: AgentRecord[] = []
    const avail = ctx.lifecycle ? new Set(await ctx.lifecycle.availableProviders()) : null
    for (const a of manifest.agents) {
      if (existing.has(a.id)) { skipped.push(a.id); continue }
      if (avail && !avail.has(a.managed.provider)) {
        sendJson(res, { error: `agent '${a.id}' uses provider '${a.managed.provider}' but no key is configured — set the workspace default first, then re-import` }, 400)
        return true
      }
      const rec = await ctx.space.upsertAgent({
        id: a.id,
        allowedCapabilities: a.capabilities,
        displayName: a.displayName,
        managed: a.managed,
      })
      created.push(rec)
      existing.add(a.id)
    }
    const spawnErrors: { id: string; error: string }[] = []
    if (ctx.lifecycle) {
      for (const rec of created) {
        try { await ctx.lifecycle.start(rec) }
        catch (err) { spawnErrors.push({ id: rec.id, error: err instanceof Error ? err.message : String(err) }) }
      }
    }
    await reconcileHeartbeats('import')
    sendJson(res, {
      ok: true,
      created: created.map((r) => publicAgent(r, ctx.hub)),
      skipped,
      spawnErrors,
      team: manifest.schema === TEAM_SCHEMA_V1
        ? { name: manifest.teamName, description: manifest.teamDescription }
        : undefined,
    })
    return true
  }

  // --- bundle import ---
  if (method === 'POST' && path === '/api/admin/bundles/import') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const rawBody = await readTextBody(req).catch(() => '')
    if (!rawBody) { sendJson(res, { error: 'empty body' }, 400); return true }
    let body: { yaml?: unknown; apiKey?: unknown }
    try {
      body = JSON.parse(rawBody)
    } catch (err) {
      sendJson(res, { error: `body must be JSON {"yaml": "<bundle yaml>", "apiKey": "<optional key>"} — got: ${err instanceof Error ? err.message : String(err)}` }, 400)
      return true
    }
    if (typeof body.yaml !== 'string' || body.yaml.length === 0) {
      sendJson(res, { error: 'body.yaml is required (non-empty string)' }, 400)
      return true
    }
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.length > 0 ? body.apiKey : undefined
    let bundle
    try {
      bundle = parseBundle(body.yaml)
    } catch (err) {
      const msg = err instanceof ManifestError ? err.message : (err instanceof Error ? err.message : String(err))
      sendJson(res, { error: msg }, 400)
      return true
    }
    const existing = new Set((await ctx.space.agents()).map((a) => a.id))
    const created: AgentRecord[] = []
    const skipped: string[] = []
    for (const a of bundle.team.agents) {
      if (existing.has(a.id)) { skipped.push(a.id); continue }
      const rec = await ctx.space.upsertAgent({
        id: a.id,
        allowedCapabilities: a.capabilities,
        displayName: a.displayName,
        managed: a.managed,
      })
      if (apiKey && a.managed.provider === 'openai-compatible') {
        try { await ctx.space.setAgentApiKey(a.id, apiKey) }
        catch (err) { log.warn('bundle import: failed to set per-agent key', { id: a.id, err }) }
      }
      created.push(rec)
      existing.add(a.id)
    }
    const spawnErrors: { id: string; error: string }[] = []
    if (ctx.lifecycle) {
      for (const rec of created) {
        try { await ctx.lifecycle.start(rec) }
        catch (err) { spawnErrors.push({ id: rec.id, error: err instanceof Error ? err.message : String(err) }) }
      }
    }
    let workflowSummary: unknown = undefined
    let workflowError: string | undefined
    if (bundle.workflowYaml) {
      if (!ctx.workflows) {
        workflowError = 'workflows surface not enabled on this host — agents were imported but the bundle workflow is unavailable'
      } else {
        try {
          workflowSummary = await ctx.workflows.importFromText(bundle.workflowYaml)
        } catch (err) {
          workflowError = err instanceof Error ? err.message : String(err)
        }
      }
    }
    await reconcileHeartbeats('bundle')
    sendJson(res, {
      ok: true,
      bundle: { name: bundle.bundleName, description: bundle.bundleDescription },
      team: { created: created.map((r) => publicAgent(r, ctx.hub)), skipped, spawnErrors },
      workflow: workflowSummary,
      workflowError,
    })
    return true
  }

  // --- edit one ---
  const editAgentMatch = path.match(/^\/api\/admin\/agents\/([^/]+)$/)

  if (method === 'PUT' && editAgentMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const id = decodeURIComponent(editAgentMatch[1]!)
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
    body.id = id
    let parsed: ParsedAgent
    try {
      parsed = validateAgentBody(body)
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400)
      return true
    }
    const existing = (await ctx.space.agents()).find((a) => a.id === id)
    if (!existing) { sendJson(res, { error: `unknown agent '${id}'` }, 404); return true }
    if (ctx.lifecycle) {
      const avail = new Set(await ctx.lifecycle.availableProviders())
      const hasInlineKey = typeof (body as { apiKey?: unknown }).apiKey === 'string' && (body as { apiKey?: string }).apiKey!.length > 0
      const hasStoredKey = (await ctx.space.getAgentApiKey(id).catch(() => null)) !== null
      if (!avail.has(parsed.managed.provider) && !hasInlineKey && !hasStoredKey) {
        sendJson(res, { error: `provider '${parsed.managed.provider}' has no API key` }, 400)
        return true
      }
      if (parsed.managed.provider === 'openai-compatible') {
        const editKey = (body as { apiKey?: unknown }).apiKey
        const willClear = editKey === ''
        const willSet = typeof editKey === 'string' && editKey.length > 0
        const willHaveKey = willSet || (!willClear && hasStoredKey)
        if (!willHaveKey) {
          sendJson(res, { error: "provider 'openai-compatible' requires a per-agent apiKey (workspace keys don't apply)" }, 400)
          return true
        }
      }
    }
    const record = await ctx.space.upsertAgent({
      id,
      allowedCapabilities: parsed.capabilities,
      displayName: parsed.displayName,
      managed: parsed.managed,
    })
    const editKey = (body as { apiKey?: string }).apiKey
    if (typeof editKey === 'string') {
      if (editKey.length === 0) {
        await ctx.space.removeAgentApiKey(id).catch(() => { /* no-op */ })
      } else {
        await ctx.space.setAgentApiKey(id, editKey)
      }
    }
    if (ctx.lifecycle) {
      try {
        await ctx.lifecycle.start(record)
      } catch (err) {
        sendJson(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
        return true
      }
    }
    await reconcileHeartbeats('edit')
    sendJson(res, { ok: true, agent: publicAgent(record, ctx.hub) })
    return true
  }

  // --- delete one ---
  if (method === 'DELETE' && editAgentMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const id = decodeURIComponent(editAgentMatch[1]!)
    if (ctx.lifecycle) {
      await ctx.lifecycle.stop(id).catch((err) => log.error('lifecycle stop failed', { id, err }))
    }
    const ok = await ctx.space.removeAgent(id)
    if (!ok) { sendJson(res, { error: `unknown agent '${id}'` }, 404); return true }
    if (ctx.lifecycle?.onAgentRemoved) {
      await ctx.lifecycle.onAgentRemoved(id).catch((err) =>
        log.error('lifecycle.onAgentRemoved failed', { id, err }),
      )
    }
    await reconcileHeartbeats('delete')
    sendJson(res, { ok: true })
    return true
  }

  // --- export one ---
  const exportAgentMatch = path.match(/^\/api\/admin\/agents\/([^/]+)\/export$/)
  if (method === 'GET' && exportAgentMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const id = decodeURIComponent(exportAgentMatch[1]!)
    const rec = (await ctx.space.agents()).find((a) => a.id === id)
    if (!rec) { sendJson(res, { error: `unknown agent '${id}'` }, 404); return true }
    if (!rec.managed) {
      sendJson(res, { error: `agent '${id}' is externally-connected (no managed spec to export)` }, 400)
      return true
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${encodeURIComponent(id)}.aipehub-agent.json"`,
    })
    res.end(JSON.stringify(renderAgentManifest(rec), null, 2))
    return true
  }

  return false
}
