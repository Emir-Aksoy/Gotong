/**
 * Admin routes for outbound ACP agent registration (ACP-OUT-M3).
 *
 * An outbound ACP agent is a LOCAL participant that, when a matching capability
 * is dispatched, drives a coding agent (Claude Code / Codex) over a long-lived
 * ACP session — spawn once, hold the session, dispatch many tasks. ACP-OUT moves
 * these from example glue into identity (`acp_outbound_agents`) so an admin can
 * CRUD them and edits take effect on the running hub without a restart.
 *
 *   GET    /api/admin/acp-agents        list registered outbound agents
 *   POST   /api/admin/acp-agents        register one (id is the participant id)
 *   PATCH  /api/admin/acp-agents/:id     targeted update (id immutable)
 *   DELETE /api/admin/acp-agents/:id     remove + unregister from the hub
 *
 * Backed by a host-injected surface (web has no @aipehub/identity dep). Absent
 * (no identity store) → every route 503s.
 *
 * Unlike A2A there is NOTHING secret here, not even an env-var pointer: an ACP
 * bridge authenticates with the underlying agent's OWN login (`claude` / `codex`
 * already logged in on this machine), so the whole record (command/args/cwd) is
 * non-secret config carried in full. The view ALSO carries runtime liveness —
 * `active` + (when inactive) `inactiveReason` — joined from the running hub, so
 * the UI can show "saved but inactive: disabled" honestly.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminRecord } from '@aipehub/core'
import { createLogger } from '@aipehub/core'

import { readJsonBody, sendJson } from './http-helpers.js'

const log = createLogger('acp-admin-routes')

/** Public projection of a stored outbound ACP agent (duck-typed mirror of the
 * host's `AcpOutboundAgent`), plus host-joined runtime liveness. No secret of
 * any kind — ACP rides the underlying agent's own login. */
export interface AcpAgentView {
  id: string
  capabilities: string[]
  command: string
  args: string[]
  cwd: string | null
  enabled: boolean
  label: string | null
  createdAt: number
  updatedAt: number
  /** True iff this agent is registered+live on the hub right now. */
  active: boolean
  /** When inactive: 'disabled' | 'id_conflict' | 'not_found'. */
  inactiveReason?: string
}

export interface AcpAgentAddInput {
  /** The LOCAL participant id (dispatch target) — supplied by the admin, unique. */
  id: string
  capabilities: string[]
  command: string
  args?: string[]
  cwd?: string | null
  label?: string | null
  enabled?: boolean
}

export interface AcpAgentUpdateInput {
  capabilities?: string[]
  command?: string
  args?: string[]
  cwd?: string | null
  label?: string | null
  enabled?: boolean
}

/** Host-injected registry surface (identity's ACP facade joined with the
 * outbound manager's liveness satisfies it). `add`/`update` also push the change
 * onto the running hub, so the returned view's `active` is already accurate. */
export interface AcpAgentAdminSurface {
  list(): AcpAgentView[]
  add(input: AcpAgentAddInput): AcpAgentView
  update(id: string, patch: AcpAgentUpdateInput): AcpAgentView
  remove(id: string): boolean
}

export interface AcpAdminRoutesCtx {
  acpAgents?: AcpAgentAdminSurface
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

const BASE = '/api/admin/acp-agents'

const ERROR_STATUS: Record<string, number> = {
  acp_agent_exists: 409,
  acp_agent_not_found: 404,
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
  log.error('acp admin store error', { err: msg })
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

/** args is optional; when present it must be an array of strings (EMPTY allowed —
 * a bare binary may take no argv). */
function coerceArgs(v: unknown): { value: string[] } | { error: string } {
  if (!Array.isArray(v)) return { error: 'args must be an array of strings' }
  for (const a of v) {
    if (typeof a !== 'string') return { error: 'args must be strings' }
  }
  return { value: v as string[] }
}

/** cwd/label must be string|null; enabled must be boolean. */
function checkOptionalFields(o: Record<string, unknown>): string | null {
  for (const f of ['cwd', 'label'] as const) {
    if (o[f] !== undefined && o[f] !== null && typeof o[f] !== 'string') {
      return `${f} must be a string or null`
    }
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return 'enabled must be a boolean'
  return null
}

function pickOptional(o: Record<string, unknown>): Partial<AcpAgentAddInput> {
  return {
    ...(o.cwd !== undefined ? { cwd: o.cwd as string | null } : {}),
    ...(o.label !== undefined ? { label: o.label as string | null } : {}),
    ...(o.enabled !== undefined ? { enabled: o.enabled as boolean } : {}),
  }
}

function coerceAdd(body: unknown): { value: AcpAgentAddInput } | { error: string } {
  const o = asObject(body)
  if (!o) return { error: 'body must be an object' }
  for (const f of ['id', 'command'] as const) {
    if (typeof o[f] !== 'string' || (o[f] as string).trim().length === 0) {
      return { error: `${f} must be a non-empty string` }
    }
  }
  const caps = coerceCapabilities(o.capabilities)
  if ('error' in caps) return { error: caps.error }
  let args: string[] | undefined
  if (o.args !== undefined) {
    const a = coerceArgs(o.args)
    if ('error' in a) return { error: a.error }
    args = a.value
  }
  const bad = checkOptionalFields(o)
  if (bad) return { error: bad }
  return {
    value: {
      id: o.id as string,
      capabilities: caps.value,
      command: o.command as string,
      ...(args !== undefined ? { args } : {}),
      ...pickOptional(o),
    },
  }
}

function coerceUpdate(body: unknown): { value: AcpAgentUpdateInput } | { error: string } {
  const o = asObject(body)
  if (!o) return { error: 'body must be an object' }
  if (o.command !== undefined && (typeof o.command !== 'string' || (o.command as string).trim().length === 0)) {
    return { error: 'command must be a non-empty string' }
  }
  let caps: string[] | undefined
  if (o.capabilities !== undefined) {
    const c = coerceCapabilities(o.capabilities)
    if ('error' in c) return { error: c.error }
    caps = c.value
  }
  let args: string[] | undefined
  if (o.args !== undefined) {
    const a = coerceArgs(o.args)
    if ('error' in a) return { error: a.error }
    args = a.value
  }
  const bad = checkOptionalFields(o)
  if (bad) return { error: bad }
  return {
    value: {
      ...(caps !== undefined ? { capabilities: caps } : {}),
      ...(o.command !== undefined ? { command: o.command as string } : {}),
      ...(args !== undefined ? { args } : {}),
      ...pickOptional(o),
    },
  }
}

/**
 * Handle the admin outbound-ACP CRUD routes. Returns `true` if the request
 * matched a `/api/admin/acp-agents[/:id]` path (and was answered).
 */
export async function handleAcpAdminRoute(
  ctx: AcpAdminRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  if (!ctx.acpAgents) {
    sendJson(res, { error: 'acp outbound admin not enabled on this host' }, 503)
    return true
  }
  const surface = ctx.acpAgents

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
        sendJson(res, { error: 'acp_agent_not_found' }, 404)
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
