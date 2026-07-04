/**
 * Admin routes for the unified deterministic `setting` ops console (setting-ops
 * M4) — the WEB surface of the one ops-core engine (CLI + web + IM all consume
 * the same host `ops-core`). Web is a thin requireAdmin → resolveActor → echo;
 * the host `SettingOpsSurface` owns ops-core's deps + the audit binding + the
 * tier chokepoint. Web carries ZERO `@gotong/host` runtime dependency — it
 * mirrors the surface structurally, exactly like `AdminHealthSurface` / the ACP
 * admin surface.
 *
 *   GET  /api/admin/setting/commands   the full ops catalog, annotated for the
 *                                      web surface + this actor (every tier is
 *                                      LISTED so the lifecycle is visible).
 *   POST /api/admin/setting/run        run ONE read / safe-mutate / config-write
 *                                      command. `{ id, args? }`.
 *
 * ── The boundary, made visible by what is ABSENT ─────────────────────────────
 *
 * There are NO destructive routes (no `/restore`, `/cold-start`,
 * `/rotate-master-key`). Cold-start / restore / rotate-master-key happen when the
 * hub is DOWN or being REPLACED, so the web process that would run them is itself
 * not up — they are CLI-only by PHYSICS. The catalog still LISTS them (with a
 * "run it from the server CLI" hint) so the operator sees the whole lifecycle,
 * but the only mutating entry point here is `/run`, and the host surface funnels
 * that into ops-core's `runOpsCommand`, which throws `OpsTierError` for any
 * destructive id (→ 403). So even a hand-crafted `POST /run {id:'restore'}`
 * cannot reach a destructive op — the chokepoint is host-side, unbypassable by
 * construction. config-write commands are likewise refused unless the resolved
 * actor is the hub owner (the host surface maps `actor.isOwner` →
 * `allowConfigWrite`).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminRecord } from '@gotong/core'
import { createLogger } from '@gotong/core'

import { readJsonBody, sendJson } from './http-helpers.js'

const log = createLogger('setting-routes')

/** Duck-typed mirror of ops-core's `OpsTier`. */
export type SettingTier = 'read' | 'safe-mutate' | 'config-write' | 'destructive-offline'

/** Duck-typed mirror of ops-core's `OpsCommandInfo` (caller-aware catalog row). */
export interface SettingCommandInfo {
  id: string
  tier: SettingTier
  title: string
  summary: string
  whereToRun?: string
  /** Can THIS surface (web, for this actor) execute it? false → display-only. */
  runnableHere: boolean
}

/** Duck-typed mirror of ops-core's `OpsResult`. */
export interface SettingOpsResult {
  command: string
  tier: SettingTier
  lines: string[]
  data?: Record<string, unknown>
}

/**
 * The resolved admin acting on the console. `isOwner` is the v4 'owner' role OR a
 * v3 Space-admin token (the personal-mode operator) — it IS the config-write
 * gate. `userId` is for audit attribution (null for a v3 token). Produced by the
 * server's shared `resolveResourceActor` closure.
 */
export interface SettingOpsActor {
  userId: string | null
  isOwner: boolean
}

/**
 * Host-injected ops surface. `createSettingOpsService` in the host satisfies it
 * structurally. `run` may throw an ops error carrying a stable `.code` (mapped to
 * HTTP below) — most importantly `OpsTierError` for a destructive/forbidden id.
 */
export interface SettingOpsSurface {
  list(actor: SettingOpsActor): Promise<SettingCommandInfo[]>
  run(id: string, args: readonly string[], actor: SettingOpsActor): Promise<SettingOpsResult>
}

export interface SettingRoutesCtx {
  settingOps?: SettingOpsSurface
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
  /** Resolves the acting admin's ops identity (owner gate + audit attribution). */
  resolveActor: (req: IncomingMessage) => SettingOpsActor
}

const BASE = '/api/admin/setting'

/**
 * Map a stable ops error `.code` to an HTTP status.
 *   - tier violations → 403 (destructive-offline is CLI-only; config-write needs
 *     owner). This is the boundary surfacing as a refusal.
 *   - unknown command → 404.
 *   - bad input / disallowed knob / bad value or price / secret key → 400.
 *   - corrupt existing pricing.json → 409 (the on-disk state conflicts).
 *   - anything else → 500.
 */
const ERROR_STATUS: Record<string, number> = {
  destructive_offline_cli_only: 403,
  config_write_not_permitted: 403,
  unknown_command: 404,
  invalid_input: 400,
  secret_key_refused: 400,
  unknown_knob: 400,
  invalid_value: 400,
  invalid_price: 400,
  pricing_corrupt: 409,
}

function sendOpsError(res: ServerResponse, err: unknown): void {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    const code = (err as { code: string }).code
    const message = err instanceof Error ? err.message : code
    // Carry the human message too — these are operator-facing diagnostics, and
    // the tier-refusal messages tell the admin exactly where to run it instead.
    sendJson(res, { error: code, message }, ERROR_STATUS[code] ?? 400)
    return
  }
  const msg = err instanceof Error ? err.message : String(err)
  log.error('setting ops run error', { err: msg })
  sendJson(res, { error: 'internal_error', message: msg }, 500)
}

/** args, when present, must be an array of strings (the CLI-style positional argv). */
function coerceArgs(v: unknown): { value: string[] } | { error: string } {
  if (v === undefined) return { value: [] }
  if (!Array.isArray(v)) return { error: 'args must be an array of strings' }
  for (const a of v) {
    if (typeof a !== 'string') return { error: 'args must be strings' }
  }
  return { value: v as string[] }
}

/**
 * Handle the admin setting-ops routes. Returns `true` iff the request matched a
 * `/api/admin/setting[/...]` path (and was answered).
 */
export async function handleSettingRoute(
  ctx: SettingRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  if (!ctx.settingOps) {
    sendJson(res, { error: 'setting ops console not enabled on this host' }, 503)
    return true
  }
  const surface = ctx.settingOps
  const actor = ctx.resolveActor(req)

  // GET /commands — the annotated catalog (every tier listed; runnableHere flags).
  if (path === `${BASE}/commands`) {
    if (method !== 'GET') {
      sendJson(res, { error: `method ${method} not allowed` }, 405)
      return true
    }
    try {
      sendJson(res, { commands: await surface.list(actor) })
    } catch (err) {
      sendOpsError(res, err)
    }
    return true
  }

  // POST /run — execute one command. Destructive ids reach here only to be
  // refused by the host chokepoint (OpsTierError → 403); there is deliberately no
  // dedicated destructive route.
  if (path === `${BASE}/run`) {
    if (method !== 'POST') {
      sendJson(res, { error: `method ${method} not allowed` }, 405)
      return true
    }
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, { error: 'invalid json body' }, 400)
      return true
    }
    const o = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
    if (!o || typeof o.id !== 'string' || o.id.trim().length === 0) {
      sendJson(res, { error: 'id must be a non-empty string' }, 400)
      return true
    }
    const args = coerceArgs(o.args)
    if ('error' in args) {
      sendJson(res, { error: args.error }, 400)
      return true
    }
    try {
      sendJson(res, { result: await surface.run(o.id.trim(), args.value, actor) })
    } catch (err) {
      sendOpsError(res, err)
    }
    return true
  }

  // Any other /api/admin/setting/* path — unknown sub-route. We OWN the prefix
  // (returned true at the top), so answer 404 rather than fall through. This is
  // also where a fabricated destructive sub-route (e.g. /restore) lands: 404,
  // because no such route exists.
  sendJson(res, { error: 'unknown setting route' }, 404)
  return true
}
