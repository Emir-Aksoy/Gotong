/**
 * /api/me/* — member-facing user routes.
 *
 * Anyone with a v4 IdentityStore session cookie (any role: owner / admin
 * / member / viewer) can hit these. The handlers force `from = userId`
 * and `case_id = userId` server-side so a member can never act on
 * another user's behalf, even if they tamper with the request body.
 *
 * # Route inventory
 *
 *   POST /api/me/dispatch                       { workflowId, payload }
 *   GET  /api/me/growth-reports
 *   GET  /api/me/growth-reports/download?path=…
 *
 * # Auth
 *
 * Owner-gating intentionally does NOT apply here — the whole point of
 * /me is "any signed-in user runs their own thing". v3 admin Bearer /
 * cookie is NOT accepted: a v3 admin has no v4 user id, so there's no
 * caseId to scope to. v3 admins manage the org via /admin; v4 owners
 * who also want to use the /me surface can — they have a v4 user id.
 *
 * # Workflow allowlist
 *
 * Dispatch is limited to a small allowlist (currently just
 * `personal-growth-flow`). The handler maps workflowId → capability +
 * accepted payload fields, then forwards via hub.dispatch with the
 * caller's userId as both `from` and `case_id`. Future workflows
 * that want a /me entry add themselves to `ALLOWED_WORKFLOWS`.
 *
 * Why an allowlist instead of a generic "dispatch anything" route:
 * the workflow runner's `from` field is normally a privileged admin
 * id (or 'system' for in-process demos). Letting an arbitrary v4 user
 * trigger an arbitrary workflow with their userId as `from` would
 * effectively grant them v3 admin's dispatch authority. The allowlist
 * keeps the surface narrow to workflows that have been audited as
 * safe for member-initiated runs.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, sendJson } from './http-helpers.js'

import type { Hub } from '@aipehub/core'
import type { GrowthReportsAdminSurface } from '@aipehub/core'
import { createLogger } from '@aipehub/core'

import {
  resolveV4Auth,
  type IdentitySurface,
  type LoginRateLimiterLike,
} from './identity-routes.js'

const log = createLogger('me-routes')

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

interface AllowedWorkflow {
  /** Capability the workflow runner listens on. */
  capability: string
  /**
   * Whitelisted payload field names. Anything else in the request body
   * is dropped before dispatch — defence-in-depth so a member can't
   * smuggle extra fields the workflow might consume in unexpected ways.
   * `case_id` is forced server-side and never sourced from the body.
   */
  payloadFields: readonly string[]
  /** Human-readable label used by the /me page. */
  label: string
}

const ALLOWED_WORKFLOWS: Record<string, AllowedWorkflow> = {
  'personal-growth-flow': {
    capability: 'plan-personal-growth',
    payloadFields: [
      'present_state',
      'aspirations',
      'struggles',
      'focus_request',
    ],
    label: 'Personal Growth (7-coach team)',
  },
}

// ---------------------------------------------------------------------------
// Helpers — kept private to this module to mirror identity-routes.ts.
// ---------------------------------------------------------------------------

/**
 * Pull the caseId out of a `reports/<caseId>/<file>.md` path. Returns
 * null on any path that doesn't match (refuses paths with `..`, paths
 * not under `reports/`, paths with no caseId segment).
 */
function parseCaseIdFromReportPath(path: string): string | null {
  if (path.includes('..')) return null
  const prefix = 'reports/'
  if (!path.startsWith(prefix)) return null
  const rest = path.slice(prefix.length)
  const slashIdx = rest.indexOf('/')
  if (slashIdx <= 0) return null
  return rest.slice(0, slashIdx)
}

// ---------------------------------------------------------------------------
// Member-facing workflow resolution (Phase 14)
//
// Replaces the hardcoded ALLOWED_WORKFLOWS table: the catalog of workflows
// a member may run is DERIVED at request time from the live workflow list,
// keeping only those that declare `surface.me.enabled` and allow the
// caller's role. The trust boundary moves from a source edit of this file
// to an import-time review of the workflow YAML (admin-gated import).
// ---------------------------------------------------------------------------

/** Roles that may run a member-facing workflow when it doesn't say otherwise.
 *  Viewer is excluded by convention (read-only); a workflow opts them in. */
const DEFAULT_ME_ROLES: readonly string[] = ['owner', 'admin', 'member']

/**
 * Read-side mirror of `@aipehub/workflow`'s `MeSurfaceSpec`. The web layer
 * has no workflow dep, so `surfaceMe` arrives as `unknown` (already
 * validated by the workflow parser at import) and we narrow it here. Only
 * the fields `/me` consumes are typed.
 */
interface MeSurfaceView {
  enabled: boolean
  label?: string
  description?: string
  /** Field descriptors, passed through to the client for form rendering. */
  inputSchema?: unknown[]
  allowedRoles?: string[]
  userScopeField?: string
}

/** A workflow resolved as runnable from `/me` for a specific caller. */
interface ResolvedMeWorkflow {
  workflowId: string
  /** Trigger capability dispatched to — internal, never sent to clients. */
  capability: string
  label: string
  description?: string
  /** Raw input field descriptors for the client form. */
  inputSchema: unknown[]
  /** Field ids the dispatch handler copies from the body (scope key excluded). */
  inputFieldIds: string[]
  /** The payload key force-set to the caller's userId — internal. */
  userScopeField: string
}

function readMeSurface(raw: unknown): MeSurfaceView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  if (typeof m.enabled !== 'boolean') return null
  const view: MeSurfaceView = { enabled: m.enabled }
  if (typeof m.label === 'string') view.label = m.label
  if (typeof m.description === 'string') view.description = m.description
  if (Array.isArray(m.inputSchema)) view.inputSchema = m.inputSchema
  if (Array.isArray(m.allowedRoles)) {
    view.allowedRoles = m.allowedRoles.filter((r): r is string => typeof r === 'string')
  }
  if (typeof m.userScopeField === 'string') view.userScopeField = m.userScopeField
  return view
}

function asFieldArray(raw: unknown): unknown[] | undefined {
  return Array.isArray(raw) ? raw : undefined
}

function fieldIds(schema: unknown[]): string[] {
  const ids: string[] = []
  for (const f of schema) {
    if (f && typeof f === 'object' && typeof (f as { id?: unknown }).id === 'string') {
      ids.push((f as { id: string }).id)
    }
  }
  return ids
}

/**
 * Decide whether `summary` is runnable from `/me` by `role`, and resolve
 * the effective label / input fields / scope key. Returns null when the
 * workflow isn't member-facing, is disabled, or excludes the role.
 */
function evaluateMeSurface(
  summary: MeWorkflowSummaryLike,
  role: string,
): ResolvedMeWorkflow | null {
  const me = readMeSurface(summary.surfaceMe)
  if (!me || me.enabled !== true) return null
  const allowedRoles = me.allowedRoles ?? DEFAULT_ME_ROLES
  if (!allowedRoles.includes(role)) return null
  // input fields: surface.me.inputSchema first, else the trigger's
  // payloadSchema (the long-form fallback), else nothing.
  const inputSchema = me.inputSchema ?? asFieldArray(summary.payloadSchema) ?? []
  const userScopeField = me.userScopeField ?? 'case_id'
  const out: ResolvedMeWorkflow = {
    workflowId: summary.id,
    capability: summary.triggerCapability,
    label: me.label ?? summary.name ?? summary.id,
    inputSchema,
    // The scope key is force-set server-side, never copied from the body —
    // drop it from the copy set even if an author listed it as a field.
    inputFieldIds: fieldIds(inputSchema).filter((id) => id !== userScopeField),
    userScopeField,
  }
  const description = me.description ?? summary.description
  if (description !== undefined) out.description = description
  return out
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Minimal structural projection of the host's workflow surface that /me
 * needs — just enough to derive the member-facing catalog. Kept narrow
 * (not the full `WorkflowSurface` from server.ts) so this module reads no
 * more than it depends on; the host's real surface satisfies it
 * structurally.
 */
export interface MeWorkflowSummaryLike {
  id: string
  name?: string
  description?: string
  triggerCapability: string
  /** `surface.me` block (Phase 14) — structurally `MeSurfaceSpec`. */
  surfaceMe?: unknown
  /** Fallback dispatch-form fields when `surface.me.inputSchema` is absent. */
  payloadSchema?: unknown
}

export interface MeWorkflowSurface {
  list(): Promise<MeWorkflowSummaryLike[]>
}

export interface HandleMeRouteCtx {
  identity: IdentitySurface
  hub: Hub
  /**
   * Optional — `/api/me/growth-reports*` returns 503 when the host
   * didn't wire a growth-reports surface (eg. personal-growth team not
   * loaded). /me/dispatch still works for any allowlisted workflow even
   * without this surface.
   */
  growthReports: GrowthReportsAdminSurface | undefined
  /**
   * AUDIT-P3-01 / -02: shared per-IP/per-user limiter (same instance as
   * the identity login limiter) so members can't loop-dispatch personal-
   * growth workflows (7 LLM agents per run) to burn the owner's API
   * quota, or hammer the report-list endpoint to force full-table scans.
   * Required. The host wires its existing `adminLoginLimiter`.
   */
  loginLimiter: LoginRateLimiterLike
  /**
   * Phase 14 — live workflow list, used to DERIVE the member-facing
   * catalog (only workflows declaring `surface.me.enabled`) instead of a
   * hardcoded allowlist. Undefined when the host wired no workflow
   * surface; the /me workflow routes then degrade to an empty catalog.
   */
  workflows: MeWorkflowSurface | undefined
}

export async function handleMeRoute(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<void> {
  // Auth gate: every /me route needs a v4 user. A2.2 — v4 IdentityStore
  // is the only auth surface here; the legacy v3-admin path was always
  // refused (no v4 user id to scope by) and is now removed entirely.
  const v4 = resolveV4Auth(ctx.identity, req)
  if (v4.user === null || v4.role === null) {
    sendJson(
      res,
      {
        error:
          'sign in at /me first (POST /api/admin/identity/login)',
        code: 'authentication_required',
      },
      401,
    )
    return
  }
  const userId = v4.user.id

  if (method === 'GET' && path === '/api/me/allowed-workflows') {
    sendJson(res, { workflows: listAllowedWorkflowsForMe() })
    return
  }
  // Phase 14 — member-facing workflow catalog, DERIVED from the live
  // workflow list (only those declaring surface.me.enabled and allowing
  // the caller's role). Supersedes the hardcoded /allowed-workflows above
  // (which M5 removes once dispatch is generalized).
  if (method === 'GET' && path === '/api/me/workflows') {
    await handleMeListWorkflows(ctx, res, v4.role)
    return
  }
  // Phase 7 M5 — org mode for the SPA shell. Every signed-in user can
  // read this (it drives body-class CSS); only owner can flip it via
  // POST /api/admin/identity/org-mode below.
  //
  // `canUpgrade` is a derived hint for the UI: true when mode is
  // personal AND the caller is owner (so we know whether to render
  // the "升级到团队" button).
  if (method === 'GET' && path === '/api/me/mode') {
    const mode = typeof ctx.identity.getOrgMode === 'function'
      ? ctx.identity.getOrgMode()
      : 'team'
    sendJson(res, {
      mode,
      canUpgrade: mode === 'personal' && v4.role === 'owner',
    })
    return
  }
  if (method === 'POST' && path === '/api/me/dispatch') {
    await handleMeDispatch(ctx, req, res, userId)
    return
  }
  if (method === 'GET' && path === '/api/me/growth-reports') {
    await handleMeListReports(ctx, res, userId)
    return
  }
  if (method === 'GET' && path === '/api/me/growth-reports/download') {
    await handleMeDownloadReport(ctx, req, res, userId)
    return
  }

  sendJson(res, { error: `unknown /me route: ${method} ${path}` }, 404)
}

// ---------------------------------------------------------------------------
// POST /api/me/dispatch
// ---------------------------------------------------------------------------

async function handleMeDispatch(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  // AUDIT-P3-01: rate-limit per-user. Each dispatch triggers a
  // personal-growth workflow (7 LLM agents). Without this, a single
  // invitee (legitimate, low-privilege member) can loop POST and burn
  // the host's API quota / agent-pool capacity. Key on userId not IP so
  // a NAT'd corp office isn't punished collectively. Default budget
  // (mirrors v3 admin login: 10/min) is generous for human use (PG
  // workflows take 5-15 min each) and a hard cap for scripts.
  //
  // `check()` not `peek()` — every successful dispatch must count, since
  // the cost is in the action itself, not in detecting attack patterns.
  const rlKey = `me-dispatch:${userId}`
  if (!ctx.loginLimiter.check(rlKey)) {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' })
    res.end('too many dispatches; try again in a minute')
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'bad body' }, 400)
    return
  }
  if (!body || typeof body !== 'object') {
    sendJson(
      res,
      { error: 'body required: {workflowId, payload}' },
      400,
    )
    return
  }
  const b = body as { workflowId?: unknown; payload?: unknown }
  if (typeof b.workflowId !== 'string') {
    sendJson(
      res,
      { error: 'workflowId must be a string (see /api/me/allowed-workflows)' },
      400,
    )
    return
  }
  const wf = ALLOWED_WORKFLOWS[b.workflowId]
  if (!wf) {
    sendJson(
      res,
      {
        error: `workflowId '${b.workflowId}' is not enabled on the /me surface`,
        code: 'workflow_not_allowed',
        allowed: Object.keys(ALLOWED_WORKFLOWS),
      },
      403,
    )
    return
  }
  const payloadIn =
    b.payload && typeof b.payload === 'object' && !Array.isArray(b.payload)
      ? (b.payload as Record<string, unknown>)
      : {}
  // Build a payload from the allowlist's accepted fields ONLY. Drop
  // any caller-supplied extras (including case_id — we force that
  // ourselves below to userId, no exceptions).
  const payload: Record<string, unknown> = {}
  for (const field of wf.payloadFields) {
    if (field in payloadIn) payload[field] = payloadIn[field]
  }
  // Force the scoping fields server-side. The agent's pickCaseId
  // reads `payload.case_id`; any value the member tried to pass under
  // that key was already dropped (case_id is not in payloadFields).
  payload.case_id = userId

  // Fire-and-forget: hub.dispatch returns a promise that only resolves
  // when the assigned participant produces a result, which for human
  // participants can be hours. Mirroring /api/admin/dispatch's default
  // pattern, we hand the response back immediately and log dispatch
  // failures asynchronously — the workflow runner is the right place
  // to observe progress, not this 200 OK.
  try {
    void ctx.hub
      .dispatch({
        from: userId,
        // B2.2.2 — stamp the dispatcher so `LlmAgent.preCallHook`
        // (the org quota gate) can debit per-user. `orgId: 'local'`
        // is a sentinel that distinguishes same-hub attribution from
        // a FED-M2 cross-hub origin (where orgId is the peer's id).
        // The quota gate only reads `userId`; orgId here is for
        // audit-log readability + future per-org aggregation.
        origin: { orgId: 'local', userId },
        strategy: { kind: 'capability', capabilities: [wf.capability] },
        payload,
        title: `${wf.label} — ${userId}`,
        // countContribution: default true; this user IS contributing.
      })
      .catch((err) => {
        // Best-effort log only — by this point the user already saw 200.
        // Re-throwing here would unhandled-promise the process.
        log.error('dispatch failed', { err })
      })
    sendJson(res, {
      ok: true,
      workflowId: b.workflowId,
      caseId: userId,
    })
  } catch (err) {
    // Synchronous throw from dispatch (eg. bad strategy shape) — the
    // promise branch above can't be hit. Surface as 400.
    sendJson(
      res,
      {
        error: err instanceof Error ? err.message : String(err),
      },
      400,
    )
  }
}

// ---------------------------------------------------------------------------
// GET /api/me/workflows — member-facing catalog (Phase 14)
// ---------------------------------------------------------------------------

async function handleMeListWorkflows(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  role: string,
): Promise<void> {
  if (!ctx.workflows) {
    sendJson(res, { workflows: [] })
    return
  }
  let summaries: MeWorkflowSummaryLike[]
  try {
    summaries = await ctx.workflows.list()
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    return
  }
  // Project to the PUBLIC shape only: id / label / description / inputSchema.
  // `capability` and `userScopeField` are internal enforcement details —
  // never surfaced, so a member can't probe the dispatch internals.
  const workflows: Array<{
    id: string
    label: string
    description?: string
    inputSchema: unknown[]
  }> = []
  for (const s of summaries) {
    const resolved = evaluateMeSurface(s, role)
    if (!resolved) continue
    const entry: { id: string; label: string; description?: string; inputSchema: unknown[] } = {
      id: resolved.workflowId,
      label: resolved.label,
      inputSchema: resolved.inputSchema,
    }
    if (resolved.description !== undefined) entry.description = resolved.description
    workflows.push(entry)
  }
  sendJson(res, { workflows })
}

// ---------------------------------------------------------------------------
// GET /api/me/growth-reports
// ---------------------------------------------------------------------------

async function handleMeListReports(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  // AUDIT-P3-02: rate-limit. growthReports.list() walks every report on
  // the host then filters in memory (the surface predates /me); a
  // looping member can force full-table scans. Higher budget than
  // dispatch (30/min vs 10/min) because list is a read, not a write.
  // `check()` for the same reason as dispatch: action volume is the cap.
  const rlKey = `me-reports:${userId}`
  if (!ctx.loginLimiter.check(rlKey)) {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' })
    res.end('too many report-list requests; try again in a minute')
    return
  }
  if (!ctx.growthReports) {
    sendJson(res, { error: 'growth reports not enabled on this host' }, 503)
    return
  }
  try {
    const all = await ctx.growthReports.list()
    // Filter to the caller's own caseId. The growth-reports list returns
    // every report on the host (it was designed for owner-gated UI); the
    // /me surface narrows it. This is the ONLY place we enforce per-user
    // visibility — getting it right is the security contract.
    const mine = all.filter((r) => r.caseId === userId)
    sendJson(res, { reports: mine })
  } catch (err) {
    sendJson(
      res,
      { error: err instanceof Error ? err.message : String(err) },
      500,
    )
  }
}

// ---------------------------------------------------------------------------
// GET /api/me/growth-reports/download?path=…
// ---------------------------------------------------------------------------

async function handleMeDownloadReport(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.growthReports) {
    sendJson(res, { error: 'growth reports not enabled on this host' }, 503)
    return
  }
  const url = new URL(
    req.url ?? '/api/me/growth-reports/download',
    `http://${req.headers.host ?? 'localhost'}`,
  )
  const reportPath = url.searchParams.get('path')
  if (!reportPath) {
    sendJson(res, { error: 'missing path' }, 400)
    return
  }
  // Defence-in-depth ACL: refuse if the path's caseId segment is not
  // the caller's userId. growthReports.read itself sanitises the path
  // (via the artifact plugin's sanitisePath), but the per-user filter
  // is OUR responsibility — without this check, any signed-in member
  // could download every other member's reports by URL guessing.
  const caseId = parseCaseIdFromReportPath(reportPath)
  if (!caseId) {
    sendJson(res, { error: 'invalid report path' }, 400)
    return
  }
  if (caseId !== userId) {
    sendJson(
      res,
      {
        error: 'forbidden: that report belongs to a different user',
        code: 'cross_user_forbidden',
      },
      403,
    )
    return
  }
  try {
    const { markdown } = await ctx.growthReports.read(reportPath)
    const filename = reportPath.split('/').pop() ?? 'report.md'
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'cache-control': 'no-store',
    })
    res.end(markdown)
  } catch {
    // Hide whether the file exists vs read-failed for any other reason —
    // either way the caller has no business knowing more than "not found".
    sendJson(res, { error: 'not found' }, 404)
  }
}

// ---------------------------------------------------------------------------
// Public catalogue — exported so the /me HTML page (or future API users)
// can render the allowlist without hardcoding the workflowId list. Kept
// as a function so the constant above stays the single source of truth.
// ---------------------------------------------------------------------------

function listAllowedWorkflowsForMe(): ReadonlyArray<{
  workflowId: string
  capability: string
  payloadFields: readonly string[]
  label: string
}> {
  return Object.entries(ALLOWED_WORKFLOWS).map(([workflowId, wf]) => ({
    workflowId,
    capability: wf.capability,
    payloadFields: wf.payloadFields,
    label: wf.label,
  }))
}
