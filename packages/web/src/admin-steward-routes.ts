/**
 * Route handlers for the OPERATOR-console hub steward ("管家") — SW-M9 A-M6.
 *
 *   POST /api/admin/steward/plan    propose (zero side effects)
 *   POST /api/admin/steward/apply   execute ONE accepted action
 *
 * The member steward lives at `/api/me/steward/*` (me-routes.ts) and manages the
 * caller's OWN resources; this is its site-wide twin behind `requireAdmin`. It
 * reuses the SAME duck-typed `MeHubStewardSurface` — the host wires a SECOND
 * steward service here (the operator one: `OPERATOR_STEWARD_IDS`, a site-wide
 * agent executor + a grant-free workflow editor), so the web layer keeps ZERO
 * runtime dep on `@gotong/hub-steward` and the action it forwards is `unknown`
 * (the HOST surface validates + re-classifies + re-tiers it; web never trusts a
 * client-supplied tier).
 *
 * Two gates, both server-side:
 *   1. `requireAdmin` — only an authenticated admin reaches these routes.
 *   2. a resolved operator `userId` — the approval inbox is a PERSON'S inbox
 *      (北极星「人是 Participant」). A dangerous / cross-hub action parks an
 *      approval item addressed to THIS operator's `/me` inbox, so we force
 *      `userId` from `resolveActor(req)` (never the body) and 503 with a clear
 *      message when the admin has no v4 user row (a v3-only Space admin) — there
 *      is no inbox to park into, so the operator steward is unavailable to them.
 *
 * No member rate limit here: operators are operators, not consumers (same stance
 * as the workflow-assist admin route + LocalAgentPool — admin actions free-ride).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminRecord } from '@gotong/core'
import { readJsonBody, sendJson } from './http-helpers.js'
import { coerceStewardHistory, type MeHubStewardSurface } from './me-routes.js'

/** The acting admin's RBAC identity (same shape the workflow / agent admin routes use). */
export interface AdminStewardActor {
  userId: string | null
  isOperator: boolean
}

export interface AdminStewardRoutesCtx {
  /**
   * The OPERATOR steward surface (the host's operator `HostStewardService`).
   * Undefined when the host wired no operator steward (disabled, or no LLM key
   * for the configured provider) → the routes return 503 so the admin UI can
   * hide the operator 管家 panel.
   */
  steward: MeHubStewardSurface | undefined
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
  /**
   * Resolve the acting admin's user identity (shared closure with the workflow /
   * agent admin RBAC). A v4 owner/admin → that user id; a v3-only Space admin →
   * `userId: null` (operator bypass for OTHER routes, but here it means "no inbox
   * to park into" → the operator steward is unavailable to them).
   */
  resolveActor(req: IncomingMessage): AdminStewardActor
}

/** Map a thrown `{ status }` (RBAC / not-found / validation) to its HTTP code, else 500. */
function errStatus(err: unknown): number {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status?: unknown }).status
    if (typeof s === 'number' && s >= 400 && s < 600) return s
  }
  return 500
}

/**
 * Resolve the operator's user id behind `requireAdmin`, writing the right error
 * response when the steward isn't wired or the admin has no inbox identity.
 * Returns the userId on success, or `null` when a response was already sent.
 */
async function gateOperator(
  ctx: AdminStewardRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<string | null> {
  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return null // requireAdmin already wrote 401/403
  if (!ctx.steward) {
    sendJson(res, { error: '操作员管家暂未启用(需要 AI 助手)。', code: 'not_wired' }, 503)
    return null
  }
  const actor = ctx.resolveActor(req)
  if (!actor.userId) {
    // R2 — a v3-only Space admin has no v4 user row, so no `/me` inbox to park a
    // second-confirmation into. The operator steward needs a person's inbox.
    sendJson(
      res,
      {
        error: '操作员管家需要一个成员账号(用于二次确认收件箱);当前管理员没有可用账号。',
        code: 'no_operator_identity',
      },
      503,
    )
    return null
  }
  return actor.userId
}

async function handleAdminStewardPlan(
  ctx: AdminStewardRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const userId = await gateOperator(ctx, req, res)
  if (!userId) return
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'bad body', code: 'bad_request' }, 400)
    return
  }
  const instruction =
    body && typeof body === 'object' && typeof (body as { instruction?: unknown }).instruction === 'string'
      ? (body as { instruction: string }).instruction.trim()
      : ''
  if (!instruction) {
    sendJson(res, { error: '请用一句话告诉管家你想做什么。', code: 'bad_request' }, 400)
    return
  }
  // Optional conversation history (multi-step follow-ups). Web only shape-coerces
  // via the SHARED helper (keeps `{role,content}` + a `{kind,status,subject?}`
  // result, drops the rest, clips to 12) so member + operator routes never drift;
  // the host service is the trimming/validation authority.
  const rawHistory = body && typeof body === 'object' ? (body as { history?: unknown }).history : undefined
  if (rawHistory !== undefined && !Array.isArray(rawHistory)) {
    sendJson(res, { error: 'history 必须是一个数组。', code: 'bad_request' }, 400)
    return
  }
  const history = coerceStewardHistory(rawHistory)
  try {
    const out = await ctx.steward!.plan({
      userId,
      instruction,
      ...(history.length ? { history } : {}),
    })
    sendJson(res, out, 200)
  } catch (err) {
    // plan throws only when hub.dispatch resolved non-ok (the steward LLM failed
    // outright) — a server-side fault, not the operator's, so 500.
    sendJson(res, { error: err instanceof Error ? err.message : String(err), code: 'steward_failed' }, 500)
  }
}

async function handleAdminStewardApply(
  ctx: AdminStewardRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const userId = await gateOperator(ctx, req, res)
  if (!userId) return
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'bad body', code: 'bad_request' }, 400)
    return
  }
  // The action is forwarded VERBATIM as `unknown` — the host's `apply` is the
  // validation + re-classification authority, so web only checks it's present.
  const action = body && typeof body === 'object' ? (body as { action?: unknown }).action : undefined
  if (action === undefined || action === null) {
    sendJson(res, { error: '缺少要执行的动作(action)。', code: 'bad_request' }, 400)
    return
  }
  try {
    const out = await ctx.steward!.apply({ userId, action })
    // Every status (done / refused / pending_approval / needs_approval) is a
    // well-formed 200 the client renders; only a malformed/unrecognized action
    // shape → 400 (it never came from a real proposal).
    sendJson(res, out, out.status === 'invalid' ? 400 : 200)
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, errStatus(err))
  }
}

/**
 * Entry point — returns `true` iff this module handled the request (matched a
 * route + wrote a response). `false` lets the caller fall through.
 */
export async function handleAdminStewardRoute(
  ctx: AdminStewardRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (method === 'POST' && path === '/api/admin/steward/plan') {
    await handleAdminStewardPlan(ctx, req, res)
    return true
  }
  if (method === 'POST' && path === '/api/admin/steward/apply') {
    await handleAdminStewardApply(ctx, req, res)
    return true
  }
  return false
}
