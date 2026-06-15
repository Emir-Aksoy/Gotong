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

/** Stream H2-OUT — long-running poll lifecycle (duck-typed mirror of identity's
 * `A2aOutboundLifecycle`). Both fields optional, so `{}` = lifecycle on with the
 * participant's defaults; a null `lifecycle` on the view means blocking. */
export interface A2aLifecycleInput {
  pollIntervalMs?: number
  maxAttempts?: number
}

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
  /** Stream H2-OUT — long-running poll lifecycle; null = blocking (legacy). */
  lifecycle: A2aLifecycleInput | null
  /**
   * Item 2 (Z-M1) — per-step OUTBOUND data-class allowlist gate at this agent's
   * edge (same `checkOutboundDataClasses` core fn the mesh peer edge uses, so
   * the two never drift). null = allow everything (legacy) / [] = lock shut /
   * list = only these classes may leave on a task's `dataClasses`.
   */
  allowedDataClasses: string[] | null
  /** Item 2 — per-agent outbound send budget per window; null = unlimited. */
  outboundQuotaBudget: number | null
  /** Item 2 — opt into the outbound approval gate (the send parks for a human). */
  requireApprovalOutbound: boolean
  enabled: boolean
  label: string | null
  createdAt: number
  updatedAt: number
  /** True iff this agent is registered+live on the hub right now. */
  active: boolean
  /**
   * When inactive: 'disabled' | 'token_env_unset' | 'approval_unconfigured'
   * (requires approval but the host has no inbox/approver) | 'id_conflict' |
   * 'not_found'.
   */
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
  /** Opt into the long-running lifecycle; null/undefined = blocking (legacy). */
  lifecycle?: A2aLifecycleInput | null
  /** Item 2 — outbound data-class allowlist; null/undefined = allow all. */
  allowedDataClasses?: string[] | null
  /** Item 2 — outbound send budget per window; null/undefined = unlimited. */
  outboundQuotaBudget?: number | null
  /** Item 2 — opt into the outbound approval gate. */
  requireApprovalOutbound?: boolean
  label?: string | null
  enabled?: boolean
}

export interface A2aAgentUpdateInput {
  capabilities?: string[]
  url?: string
  tokenEnv?: string
  peerId?: string | null
  targetSkill?: string | null
  /** undefined = keep; null = turn lifecycle OFF; object = set/replace it. */
  lifecycle?: A2aLifecycleInput | null
  /** undefined = keep; null = clear (allow all); list = replace. */
  allowedDataClasses?: string[] | null
  /** undefined = keep; null = clear (unlimited); number = replace. */
  outboundQuotaBudget?: number | null
  /** undefined = keep; boolean = set. */
  requireApprovalOutbound?: boolean
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

/**
 * lifecycle (Stream H2-OUT) shape check: null → clear; an object with optional
 * positive-number pollIntervalMs/maxAttempts → set; anything else → error. Only
 * called when the key is present (undefined = "keep" stays out of the patch).
 * The store re-validates authoritatively; this is the web shape gate.
 */
function coerceLifecycle(v: unknown): { value: A2aLifecycleInput | null } | { error: string } {
  if (v === null) return { value: null }
  if (typeof v !== 'object' || Array.isArray(v)) {
    return { error: 'lifecycle must be an object or null' }
  }
  const o = v as Record<string, unknown>
  const out: A2aLifecycleInput = {}
  for (const f of ['pollIntervalMs', 'maxAttempts'] as const) {
    if (o[f] !== undefined) {
      const n = o[f]
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
        return { error: `lifecycle.${f} must be a positive number` }
      }
      out[f] = n
    }
  }
  return { value: out }
}

/**
 * Item 2 — outbound data-class allowlist shape check: null → clear (allow all);
 * an array of strings → set ([] = lock shut); anything else → error. Only called
 * when the key is present. The store re-validates authoritatively.
 */
function coerceDataClasses(v: unknown): { value: string[] | null } | { error: string } {
  if (v === null) return { value: null }
  if (!Array.isArray(v)) return { error: 'allowedDataClasses must be an array of strings or null' }
  for (const c of v) {
    if (typeof c !== 'string') return { error: 'allowedDataClasses must be strings' }
  }
  return { value: v as string[] }
}

/**
 * Item 2 — outbound quota budget shape check: null → clear (unlimited); a
 * non-negative finite number → set; anything else → error. Only called when the
 * key is present.
 */
function coerceQuotaBudget(v: unknown): { value: number | null } | { error: string } {
  if (v === null) return { value: null }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    return { error: 'outboundQuotaBudget must be a non-negative number or null' }
  }
  return { value: v }
}

/** peerId/targetSkill/label must be string|null; enabled/requireApprovalOutbound boolean. */
function checkOptionalFields(o: Record<string, unknown>): string | null {
  for (const f of ['peerId', 'targetSkill', 'label'] as const) {
    if (o[f] !== undefined && o[f] !== null && typeof o[f] !== 'string') {
      return `${f} must be a string or null`
    }
  }
  for (const f of ['enabled', 'requireApprovalOutbound'] as const) {
    if (o[f] !== undefined && typeof o[f] !== 'boolean') return `${f} must be a boolean`
  }
  return null
}

function pickOptional(o: Record<string, unknown>): Partial<A2aAgentAddInput> {
  return {
    ...(o.peerId !== undefined ? { peerId: o.peerId as string | null } : {}),
    ...(o.targetSkill !== undefined ? { targetSkill: o.targetSkill as string | null } : {}),
    ...(o.label !== undefined ? { label: o.label as string | null } : {}),
    ...(o.enabled !== undefined ? { enabled: o.enabled as boolean } : {}),
    ...(o.requireApprovalOutbound !== undefined
      ? { requireApprovalOutbound: o.requireApprovalOutbound as boolean }
      : {}),
  }
}

/**
 * Item 2 — coerce the present-key-gated outbound gate fields (data-class +
 * quota) shared by add/update. Returns the fields to spread, or an error.
 */
function coerceGateFields(
  o: Record<string, unknown>,
): { value: { allowedDataClasses?: string[] | null; outboundQuotaBudget?: number | null } } | { error: string } {
  const out: { allowedDataClasses?: string[] | null; outboundQuotaBudget?: number | null } = {}
  if (o.allowedDataClasses !== undefined) {
    const dc = coerceDataClasses(o.allowedDataClasses)
    if ('error' in dc) return { error: dc.error }
    out.allowedDataClasses = dc.value
  }
  if (o.outboundQuotaBudget !== undefined) {
    const q = coerceQuotaBudget(o.outboundQuotaBudget)
    if ('error' in q) return { error: q.error }
    out.outboundQuotaBudget = q.value
  }
  return { value: out }
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
  let lifecycle: A2aLifecycleInput | null | undefined
  if (o.lifecycle !== undefined) {
    const lc = coerceLifecycle(o.lifecycle)
    if ('error' in lc) return { error: lc.error }
    lifecycle = lc.value
  }
  const gate = coerceGateFields(o)
  if ('error' in gate) return { error: gate.error }
  return {
    value: {
      id: o.id as string,
      capabilities: caps.value,
      url: o.url as string,
      tokenEnv: o.tokenEnv as string,
      ...(lifecycle !== undefined ? { lifecycle } : {}),
      ...gate.value,
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
  let lifecycle: A2aLifecycleInput | null | undefined
  if (o.lifecycle !== undefined) {
    const lc = coerceLifecycle(o.lifecycle)
    if ('error' in lc) return { error: lc.error }
    lifecycle = lc.value
  }
  const gate = coerceGateFields(o)
  if ('error' in gate) return { error: gate.error }
  return {
    value: {
      ...(caps !== undefined ? { capabilities: caps } : {}),
      ...(o.url !== undefined ? { url: o.url as string } : {}),
      ...(o.tokenEnv !== undefined ? { tokenEnv: o.tokenEnv as string } : {}),
      ...(lifecycle !== undefined ? { lifecycle } : {}),
      ...gate.value,
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
