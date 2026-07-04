/**
 * Admin routes for OIDC identity-provider registration (Route B P1-M4f-1).
 *
 * The hub is a Relying Party; an admin registers the IdPs it accepts SSO from.
 * CRUD over the host's provider store (which keeps the confidential
 * client_secret in the vault and never returns it). These are the management
 * side of OIDC — the public browser login routes live in oidc-routes.ts.
 *
 *   GET    /api/admin/oidc/providers       list registered IdPs (no secret)
 *   POST   /api/admin/oidc/providers       register one (clientSecret write-only)
 *   PATCH  /api/admin/oidc/providers/:id    targeted update (rotate/clear secret)
 *   DELETE /api/admin/oidc/providers/:id    remove + revoke its secret
 *
 * Backed by a host-injected surface (web has no @gotong/identity dep). Absent
 * (no identity store) → every route 503s. The client_secret is accepted on
 * input but NEVER echoed back: the public view only carries `hasClientSecret`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminRecord } from '@gotong/core'
import { createLogger } from '@gotong/core'

import { readJsonBody, sendJson } from './http-helpers.js'

const log = createLogger('oidc-admin-routes')

/** Public projection of a registered IdP (duck-typed mirror of the host's
 * `OidcProvider`). NEVER carries the client_secret — only `hasClientSecret`. */
export interface OidcProviderView {
  id: string
  issuer: string
  clientId: string
  redirectUri: string
  scope: string | null
  enabled: boolean
  label: string | null
  hasClientSecret: boolean
  createdAt: number
  updatedAt: number
}

export interface OidcProviderAddInput {
  issuer: string
  clientId: string
  redirectUri: string
  scope?: string | null
  clientSecret?: string | null
  label?: string | null
  enabled?: boolean
}

export interface OidcProviderUpdateInput {
  clientId?: string
  redirectUri?: string
  scope?: string | null
  clientSecret?: string | null
  label?: string | null
  enabled?: boolean
}

/** Host-injected provider-registry surface (the identity store's OIDC facade
 * satisfies it). `add`/`update` accept a write-only `clientSecret`; the
 * returned view never carries it. */
export interface OidcProviderAdminSurface {
  list(): OidcProviderView[]
  add(input: OidcProviderAddInput): OidcProviderView
  update(id: string, patch: OidcProviderUpdateInput): OidcProviderView
  remove(id: string): boolean
}

export interface OidcAdminRoutesCtx {
  oidcAdmin?: OidcProviderAdminSurface
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

const BASE = '/api/admin/oidc/providers'

const ERROR_STATUS: Record<string, number> = {
  oidc_provider_exists: 409,
  oidc_provider_not_found: 404,
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
  log.error('oidc admin store error', { err: msg })
  sendJson(res, { error: msg }, 500)
}

function asObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

/** scope/clientSecret/label must be string|null; enabled must be boolean. */
function checkOptionalFields(o: Record<string, unknown>): string | null {
  for (const f of ['scope', 'clientSecret', 'label'] as const) {
    if (o[f] !== undefined && o[f] !== null && typeof o[f] !== 'string') {
      return `${f} must be a string or null`
    }
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return 'enabled must be a boolean'
  return null
}

function pickOptional(o: Record<string, unknown>): Partial<OidcProviderAddInput> {
  return {
    ...(o.scope !== undefined ? { scope: o.scope as string | null } : {}),
    ...(o.clientSecret !== undefined ? { clientSecret: o.clientSecret as string | null } : {}),
    ...(o.label !== undefined ? { label: o.label as string | null } : {}),
    ...(o.enabled !== undefined ? { enabled: o.enabled as boolean } : {}),
  }
}

function coerceAdd(body: unknown): { value: OidcProviderAddInput } | { error: string } {
  const o = asObject(body)
  if (!o) return { error: 'body must be an object' }
  for (const f of ['issuer', 'clientId', 'redirectUri'] as const) {
    if (typeof o[f] !== 'string' || (o[f] as string).trim().length === 0) {
      return { error: `${f} must be a non-empty string` }
    }
  }
  const bad = checkOptionalFields(o)
  if (bad) return { error: bad }
  return {
    value: {
      issuer: o.issuer as string,
      clientId: o.clientId as string,
      redirectUri: o.redirectUri as string,
      ...pickOptional(o),
    },
  }
}

function coerceUpdate(body: unknown): { value: OidcProviderUpdateInput } | { error: string } {
  const o = asObject(body)
  if (!o) return { error: 'body must be an object' }
  for (const f of ['clientId', 'redirectUri'] as const) {
    if (o[f] !== undefined && (typeof o[f] !== 'string' || (o[f] as string).trim().length === 0)) {
      return { error: `${f} must be a non-empty string` }
    }
  }
  const bad = checkOptionalFields(o)
  if (bad) return { error: bad }
  return {
    value: {
      ...(o.clientId !== undefined ? { clientId: o.clientId as string } : {}),
      ...(o.redirectUri !== undefined ? { redirectUri: o.redirectUri as string } : {}),
      ...pickOptional(o),
    },
  }
}

/**
 * Handle the admin OIDC provider CRUD routes. Returns `true` if the request
 * matched a `/api/admin/oidc/providers[/:id]` path (and was answered).
 */
export async function handleOidcAdminRoute(
  ctx: OidcAdminRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  if (!ctx.oidcAdmin) {
    sendJson(res, { error: 'oidc admin not enabled on this host' }, 503)
    return true
  }
  const surface = ctx.oidcAdmin

  // Collection: list / register.
  if (path === BASE) {
    if (method === 'GET') {
      sendJson(res, { providers: surface.list() })
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
        sendJson(res, { provider: surface.add(parsed.value) }, 201)
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
    sendJson(res, { error: 'bad provider id' }, 400)
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
      sendJson(res, { provider: surface.update(id, parsed.value) })
    } catch (err) {
      sendStoreError(res, err)
    }
    return true
  }

  if (method === 'DELETE') {
    try {
      const removed = surface.remove(id)
      if (!removed) {
        sendJson(res, { error: 'oidc_provider_not_found' }, 404)
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
