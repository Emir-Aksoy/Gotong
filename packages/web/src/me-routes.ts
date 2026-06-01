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
 * # Member-facing workflow catalog (Phase 14)
 *
 * Dispatch is limited to workflows that declare `surface.me.enabled` in
 * their YAML and whose `allowedRoles` include the caller's role. The
 * catalog is DERIVED at request time from the live workflow list
 * (`ctx.workflows.list()`), not a hardcoded table — so opening a
 * workflow to members is an import-time decision by an admin (who
 * already gates `/api/admin/workflows/import`), not a source edit here.
 *
 * For an allowed workflow the handler copies only the declared input
 * fields, forces `payload[userScopeField] = userId` (default `case_id`),
 * and forwards via hub.dispatch with the caller's userId as `from`.
 *
 * Why a gate at all (not a generic "dispatch anything" route): the
 * workflow runner's `from` field is normally a privileged admin id (or
 * 'system' for in-process demos). Letting an arbitrary v4 user trigger
 * an arbitrary workflow with their userId as `from` would effectively
 * grant them v3 admin's dispatch authority. The `surface.me.enabled`
 * declaration is the audited boundary that keeps the surface narrow.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, sendJson } from './http-helpers.js'
import { readRawBody } from './uploads-routes.js'

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
  // Phase 15 — only a PUBLISHED workflow is member-facing. A draft / review /
  // deprecated / archived workflow is never runnable from /me, even when it
  // declares `surface.me.enabled`. `state` is absent only on a legacy host that
  // predates the lifecycle; there we fall through and let surface.me gate it.
  if (summary.state !== undefined && summary.state !== 'published') return null
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

/**
 * Look up one workflow by id in the live catalog and resolve it for the
 * caller's role. Returns null when the workflow surface is unwired, the
 * id isn't found, or it isn't member-facing for this role — all of which
 * the dispatch handler turns into a 403. Fail-closed: a list() error also
 * resolves to null (deny rather than dispatch on incomplete info).
 */
async function resolveMeWorkflow(
  ctx: HandleMeRouteCtx,
  workflowId: string,
  role: string,
): Promise<ResolvedMeWorkflow | null> {
  if (!ctx.workflows) return null
  let summaries: MeWorkflowSummaryLike[]
  try {
    summaries = await ctx.workflows.list()
  } catch (err) {
    log.error('me dispatch: workflow list failed; denying', { err })
    return null
  }
  const summary = summaries.find((s) => s.id === workflowId)
  if (!summary) return null
  return evaluateMeSurface(summary, role)
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
  /**
   * Phase 15 lifecycle state. Only `'published'` is member-facing; a draft /
   * deprecated / archived workflow is excluded from the `/me` catalog and its
   * dispatch is denied (403). Absent on legacy hosts that predate lifecycle.
   */
  state?: string
}

export interface MeWorkflowSurface {
  list(): Promise<MeWorkflowSummaryLike[]>
}

// ---------------------------------------------------------------------------
// Member run history surface (Phase 19 P1-M2)
//
// Duck-typed so the web layer takes no runtime dep on `@aipehub/workflow`. The
// host's workflow surface satisfies it structurally: its `listRunsByUser`
// returns the wider `WorkflowRunSummary`, assignable to the narrow `MeRunView`.
// `listRunsByUser` is already scoped to the caller server-side (keyed on the
// run's `triggeredByOrigin.userId`), so a member only ever sees their own runs.
// ---------------------------------------------------------------------------

/** Public projection of a workflow run — what the member's client sees. */
export interface MeRunView {
  runId: string
  workflowId: string
  status: string
  startedAt: number
  endedAt?: number
  error?: string
}

export interface MeRunSurface {
  /** Runs initiated by one user, newest first. Already scoped server-side. */
  listRunsByUser(
    userId: string,
    opts?: { limit?: number; workflowId?: string },
  ): Promise<MeRunView[]>
}

// ---------------------------------------------------------------------------
// Member agent directory surface (Phase 19 P1-M3)
//
// Duck-typed; the HOST does the sanitization and hands the web layer ONLY the
// safe projection (`MeAgentView`). The raw `AgentRecord.managed` block — system
// prompt, model, provider baseURL, any per-agent key — never crosses into the
// web layer, so a member can never read another participant's prompt or config.
// Capabilities ARE surfaced: they're functional "what can this helper do"
// labels, not secrets.
// ---------------------------------------------------------------------------

/** Sanitized projection of a managed agent — what a member's client sees. */
export interface MeAgentView {
  id: string
  label: string
  capabilities: string[]
  /** Whether the agent is currently registered on the Hub. */
  online: boolean
  /**
   * Reserved for a short, non-sensitive human description. NOT populated from
   * the system prompt (that's deliberately excluded). Optional until the agent
   * model carries a safe description field.
   */
  description?: string
}

export interface MeAgentListSurface {
  /** All host-managed agents, sanitized. Same view for every member. */
  listForMembers(): Promise<MeAgentView[]>
}

// ---------------------------------------------------------------------------
// Member upload surface (Phase 19 P1-M4)
//
// Same host UploadSurface the admin route uses (`WorkflowSurface`-style duck
// type), but member uploads are written under a per-user scope (`me/<userId>`)
// so a member can only download their OWN artifacts. The route forces both the
// upload scope and the download prefix from the SESSION userId — never a
// client-supplied value — so isolation can't be spoofed.
// ---------------------------------------------------------------------------

export interface MeUploadSurface {
  put(params: {
    bytes: Uint8Array
    declaredMime: string
    filename?: string
    by: string
    scope?: string
  }): Promise<{ artifactId: string; mime: string; size: number }>
  get(artifactId: string): Promise<{ bytes: Uint8Array; mime: string }>
}

/**
 * Per-user uploads scope. Member artifacts live under `uploads/<scope>/…`.
 * userId is identity-minted, but we never trust it raw into a path — collapse
 * anything outside `[A-Za-z0-9_-]`. Both the upload (scope) and the download
 * (prefix) sides call this, so they always agree.
 */
function memberUploadScope(userId: string): string {
  return `me/${userId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

// ---------------------------------------------------------------------------
// Member task inbox surface (Phase 16)
//
// Duck-typed so the web layer takes no runtime dep on `@aipehub/inbox`; the
// host's `HostInboxService` satisfies it structurally. `listPending` is already
// scoped to the caller server-side and returns the PUBLIC item shape (no
// userId / parent / status — internal). `resolve` runs the two-step
// suspend/resume and throws an error carrying a `.code` the route maps to an
// HTTP status (like the workflow lifecycle routes), never an instanceof check.
// ---------------------------------------------------------------------------

/** Public projection of an inbox item — what the member's client sees. */
export interface InboxItemView {
  itemId: string
  kind: string
  prompt: string
  title?: string
  options?: unknown[]
  editField?: unknown
  createdAt: number
}

export interface InboxSurface {
  /** Pending items for one user, newest first. Already scoped server-side. */
  listPending(userId: string): Promise<InboxItemView[]>
  /**
   * Resolve one item with the member's decision. Forces `userId` to the
   * caller. Throws an error with `.code` of `not_found` / `already_resolved`
   * / `forbidden` / `invalid_decision` (or `invalid_payload`) on failure.
   */
  resolve(args: { itemId: string; userId: string; decision: unknown }): Promise<void>
  /**
   * inbox-gov M2 — hand a pending item off to another member, identified by
   * email. Forces the delegating `userId` to the caller. Throws an error with
   * `.code` of `not_found` / `forbidden` / `already_resolved` / `invalid_target`.
   */
  delegate(args: {
    itemId: string
    userId: string
    toEmail: string
    note?: string
  }): Promise<void>
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
  /**
   * Phase 19 P1-M2 — member run history. Undefined when the host wired no
   * workflow surface; `/api/me/runs` then degrades to an empty list and the
   * catalog omits `latestStatus`. Usually the same object as `workflows`.
   */
  runs: MeRunSurface | undefined
  /**
   * Phase 19 P1-M3 — sanitized agent directory. Undefined when the host wired
   * no agent surface; `/api/me/agents` then degrades to an empty list.
   */
  meAgents: MeAgentListSurface | undefined
  /**
   * Phase 19 P1-M4 — member file uploads. Undefined when the host wired no
   * upload backing; `/api/me/uploads` then returns 503.
   */
  uploads: MeUploadSurface | undefined
  /**
   * Phase 16 — member task inbox. Undefined when the host wired no inbox;
   * the /me/inbox routes then degrade to an empty list / 503.
   */
  inbox: InboxSurface | undefined
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

  // Phase 14 — member-facing workflow catalog, DERIVED from the live
  // workflow list (only those declaring surface.me.enabled and allowing
  // the caller's role).
  if (method === 'GET' && path === '/api/me/workflows') {
    await handleMeListWorkflows(ctx, res, userId, v4.role)
    return
  }
  // Phase 19 P1-M2 — "my recent runs". Server-scoped to the caller; a member
  // can never read another user's run history.
  if (method === 'GET' && path === '/api/me/runs') {
    await handleMeListRuns(ctx, res, userId)
    return
  }
  // Phase 19 P1-M3 — sanitized agent directory ("my AI helpers"). Same view
  // for every member; the host already stripped prompts / keys / config.
  if (method === 'GET' && path === '/api/me/agents') {
    await handleMeListAgents(ctx, res)
    return
  }
  // Phase 19 P1-M4 — member file uploads. POST writes under the caller's
  // per-user scope; GET serves back ONLY artifacts under that scope (a member
  // can't read another user's upload). Both derive the scope from the session
  // userId, never a client value.
  if (path === '/api/me/uploads' && (method === 'POST' || method === 'GET')) {
    await handleMeUploads(ctx, req, res, userId, method)
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
    await handleMeDispatch(ctx, req, res, userId, v4.role)
    return
  }
  // Phase 16 — member task inbox. GET lists the caller's pending items;
  // POST /:itemId/resolve submits their decision (userId forced server-side).
  if (method === 'GET' && path === '/api/me/inbox') {
    await handleMeListInbox(ctx, res, userId)
    return
  }
  {
    const m =
      method === 'POST' ? /^\/api\/me\/inbox\/([^/]+)\/resolve$/.exec(path) : null
    if (m) {
      await handleMeResolveInbox(ctx, req, res, userId, decodeURIComponent(m[1]!))
      return
    }
  }
  // inbox-gov M2 — hand a pending item off to another member (by email).
  {
    const m =
      method === 'POST' ? /^\/api\/me\/inbox\/([^/]+)\/delegate$/.exec(path) : null
    if (m) {
      await handleMeDelegateInbox(ctx, req, res, userId, decodeURIComponent(m[1]!))
      return
    }
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
  role: string,
): Promise<void> {
  // AUDIT-P3-01: rate-limit per-user. Each dispatch triggers a
  // workflow that may fan out to several LLM agents. Without this, a single
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
      { error: 'workflowId must be a string (see GET /api/me/workflows)' },
      400,
    )
    return
  }
  // Resolve against the live catalog: the workflow must declare
  // surface.me.enabled AND allow this caller's role. Resolution is the
  // single security gate — there's no hardcoded allowlist any more.
  const wf = await resolveMeWorkflow(ctx, b.workflowId, role)
  if (!wf) {
    sendJson(
      res,
      {
        error: `workflowId '${b.workflowId}' is not enabled on the /me surface`,
        code: 'workflow_not_allowed',
      },
      403,
    )
    return
  }
  const payloadIn =
    b.payload && typeof b.payload === 'object' && !Array.isArray(b.payload)
      ? (b.payload as Record<string, unknown>)
      : {}
  // Build a payload from the declared input fields ONLY. Drop any
  // caller-supplied extras (including the scope key — it's excluded from
  // inputFieldIds, and we force it ourselves below to userId).
  const payload: Record<string, unknown> = {}
  for (const field of wf.inputFieldIds) {
    if (field in payloadIn) payload[field] = payloadIn[field]
  }
  // Force the scope key server-side. Any value the member tried to pass
  // under it was already dropped above (it's not in inputFieldIds), so a
  // member can never act on another user's behalf. Default key is
  // `case_id`; a workflow may declare its own via surface.me.userScopeField.
  payload[wf.userScopeField] = userId

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
    // Don't echo the scope field/value: the caller knows their own id,
    // and the scope key name is an internal enforcement detail (kept off
    // the catalog too).
    sendJson(res, {
      ok: true,
      workflowId: b.workflowId,
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
// GET /api/me/inbox  +  POST /api/me/inbox/:itemId/resolve  (Phase 16)
// ---------------------------------------------------------------------------

async function handleMeListInbox(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  // No inbox wired → empty list (mirrors the workflows catalog degradation),
  // so the client renders an empty panel rather than erroring.
  if (!ctx.inbox) {
    sendJson(res, { items: [] })
    return
  }
  try {
    // listPending is scoped to the caller server-side — a member can only ever
    // see their own items. The surface returns the public view already.
    const items = await ctx.inbox.listPending(userId)
    sendJson(res, { items })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

async function handleMeResolveInbox(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  itemId: string,
): Promise<void> {
  if (!ctx.inbox) {
    sendJson(res, { error: 'inbox not enabled on this host' }, 503)
    return
  }
  // Rate-limit per-user: resolving resumes a parked workflow that may fan out
  // to LLM agents downstream — same budget machinery as /me/dispatch. The
  // markResolved guard already caps repeat-resolves of one item, but this
  // bounds a member churning across many assigned items.
  if (!ctx.loginLimiter.check(`me-inbox-resolve:${userId}`)) {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' })
    res.end('too many inbox resolves; try again in a minute')
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'bad body' }, 400)
    return
  }
  const decision =
    body && typeof body === 'object' ? (body as { decision?: unknown }).decision : undefined
  if (decision === undefined) {
    sendJson(res, { error: 'body required: {decision}' }, 400)
    return
  }
  try {
    // userId is forced from the session — a member can never resolve another
    // user's item (the surface re-checks ownership and throws 'forbidden').
    await ctx.inbox.resolve({ itemId, userId, decision })
    sendJson(res, { ok: true, itemId })
  } catch (err) {
    const code = (err as { code?: unknown }).code
    const status =
      code === 'not_found'
        ? 404
        : code === 'forbidden'
          ? 403
          : code === 'already_resolved'
            ? 409
            : code === 'invalid_decision' || code === 'invalid_payload'
              ? 400
              : 500
    const payload: Record<string, unknown> = {
      error: err instanceof Error ? err.message : String(err),
    }
    if (typeof code === 'string') payload.code = code
    sendJson(res, payload, status)
  }
}

/**
 * inbox-gov M2 — POST /api/me/inbox/:itemId/delegate. Hand a pending item off
 * to another member, identified by `{ toEmail, note? }`. The delegating user is
 * forced from the session; the host resolves the email (never a user id) and
 * fails closed on an unknown / self target.
 */
async function handleMeDelegateInbox(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  itemId: string,
): Promise<void> {
  if (!ctx.inbox) {
    sendJson(res, { error: 'inbox not enabled on this host' }, 503)
    return
  }
  // Same per-user budget as resolve — a handoff is cheap, but this bounds a
  // member churning across many items.
  if (!ctx.loginLimiter.check(`me-inbox-delegate:${userId}`)) {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' })
    res.end('too many inbox delegations; try again in a minute')
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'bad body' }, 400)
    return
  }
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const toEmail = typeof b.toEmail === 'string' ? b.toEmail : ''
  if (toEmail.length === 0) {
    sendJson(res, { error: 'body required: {toEmail}', code: 'invalid_target' }, 400)
    return
  }
  const note = typeof b.note === 'string' ? b.note : undefined
  try {
    await ctx.inbox.delegate({ itemId, userId, toEmail, note })
    sendJson(res, { ok: true, itemId })
  } catch (err) {
    const code = (err as { code?: unknown }).code
    const status =
      code === 'not_found'
        ? 404
        : code === 'forbidden'
          ? 403
          : code === 'already_resolved'
            ? 409
            : code === 'invalid_target'
              ? 400
              : 500
    const payload: Record<string, unknown> = {
      error: err instanceof Error ? err.message : String(err),
    }
    if (typeof code === 'string') payload.code = code
    sendJson(res, payload, status)
  }
}

// ---------------------------------------------------------------------------
// GET /api/me/workflows — member-facing catalog (Phase 14)
// ---------------------------------------------------------------------------

interface MeCatalogEntry {
  id: string
  label: string
  description?: string
  inputSchema: unknown[]
  /** Phase 19 P1-M2 — status of the caller's newest run of this workflow. */
  latestStatus?: string
  /** When that newest run started (ms since epoch). */
  lastRunAt?: number
}

async function handleMeListWorkflows(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
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
  // Phase 19 P1-M2 — fetch the caller's runs ONCE (newest first), then index
  // the newest per workflow. Best-effort: a runs-surface failure must not sink
  // the catalog, so we degrade to "no status" rather than 500.
  const newestByWorkflow = new Map<string, MeRunView>()
  if (ctx.runs) {
    try {
      for (const r of await ctx.runs.listRunsByUser(userId)) {
        if (!newestByWorkflow.has(r.workflowId)) newestByWorkflow.set(r.workflowId, r)
      }
    } catch (err) {
      log.error('me catalog: run enrichment failed; omitting status', { err })
    }
  }
  // Project to the PUBLIC shape only: id / label / description / inputSchema
  // (+ the caller's own run status). `capability` and `userScopeField` are
  // internal enforcement details — never surfaced, so a member can't probe
  // the dispatch internals.
  const workflows: MeCatalogEntry[] = []
  for (const s of summaries) {
    const resolved = evaluateMeSurface(s, role)
    if (!resolved) continue
    const entry: MeCatalogEntry = {
      id: resolved.workflowId,
      label: resolved.label,
      inputSchema: resolved.inputSchema,
    }
    if (resolved.description !== undefined) entry.description = resolved.description
    const last = newestByWorkflow.get(resolved.workflowId)
    if (last) {
      entry.latestStatus = last.status
      entry.lastRunAt = last.startedAt
    }
    workflows.push(entry)
  }
  sendJson(res, { workflows })
}

// ---------------------------------------------------------------------------
// GET /api/me/runs — the caller's own recent runs (Phase 19 P1-M2)
// ---------------------------------------------------------------------------

async function handleMeListRuns(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.runs) {
    // No workflow/runs surface wired → empty list (mirrors the catalog
    // degradation), so the client renders an empty panel rather than erroring.
    sendJson(res, { runs: [] })
    return
  }
  let rows: MeRunView[]
  try {
    rows = await ctx.runs.listRunsByUser(userId, { limit: 50 })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    return
  }
  // Re-project to the public run view: drop any extra fields the wider host
  // summary may carry (eg. triggeredByTaskId / stepCount), keep only what the
  // member needs to render a run row.
  const runs = rows.map((r) => {
    const out: MeRunView = {
      runId: r.runId,
      workflowId: r.workflowId,
      status: r.status,
      startedAt: r.startedAt,
    }
    if (r.endedAt !== undefined) out.endedAt = r.endedAt
    if (r.error !== undefined) out.error = r.error
    return out
  })
  sendJson(res, { runs })
}

// ---------------------------------------------------------------------------
// GET /api/me/agents — sanitized agent directory (Phase 19 P1-M3)
// ---------------------------------------------------------------------------

async function handleMeListAgents(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.meAgents) {
    // No agent surface wired → empty list (mirrors the catalog degradation).
    sendJson(res, { agents: [] })
    return
  }
  let agents: MeAgentView[]
  try {
    agents = await ctx.meAgents.listForMembers()
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    return
  }
  // The host already sanitized — pass through verbatim (no prompt / key /
  // config to strip here).
  sendJson(res, { agents })
}

// ---------------------------------------------------------------------------
// GET / POST /api/me/uploads — member file uploads (Phase 19 P1-M4)
// ---------------------------------------------------------------------------

const ME_UPLOAD_CEILING_BYTES = 50 * 1024 * 1024

async function handleMeUploads(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  method: string,
): Promise<void> {
  if (!ctx.uploads) {
    sendJson(res, { error: 'uploads not enabled on this host' }, 503)
    return
  }
  const scope = memberUploadScope(userId)
  const prefix = `uploads/${scope}/`

  // --- download: own artifacts only ---
  if (method === 'GET') {
    const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const id = u.searchParams.get('id')
    if (!id) {
      sendJson(res, { error: 'missing ?id=<artifactId>' }, 400)
      return
    }
    // Isolation: a member may only read artifacts under their OWN scope.
    // Anything else → 404 (don't reveal whether it exists for someone else).
    if (!id.startsWith(prefix)) {
      sendJson(res, { error: 'not found' }, 404)
      return
    }
    try {
      const { bytes, mime } = await ctx.uploads.get(id)
      const filename = id.split('/').pop() ?? 'artifact'
      const safeFilename = filename.replace(/[^A-Za-z0-9._-]/g, '_')
      res.writeHead(200, {
        'content-type': mime || 'application/octet-stream',
        'content-length': String(bytes.byteLength),
        'content-disposition': `inline; filename="${safeFilename}"`,
        'cache-control': 'private, max-age=300',
      })
      res.end(Buffer.from(bytes))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const lower = msg.toLowerCase()
      const code = lower.includes('enoent') || lower.includes('no such file') ? 404 : 500
      sendJson(res, { error: code === 404 ? 'not found' : msg }, code)
    }
    return
  }

  // --- upload (POST) ---
  // Rate-limit per user (same budget machinery as /me/dispatch) so a member
  // can't loop-upload to exhaust disk.
  if (!ctx.loginLimiter.check(`me-upload:${userId}`)) {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' })
    res.end('too many uploads; try again in a minute')
    return
  }
  const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const filename = u.searchParams.get('filename') || undefined
  const declaredMime =
    u.searchParams.get('mime')
    || (typeof req.headers['content-type'] === 'string'
        ? req.headers['content-type']!.split(';')[0]!.trim()
        : '')
    || 'application/octet-stream'
  const declaredLen = Number.parseInt(
    typeof req.headers['content-length'] === 'string' ? req.headers['content-length'] : '',
    10,
  )
  if (Number.isFinite(declaredLen) && declaredLen > ME_UPLOAD_CEILING_BYTES) {
    sendJson(res, { error: `body too large (limit ${ME_UPLOAD_CEILING_BYTES} bytes)` }, 413)
    req.resume()
    return
  }
  let bytes: Buffer
  try {
    bytes = await readRawBody(req, ME_UPLOAD_CEILING_BYTES)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, { error: msg }, msg.startsWith('body too large') ? 413 : 400)
    return
  }
  if (bytes.length === 0) {
    sendJson(res, { error: 'empty body (no file content)' }, 400)
    return
  }
  try {
    const put = await ctx.uploads.put({
      bytes,
      declaredMime,
      ...(filename ? { filename } : {}),
      by: userId,
      // Per-user isolation: forced from the SESSION userId, never a client value.
      scope,
    })
    sendJson(res, put)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn('me upload rejected', { by: userId, mime: declaredMime, size: bytes.length, err: msg })
    const isClientError = /mime|exceeds maxBytes|traversal|relative|null byte|path-safe/.test(msg)
    sendJson(res, { error: msg }, isClientError ? 400 : 500)
  }
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
