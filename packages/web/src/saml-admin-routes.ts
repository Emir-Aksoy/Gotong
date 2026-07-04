/**
 * Admin routes for SAML 2.0 IdP registration (Route B P1-M5f-1).
 *
 * The hub is a Service Provider; an admin registers the IdPs it accepts SSO
 * assertions from. CRUD over the host's provider store. The browser-facing
 * login routes live in saml-routes.ts — these are the management side.
 *
 *   GET    /api/admin/saml/providers       list registered IdPs (cert included)
 *   POST   /api/admin/saml/providers       register one
 *   PATCH  /api/admin/saml/providers/:id    targeted update (idpEntityId immutable)
 *   DELETE /api/admin/saml/providers/:id    remove
 *
 * Backed by a host-injected surface (web has no @gotong/identity dep). Absent
 * (no identity store) → every route 503s.
 *
 * Why this carries the cert (unlike the OIDC admin routes, which hide the
 * client_secret): `idpCert` is a PUBLIC X.509 verification key — pinning it is
 * the whole point, and an admin must be able to see which cert is pinned to
 * audit it. There is no SAML secret, so there is no vault and nothing to scrub.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminRecord } from '@gotong/core'
import { createLogger } from '@gotong/core'

import { readJsonBody, sendJson } from './http-helpers.js'

const log = createLogger('saml-admin-routes')

/** Public projection of a registered IdP (duck-typed mirror of the host's
 * `SamlProvider`). Carries `idpCert` — it is a public verification key. */
export interface SamlProviderView {
  id: string
  idpEntityId: string
  ssoUrl: string
  idpCert: string
  spEntityId: string
  enabled: boolean
  label: string | null
  createdAt: number
  updatedAt: number
}

export interface SamlProviderAddInput {
  idpEntityId: string
  ssoUrl: string
  idpCert: string
  spEntityId: string
  label?: string | null
  enabled?: boolean
}

/** Targeted update — `idpEntityId` is immutable (re-add to change IdP). */
export interface SamlProviderUpdateInput {
  ssoUrl?: string
  idpCert?: string
  spEntityId?: string
  label?: string | null
  enabled?: boolean
}

/** Host-injected provider-registry surface (the identity store's SAML facade
 * satisfies it). */
export interface SamlProviderAdminSurface {
  list(): SamlProviderView[]
  add(input: SamlProviderAddInput): SamlProviderView
  update(id: string, patch: SamlProviderUpdateInput): SamlProviderView
  remove(id: string): boolean
}

export interface SamlAdminRoutesCtx {
  samlAdmin?: SamlProviderAdminSurface
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

const BASE = '/api/admin/saml/providers'

const ERROR_STATUS: Record<string, number> = {
  saml_provider_exists: 409,
  saml_provider_not_found: 404,
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
  log.error('saml admin store error', { err: msg })
  sendJson(res, { error: msg }, 500)
}

function asObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

/** label must be string|null; enabled must be boolean. */
function checkOptionalFields(o: Record<string, unknown>): string | null {
  if (o.label !== undefined && o.label !== null && typeof o.label !== 'string') {
    return 'label must be a string or null'
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return 'enabled must be a boolean'
  return null
}

function pickOptional(o: Record<string, unknown>): Pick<SamlProviderAddInput, 'label' | 'enabled'> {
  return {
    ...(o.label !== undefined ? { label: o.label as string | null } : {}),
    ...(o.enabled !== undefined ? { enabled: o.enabled as boolean } : {}),
  }
}

function coerceAdd(body: unknown): { value: SamlProviderAddInput } | { error: string } {
  const o = asObject(body)
  if (!o) return { error: 'body must be an object' }
  for (const f of ['idpEntityId', 'ssoUrl', 'idpCert', 'spEntityId'] as const) {
    if (typeof o[f] !== 'string' || (o[f] as string).trim().length === 0) {
      return { error: `${f} must be a non-empty string` }
    }
  }
  const bad = checkOptionalFields(o)
  if (bad) return { error: bad }
  return {
    value: {
      idpEntityId: o.idpEntityId as string,
      ssoUrl: o.ssoUrl as string,
      idpCert: o.idpCert as string,
      spEntityId: o.spEntityId as string,
      ...pickOptional(o),
    },
  }
}

function coerceUpdate(body: unknown): { value: SamlProviderUpdateInput } | { error: string } {
  const o = asObject(body)
  if (!o) return { error: 'body must be an object' }
  for (const f of ['ssoUrl', 'idpCert', 'spEntityId'] as const) {
    if (o[f] !== undefined && (typeof o[f] !== 'string' || (o[f] as string).trim().length === 0)) {
      return { error: `${f} must be a non-empty string` }
    }
  }
  const bad = checkOptionalFields(o)
  if (bad) return { error: bad }
  return {
    value: {
      ...(o.ssoUrl !== undefined ? { ssoUrl: o.ssoUrl as string } : {}),
      ...(o.idpCert !== undefined ? { idpCert: o.idpCert as string } : {}),
      ...(o.spEntityId !== undefined ? { spEntityId: o.spEntityId as string } : {}),
      ...pickOptional(o),
    },
  }
}

/**
 * Handle the admin SAML provider CRUD routes. Returns `true` if the request
 * matched a `/api/admin/saml/providers[/:id]` path (and was answered).
 */
export async function handleSamlAdminRoute(
  ctx: SamlAdminRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  if (!ctx.samlAdmin) {
    sendJson(res, { error: 'saml admin not enabled on this host' }, 503)
    return true
  }
  const surface = ctx.samlAdmin

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
        sendJson(res, { error: 'saml_provider_not_found' }, 404)
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
