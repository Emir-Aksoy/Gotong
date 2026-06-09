/**
 * /api/admin/workflows/* — workflow CRUD + AI assistant routes.
 *
 * Extracted from server.ts (P3 audit cleanup — server.ts is 3700+ lines)
 * following the same shape as identity-routes.ts / me-routes.ts:
 *
 *   - Shared HTTP helpers (sendJson / readJsonBody / readTextBody) from
 *     ./http-helpers.js — the C3 cleanup that folded the per-route copies.
 *   - Narrow `WorkflowRoutesCtx` projection of server.ts's HandlerCtx —
 *     only the fields these handlers need (hub, workflows surface,
 *     workflow-assist surface, plus the parent's `requireAdmin` closure
 *     so we don't duplicate v3 admin auth machinery).
 *   - One entry point `handleWorkflowRoute(ctx, req, res, method, path,
 *     url): Promise<boolean>` — returns true iff the request was handled.
 *
 * # Route inventory
 *
 *   GET    /api/admin/workflows                      — list all (incl. drafts)
 *   POST   /api/admin/workflows/import               — YAML/JSON → register
 *   POST   /api/admin/workflows/assist               — Phase 13 M3 AI draft
 *   GET    /api/admin/workflows/runs                 — list recorded runs
 *   GET    /api/admin/workflows/runs/:id             — read one run
 *   DELETE /api/admin/workflows/:id                  — unregister + delete YAML
 *
 * Auth: every route is admin-gated via the host-supplied `requireAdmin`.
 * When the host didn't wire `workflows` (embedded / test mode), CRUD
 * endpoints return 404 so the admin UI can hide the panel; when assist
 * is absent (no LLM key / disabled), 503.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, readTextBody, sendJson } from './http-helpers.js'

import type { AdminRecord, Hub } from '@aipehub/core'

import type {
  WorkflowAssistSurface,
  WorkflowAssistContextHints,
  WorkflowSummary,
  WorkflowSurface,
} from './server.js'

// ---------------------------------------------------------------------------
// Context — narrow projection of server.ts's HandlerCtx. Only the bits
// these routes touch, plus the `requireAdmin` closure so we don't have
// to re-export the v3 admin auth internals.
// ---------------------------------------------------------------------------

/**
 * P2-M2 — narrow audit-write capability. Structurally satisfied by the
 * host's `IdentityStore` (its `writeAuditLog` is optional too), so the host
 * passes its existing `identity` surface here with no extra wiring; web keeps
 * its zero-identity-runtime-dep posture. Absent (or pre-V4-AUDIT-06) → the
 * lifecycle transitions still work, just unaudited. The `actorSource` union
 * mirrors `IdentityAuditActorSource` so `ctx.identity` is assignable verbatim.
 */
export interface WorkflowAuditSink {
  writeAuditLog?(input: {
    action: string
    actorSource: 'v4-session' | 'v4-bearer' | 'anonymous' | 'system' | 'federated'
    actorUserId?: string | null
    targetUserId?: string | null
    targetCredentialId?: string | null
    ip?: string | null
    userAgent?: string | null
    metadata?: Record<string, unknown> | null
    success?: boolean
  }): unknown
}

// P2-M5b — resource-level RBAC (workflow ownership). The grant sink is
// structurally satisfied by the host IdentityStore; web keeps zero identity
// runtime dep. Perm literals mirror @aipehub/identity's WorkflowPerm.
export type WorkflowPermLiteral = 'owner' | 'editor' | 'viewer'

export interface WorkflowGrantRow {
  workflowId: string
  userId: string
  perm: string
  grantedBy: string | null
  grantedAt: number
}

export interface WorkflowGrantSink {
  setWorkflowGrant(input: {
    workflowId: string
    userId: string
    perm: WorkflowPermLiteral
    grantedBy?: string | null
  }): unknown
  hasWorkflowGrant(
    workflowId: string,
    userId: string,
    min: WorkflowPermLiteral,
  ): boolean
  listWorkflowGrants(workflowId: string): WorkflowGrantRow[]
  removeWorkflowGrant(workflowId: string, userId: string): boolean
  removeAllWorkflowGrants(workflowId: string): number
}

/**
 * The acting admin's RBAC identity for one request. `isOperator` (org owner
 * or v3 Space-admin) BYPASSES grants entirely — so personal mode and the
 * legacy admin-token path keep working with zero behaviour change. A
 * non-operator must carry a `userId` (v4 user) checked against the grants.
 */
export interface WorkflowActor {
  userId: string | null
  isOperator: boolean
}

export interface WorkflowRoutesCtx {
  hub: Hub
  workflows: WorkflowSurface | undefined
  workflowAssist: WorkflowAssistSurface | undefined
  /**
   * P2-M2 — optional audit sink. The host wires its `identity` surface here;
   * governance-significant lifecycle transitions write one row through it.
   */
  audit?: WorkflowAuditSink
  /**
   * P2-M5b — workflow grant store (IdentityStore satisfies it). Absent →
   * RBAC disabled (embedded / older host): every admin passes, no owner seed.
   */
  grants?: WorkflowGrantSink
  /**
   * P2-M5b — resolve the acting admin's RBAC identity. Absent → treat every
   * admin as an operator (no RBAC). Paired with `grants`: both present = RBAC on.
   */
  resolveActor?(req: IncomingMessage): WorkflowActor
  /**
   * The parent's admin gate. On rejection (401 / 429) this closure
   * writes the response itself and returns `null`; on success it
   * returns the resolved `AdminRecord`. Workflow handlers short-
   * circuit when it returns null.
   */
  requireAdmin(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<AdminRecord | null>
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Try to handle a request against the workflow route set. Returns
 * `true` iff the request matched (and the response was written by us /
 * the auth gate); the caller's main switch then falls through.
 *
 * Important: the DELETE /api/admin/workflows/:id pattern MUST be tested
 * AFTER the /runs sub-routes; the dispatcher inside this function
 * already does so. Don't reorder.
 */
export async function handleWorkflowRoute(
  ctx: WorkflowRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  url: URL,
): Promise<boolean> {
  // GET /api/admin/workflows — list ALL workflows (incl. draft / review /
  // archived). The admin panel is the operator's full view; the /me member
  // catalog uses a separate live-only surface.
  if (method === 'GET' && path === '/api/admin/workflows') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return true
    }
    try {
      const list = await ctx.workflows.listAll()
      sendJson(res, { workflows: list })
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  // POST /api/admin/workflows/import — accept YAML or JSON body
  if (method === 'POST' && path === '/api/admin/workflows/import') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return true
    }
    const raw = await readTextBody(req).catch(() => '')
    if (!raw) { sendJson(res, { error: 'empty body' }, 400); return true }
    try {
      const summary = await ctx.workflows.importFromText(raw)
      // P2-M5b — the importer becomes the workflow's owner (RBAC seed).
      seedWorkflowOwner(ctx, req, summary.id)
      auditWorkflowTransition(ctx, admin, 'workflow_import', summary)
      sendJson(res, { ok: true, workflow: summary })
    } catch (err) {
      // P2-M1 — a structural rejection (deep-check) carries `code` + `violations`;
      // lifecycleErrorStatus maps unknown codes to 400 (same as before).
      sendJson(res, lifecycleErrorBody(err), lifecycleErrorStatus(err))
    }
    return true
  }

  // POST /api/admin/workflows/draft — save YAML as a DRAFT (Phase 15).
  // The opt-in counterpart to /import: creates the workflow but does NOT
  // make it live (no runner, absent from list() until published).
  if (method === 'POST' && path === '/api/admin/workflows/draft') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return true
    }
    const raw = await readTextBody(req).catch(() => '')
    if (!raw) { sendJson(res, { error: 'empty body' }, 400); return true }
    try {
      const summary = await ctx.workflows.saveDraft(raw, { by: admin.id })
      // P2-M5b — drafting a new workflow makes you its owner (RBAC seed).
      seedWorkflowOwner(ctx, req, summary.id)
      sendJson(res, { ok: true, workflow: summary })
    } catch (err) {
      sendJson(res, lifecycleErrorBody(err), lifecycleErrorStatus(err))
    }
    return true
  }

  // POST /api/admin/workflows/assist — Phase 13 M3 natural-language draft.
  // The host wires `ctx.workflowAssist` to a `WorkflowAssistantAgent`
  // registered at boot (capability=`workflow:assist`). When absent (no
  // LLM key resolved, or operator set `AIPE_ASSISTANT_DISABLED=1`),
  // respond 503 so the admin UI can hide the "AI assistant" button
  // cleanly.
  //
  // Request body (JSON):
  //   { description: string, contextHints?: WorkflowAssistContextHints }
  // Response body (200):
  //   { ok: true, yaml, explanation, raw, draftStatus, validationError?,
  //     by?, stopReason?, deepCheck? }
  //   - `deepCheck` (Phase 13 M4) is populated iff the request carried
  //     `contextHints` AND the YAML parsed cleanly. Caller treats
  //     `deepCheck.ok=false` as a yellow "warnings" state — admin can
  //     still save, but the workflow references hub entities that don't
  //     currently exist. See WorkflowDeepCheckResult in server.ts.
  // Response body (4xx/5xx): { error: string }
  if (method === 'POST' && path === '/api/admin/workflows/assist') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflowAssist) {
      sendJson(res, { error: 'workflow assistant not enabled on this host' }, 503)
      return true
    }
    const body = (await readJsonBody(req).catch(() => undefined)) as
      | { description?: unknown; contextHints?: WorkflowAssistContextHints }
      | undefined
    const description =
      body && typeof body.description === 'string' ? body.description : ''
    if (description.trim().length === 0) {
      sendJson(res, { error: 'description is required (non-empty string)' }, 400)
      return true
    }
    try {
      const result = await ctx.workflowAssist.assist({
        description,
        ...(body?.contextHints ? { contextHints: body.contextHints } : {}),
        by: admin.id,
      })
      sendJson(res, { ok: true, ...result })
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  // List recorded workflow runs. Both /runs and /runs/:id are wired
  // before the catch-all DELETE /:id route so a runId can never get
  // routed as a workflow id.
  if (method === 'GET' && path === '/api/admin/workflows/runs') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return true
    }
    const workflowIdRaw = url.searchParams.get('workflowId') ?? undefined
    const limitRaw = url.searchParams.get('limit')
    const opts: { workflowId?: string; limit?: number } = {}
    if (workflowIdRaw) opts.workflowId = workflowIdRaw
    if (limitRaw !== null) {
      const n = Number(limitRaw)
      if (Number.isFinite(n) && n >= 0) opts.limit = Math.min(1000, Math.floor(n))
    }
    try {
      const runs = await ctx.workflows.listRuns(opts)
      sendJson(res, { runs })
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  const readRunMatch = path.match(/^\/api\/admin\/workflows\/runs\/([^/]+)$/)
  if (method === 'GET' && readRunMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return true
    }
    const runId = decodeURIComponent(readRunMatch[1]!)
    try {
      const run = await ctx.workflows.readRun(runId)
      if (run == null) {
        sendJson(res, { error: `unknown run '${runId}'` }, 404)
        return true
      }
      sendJson(res, { run })
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  // v5 Stream G day-5 — the cross-hub transcript CHAIN. For one step of a run
  // that ran on a peer hub, pull the peer's own transcript of that one task
  // (the opt-in `peer.transcript` rpc). Wired here, under /runs, so the two
  // path segments never collide with the single-segment workflow routes below.
  // The host owns the peer link + fetch; the Web layer just forwards the
  // duck-typed verdict. A host with no peer-link resolver omits the method → 404.
  const peerTxMatch = path.match(
    /^\/api\/admin\/workflows\/runs\/([^/]+)\/steps\/([^/]+)\/peer-transcript$/,
  )
  if (method === 'GET' && peerTxMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows || !ctx.workflows.fetchPeerStepTranscript) {
      sendJson(res, { error: 'cross-hub transcript chain not enabled on this host' }, 404)
      return true
    }
    const runId = decodeURIComponent(peerTxMatch[1]!)
    const stepId = decodeURIComponent(peerTxMatch[2]!)
    // PB — `?branch=<id>` targets ONE branch of a parallel step (the per-branch
    // executor/handle maps); omitted ⇒ the step-level fields (a simple step).
    const branch = url.searchParams.get('branch') ?? undefined
    try {
      const out = (await ctx.workflows.fetchPeerStepTranscript(runId, stepId, branch)) as
        | { ok: true; slice: unknown }
        | { ok: false; code: string; message: string }
      // A genuinely-missing run/step is a 404; the soft verdicts (same-hub step,
      // disconnected peer, peer not sharing) ride back as 200 so the UI renders
      // the reason inline rather than treating it as an error.
      if (out && out.ok === false && (out.code === 'unknown_run' || out.code === 'unknown_step')) {
        sendJson(res, out, 404)
        return true
      }
      sendJson(res, out)
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  // Phase 15 lifecycle transitions — POST /api/admin/workflows/:id/<action>.
  // Wired before the catch-all DELETE /:id (single-segment) — these all
  // carry a second path segment so they never collide. `publish` accepts an
  // optional `{ text }` body (publish an edit); `rollback` requires
  // `{ targetRevision }`; the rest need no body. The acting admin is stamped
  // as `by` for the audit log.
  const lifecycleMatch = path.match(
    /^\/api\/admin\/workflows\/([^/]+)\/(draft|review|publish|deprecate|archive|rollback)$/,
  )
  if (method === 'POST' && lifecycleMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return true
    }
    const wf = ctx.workflows
    const id = decodeURIComponent(lifecycleMatch[1]!)
    const action = lifecycleMatch[2]!
    // P2-M5b — every lifecycle transition needs editor+ on this workflow.
    // Operators (org owner / v3 admin) bypass; RBAC-off hosts pass through.
    if (denyIfNoWorkflowPerm(ctx, req, res, id, 'editor')) return true
    const by = admin.id
    try {
      let summary: WorkflowSummary
      switch (action) {
        case 'review':
          summary = await wf.submitReview(id, { by })
          break
        case 'draft':
          summary = await wf.backToDraft(id, { by })
          break
        case 'deprecate':
          summary = await wf.deprecate(id, { by })
          break
        case 'archive':
          summary = await wf.archive(id, { by })
          break
        case 'publish': {
          const body = (await readJsonBody(req).catch(() => undefined)) as
            | { text?: unknown }
            | undefined
          const text = body && typeof body.text === 'string' ? body.text : undefined
          summary = await wf.publish(id, { ...(text !== undefined ? { text } : {}), by })
          break
        }
        case 'rollback': {
          const body = (await readJsonBody(req).catch(() => undefined)) as
            | { targetRevision?: unknown }
            | undefined
          const target =
            body && typeof body.targetRevision === 'number' ? body.targetRevision : NaN
          if (!Number.isInteger(target)) {
            sendJson(res, { error: 'targetRevision (integer) is required' }, 400)
            return true
          }
          summary = await wf.rollback(id, { targetRevision: target, by })
          break
        }
        default:
          sendJson(res, { error: `unknown action '${action}'` }, 400)
          return true
      }
      // Audit only the governance-significant transitions (publish / deprecate /
      // archive / rollback). review/draft are authoring-internal churn — see
      // WORKFLOW_AUDIT_ACTION. A null lookup → no row, by design.
      const auditAction = WORKFLOW_AUDIT_ACTION[action]
      if (auditAction) auditWorkflowTransition(ctx, admin, auditAction, summary)
      sendJson(res, { ok: true, workflow: summary })
    } catch (err) {
      sendJson(res, lifecycleErrorBody(err), lifecycleErrorStatus(err))
    }
    return true
  }

  // GET /api/admin/workflows/:id/revisions — revision metadata, ascending.
  const revisionsMatch = path.match(/^\/api\/admin\/workflows\/([^/]+)\/revisions$/)
  if (method === 'GET' && revisionsMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return true
    }
    const id = decodeURIComponent(revisionsMatch[1]!)
    try {
      const revisions = await ctx.workflows.listRevisions(id)
      sendJson(res, { revisions })
    } catch (err) {
      sendJson(
        res,
        { error: err instanceof Error ? err.message : String(err) },
        lifecycleErrorStatus(err),
      )
    }
    return true
  }

  // GET /api/admin/workflows/:id/state — full lifecycle view.
  const stateMatch = path.match(/^\/api\/admin\/workflows\/([^/]+)\/state$/)
  if (method === 'GET' && stateMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return true
    }
    const id = decodeURIComponent(stateMatch[1]!)
    try {
      const lifecycle = await ctx.workflows.getState(id)
      sendJson(res, { lifecycle })
    } catch (err) {
      sendJson(
        res,
        { error: err instanceof Error ? err.message : String(err) },
        lifecycleErrorStatus(err),
      )
    }
    return true
  }

  // P2-M5b — workflow grant management (resource RBAC). Owner-gated; operators
  // (org owner / v3 admin) bypass. Wired before the catch-all DELETE /:id; the
  // extra /grants segment(s) keep these unambiguous. When RBAC is off (no
  // grants sink) → 404 so the admin UI hides the panel.
  const grantsMatch = path.match(/^\/api\/admin\/workflows\/([^/]+)\/grants$/)
  if (grantsMatch && (method === 'GET' || method === 'POST')) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.grants) {
      sendJson(res, { error: 'workflow RBAC not enabled on this host' }, 404)
      return true
    }
    const id = decodeURIComponent(grantsMatch[1]!)
    // Managing (and viewing) the access list is an owner concern.
    if (denyIfNoWorkflowPerm(ctx, req, res, id, 'owner')) return true
    if (method === 'GET') {
      sendJson(res, { grants: ctx.grants.listWorkflowGrants(id) })
      return true
    }
    const body = (await readJsonBody(req).catch(() => undefined)) as
      | { userId?: unknown; perm?: unknown }
      | undefined
    const userId =
      body && typeof body.userId === 'string' ? body.userId.trim() : ''
    const perm = body && typeof body.perm === 'string' ? body.perm : ''
    if (!userId) {
      sendJson(res, { error: 'userId is required' }, 400)
      return true
    }
    if (perm !== 'owner' && perm !== 'editor' && perm !== 'viewer') {
      sendJson(res, { error: "perm must be 'owner' | 'editor' | 'viewer'" }, 400)
      return true
    }
    try {
      ctx.grants.setWorkflowGrant({ workflowId: id, userId, perm, grantedBy: admin.id })
      sendJson(res, { ok: true, grants: ctx.grants.listWorkflowGrants(id) })
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400)
    }
    return true
  }

  // DELETE /api/admin/workflows/:id/grants/:userId — revoke one grant.
  const grantDeleteMatch = path.match(
    /^\/api\/admin\/workflows\/([^/]+)\/grants\/([^/]+)$/,
  )
  if (method === 'DELETE' && grantDeleteMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.grants) {
      sendJson(res, { error: 'workflow RBAC not enabled on this host' }, 404)
      return true
    }
    const id = decodeURIComponent(grantDeleteMatch[1]!)
    const userId = decodeURIComponent(grantDeleteMatch[2]!)
    if (denyIfNoWorkflowPerm(ctx, req, res, id, 'owner')) return true
    const removed = ctx.grants.removeWorkflowGrant(id, userId)
    sendJson(res, { ok: true, removed })
    return true
  }

  // DELETE /api/admin/workflows/:id — unregister + delete YAML.
  // Wired LAST so the /runs sub-routes can never get caught here.
  const deleteWorkflowMatch = path.match(/^\/api\/admin\/workflows\/([^/]+)$/)
  if (method === 'DELETE' && deleteWorkflowMatch) {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.workflows) {
      sendJson(res, { error: 'workflows not enabled on this host' }, 404)
      return true
    }
    const id = decodeURIComponent(deleteWorkflowMatch[1]!)
    // P2-M5b — deleting a workflow needs owner on it (operators bypass).
    if (denyIfNoWorkflowPerm(ctx, req, res, id, 'owner')) return true
    try {
      await ctx.workflows.remove(id)
      // Drop the workflow's grants so a re-import with the same id starts clean.
      ctx.grants?.removeAllWorkflowGrants(id)
      sendJson(res, { ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // "not loaded" → 404, everything else → 400
      const status = /not loaded|unknown/i.test(msg) ? 404 : 400
      sendJson(res, { error: msg }, status)
    }
    return true
  }

  return false
}

/**
 * Map a lifecycle/revision error to an HTTP status by its duck-typed `code`
 * (the Web layer never imports the workflow error classes). Unknown codes fall
 * back to 400 (a malformed request is the common case).
 *
 *   unknown_workflow                                  → 404
 *   revision_missing / rollback_target_required /     → 400
 *     no_current_revision
 *   illegal_transition / capability_immutable /       → 409
 *     stale_head
 */
function lifecycleErrorStatus(err: unknown): number {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code: unknown }).code)
      : ''
  switch (code) {
    case 'unknown_workflow':
      return 404
    case 'illegal_transition':
    case 'capability_immutable':
    case 'stale_head':
      return 409
    case 'revision_missing':
    case 'rollback_target_required':
    case 'no_current_revision':
      return 400
    default:
      return 400
  }
}

/**
 * Build the JSON error body for a workflow lifecycle / structural failure.
 * Always carries `error` (message); adds `code` + `violations` when the thrown
 * error carries them — P2-M1 attaches the deep-check `violations` array to a
 * `structure_check_failed` error so the admin UI can render the offending
 * fields, not just a flat string.
 */
function lifecycleErrorBody(err: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error: err instanceof Error ? err.message : String(err),
  }
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string') body.code = code
    const violations = (err as { violations?: unknown }).violations
    if (Array.isArray(violations)) body.violations = violations
  }
  return body
}

/**
 * P2-M5b — workflow RBAC gate. Returns true (and writes 403) iff the acting
 * admin LACKS `min` permission on the workflow; false = allowed, continue.
 *
 * RBAC is OFF when the host didn't wire BOTH `grants` and `resolveActor`
 * (embedded / test / pre-migration host) — then every admin passes, so
 * existing deployments are unaffected. Operators (org owner / v3 Space admin)
 * always bypass; a non-operator needs a `userId` with a grant ≥ `min`.
 */
function denyIfNoWorkflowPerm(
  ctx: WorkflowRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  min: WorkflowPermLiteral,
): boolean {
  if (!ctx.grants || !ctx.resolveActor) return false
  const actor = ctx.resolveActor(req)
  if (actor.isOperator) return false
  if (actor.userId && ctx.grants.hasWorkflowGrant(id, actor.userId, min)) {
    return false
  }
  sendJson(
    res,
    { error: `workflow '${id}' requires ${min} permission`, code: 'workflow_forbidden' },
    403,
  )
  return true
}

/**
 * P2-M5b — seed the creator as the workflow's owner after import / draft.
 * Only when RBAC is wired AND the actor is a v4 user: a v3-admin operator has
 * no user row to own it (operators manage by bypass, not by grant). Best-effort
 * — a grant-seed hiccup must never fail the create that already succeeded.
 */
function seedWorkflowOwner(
  ctx: WorkflowRoutesCtx,
  req: IncomingMessage,
  workflowId: string,
): void {
  if (!ctx.grants || !ctx.resolveActor) return
  const actor = ctx.resolveActor(req)
  if (!actor.userId) return
  try {
    ctx.grants.setWorkflowGrant({
      workflowId,
      userId: actor.userId,
      perm: 'owner',
      grantedBy: actor.userId,
    })
  } catch {
    // best-effort — see jsdoc.
  }
}

/**
 * P2-M2 — route action → audit action string. Web has no `@aipehub/identity`
 * runtime dep, so these mirror the `AUDIT_ACTIONS.WORKFLOW_*` literals (same
 * pattern as setup-routes' `'setup_owner_created'`). Only governance-significant
 * transitions appear here; `review` / `draft` (back-to-draft) are authoring
 * churn and deliberately absent → no audit row.
 */
const WORKFLOW_AUDIT_ACTION: Readonly<Record<string, string>> = {
  publish: 'workflow_publish',
  deprecate: 'workflow_deprecate',
  archive: 'workflow_archive',
  rollback: 'workflow_rollback',
}

/**
 * P2-M2 — write one governance row for a workflow lifecycle transition.
 * Best-effort and structurally optional (mirrors identity-routes' `tryAudit`):
 * a host without an audit sink, or one whose identity surface predates
 * V4-AUDIT-06, silently skips. The metadata pins the workflow id + the
 * revision new runs now bind to, so the row answers "what changed to which
 * revision". Admin actions arrive through the session-backed SPA → actorSource
 * `'v4-session'`. An audit-insert fault must NEVER fail the transition itself.
 */
function auditWorkflowTransition(
  ctx: WorkflowRoutesCtx,
  admin: AdminRecord,
  action: string,
  summary: WorkflowSummary,
): void {
  if (typeof ctx.audit?.writeAuditLog !== 'function') return
  try {
    ctx.audit.writeAuditLog({
      action,
      actorSource: 'v4-session',
      actorUserId: admin.id,
      metadata: {
        workflowId: summary.id,
        revision: summary.currentRevision ?? null,
        state: summary.state ?? null,
      },
      success: true,
    })
  } catch {
    // best-effort; see jsdoc — never mask the (already-succeeded) transition.
  }
}
