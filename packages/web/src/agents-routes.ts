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
} from '@gotong/core'
import { createLogger } from '@gotong/core'
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
import { decryptJson } from './template-crypto.js'
import { injectAgentSecrets, parseTemplate, type ParsedTemplate } from './template-manifest.js'

const log = createLogger('agents-routes')

// -- types ----------------------------------------------------------------

/** Duck-typed workflow surface — only the method the bundle importer needs. */
export interface AgentsWorkflowSurface {
  importFromText(yaml: string): Promise<unknown>
}

/**
 * ease-of-use ③-M1 — duck-typed LLM-key probe. The host's LocalAgentPool
 * satisfies it via `hasResolvableLlmKey(agentId, provider)`. The template-import
 * handler uses it to derive the "agent X still needs a key" half of the
 * post-install checklist (the KB-slot half is always derivable from the parsed
 * template alone). Absent → the missing-key advisories are simply omitted (zero
 * regression on hosts that don't wire it). Best-effort by contract: a probe that
 * throws is treated as "resolvable" so the checklist never blocks or fails an
 * import — it's advisory, not a gate.
 */
export interface LlmKeyProbe {
  resolvesKey(agentId: string, provider: string): Promise<boolean>
}

/**
 * RES-M2 — duck-typed adaptation proposal engine. The host wires
 * `createResourceAdaptationService`; the template-import handler asks it for
 * proposals about the freshly-created agents + unwired KB slots, and attaches
 * them to the post-install checklist. Proposals are pure data (echoed opaquely
 * here — the server owns their shape); nothing is enacted until RES-M3 apply on
 * explicit human approval. Absent → the checklist carries no `adaptations`.
 */
export interface AgentsAdaptationSurface {
  propose(input: {
    agents: readonly { id: string; provider: string }[]
    kbSlots?: readonly { name: string; useMcpServer?: string }[]
  }): Promise<unknown[]>
}

/** v5 E4-M1 — grant levels on an agent resource (mirror of workflow perms). */
export type AgentPermLiteral = 'viewer' | 'editor' | 'owner'

/**
 * v5 E4-M1 — duck-typed agent-grant sink (the IdentityStore satisfies it via
 * its `hasAgentGrant`/`setAgentGrant`/… facade). Mirrors workflow-routes'
 * WorkflowGrantSink so the web layer keeps zero `@gotong/identity` runtime dep.
 */
export interface AgentGrantSink {
  hasAgentGrant(agentId: string, userId: string, min: AgentPermLiteral): boolean
  setAgentGrant(input: {
    agentId: string
    userId: string
    perm: AgentPermLiteral
    grantedBy?: string | null
  }): unknown
  listAgentGrants(agentId: string): {
    agentId: string
    userId: string
    perm: AgentPermLiteral
    grantedBy: string | null
    grantedAt: number
  }[]
  removeAgentGrant(agentId: string, userId: string): boolean
  removeAllAgentGrants(agentId: string): number
}

/** v5 E4-M1 — the acting admin's RBAC identity (same shape workflow-routes uses). */
export interface AgentActor {
  userId: string | null
  isOperator: boolean
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
  /**
   * v5 E4-M1 — agent resource RBAC (mirrors workflow-routes). RBAC is OFF unless
   * the host wires BOTH `agentGrants` and `resolveActor`; then operators (org
   * owner / v3 Space admin) bypass and a non-operator v4 admin needs a grant.
   * Absent → every admin passes (zero regression for existing deployments).
   */
  agentGrants?: AgentGrantSink
  resolveActor?(req: IncomingMessage): AgentActor
  /**
   * ease-of-use ③-M1 — optional probe for the template-import post-install
   * checklist. The host wires it to LocalAgentPool.hasResolvableLlmKey. Absent
   * → the "agent X still needs a key" advisories are omitted (KB-slot advisories
   * are still derived from the parsed template).
   */
  llmKeyProbe?: LlmKeyProbe
  /**
   * RES-M2 — optional adaptation proposal engine. The template-import handler
   * asks it for proposals about the freshly-created agents + unwired KB slots.
   * Absent → the checklist carries no `adaptations` (zero regression).
   */
  resourceAdaptation?: AgentsAdaptationSurface
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
  // Butler fold-in opt-in marker: spawn a chat agent as a resident
  // PersonalButlerAgent (cross-session memory + governed loop). Pure
  // passthrough — the host owns the upgrade and can also default it on via
  // GOTONG_BUTLER, so most deployments never set this per-agent.
  if (typeof body.butler === 'boolean') managed.butler = body.butler
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

// -- RES-M3: adaptation apply --------------------------------------------------

/**
 * RES-M3 — the proposal shape the adapt-apply route accepts. A permissive mirror
 * of the host `AdaptationProposal` (web keeps zero host runtime dep). Only the
 * fields the apply needs are read; everything is treated as untrusted input.
 */
interface AdaptApplyProposal {
  kind?: unknown
  agentId?: unknown
  applicable?: unknown
  toProvider?: unknown
  suggestedBaseURL?: unknown
  endpointLabel?: unknown
}

/**
 * RES-M3 — turn an APPLICABLE proposal + the target agent's current record into
 * a PUT-shaped edit body (the exact contract `applyAgentEdit` validates). We
 * rebuild the agent's own fields and override ONLY the provider bits, so an
 * adaptation is a constrained edit that preserves system prompt / capabilities /
 * MCP wiring / heartbeat. Returns null for anything that can't be cleanly enacted
 * (advisory kinds, a non-native switch target, a non-managed agent) so the route
 * fails closed — nothing is ever half-applied.
 */
function adaptEditBodyFromProposal(
  existing: AgentRecord,
  p: AdaptApplyProposal,
): Record<string, unknown> | null {
  const m = existing.managed
  if (!m || m.kind !== 'llm') return null // only managed LLM agents can be adapted
  const body: Record<string, unknown> = {
    id: existing.id,
    capabilities: existing.allowedCapabilities,
    system: m.system ?? '',
    provider: m.provider,
  }
  if (existing.displayName) body.displayName = existing.displayName
  if (typeof m.model === 'string' && m.model) body.model = m.model
  if (typeof m.weightDefault === 'number') body.weightDefault = m.weightDefault
  if (m.uses) body.uses = m.uses
  if (m.useMcpServers) body.useMcpServers = m.useMcpServers
  if (m.heartbeat) body.heartbeat = m.heartbeat
  if (typeof m.butler === 'boolean') body.butler = m.butler

  if (p.kind === 'use_local_endpoint') {
    if (typeof p.suggestedBaseURL !== 'string' || !p.suggestedBaseURL) return null
    body.provider = 'openai-compatible'
    body.baseURL = p.suggestedBaseURL
    if (typeof p.endpointLabel === 'string' && p.endpointLabel) body.providerLabel = p.endpointLabel
    // A local model server (e.g. Ollama) ignores the key, but openai-compatible
    // validation requires a non-empty per-agent key — set a harmless placeholder.
    body.apiKey = 'local'
    return body
  }
  if (p.kind === 'switch_provider') {
    // Only native literals are one-click applicable (RES-M2 sets `applicable`
    // to match); a compat target would need a baseURL the inventory can't give.
    if (p.toProvider !== 'anthropic' && p.toProvider !== 'openai') return null
    body.provider = p.toProvider
    delete body.baseURL // shed any compat-only fields carried from the old provider
    delete body.providerLabel
    return body
  }
  return null // advisory kinds (set_env_key / wire_mcp_server) are not enactable
}

// -- RBAC (v5 E4-M1) ------------------------------------------------------

/**
 * v5 E4-M1 — agent grant gate. Returns true (and writes 403) iff the acting
 * admin LACKS `min` permission on the agent; false = allowed, continue.
 *
 * RBAC is OFF when the host didn't wire BOTH `agentGrants` and `resolveActor`
 * (embedded / test / pre-migration host) — then every admin passes, so existing
 * deployments are unaffected. Operators (org owner / v3 Space admin) always
 * bypass; a non-operator needs a `userId` holding a grant ≥ `min`.
 */
function denyIfNoAgentPerm(
  ctx: AgentsRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  min: AgentPermLiteral,
): boolean {
  if (!ctx.agentGrants || !ctx.resolveActor) return false
  const actor = ctx.resolveActor(req)
  if (actor.isOperator) return false
  if (actor.userId && ctx.agentGrants.hasAgentGrant(id, actor.userId, min)) return false
  sendJson(res, { error: `agent '${id}' requires ${min} permission`, code: 'agent_forbidden' }, 403)
  return true
}

/**
 * v5 E4-M1 — seed the creator as the agent's owner after create / import. Only
 * when RBAC is wired AND the actor is a v4 user: a v3-admin operator has no user
 * row to own it (operators manage by bypass, not by grant). Best-effort — a
 * grant-seed hiccup must never fail the create that already succeeded.
 */
function seedAgentOwner(ctx: AgentsRoutesCtx, req: IncomingMessage, agentId: string): void {
  if (!ctx.agentGrants || !ctx.resolveActor) return
  const actor = ctx.resolveActor(req)
  if (!actor.userId) return
  try {
    ctx.agentGrants.setAgentGrant({ agentId, userId: actor.userId, perm: 'owner', grantedBy: actor.userId })
  } catch (err) {
    log.warn('seed agent owner failed', { agentId, err })
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

  // Shared write path for editing ONE existing agent from a PUT-shaped body:
  // validate → provider-key check → upsert → set/clear per-agent key →
  // lifecycle.start → heartbeat reconcile. Both the PUT edit route and the
  // RES-M3 adapt-apply route funnel through here so an "apply a proposal" write
  // gets the exact same validation, lifecycle restart, and reconcile as a manual
  // edit — the adaptation apply is nothing more than a constrained agent edit.
  // Returns an outcome; the CALLER owns the HTTP response (and RBAC / auth).
  const applyAgentEdit = async (
    id: string,
    body: Record<string, unknown>,
    at: string,
  ): Promise<{ ok: true; record: AgentRecord } | { ok: false; status: number; error: string }> => {
    body.id = id
    let parsed: ParsedAgent
    try {
      parsed = validateAgentBody(body)
    } catch (err) {
      return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) }
    }
    const existing = (await ctx.space.agents()).find((a) => a.id === id)
    if (!existing) return { ok: false, status: 404, error: `unknown agent '${id}'` }
    if (ctx.lifecycle) {
      const avail = new Set(await ctx.lifecycle.availableProviders())
      const hasInlineKey =
        typeof (body as { apiKey?: unknown }).apiKey === 'string' && (body as { apiKey?: string }).apiKey!.length > 0
      const hasStoredKey = (await ctx.space.getAgentApiKey(id).catch(() => null)) !== null
      if (!avail.has(parsed.managed.provider) && !hasInlineKey && !hasStoredKey) {
        return { ok: false, status: 400, error: `provider '${parsed.managed.provider}' has no API key` }
      }
      if (parsed.managed.provider === 'openai-compatible') {
        const editKey = (body as { apiKey?: unknown }).apiKey
        const willClear = editKey === ''
        const willSet = typeof editKey === 'string' && editKey.length > 0
        const willHaveKey = willSet || (!willClear && hasStoredKey)
        if (!willHaveKey) {
          return {
            ok: false,
            status: 400,
            error: "provider 'openai-compatible' requires a per-agent apiKey (workspace keys don't apply)",
          }
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
        return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) }
      }
    }
    await reconcileHeartbeats(at)
    return { ok: true, record }
  }

  // --- RES-M3: apply ONE adaptation proposal (human-approved) ---
  // The operator submitting a SPECIFIC proposal IS the human approval — nothing
  // is ever changed silently. Only `applicable` proposals (use_local_endpoint /
  // switch_provider to a native provider) are enactable; advisory ones are
  // rejected with a clear message. The write funnels through applyAgentEdit, so
  // an apply is exactly a constrained agent edit (same validation + lifecycle +
  // reconcile). RES-M1 probing and RES-M2 proposing stay strictly read-only.
  if (method === 'POST' && path === '/api/admin/resources/adapt') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const reqBody = (await readJsonBody(req).catch(() => ({}))) as { proposal?: AdaptApplyProposal }
    const p = reqBody.proposal
    if (!p || typeof p !== 'object') {
      sendJson(res, { ok: false, error: 'body.proposal is required' }, 400)
      return true
    }
    if (p.applicable !== true) {
      // Advisory proposals (set env var, wire an MCP slot, fill a baseURL) are a
      // human action outside the hub — fail closed, never guess.
      sendJson(res, { ok: false, error: '该提议是建议性的，需要你手动处理，不能一键应用', code: 'not_applicable' }, 400)
      return true
    }
    const agentId = typeof p.agentId === 'string' ? p.agentId : ''
    if (!agentId) {
      sendJson(res, { ok: false, error: 'proposal.agentId is required' }, 400)
      return true
    }
    // Applying a proposal edits the agent → require editor on it (v5 E4-M1 RBAC).
    if (denyIfNoAgentPerm(ctx, req, res, agentId, 'editor')) return true
    const existing = (await ctx.space.agents()).find((a) => a.id === agentId)
    if (!existing) {
      sendJson(res, { ok: false, error: `unknown agent '${agentId}'` }, 404)
      return true
    }
    const editBody = adaptEditBodyFromProposal(existing, p)
    if (!editBody) {
      // Defense in depth: a proposal that survived the applicable gate but can't
      // be cleanly turned into an edit (advisory kind, non-native switch target,
      // non-managed agent) is rejected — never half-applied.
      sendJson(res, { ok: false, error: '该提议无法自动应用（不受支持的类型或目标）', code: 'not_applicable' }, 400)
      return true
    }
    const outcome = await applyAgentEdit(agentId, editBody, 'adapt')
    if (!outcome.ok) {
      sendJson(res, { ok: false, error: outcome.error }, outcome.status)
      return true
    }
    sendJson(res, { ok: true, applied: { kind: p.kind, agentId }, agent: publicAgent(outcome.record, ctx.hub) })
    return true
  }

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
    seedAgentOwner(ctx, req, record.id)
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
    for (const rec of created) seedAgentOwner(ctx, req, rec.id)
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
    for (const rec of created) seedAgentOwner(ctx, req, rec.id)
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

  // --- template import (v5 B-M4) ---
  // The inverse of the B-M2/B-M3 export: land an gotong.template/v1's agents +
  // workflows. Mirrors bundle import (same upsert / skip-existing / lifecycle /
  // importFromText pattern) but with N workflows, KB slots reported (NOT
  // auto-wired — decision #4: the importer connects their OWN knowledge base to
  // each slot), and optional sidecar decryption (B-M3): with the separately-
  // delivered key, scrubbed MCP secrets are re-injected. Personnel is NEVER
  // restored — principal ids are hub-local and don't transfer across hubs.
  if (method === 'POST' && path === '/api/admin/templates/import') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const rawBody = await readTextBody(req).catch(() => '')
    if (!rawBody) { sendJson(res, { error: 'empty body' }, 400); return true }
    let body: { template?: unknown; encryptionKey?: unknown }
    try {
      body = JSON.parse(rawBody)
    } catch (err) {
      sendJson(res, { error: `body must be JSON {"template": "<template yaml/json>", "encryptionKey": "<optional base64 key>"} — got: ${err instanceof Error ? err.message : String(err)}` }, 400)
      return true
    }
    if (typeof body.template !== 'string' || body.template.length === 0) {
      sendJson(res, { error: 'body.template is required (non-empty string)' }, 400)
      return true
    }
    const encryptionKey =
      typeof body.encryptionKey === 'string' && body.encryptionKey.length > 0 ? body.encryptionKey : undefined
    let template: ParsedTemplate
    try {
      template = parseTemplate(body.template)
    } catch (err) {
      const msg = err instanceof ManifestError ? err.message : err instanceof Error ? err.message : String(err)
      sendJson(res, { error: msg }, 400)
      return true
    }

    // B-M3 sidecar: decrypt with the separately-delivered key, if present. No
    // key + an encrypted block → land structure with ${PLACEHOLDER}s (the
    // importer supplies real values via their own env); flagged in the response.
    let secrets: Record<string, string> | undefined
    let encryptedSkipped = false
    let personnelOmitted = false
    if (template.encrypted) {
      if (!encryptionKey) {
        encryptedSkipped = true
      } else {
        let sidecar: { secrets?: Record<string, string>; personnel?: unknown }
        try {
          sidecar = decryptJson(template.encrypted, encryptionKey) as typeof sidecar
        } catch (err) {
          sendJson(res, { error: `could not decrypt the template's sensitive sidecar — wrong key? (${err instanceof Error ? err.message : String(err)})` }, 400)
          return true
        }
        if (sidecar.secrets && typeof sidecar.secrets === 'object') secrets = sidecar.secrets
        // Personnel decrypts fine but is deliberately NOT restored (hub-local ids).
        if (sidecar.personnel) personnelOmitted = true
      }
    }

    const existing = new Set((await ctx.space.agents()).map((a) => a.id))
    const created: AgentRecord[] = []
    const skipped: string[] = []
    // ease-of-use ③-M1 — remember each freshly-created agent's LLM provider so
    // the post-install checklist can probe whether it has a resolvable key yet.
    // Read from the parsed (pre-injection) managed spec; the provider tag is
    // identical after secret injection.
    const createdProviders: { id: string; provider: string }[] = []
    for (const a of template.agents) {
      if (existing.has(a.id)) { skipped.push(a.id); continue }
      const managed = secrets ? injectAgentSecrets(a.managed, secrets) : a.managed
      const rec = await ctx.space.upsertAgent({
        id: a.id,
        allowedCapabilities: a.capabilities,
        displayName: a.displayName,
        managed,
      })
      created.push(rec)
      if (a.managed && typeof a.managed.provider === 'string') {
        createdProviders.push({ id: a.id, provider: a.managed.provider })
      }
      existing.add(a.id)
    }
    const spawnErrors: { id: string; error: string }[] = []
    if (ctx.lifecycle) {
      for (const rec of created) {
        try { await ctx.lifecycle.start(rec) }
        catch (err) { spawnErrors.push({ id: rec.id, error: err instanceof Error ? err.message : String(err) }) }
      }
    }

    // N workflows — soft-report per id (a duplicate id fails just that one,
    // agents already landed; mirrors the bundle's tolerant single-workflow path).
    const workflows: { id: string; ok: boolean; error?: string }[] = []
    for (const wf of template.workflows) {
      if (!ctx.workflows) {
        workflows.push({ id: wf.id, ok: false, error: 'workflows surface not enabled on this host' })
        continue
      }
      try {
        await ctx.workflows.importFromText(wf.yaml)
        workflows.push({ id: wf.id, ok: true })
      } catch (err) {
        workflows.push({ id: wf.id, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    }

    for (const rec of created) seedAgentOwner(ctx, req, rec.id)
    await reconcileHeartbeats('template')

    // ease-of-use ③-M1 — derive the post-install "last mile" checklist so the
    // gallery can tell the importer what's left to do, rather than just showing
    // counts. Two halves:
    //   - kbSlotsToWire: KB slots the import did NOT auto-wire (decision #4 — we
    //     report, never connect). A slot with an inline `mcpServer` is already
    //     usable; only `useMcpServer` references (or bare slots) need the
    //     importer to point them at their own MCP server.
    //   - agentsMissingKey: freshly-created LLM agents with no resolvable key
    //     yet (→ finish the first-run key wizard / add an org credential).
    //     Derived from the host's key probe; absent (or mock provider) → omitted.
    const kbSlotsToWire = template.knowledgeBases
      .filter((kb) => !kb.mcpServer)
      .map((kb) => ({ name: kb.name, ...(kb.useMcpServer ? { useMcpServer: kb.useMcpServer } : {}) }))
    // FDE-M1 — abstract connector slots (`requires.connectors`): like KB slots
    // these are reported, never auto-wired. Slot id = the MCP server NAME to
    // hang (hub registry, or inline on an agent); which backend is the
    // installer's runtime decision. Optional slots degrade gracefully — the
    // hint tells the importer what the solution does without them.
    const connectorsToWire = template.connectorSlots.map((s) => ({
      id: s.id,
      optional: s.optional,
      ...(s.hint !== undefined ? { hint: s.hint } : {}),
      ...(s.capability !== undefined ? { capability: s.capability } : {}),
    }))
    const agentsMissingKey: { id: string; provider: string }[] = []
    if (ctx.llmKeyProbe) {
      for (const { id, provider } of createdProviders) {
        if (provider === 'mock') continue
        try {
          if (!(await ctx.llmKeyProbe.resolvesKey(id, provider))) {
            agentsMissingKey.push({ id, provider })
          }
        } catch {
          // Probe fault → advisory omit. The checklist must never block or
          // fail an import; a missing probe result is "assume resolvable".
        }
      }
    }

    // RES-M2 — adaptation proposals: how the just-imported agents / KB slots
    // could be wired to THIS machine's resources (use the local Ollama, switch
    // to a provider that already has a key, …). Pure suggestions — nothing is
    // enacted here; RES-M3 apply does that on explicit human approval. Scoped to
    // the freshly-created agents so the importer sees proposals for what they
    // just installed. Best-effort: a proposal fault never fails the import.
    let adaptations: unknown[] = []
    if (ctx.resourceAdaptation && createdProviders.length > 0) {
      try {
        adaptations = await ctx.resourceAdaptation.propose({
          agents: createdProviders,
          kbSlots: kbSlotsToWire,
        })
      } catch {
        adaptations = []
      }
    }

    sendJson(res, {
      ok: true,
      template: { name: template.name, version: template.version, description: template.description },
      team: { created: created.map((r) => publicAgent(r, ctx.hub)), skipped, spawnErrors },
      workflows,
      // KB slots are reported, never auto-wired (decision #4) — the importer
      // connects their own knowledge base to each declared slot.
      knowledgeBases: template.knowledgeBases.map((kb) => ({
        name: kb.name,
        description: kb.description,
        wiring: kb.mcpServer ? 'inline' : 'ref',
        useMcpServer: kb.useMcpServer,
      })),
      secretsApplied: secrets ? Object.keys(secrets).length : 0,
      encryptedSkipped,
      personnelOmitted,
      // ease-of-use ③-M1 — the "what's left to do" checklist (see above).
      // RES-M2 — `adaptations`: read-only proposals to wire agents/slots to
      // local resources; each is applied only via explicit RES-M3 human approval.
      postInstallChecklist: { kbSlotsToWire, connectorsToWire, agentsMissingKey, adaptations },
    })
    return true
  }

  // --- agent grant management (v5 E4-M1, resource RBAC) ---
  // Owner-gated; operators (org owner / v3 admin) bypass. Matched BEFORE the
  // catch-all PUT/DELETE /:id — the extra /grants segment(s) keep these
  // unambiguous. RBAC off (no agentGrants) → 404 so the admin UI hides the panel.
  const agentGrantsMatch = path.match(/^\/api\/admin\/agents\/([^/]+)\/grants$/)
  if (agentGrantsMatch && (method === 'GET' || method === 'POST')) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.agentGrants) {
      sendJson(res, { error: 'agent RBAC not enabled on this host' }, 404)
      return true
    }
    const id = decodeURIComponent(agentGrantsMatch[1]!)
    // Managing (and viewing) the access list is an owner concern.
    if (denyIfNoAgentPerm(ctx, req, res, id, 'owner')) return true
    if (method === 'GET') {
      sendJson(res, { grants: ctx.agentGrants.listAgentGrants(id) })
      return true
    }
    const body = (await readJsonBody(req).catch(() => undefined)) as
      | { userId?: unknown; perm?: unknown }
      | undefined
    const userId = body && typeof body.userId === 'string' ? body.userId.trim() : ''
    const perm = body && typeof body.perm === 'string' ? body.perm : ''
    if (!userId) {
      sendJson(res, { error: 'userId is required' }, 400)
      return true
    }
    if (perm !== 'owner' && perm !== 'editor' && perm !== 'viewer') {
      sendJson(res, { error: "perm must be 'owner' | 'editor' | 'viewer'" }, 400)
      return true
    }
    try {
      ctx.agentGrants.setAgentGrant({ agentId: id, userId, perm, grantedBy: admin.id })
      sendJson(res, { ok: true, grants: ctx.agentGrants.listAgentGrants(id) })
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400)
    }
    return true
  }

  // DELETE /api/admin/agents/:id/grants/:userId — revoke one grant.
  const agentGrantDeleteMatch = path.match(/^\/api\/admin\/agents\/([^/]+)\/grants\/([^/]+)$/)
  if (method === 'DELETE' && agentGrantDeleteMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.agentGrants) {
      sendJson(res, { error: 'agent RBAC not enabled on this host' }, 404)
      return true
    }
    const id = decodeURIComponent(agentGrantDeleteMatch[1]!)
    const userId = decodeURIComponent(agentGrantDeleteMatch[2]!)
    if (denyIfNoAgentPerm(ctx, req, res, id, 'owner')) return true
    const removed = ctx.agentGrants.removeAgentGrant(id, userId)
    sendJson(res, { ok: true, removed })
    return true
  }

  // --- edit one ---
  const editAgentMatch = path.match(/^\/api\/admin\/agents\/([^/]+)$/)

  if (method === 'PUT' && editAgentMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const id = decodeURIComponent(editAgentMatch[1]!)
    // v5 E4-M1 — editing the agent needs editor on it (operators bypass).
    if (denyIfNoAgentPerm(ctx, req, res, id, 'editor')) return true
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
    const outcome = await applyAgentEdit(id, body, 'edit')
    if (!outcome.ok) {
      sendJson(res, { ok: false, error: outcome.error }, outcome.status)
      return true
    }
    sendJson(res, { ok: true, agent: publicAgent(outcome.record, ctx.hub) })
    return true
  }

  // --- delete one ---
  if (method === 'DELETE' && editAgentMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    const id = decodeURIComponent(editAgentMatch[1]!)
    // v5 E4-M1 — deleting an agent needs owner on it (operators bypass).
    if (denyIfNoAgentPerm(ctx, req, res, id, 'owner')) return true
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
    // Drop the agent's grants so a re-create with the same id starts clean.
    ctx.agentGrants?.removeAllAgentGrants(id)
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
    // v5 E4-M1 — exporting an agent's spec needs at least viewer (operators bypass).
    if (denyIfNoAgentPerm(ctx, req, res, id, 'viewer')) return true
    const rec = (await ctx.space.agents()).find((a) => a.id === id)
    if (!rec) { sendJson(res, { error: `unknown agent '${id}'` }, 404); return true }
    if (!rec.managed) {
      sendJson(res, { error: `agent '${id}' is externally-connected (no managed spec to export)` }, 400)
      return true
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${encodeURIComponent(id)}.gotong-agent.json"`,
    })
    res.end(JSON.stringify(renderAgentManifest(rec), null, 2))
    return true
  }

  return false
}
