/**
 * Admin routes for outbound A2A agent registration (Route B P1-M11c).
 *
 * An outbound A2A agent is a LOCAL participant that, when a matching capability
 * is dispatched, forwards the task to an external agent's A2A `message/send`.
 * Phase 18 C-M4 configured these from the `AIPE_A2A_AGENTS` env blob (no UI, no
 * persistence); M11 moves them into identity (`a2a_outbound_agents`) so an admin
 * can CRUD them and edits take effect on the running hub without a restart.
 *
 *   GET    /api/admin/a2a-agents       list registered outbound agents
 *   POST   /api/admin/a2a-agents       register one (id is the participant id)
 *   PATCH  /api/admin/a2a-agents/:id    targeted update (id immutable)
 *   DELETE /api/admin/a2a-agents/:id    remove + unregister from the hub
 *
 * Backed by a host-injected surface (web has no @aipehub/identity dep). Absent
 * (no identity store) → every route 503s.
 *
 * Unlike OIDC there is NO secret to hide: `tokenEnv` is the NAME of the env var
 * the bearer is read from, not the bearer itself, so the view carries it in full
 * (an admin must see which env var to provision). The view ALSO carries runtime
 * liveness — `active` + (when inactive) `inactiveReason` — which the host joins
 * from the running hub, so the UI can show "saved but inactive: token env unset"
 * honestly instead of pretending a token-less row is running.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminRecord } from '@aipehub/core'
import { createLogger } from '@aipehub/core'

import { readJsonBody, sendJson } from './http-helpers.js'

const log = createLogger('a2a-admin-routes')

/** Public projection of a stored outbound A2A agent (duck-typed mirror of the
 * host's `A2aOutboundAgent`), plus host-joined runtime liveness. The bearer is
 * NEVER carried — only `tokenEnv`, the name of the env var it lives in. */
export interface A2aAgentView {
  id: string
  capabilities: string[]
  url: string
  tokenEnv: string
  peerId: string | null
  targetSkill: string | null
  enabled: boolean
  label: string | null
  createdAt: number
  updatedAt: number
  /** True iff this agent is registered+live on the hub right now. */
  active: boolean
  /** When inactive: 'disabled' | 'token_env_unset' | 'id_conflict' | 'not_found'. */
  inactiveReason?: string
}

export interface A2aAgentAddInput {
  /** The LOCAL participant id (dispatch target) — supplied by the admin, unique. */
  id: string
  capabilities: string[]
  url: string
  tokenEnv: string
  peerId?: string | null
  targetSkill?: string | null
  label?: string | null
  enabled?: boolean
}

export interface A2aAgentUpdateInput {
  capabilities?: string[]
  url?: string
  tokenEnv?: string
  peerId?: string | null
  targetSkill?: string | null
  label?: string | null
  enabled?: boolean
}

/** Host-injected registry surface (identity's A2A facade joined with the
 * outbound manager's liveness satisfies it). `add`/`update` also push the change
 * onto the running hub, so the returned view's `active` is already accurate. */
export interface A2aAgentAdminSurface {
  list(): A2aAgentView[]
  add(input: A2aAgentAddInput): A2aAgentView
  update(id: string, patch: A2aAgentUpdateInput): A2aAgentView
  remove(id: string): boolean
}

export interface A2aAdminRoutesCtx {
  a2aAgents?: A2aAgentAdminSurface
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

const BASE = '/api/admin/a2a-agents'

const ERROR_STATUS: Record<string, number> = {
  a2a_agent_exists: 409,
  a2a_agent_not_found: 404,
  invalid_input: 400,
}

/** Map a typed store error (`.code`) to an HTTP status; unknown → 500. */
function sendStoreError(res: ServerResponse, err: unknown): void {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    const code = (err as { code: string }).code
    sendJson(res, { error: code }, ERROR_STATUS[code] ?? 400)
    return
  }
  const msg = err instanceof Error ? err.message : String(err)
  log.error('a2a admin store error', { err: msg })
  sendJson(res, { error: msg }, 500)
}

function asObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

/** capabilities must be a non-empty array of strings (the store trims/normalizes). */
function coerceCapabilities(v: unknown): { value: string[] } | { error: string } {
  if (!Array.isArray(v) || v.length === 0) {
    return { error: 'capabilities must be a non-empty array of strings' }
  }
  for (const c of v) {
    if (typeof c !== 'string') return { error: 'capabilities must be strings' }
  }
  return { value: v as string[] }
}

/** peerId/targetSkill/label must be string|null; enabled must be boolean. */
function checkOptionalFields(o: Record<string, unknown>): string | null {
  for (const f of ['peerId', 'targetSkill', 'label'] as const) {
    if (o[f] !== undefined && o[f] !== null && typeof o[f] !== 'string') {
      return `${f} must be a string or null`
    }
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return 'enabled must be a boolean'
  return null
}

function pickOptional(o: Record<string, unknown>): Partial<A2aAgentAddInput> {
  return {
    ...(o.peerId !== undefined ? { peerId: o.peerId as string | null } : {}),
    ...(o.targetSkill !== undefined ? { targetSkill: o.targetSkill as string | null } : {}),
    ...(o.label !== undefined ? { label: o.label as string | null } : {}),
    ...(o.enabled !== undefined ? { enabled: o.enabled as boolean } : {}),
  }
}

function coerceAdd(body: unknown): { value: A2aAgentAddInput } | { error: string } {
  const o = asObject(body)
  if (!o) return { error: 'body must be an object' }
  for (const f of ['id', 'url', 'tokenEnv'] as const) {
    if (typeof o[f] !== 'string' || (o[f] as string).trim().length === 0) {
      return { error: `${f} must be a non-empty string` }
    }
  }
  const caps = coerceCapabilities(o.capabilities)
  if ('error' in caps) return { error: caps.error }
  const bad = checkOptionalFields(o)
  if (bad) return { error: bad }
  return {
    value: {
      id: o.id as string,
      capabilities: caps.value,
      url: o.url as string,
      tokenEnv: o.tokenEnv as string,
      ...pickOptional(o),
    },
  }
}

function coerceUpdate(body: unknown): { value: A2aAgentUpdateInput } | { error: string } {
  const o = asObject(body)
  if (!o) return { error: 'body must be an object' }
  for (const f of ['url', 'tokenEnv'] as const) {
    if (o[f] !== undefined && (typeof o[f] !== 'string' || (o[f] as string).trim().length === 0)) {
      return { error: `${f} must be a non-empty string` }
    }
  }
  let caps: string[] | undefined
  if (o.capabilities !== undefined) {
    const c = coerceCapabilities(o.capabilities)
    if ('error' in c) return { error: c.error }
    caps = c.value
  }
  const bad = checkOptionalFields(o)
  if (bad) return { error: bad }
  return {
    value: {
      ...(caps !== undefined ? { capabilities: caps } : {}),
      ...(o.url !== undefined ? { url: o.url as string } : {}),
      ...(o.tokenEnv !== undefined ? { tokenEnv: o.tokenEnv as string } : {}),
      ...pickOptional(o),
    },
  }
}

/**
 * Handle the admin outbound-A2A CRUD routes. Returns `true` if the request
 * matched a `/api/admin/a2a-agents[/:id]` path (and was answered).
 */
export async function handleA2aAdminRoute(
  ctx: A2aAdminRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  if (!ctx.a2aAgents) {
    sendJson(res, { error: 'a2a outbound admin not enabled on this host' }, 503)
    return true
  }
  const surface = ctx.a2aAgents

  // Collection: list / register.
  if (path === BASE) {
    if (method === 'GET') {
      sendJson(res, { agents: surface.list() })
      return true
    }
    if (method === 'POST') {
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, { error: 'invalid json body' }, 400)
        return true
      }
      const parsed = coerceAdd(body)
      if ('error' in parsed) {
        sendJson(res, { error: parsed.error }, 400)
        return true
      }
      try {
        sendJson(res, { agent: surface.add(parsed.value) }, 201)
      } catch (err) {
        sendStoreError(res, err)
      }
      return true
    }
    sendJson(res, { error: `method ${method} not allowed` }, 405)
    return true
  }

  // Item: update / remove. The id is the single segment after the base.
  const id = decodeURIComponent(path.slice(BASE.length + 1))
  if (!id || id.includes('/')) {
    sendJson(res, { error: 'bad agent id' }, 400)
    return true
  }

  if (method === 'PATCH') {
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, { error: 'invalid json body' }, 400)
      return true
    }
    const parsed = coerceUpdate(body)
    if ('error' in parsed) {
      sendJson(res, { error: parsed.error }, 400)
      return true
    }
    try {
      sendJson(res, { agent: surface.update(id, parsed.value) })
    } catch (err) {
      sendStoreError(res, err)
    }
    return true
  }

  if (method === 'DELETE') {
    try {
      const removed = surface.remove(id)
      if (!removed) {
        sendJson(res, { error: 'a2a_agent_not_found' }, 404)
        return true
      }
      sendJson(res, { ok: true })
    } catch (err) {
      sendStoreError(res, err)
    }
    return true
  }

  sendJson(res, { error: `method ${method} not allowed` }, 405)
  return true
}
