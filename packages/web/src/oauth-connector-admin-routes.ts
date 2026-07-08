/**
 * C-M2-M5a — admin routes for outbound OAuth connector registration (接入现实生活 track).
 *
 * The management side of an outbound OAuth connector (the browser connect flow —
 * `POST /api/admin/oauth/start` + `GET /api/oauth/callback` — lives in
 * oauth-connect-routes.ts). CRUD over the host's connector store, which keeps
 * the confidential client_secret AND the obtained token set in the vault and
 * never returns either — the public view only carries `hasClientSecret` +
 * `connected`. Modelled on oidc-admin-routes.ts (same posture: web has no
 * @gotong/identity dep, so the view/input types are duck-typed mirrors).
 *
 *   GET    /api/admin/oauth/connectors            list registered connectors (no secret)
 *   POST   /api/admin/oauth/connectors            register one (clientSecret write-only)
 *   PATCH  /api/admin/oauth/connectors/:id         targeted update (rotate/clear secret, toggle)
 *   DELETE /api/admin/oauth/connectors/:id         remove + revoke secret + token
 *   POST   /api/admin/oauth/connectors/:id/disconnect   clear the token set (keep config)
 *
 * Absent (no identity store) → every route 503s. `接入 ≠ 授权行动`: registering a
 * connector only lets an agent CALL the provider once connected; high-risk
 * actions still pass the butler's governed approval gate.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminRecord } from '@gotong/core'
import { createLogger } from '@gotong/core'

import { readJsonBody, sendJson } from './http-helpers.js'

const log = createLogger('oauth-connector-admin-routes')

/**
 * Public projection of a registered connector (duck-typed mirror of the host's
 * `OAuthConnector`). NEVER carries the client_secret or the token set — only
 * `hasClientSecret` + `connected` (+ non-secret expiry for the UI).
 */
export interface OAuthConnectorView {
  id: string
  displayName: string | null
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  redirectUri: string
  scope: string
  extraAuthParams: Record<string, string> | null
  mcpServerName: string | null
  hasClientSecret: boolean
  connected: boolean
  accessTokenExpiresAt: number | null
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface OAuthConnectorAddInput {
  id: string
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  redirectUri: string
  scope: string
  displayName?: string | null
  extraAuthParams?: Record<string, string> | null
  mcpServerName?: string | null
  clientSecret?: string | null
  enabled?: boolean
}

export interface OAuthConnectorUpdateInput {
  authorizationEndpoint?: string
  tokenEndpoint?: string
  clientId?: string
  redirectUri?: string
  scope?: string
  displayName?: string | null
  extraAuthParams?: Record<string, string> | null
  mcpServerName?: string | null
  clientSecret?: string | null
  enabled?: boolean
}

/**
 * Host-injected connector-registry surface (the identity store's OAuth facade
 * satisfies it). `add`/`update` accept a write-only `clientSecret`; the returned
 * view never carries it. `disconnect` clears the token set (revoke the
 * connection) while keeping the config so it can be reconnected.
 */
export interface OAuthConnectorAdminSurface {
  list(): OAuthConnectorView[]
  add(input: OAuthConnectorAddInput): OAuthConnectorView
  update(id: string, patch: OAuthConnectorUpdateInput): OAuthConnectorView
  remove(id: string): boolean
  disconnect(id: string): boolean
}

export interface OAuthConnectorAdminCtx {
  oauthConnectorAdmin?: OAuthConnectorAdminSurface
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

const BASE = '/api/admin/oauth/connectors'

const ERROR_STATUS: Record<string, number> = {
  oauth_connector_exists: 409,
  oauth_connector_not_found: 404,
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
  log.error('oauth connector admin store error', { err: msg })
  sendJson(res, { error: msg }, 500)
}

function asObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

/** displayName/mcpServerName/clientSecret must be string|null; enabled boolean;
 * extraAuthParams null or a flat string→string record. Returns an error message
 * or null. */
function checkOptionalFields(o: Record<string, unknown>): string | null {
  for (const f of ['displayName', 'mcpServerName', 'clientSecret'] as const) {
    if (o[f] !== undefined && o[f] !== null && typeof o[f] !== 'string') {
      return `${f} must be a string or null`
    }
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return 'enabled must be a boolean'
  if (o.extraAuthParams !== undefined && o.extraAuthParams !== null) {
    const ep = o.extraAuthParams
    if (typeof ep !== 'object' || Array.isArray(ep)) return 'extraAuthParams must be an object or null'
    for (const [k, v] of Object.entries(ep as Record<string, unknown>)) {
      if (typeof v !== 'string') return `extraAuthParams.${k} must be a string`
    }
  }
  return null
}

function pickOptional(
  o: Record<string, unknown>,
): Partial<OAuthConnectorAddInput> {
  return {
    ...(o.displayName !== undefined ? { displayName: o.displayName as string | null } : {}),
    ...(o.mcpServerName !== undefined ? { mcpServerName: o.mcpServerName as string | null } : {}),
    ...(o.clientSecret !== undefined ? { clientSecret: o.clientSecret as string | null } : {}),
    ...(o.extraAuthParams !== undefined
      ? { extraAuthParams: o.extraAuthParams as Record<string, string> | null }
      : {}),
    ...(o.enabled !== undefined ? { enabled: o.enabled as boolean } : {}),
  }
}

const REQUIRED_ADD = ['id', 'authorizationEndpoint', 'tokenEndpoint', 'clientId', 'redirectUri', 'scope'] as const

function coerceAdd(body: unknown): { value: OAuthConnectorAddInput } | { error: string } {
  const o = asObject(body)
  if (!o) return { error: 'body must be an object' }
  for (const f of REQUIRED_ADD) {
    if (typeof o[f] !== 'string' || (o[f] as string).trim().length === 0) {
      return { error: `${f} must be a non-empty string` }
    }
  }
  const bad = checkOptionalFields(o)
  if (bad) return { error: bad }
  return {
    value: {
      id: o.id as string,
      authorizationEndpoint: o.authorizationEndpoint as string,
      tokenEndpoint: o.tokenEndpoint as string,
      clientId: o.clientId as string,
      redirectUri: o.redirectUri as string,
      scope: o.scope as string,
      ...pickOptional(o),
    },
  }
}

const UPDATABLE_STRINGS = ['authorizationEndpoint', 'tokenEndpoint', 'clientId', 'redirectUri', 'scope'] as const

function coerceUpdate(body: unknown): { value: OAuthConnectorUpdateInput } | { error: string } {
  const o = asObject(body)
  if (!o) return { error: 'body must be an object' }
  for (const f of UPDATABLE_STRINGS) {
    if (o[f] !== undefined && (typeof o[f] !== 'string' || (o[f] as string).trim().length === 0)) {
      return { error: `${f} must be a non-empty string` }
    }
  }
  const bad = checkOptionalFields(o)
  if (bad) return { error: bad }
  const value: OAuthConnectorUpdateInput = {
    ...pickOptional(o),
  }
  for (const f of UPDATABLE_STRINGS) {
    if (o[f] !== undefined) value[f] = o[f] as string
  }
  return { value }
}

/**
 * Handle the admin OAuth connector CRUD routes. Returns `true` if the request
 * matched a `/api/admin/oauth/connectors[...]` path (and was answered).
 */
export async function handleOAuthConnectorAdminRoute(
  ctx: OAuthConnectorAdminCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  if (!ctx.oauthConnectorAdmin) {
    sendJson(res, { error: 'oauth connector admin not enabled on this host' }, 503)
    return true
  }
  const surface = ctx.oauthConnectorAdmin

  // Collection: list / register.
  if (path === BASE) {
    if (method === 'GET') {
      sendJson(res, { connectors: surface.list() })
      return true
    }
    if (method === 'POST') {
      const body = await readBody(req, res)
      if (body === undefined) return true
      const parsed = coerceAdd(body)
      if ('error' in parsed) {
        sendJson(res, { error: parsed.error }, 400)
        return true
      }
      try {
        sendJson(res, { connector: surface.add(parsed.value) }, 201)
      } catch (err) {
        sendStoreError(res, err)
      }
      return true
    }
    sendJson(res, { error: `method ${method} not allowed` }, 405)
    return true
  }

  // Item routes. The remainder after the base is `:id` or `:id/disconnect`.
  const rest = path.slice(BASE.length + 1)
  const slash = rest.indexOf('/')
  const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash))
  const sub = slash === -1 ? '' : rest.slice(slash + 1)
  if (!id) {
    sendJson(res, { error: 'bad connector id' }, 400)
    return true
  }

  // POST /:id/disconnect — clear the token set, keep the config.
  if (sub === 'disconnect') {
    if (method !== 'POST') {
      sendJson(res, { error: `method ${method} not allowed` }, 405)
      return true
    }
    try {
      const wasConnected = surface.disconnect(id)
      sendJson(res, { ok: true, wasConnected })
    } catch (err) {
      sendStoreError(res, err)
    }
    return true
  }
  if (sub) {
    sendJson(res, { error: 'unknown sub-resource' }, 404)
    return true
  }

  if (method === 'PATCH') {
    const body = await readBody(req, res)
    if (body === undefined) return true
    const parsed = coerceUpdate(body)
    if ('error' in parsed) {
      sendJson(res, { error: parsed.error }, 400)
      return true
    }
    try {
      sendJson(res, { connector: surface.update(id, parsed.value) })
    } catch (err) {
      sendStoreError(res, err)
    }
    return true
  }

  if (method === 'DELETE') {
    try {
      const removed = surface.remove(id)
      if (!removed) {
        sendJson(res, { error: 'oauth_connector_not_found' }, 404)
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

/** Read + JSON-parse the body, answering 400 on parse failure. Returns the
 * parsed body, or `undefined` if it already sent the 400. */
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  try {
    return await readJsonBody(req)
  } catch {
    sendJson(res, { error: 'invalid json body' }, 400)
    return undefined
  }
}
