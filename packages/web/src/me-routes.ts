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
  /**
   * v5 D-M4 — read-only "this helper wakes itself on a cadence" indicator.
   * Only the `enabled` flag crosses over — the interval and (especially) the
   * checklist stay host-side, since a checklist can carry standing instructions.
   */
  heartbeat?: { enabled: boolean }
}

export interface MeAgentListSurface {
  /** All host-managed agents, sanitized. Same view for every member. */
  listForMembers(): Promise<MeAgentView[]>
}

// ---------------------------------------------------------------------------
// Member agent ownership + self-service CRUD (v5 A-M2)
//
// "I can build and manage MY OWN helpers", distinct from the read-only
// directory above (every helper I'm allowed to talk to). Ownership lives in
// the identity `resource_grants` table (kind='agent', perm='owner') — NOT a
// field on the agent record — so the one grant model (v5 #3) covers it.
//
// The HOST owns every privileged decision: it composes the real participant id
// from the SESSION userId (`me.<userId>.<handle>` — a member can't squat or
// guess another member's namespace, the same "scope from the session, never a
// client value" rule the uploads surface uses), enforces ownership on every
// edit/delete, constrains the provider to ones it already has a key for, and
// records / clears the owner grant. The web layer only shape-checks the body.
//
// A member's own-agent view MAY include the system prompt + model: they wrote
// it, and they need it to edit. The per-agent API key is never set by a member
// (that's a credential — A-M3) and never crosses the wire either way.
// ---------------------------------------------------------------------------

/** A member's view of an agent they OWN (richer than the sanitized directory). */
export interface MeOwnedAgentView {
  id: string
  label: string
  capabilities: string[]
  online: boolean
  provider: string
  model?: string
  /** The system prompt — visible because the member owns + edits this agent. */
  system: string
  createdAt: string
}

/** Shape-checked member create/update body (the raw `id` is a short handle). */
export interface MeAgentInput {
  id: string
  label: string
  capabilities: string[]
  system: string
  provider: string
  model?: string
}

export interface MeAgentAdminSurface {
  /** Providers this member may pick — the host's org/workspace/env keys plus
   * any the member brought their OWN key for (A-M3), so a personal-hub user
   * who added their key sees a real provider, not just 'mock'. */
  availableProviders(userId: string): Promise<string[]>
  /** Agents owned by `userId` (perm='owner' grant) that still exist. */
  listOwned(userId: string): Promise<MeOwnedAgentView[]>
  /**
   * Read one agent's full config — the read FLOOR of the grant ladder
   * (P1-M1c): `userId` must hold at least 'viewer'. Throws (status 403/404)
   * otherwise, so a viewer grant is real (read-only) and a non-grantee can't
   * enumerate ids.
   */
  read(userId: string, agentId: string): Promise<MeOwnedAgentView>
  /** Create an agent owned by `userId`; host composes the namespaced id. */
  create(userId: string, input: MeAgentInput): Promise<MeOwnedAgentView>
  /** Edit an agent `userId` owns. Throws (status 403/404) otherwise. */
  update(
    userId: string,
    agentId: string,
    input: Partial<Omit<MeAgentInput, 'id'>>,
  ): Promise<MeOwnedAgentView>
  /** Delete an agent `userId` owns. Throws (status 403/404) otherwise. */
  remove(userId: string, agentId: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Member agent access-grant surface (v5 A-M4)
//
// An agent's OWNER shares it with other principals via the unified
// resource_grants table (A-M1): grant a user / agent / peer-hub viewer /
// editor / owner. Granting another USER 'owner' is co-ownership — they can
// then manage the agent from their own /me (the CRUD surface enforces owner).
// viewer / editor are recorded for when finer agent-level enforcement lands;
// today only 'owner' is enforced, so 'owner' is the immediately functional
// level and the others are forward-looking data.
//
// Every privileged decision is the host's: the caller must already OWN the
// agent (else 404, no enumeration), the host parses + validates the principal,
// and refuses any mutation that would ORPHAN the resource (leave it with zero
// owners). The web layer only shape-checks the body and maps status-coded
// errors to HTTP — it never imports identity, so the principal arrives as
// plain { principalKind, principalId } strings and the host narrows them.
// ---------------------------------------------------------------------------

/** One access grant on a resource, as a member's client sees it. */
export interface MeGrantView {
  principalKind: string
  principalId: string
  perm: string
  /** principalKey ("<kind>:<id>") — the client passes this back verbatim on DELETE. */
  principalKey: string
  /** Who wrote the grant (a userId or principalKey); null = system seed. */
  grantedBy: string | null
  grantedAt: number
  /** True when this grant is the calling member's own (the UI marks + protects it). */
  isSelf: boolean
}

/** Shape-checked grant-set body. */
export interface MeGrantInput {
  principalKind: string
  principalId: string
  perm: string
}

export interface MeAgentGrantsSurface {
  /** All grants on an agent `userId` owns, oldest-first. Throws (404) if not owned. */
  list(userId: string, agentId: string): Promise<MeGrantView[]>
  /** Upsert a grant on an agent `userId` owns. Throws on not-owned / orphan / bad input. */
  set(userId: string, agentId: string, input: MeGrantInput): Promise<MeGrantView>
  /** Remove a grant by principalKey. Throws on not-owned / orphan; false if absent. */
  remove(userId: string, agentId: string, principalKey: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Member API-credential surface (v5 A-M3)
//
// A member manages THEIR OWN LLM API keys ("bring your own key"). Keys live in
// the identity vault with ownerKind='user'/ownerId=<caller> and are consumed by
// the member's own agents (A-M2) via the per-user fallback (A-M3a). The web
// layer only shape-checks + maps errors; every privileged decision (encryption,
// ownership on delete, provider allow-list) stays in the host surface. The
// SECRET is never returned — only metadata.
// ---------------------------------------------------------------------------

/** A member's view of one of their own stored credentials — never the secret. */
export interface MeCredentialView {
  id: string
  provider: string
  label: string | null
  createdAt: number
  lastUsedAt: number | null
}

/** Shape-checked member credential create body. */
export interface MeCredentialInput {
  provider: string
  apiKey: string
  label?: string
}

export interface MeCredentialsSurface {
  /** Providers a member may store a raw key for (the picker's options). */
  providers(): Promise<string[]>
  /** The caller's own stored credentials (metadata only). */
  list(userId: string): Promise<MeCredentialView[]>
  /** Store a new key owned by `userId`. Returns the metadata view (no secret). */
  create(userId: string, input: MeCredentialInput): Promise<MeCredentialView>
  /** Revoke one of `userId`'s OWN credentials. Throws (status 404) otherwise. */
  remove(userId: string, credentialId: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Member butler-memory privacy view (Personal Butler M6c — 被遗忘权)
//
// "What does my butler remember about me?" A member sees their butler's
// distilled profile (semantic) + recently captured turns (episodic), can
// FORGET one entry or everything (right to be forgotten), and EXPORT the lot
// (data portability). Every op is scoped to the SESSION userId server-side —
// the per-user memory namespace (openButlerMemory) is the no-leak boundary, so
// a member can only ever see / erase their OWN butler's memory.
// ---------------------------------------------------------------------------

/** One remembered entry as the member sees it — content + when + tiering tags. */
export interface ButlerMemoryView {
  id: string
  /** 'episodic' (a captured turn) or 'semantic' (a distilled fact). */
  kind: string
  text: string
  /** Epoch ms when written. */
  ts: number
  /**
   * Tiering projection (decision ③), all optional so a flat entry is unchanged:
   *   - `tier`       the topic cluster id (persona / projects / … / misc)
   *   - `level`      'digest' (mid layer) or 'profile' (stable layer)
   *   - `importance` 1–5 salience
   * These let the privacy panel show the member WHICH cluster a fact lives in
   * and HOW important the butler rated it — same right-to-inspect as the text.
   */
  tier?: string
  level?: string
  importance?: number
  /**
   * Long-term memory projection (decisions E/F/G/D), all optional so a plain
   * fact is unchanged — the member's right to inspect extends to HOW the butler
   * organizes a memory over time, not just its text:
   *   - `links`       (E) ids of related entries the butler cross-linked
   *   - `recallCount` (F) how many times this fact has been recalled
   *   - `lastRecalled`(F) epoch ms it was last recalled
   *   - `form`        (G) 'procedure' when it's a remembered how-to
   *   - `steps`       (G) the procedure's ordered steps
   *   - `validFrom` / `validTo` (D) the fact's validity interval (epoch ms)
   *   - `active`      (D) whether it is in effect right now — only attached for
   *                   bitemporal facts (a `validFrom`/`validTo` is set), so a
   *                   legacy "always true" fact shows no validity badge
   */
  links?: string[]
  recallCount?: number
  lastRecalled?: number
  form?: string
  steps?: string[]
  validFrom?: number
  validTo?: number
  active?: boolean
}

/** What the privacy panel shows: the distilled profile + recent captured turns. */
export interface ButlerMemorySnapshot {
  /** Semantic entries — the durable "what the butler knows about me". */
  profile: ButlerMemoryView[]
  /** Episodic entries — recently captured turns, newest first. */
  recent: ButlerMemoryView[]
}

export interface ButlerMemorySurface {
  /** The caller's own butler memory: profile + recent captures. */
  read(userId: string): Promise<ButlerMemorySnapshot>
  /** Every entry the caller's butler remembers (for export / portability). */
  export(userId: string): Promise<ButlerMemoryView[]>
  /** Forget one entry by id. Returns false if it wasn't there. */
  forget(userId: string, id: string): Promise<boolean>
  /** Forget EVERYTHING the butler remembers about this member (被遗忘权). */
  forgetAll(userId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Member IM-binding surface (GO-LIVE GL-1c)
//
// Lets a member link THEIR OWN IM account (Telegram, …): mint a one-time
// binding code here, DM the bot `/bind <code>`, and from then on their IM
// messages dispatch as that member. The host (HostMeImService) owns every
// privileged decision — issuance/list are scoped to the session userId, revoke
// is gated on ownership (404 otherwise, anti-enumeration). There is no secret
// to project: a binding is just (platform, platformUserId) → this member.
// ---------------------------------------------------------------------------

/** One of the caller's own IM bindings (no secret — a binding has none). */
export interface MeImBindingView {
  platform: string
  platformUserId: string
  displayName: string | null
  /** Unix ms (matches the identity store's native timestamp shape). */
  createdAt: number
}

/** A freshly minted one-time binding code (single-use, short-lived). */
export interface MeImCodeView {
  code: string
  /** Unix ms; the code is rejected on claim once `expiresAt < now`. */
  expiresAt: number
}

export interface MeImSurface {
  /** Whether an IM bridge is actually running (pure UI hint for the panel). */
  enabled(): boolean
  /** The caller's own IM bindings. */
  listBindings(userId: string): Promise<MeImBindingView[]>
  /** Mint a one-time binding code owned by `userId`. Rotates the prior one. */
  issueCode(userId: string): Promise<MeImCodeView>
  /** Disconnect one of `userId`'s OWN bindings. Throws (status 404) otherwise. */
  removeBinding(userId: string, platform: string, platformUserId: string): Promise<boolean>
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
  /** inbox-gov M2 — the most recent handoff note, shown to the new assignee. */
  handoffNote?: string
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

// ---------------------------------------------------------------------------
// WFEDIT — member natural-language workflow editing (the `/me` OpenClaw-style
// editor) with the cross-hub 出入口 locked. Duck-typed so web carries no host
// runtime dep: the host's `MeWorkflowEditService` satisfies these structurally.
// The boundary (`trigger` + cross-hub `egress`) is surfaced verbatim so the UI
// can render the "🔒 跨 hub 出入口(锁住)" notice; `violations` lists exactly
// what a rejected edit tried to change.
// ---------------------------------------------------------------------------

/** The governed cross-hub boundary of a workflow — the part a member can't change. */
export interface MeWorkflowBoundaryView {
  /** Ingress: the trigger capability. */
  trigger: string
  /** Egress: each cross-hub hop with its data classes (empty ⇒ purely local). */
  egress: Array<{ stepId: string; capability: string; dataClasses: string[] }>
}

/** One reason an edit was rejected for touching the cross-hub boundary. */
export interface MeWorkflowBoundaryViolationView {
  kind: string
  stepId?: string
  /** Human-readable (zh) explanation, shown to the member verbatim. */
  detail: string
}

export type MeWorkflowEditableResult =
  | {
      ok: true
      workflowId: string
      state: string
      /** False for archived / under-review workflows — the UI disables the box. */
      editable: boolean
      yaml: string
      boundary: MeWorkflowBoundaryView
      crossHub: boolean
    }
  | { ok: false; reason: string; message: string }

export type MeWorkflowEditResult =
  | {
      ok: true
      state: string
      applied: 'published' | 'draft'
      yaml: string
      explanation: string
      boundary: MeWorkflowBoundaryView
      /**
       * WFEDIT-D1 — line diff pre-edit → persisted YAML (`same`/`add`/`del`),
       * rendered by the member editor as "这次改了什么". Echoed verbatim.
       */
      diff?: Array<{ kind: string; text: string }>
      deepCheck?: unknown
    }
  | {
      ok: false
      reason: string
      message: string
      violations?: MeWorkflowBoundaryViolationView[]
      detail?: string
      draftStatus?: string
    }

export interface MeWorkflowEditSurface {
  /** Current YAML + governed boundary + crossHub flag (editor-gated server-side). */
  editableView(workflowId: string, userId: string): Promise<MeWorkflowEditableResult>
  /** Apply a member NL edit, boundary-locked + structure-gated (editor-gated server-side). */
  edit(args: {
    workflowId: string
    instruction: string
    userId: string
    /** WFEDIT-D3 — prior turns of this edit session (client-held; host re-sanitizes + caps). */
    history?: Array<{ instruction: string; outcome?: string }>
    /** WFEDIT-D4 — live LLM chunks of THIS edit (host routes them per-call; absent ⇒ no streaming). */
    onChunk?: (chunk: string) => void
  }): Promise<MeWorkflowEditResult>
}

// ---------------------------------------------------------------------------
// ARCH-M6 — member workflow AUTHORING ("工作流架构师" from the /me side). The
// sibling of `MeWorkflowEditSurface`: that one RESHAPES an existing workflow;
// this one CREATES a brand-new one from plain language, and EXPLAINS any
// catalog workflow at an adjustable depth (with its flowchart). Duck-typed so
// the web layer takes NO runtime dep on the host — the host's
// `MeWorkflowCreateService` satisfies it. `graph` / `deepCheck` ride through as
// `unknown` (verbatim echo, same discipline as the editor's `deepCheck` and the
// steward's `action`); the client renders the DAG SVG from `graph`.
// ---------------------------------------------------------------------------

/**
 * ARCH-M6 — the architect's depth levels, mirrored locally so the web layer
 * takes NO runtime dep on `@aipehub/workflow-assistant`. Same duck-typing
 * discipline as the rest of this surface (e.g. `WorkflowGraphView` echoed as
 * `unknown`). Kept narrow so the host's `MeWorkflowCreateRequest.detail`
 * (`WorkflowDetailLevel`) is assignable into the surface contract under
 * `strictFunctionTypes`.
 */
export type MeWorkflowDetailLevel = 'oneliner' | 'brief' | 'detailed'

export type MeWorkflowCreateResult =
  | {
      ok: true
      /** The id of the freshly-created draft. */
      workflowId: string
      /** The YAML now persisted as a draft. */
      yaml: string
      /** The architect's plain-language summary (depth follows `detail`). */
      explanation: string
      /** DAG projection — the inline/downloadable flowchart. Echoed verbatim. */
      graph?: unknown
      /** Advisory deep-check (unknown agent/capability warnings). Echoed verbatim. */
      deepCheck?: unknown
    }
  | {
      ok: false
      reason: string
      message: string
      detail?: string
      draftStatus?: string
    }

export type MeWorkflowExplainResult =
  | {
      ok: true
      workflowId: string
      /** The workflow's YAML (explain mode never regenerates it). */
      yaml: string
      explanation: string
      /** The depth used ('oneliner' | 'brief' | 'detailed'). */
      detail: string
      graph?: unknown
      deepCheck?: unknown
    }
  | { ok: false; reason: string; message: string; detail?: string }

export interface MeWorkflowCreateSurface {
  /**
   * Author a brand-new workflow from a member's plain-language description. The
   * host drafts it + seeds the member as owner; a workflow with any cross-hub
   * egress hop is rejected (members are local-only). The editing/creating userId
   * is server-forced (the route passes the session user).
   */
  create(args: {
    instruction: string
    userId: string
    /** Explanation depth — 'oneliner' | 'brief' | 'detailed'. Default brief. */
    detail?: MeWorkflowDetailLevel
    /** Prior turns of this authoring conversation (client-held; host re-sanitizes + caps). */
    history?: Array<{ instruction: string; outcome?: string }>
    /** Live LLM chunks of THIS call (host routes them per-call; absent ⇒ no streaming). */
    onChunk?: (chunk: string) => void
  }): Promise<MeWorkflowCreateResult>
  /**
   * Narrate an existing workflow at an adjustable depth (plus its flowchart).
   * The route gates VISIBILITY via `resolveMeWorkflow` before calling this, so
   * the host executor only fetches the YAML + runs the architect in explain mode.
   */
  explain(args: {
    workflowId: string
    userId: string
    detail?: MeWorkflowDetailLevel
    /** Optional focus question for the narration. */
    focus?: string
    onChunk?: (chunk: string) => void
  }): Promise<MeWorkflowExplainResult>
}

// ---------------------------------------------------------------------------
// SW-M6 — the hub steward ("管家"). A member manages THEIR OWN agents +
// workflows by talking to it in plain language. Duck-typed so the web layer
// takes NO runtime dep on `@aipehub/hub-steward` (mirroring InboxSurface /
// MeWorkflowEditSurface); the host's `HubStewardSurface` satisfies it.
//
//   - `plan`  turns one instruction into a classified proposal with ZERO side
//             effects — the member previews it, then applies the actions they
//             accept;
//   - `apply` executes ONE accepted action. The action rides as `unknown`: the
//             HOST surface is the validation + classification authority
//             (`validateStewardAction` + re-tiering), so web forwards it
//             verbatim and never trusts the client's tier. Dangerous / cross-hub
//             actions route to the approval inbox (the user's two hard
//             constraints — 「跨 hub + 危险动作都再次确认」).
// ---------------------------------------------------------------------------

/** One proposed action + the HOST-assigned tier + a member-readable summary. */
export interface MeHubStewardClassifiedAction {
  /** The raw action object — echoed verbatim back on `apply`. */
  action: unknown
  /** 'safe' | 'dangerous' | 'cross_hub' | 'forbidden' (host-authoritative). */
  tier: string
  summary: string
}

export interface MeHubStewardPlanResult {
  reply: string
  actions: MeHubStewardClassifiedAction[]
}

/** What `apply` resolves to — each variant carries its own `status` so the UI
 *  branches without inspecting an HTTP code (only `invalid` is an HTTP error). */
export type MeHubStewardApplyResult =
  | { status: 'done'; tier: string; result: unknown }
  | { status: 'refused'; reason: string }
  | { status: 'invalid'; reason: string }
  | { status: 'pending_approval'; tier: string; inboxItemId: string }
  | { status: 'needs_approval'; tier: string }

/**
 * One turn of a steward conversation the SPA echoes back for multi-step
 * follow-ups. From Phase C a turn may carry the STRUCTURED outcome of the action
 * it applied (`result`); the host folds that into a fixed-format `[执行结果] …`
 * line so the next proposal builds on what already ran. The web only
 * shape-coerces — the host service whitelists `result.kind`/`status` against the
 * real action enum and clips, so a forged result can never inject free narrative
 * (only host-rendered text from a whitelisted kind/status/subject reaches the
 * prompt).
 */
export interface StewardHistoryTurn {
  role: 'user' | 'assistant'
  content: string
  result?: { kind: string; status: string; subject?: string }
}

export interface MeHubStewardSurface {
  /** Propose: ZERO side effects. Throws iff the underlying dispatch failed. */
  plan(input: {
    userId: string
    instruction: string
    /** Prior turns of this steward conversation (multi-step follow-ups). */
    history?: StewardHistoryTurn[]
  }): Promise<MeHubStewardPlanResult>
  /** Apply ONE accepted action (validated + re-classified server-side). */
  apply(input: { userId: string; action: unknown }): Promise<MeHubStewardApplyResult>
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
   * v5 A-M2 — member agent ownership + self-service CRUD. Undefined when the
   * host wired no identity (ownership grants live in identity); the
   * create/list-owned/update/delete routes then return 503.
   */
  meAgentAdmin: MeAgentAdminSurface | undefined
  /**
   * v5 A-M4 — member agent access-grant management (an owner shares their agent
   * with other principals). Undefined when the host wired no identity (grants
   * live in identity); the grant routes then return 503 (empty list on GET).
   */
  meAgentGrants: MeAgentGrantsSurface | undefined
  /**
   * v5 A-M3 — member API-credential ("bring your own key") management.
   * Undefined when the host wired no identity/vault; the credential routes
   * then return 503 (and an empty list on GET).
   */
  meCredentials: MeCredentialsSurface | undefined
  /**
   * Personal Butler M6c — the member's butler-memory privacy view ("what does
   * my butler remember about me", forget / export). Undefined when the host
   * wired no butler memory; the /api/me/butler/memory routes then degrade to an
   * empty snapshot (GET) / 503 (mutations).
   */
  butlerMemory: ButlerMemorySurface | undefined
  /**
   * GO-LIVE GL-1c — member IM-account linking. Undefined when the host wired no
   * identity; the /api/me/im routes then return 503 (empty list on GET).
   */
  meIm: MeImSurface | undefined
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
  /**
   * WFEDIT — member natural-language workflow editing. Undefined when the host
   * wired no edit service (no AI assistant key / not wired); the
   * `/api/me/workflows/:id/{editable,edit}` routes then return 503.
   */
  workflowEdit: MeWorkflowEditSurface | undefined
  /**
   * ARCH-M6 — member natural-language workflow AUTHORING (新建) + member EXPLAIN.
   * Undefined when the host wired no create service (no AI assistant key /
   * identity); the `/api/me/workflows/create` and `/api/me/workflows/:id/explain`
   * routes then return 503. The architect drafts a member-owned, local-only
   * workflow; explain narrates any catalog-visible workflow at depth.
   */
  workflowCreate: MeWorkflowCreateSurface | undefined
  /**
   * SW-M6 — the hub steward ("管家"). Undefined when the host wired no steward
   * service (disabled, or no LLM key for the configured provider); the
   * `/api/me/steward/{plan,apply}` routes then return 503 so the member UI can
   * hide the 管家 panel.
   */
  hubSteward: MeHubStewardSurface | undefined
  /**
   * ease-of-use ①TC-ME — member "test connection" probe for a BYO key. Same
   * object the setup/admin probe uses (server.ts `ctx.llmKeyTest`), inlined here
   * as a narrow duck-type to avoid a me-routes ↔ server import cycle. Undefined
   * when the host wired no key-test surface; `POST /api/me/test-llm-key` then
   * returns 503. The member route restricts `provider` to the BYO set
   * (anthropic/openai) and never forwards a baseURL, so this carries NO
   * arbitrary-endpoint (SSRF) surface — strictly safer than the admin probe.
   */
  llmKeyTest:
    | {
        testLlmKey(input: {
          provider: string
          apiKey: string
          baseURL?: string
          model?: string
        }): Promise<{
          ok: boolean
          model: string
          latencyMs: number
          code?: string
          message?: string
        }>
      }
    | undefined
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
  // WFEDIT — member natural-language workflow editing. The catalog GET above is
  // an EXACT match, so these `/:id/{editable,edit}` sub-paths never collide.
  // `editable` returns the current YAML + the locked cross-hub boundary; `edit`
  // applies a plain-language change with the 出入口 locked. Both are editor-gated
  // by the host service (the route just forwards the session userId).
  {
    const ed = /^\/api\/me\/workflows\/([^/]+)\/editable$/.exec(path)
    if (ed && method === 'GET') {
      await handleMeWorkflowEditable(ctx, res, userId, decodeURIComponent(ed[1]!))
      return
    }
    // ARCH-M6 — member workflow AUTHORING. `create` is an EXACT path (POST): none
    // of the `/:id/{editable,edit,explain}` regexes match a bare `/create`, so it
    // never collides. The architect drafts a member-owned, local-only workflow.
    if (method === 'POST' && path === '/api/me/workflows/create') {
      await handleMeWorkflowCreate(ctx, req, res, userId)
      return
    }
    const edit = /^\/api\/me\/workflows\/([^/]+)\/edit$/.exec(path)
    if (edit && method === 'POST') {
      await handleMeWorkflowEdit(ctx, req, res, userId, decodeURIComponent(edit[1]!))
      return
    }
    // ARCH-M6 — member EXPLAIN: narrate a catalog workflow at depth + its
    // flowchart. Visibility-gated by the caller's role (handler runs
    // `resolveMeWorkflow` first), so a member can only explain what they can see.
    const explain = /^\/api\/me\/workflows\/([^/]+)\/explain$/.exec(path)
    if (explain && method === 'POST') {
      await handleMeWorkflowExplain(ctx, req, res, userId, v4.role, decodeURIComponent(explain[1]!))
      return
    }
  }
  // SW-M6 — the hub steward ("管家"): a member manages THEIR OWN agents +
  // workflows by talking to it. `plan` proposes (zero side effects); `apply`
  // executes ONE accepted action, validated + re-classified server-side, routing
  // dangerous / cross-hub actions to the approval inbox (the two hard
  // constraints). Both are exact-path POSTs, so they never collide.
  if (method === 'POST' && path === '/api/me/steward/plan') {
    await handleMeStewardPlan(ctx, req, res, userId)
    return
  }
  if (method === 'POST' && path === '/api/me/steward/apply') {
    await handleMeStewardApply(ctx, req, res, userId)
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
  // v5 A-M2 — member agent ownership + self-service CRUD. These sit on the
  // SAME /api/me/agents path family but are guarded by exact path / method, so
  // the directory GET above is unaffected.
  if (method === 'GET' && path === '/api/me/agents/providers') {
    await handleMeAgentProviders(ctx, res, userId)
    return
  }
  if (method === 'GET' && path === '/api/me/agents/owned') {
    await handleMeListOwnedAgents(ctx, res, userId)
    return
  }
  if (method === 'POST' && path === '/api/me/agents') {
    await handleMeCreateAgent(ctx, req, res, userId)
    return
  }
  {
    const m = /^\/api\/me\/agents\/([^/]+)$/.exec(path)
    // GET is the read floor (viewer+); the exact /owned + /providers GETs are
    // matched above, so this single-segment pattern only catches real ids.
    if (m && method === 'GET') {
      await handleMeReadAgent(ctx, res, userId, decodeURIComponent(m[1]!))
      return
    }
    if (m && method === 'PUT') {
      await handleMeUpdateAgent(ctx, req, res, userId, decodeURIComponent(m[1]!))
      return
    }
    if (m && method === 'DELETE') {
      await handleMeDeleteAgent(ctx, res, userId, decodeURIComponent(m[1]!))
      return
    }
  }
  // ease-of-use ②TC-ME — quick-chat to an agent the member can access. The
  // extra `/chat` segment means the single-segment CRUD regex above never
  // catches it. Mirror of the admin post-create quick-chat, but member-scoped
  // (ownership gate = meAgentAdmin.read) and synchronous (waits for the reply
  // so the UI can render it).
  {
    const chat = method === 'POST' ? /^\/api\/me\/agents\/([^/]+)\/chat$/.exec(path) : null
    if (chat) {
      await handleMeChatAgent(ctx, req, res, userId, decodeURIComponent(chat[1]!))
      return
    }
  }
  // v5 A-M4 — agent access grants: the owner shares their agent with other
  // principals (user / agent / peer-hub) at viewer / editor / owner. These have
  // an extra `/grants` segment, so the single-segment CRUD regex above never
  // swallows them. The DELETE principalKey is URL-encoded (ids may hold colons).
  {
    const list = method === 'GET' ? /^\/api\/me\/agents\/([^/]+)\/grants$/.exec(path) : null
    if (list) {
      await handleMeListAgentGrants(ctx, res, userId, decodeURIComponent(list[1]!))
      return
    }
    const create = method === 'POST' ? /^\/api\/me\/agents\/([^/]+)\/grants$/.exec(path) : null
    if (create) {
      await handleMeSetAgentGrant(ctx, req, res, userId, decodeURIComponent(create[1]!))
      return
    }
    const del =
      method === 'DELETE' ? /^\/api\/me\/agents\/([^/]+)\/grants\/([^/]+)$/.exec(path) : null
    if (del) {
      await handleMeRemoveAgentGrant(
        ctx,
        res,
        userId,
        decodeURIComponent(del[1]!),
        decodeURIComponent(del[2]!),
      )
      return
    }
  }
  // v5 A-M3 — member API credentials ("bring your own key"). GET returns the
  // caller's own stored keys (metadata only) + the allowable providers; POST
  // stores a new key; DELETE revokes one the caller owns. All scoped to the
  // session userId server-side.
  if (method === 'GET' && path === '/api/me/credentials') {
    await handleMeListCredentials(ctx, res, userId)
    return
  }
  if (method === 'POST' && path === '/api/me/credentials') {
    await handleMeCreateCredential(ctx, req, res, userId)
    return
  }
  {
    const m = /^\/api\/me\/credentials\/([^/]+)$/.exec(path)
    if (m && method === 'DELETE') {
      await handleMeDeleteCredential(ctx, res, userId, decodeURIComponent(m[1]!))
      return
    }
  }
  // Personal Butler M6c — "what does my butler remember about me" privacy view.
  // GET reads the profile + recent captures; GET .../export returns everything
  // (data portability); DELETE one entry or all (right to be forgotten). All
  // scoped to the session userId server-side — a member sees only THEIR butler.
  if (method === 'GET' && path === '/api/me/butler/memory') {
    await handleMeButlerMemoryRead(ctx, res, userId)
    return
  }
  if (method === 'GET' && path === '/api/me/butler/memory/export') {
    await handleMeButlerMemoryExport(ctx, res, userId)
    return
  }
  if (method === 'DELETE' && path === '/api/me/butler/memory') {
    await handleMeButlerMemoryForgetAll(ctx, res, userId)
    return
  }
  {
    const m = /^\/api\/me\/butler\/memory\/([^/]+)$/.exec(path)
    if (m && method === 'DELETE') {
      await handleMeButlerMemoryForget(ctx, res, userId, decodeURIComponent(m[1]!))
      return
    }
  }
  // ease-of-use ①TC-ME — "test connection" for a BYO key BEFORE the member
  // saves it (mirror of the setup-wizard / admin probe, member-scoped). Sends
  // ONE tiny request with the typed key; nothing is stored. Restricted to the
  // providers a member may bring (anthropic/openai), and no baseURL is ever
  // forwarded, so there's no arbitrary-endpoint / SSRF surface — the
  // operator probe (with baseURL) stays admin-only.
  if (method === 'POST' && path === '/api/me/test-llm-key') {
    await handleMeTestLlmKey(ctx, req, res, userId)
    return
  }
  // GO-LIVE GL-1c — member IM-account linking. GET returns whether a bridge is
  // running + the caller's own bindings; POST mints a one-time binding code the
  // member DMs to the bot as `/bind <code>`; DELETE disconnects one of the
  // caller's OWN bindings. All scoped to the session userId server-side.
  if (method === 'GET' && path === '/api/me/im') {
    await handleMeListIm(ctx, res, userId)
    return
  }
  if (method === 'POST' && path === '/api/me/im/binding-code') {
    await handleMeIssueImCode(ctx, res, userId)
    return
  }
  {
    const m = /^\/api\/me\/im\/bindings\/([^/]+)\/([^/]+)$/.exec(path)
    if (m && method === 'DELETE') {
      await handleMeRemoveImBinding(
        ctx,
        res,
        userId,
        decodeURIComponent(m[1]!),
        decodeURIComponent(m[2]!),
      )
      return
    }
  }
  // Phase 19 P1-M4 — member file uploads. POST writes under the caller's
  // per-user scope; GET serves back ONLY artifacts under that scope (a member
  // can't read another user's upload). Both derive the scope from the session
  // userId, never a client value.
  if (path === '/api/me/uploads' && (method === 'POST' || method === 'GET')) {
    await handleMeUploads(ctx, req, res, userId, method)
    return
  }
  // Route B P1-M3e — MFA (TOTP) self-service. A member manages their OWN second
  // factor; userId/email come from the session, never a client value. Enroll
  // mints a pending secret (QR payload), confirm activates it with a current
  // code, disable turns it off (an ACTIVE factor needs a current code so a
  // hijacked session alone can't strip 2FA; a PENDING enrollment can just be
  // cancelled). Admin-forced MFA / admin reset / recovery codes are later work.
  if (method === 'GET' && path === '/api/me/totp') {
    await handleMeTotpState(ctx, res, userId)
    return
  }
  if (method === 'POST' && path === '/api/me/totp/enroll') {
    await handleMeTotpEnroll(ctx, res, userId, v4.user.email)
    return
  }
  if (method === 'POST' && path === '/api/me/totp/confirm') {
    await handleMeTotpConfirm(ctx, req, res, userId)
    return
  }
  if (method === 'POST' && path === '/api/me/totp/disable') {
    await handleMeTotpDisable(ctx, req, res, userId)
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
  if (!checkMeRateLimit(ctx, userId, 'me-dispatch')) {
    sendRateLimited(res, 'too many dispatches; try again in a minute')
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

/**
 * Per-user application-layer rate limit for an expensive AUTHENTICATED action
 * (Route B P1-M2). The /me endpoints that fan out to LLM agents share one
 * budget bucket PER ACTION + per user, so a member can't loop one endpoint to
 * burn the host's API quota / agent-pool capacity. Keyed on userId (not IP) so
 * a NAT'd office isn't punished collectively.
 *
 * Returns true if the hit is allowed (and records it via `check()`). On
 * rejection it is fail-closed AND observable: a best-effort `rate_limited`
 * audit row is written so an operator can SEE a member hitting the cap, then
 * false is returned and the caller sends 429. Before P1-M2 the reject was
 * silent — fail-closed, but invisible.
 */
function checkMeRateLimit(ctx: HandleMeRouteCtx, userId: string, action: string): boolean {
  if (ctx.loginLimiter.check(`${action}:${userId}`)) return true
  // 'rate_limited' is identity's AUDIT_ACTIONS.RATE_LIMITED — kept as a literal
  // because the web layer carries no runtime identity dep (the test pins the
  // two together by asserting against the constant). Best-effort: a fault in
  // the audit write must never change the 429 the caller is about to send.
  try {
    ctx.identity.writeAuditLog?.({
      action: 'rate_limited',
      actorSource: 'v4-session',
      actorUserId: userId,
      success: false,
      metadata: { action, scope: 'me' },
    })
  } catch {
    /* swallow — observability is best-effort, the limit still holds */
  }
  return false
}

/** Typed 429 for a member rate-limit reject (keeps the retry-after header). */
function sendRateLimited(res: ServerResponse, message: string): void {
  res.writeHead(429, {
    'content-type': 'application/json; charset=utf-8',
    'retry-after': '60',
  })
  res.end(JSON.stringify({ error: message, code: 'rate_limited' }))
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
  if (!checkMeRateLimit(ctx, userId, 'me-inbox-resolve')) {
    sendRateLimited(res, 'too many inbox resolves; try again in a minute')
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
  if (!checkMeRateLimit(ctx, userId, 'me-inbox-delegate')) {
    sendRateLimited(res, 'too many inbox delegations; try again in a minute')
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

/**
 * Map a host edit-service `reason` to an HTTP status. Kept as a string switch
 * (web carries no host runtime dep) — the host enum and these literals are
 * pinned together by the route test. `boundary_locked` is a 409 (a conflict
 * with the governed contract), the assistant/parse/structure failures are 422
 * (the request was understood but couldn't produce a valid workflow), and an
 * unavailable assistant is 503 (transient, retry later).
 */
function statusForEditReason(reason: string): number {
  switch (reason) {
    case 'forbidden':
      return 403
    case 'not_found':
      return 404
    case 'no_source':
    case 'under_review':
    case 'archived':
    case 'boundary_locked':
      return 409
    case 'assistant_failed':
    case 'parse_failed':
    case 'id_changed':
    case 'structure_failed':
      return 422
    case 'assistant_unavailable':
      return 503
    default:
      return 400
  }
}

/**
 * WFEDIT — `GET /api/me/workflows/:id/editable`. Returns the current authored
 * YAML + the governed cross-hub boundary + an `editable` flag, so the UI can
 * open the editor and render the "🔒 跨 hub 出入口(锁住)" notice. Editor-gated
 * server-side (the host service refuses non-editors with `forbidden`).
 */
async function handleMeWorkflowEditable(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
  workflowId: string,
): Promise<void> {
  if (!ctx.workflowEdit) {
    sendJson(res, { error: '工作流编辑暂未启用(需要 AI 助手)。', code: 'not_wired' }, 503)
    return
  }
  const r = await ctx.workflowEdit.editableView(workflowId, userId)
  if (r.ok) {
    sendJson(res, r, 200)
    return
  }
  sendJson(res, { error: r.message, code: r.reason }, statusForEditReason(r.reason))
}

/**
 * WFEDIT — `POST /api/me/workflows/:id/edit`, body `{ instruction }`. Applies a
 * plain-language change with the cross-hub 出入口 locked (boundary lock +
 * structure hard-gate live in the host service). Rate-limited like
 * `/api/me/dispatch` because each edit triggers an LLM call (the assistant).
 */
async function handleMeWorkflowEdit(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  workflowId: string,
): Promise<void> {
  if (!ctx.workflowEdit) {
    sendJson(res, { error: '工作流编辑暂未启用(需要 AI 助手)。', code: 'not_wired' }, 503)
    return
  }
  // An edit drives one assistant LLM call — same quota concern as dispatch.
  if (!checkMeRateLimit(ctx, userId, 'me-wf-edit')) {
    sendRateLimited(res, '改得太频繁了,过一会儿再试。')
    return
  }
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
    sendJson(res, { error: '请用一句话描述你想怎么改这个工作流。', code: 'bad_request' }, 400)
    return
  }
  // WFEDIT-D3 — optional conversation history. Web only shape-coerces (duck
  // discipline): keep `{instruction: string}` turns, drop the rest; the host
  // service is the authority on trimming/clipping/turn caps.
  const rawHistory = body && typeof body === 'object' ? (body as { history?: unknown }).history : undefined
  if (rawHistory !== undefined && !Array.isArray(rawHistory)) {
    sendJson(res, { error: 'history 必须是一个数组。', code: 'bad_request' }, 400)
    return
  }
  const history = (rawHistory ?? [])
    .filter(
      (t): t is { instruction: string; outcome?: unknown } =>
        !!t && typeof t === 'object' && typeof (t as { instruction?: unknown }).instruction === 'string',
    )
    .slice(-12)
    .map((t) => ({
      instruction: t.instruction,
      ...(typeof t.outcome === 'string' ? { outcome: t.outcome } : {}),
    }))
  // WFEDIT-D4 — streaming mode (body `stream: true`): NDJSON over THIS response.
  // Chunks only ever flow into the member's own request/response pair, so the
  // member-safety property ("you only see your own edit's typing") holds by
  // construction — no global stream, no taskId keying, nothing to mis-scope.
  if (body && typeof body === 'object' && (body as { stream?: unknown }).stream === true) {
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      // Some reverse proxies buffer streamed bodies unless told not to.
      'x-accel-buffering': 'no',
    })
    const writeLine = (obj: unknown) => {
      // Client may have gone away mid-stream; the edit itself must still finish
      // (publish/saveDraft are server-side effects, same as non-stream mode).
      try {
        res.write(JSON.stringify(obj) + '\n')
      } catch {
        /* ignore */
      }
    }
    let r: MeWorkflowEditResult
    try {
      r = await ctx.workflowEdit.edit({
        workflowId,
        instruction,
        userId,
        ...(history.length ? { history } : {}),
        onChunk: (chunk) => writeLine({ kind: 'chunk', text: chunk }),
      })
    } catch (err) {
      // Headers are already out as 200 — carry the failure in the result line
      // (mirrors what SSE-style endpoints do once a stream is open).
      writeLine({
        kind: 'result',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'internal',
      })
      res.end()
      return
    }
    if (r.ok) {
      writeLine({ kind: 'result', ...r })
    } else {
      // Same body shape as the non-stream error response (+ ok:false so the
      // client branches without inspecting an HTTP status it no longer has).
      writeLine({
        kind: 'result',
        ok: false,
        error: r.message,
        code: r.reason,
        ...(r.violations ? { violations: r.violations } : {}),
        ...(r.detail ? { detail: r.detail } : {}),
        ...(r.draftStatus ? { draftStatus: r.draftStatus } : {}),
      })
    }
    res.end()
    return
  }
  const r = await ctx.workflowEdit.edit({
    workflowId,
    instruction,
    userId,
    ...(history.length ? { history } : {}),
  })
  if (r.ok) {
    sendJson(res, r, 200)
    return
  }
  sendJson(
    res,
    {
      error: r.message,
      code: r.reason,
      ...(r.violations ? { violations: r.violations } : {}),
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.draftStatus ? { draftStatus: r.draftStatus } : {}),
    },
    statusForEditReason(r.reason),
  )
}

// ---------------------------------------------------------------------------
// ARCH-M6 — member workflow AUTHORING (新建) + member EXPLAIN ("工作流架构师").
// `create` authors a brand-new draft from plain language (local-only — cross-hub
// egress rejected by the host); `explain` narrates a catalog-visible workflow at
// an adjustable depth + emits its flowchart. Both server-force userId, drive an
// LLM call (rate-limited), and support per-call NDJSON streaming (same member-
// safety-by-construction as the editor: chunks only ever flow into the caller's
// own request/response pair).
// ---------------------------------------------------------------------------

const WORKFLOW_DETAIL_LEVELS = new Set<MeWorkflowDetailLevel>(['oneliner', 'brief', 'detailed'])

/** Accept only a known depth level; anything else → undefined (host default brief). */
function coerceWorkflowDetail(raw: unknown): MeWorkflowDetailLevel | undefined {
  return typeof raw === 'string' && WORKFLOW_DETAIL_LEVELS.has(raw as MeWorkflowDetailLevel)
    ? (raw as MeWorkflowDetailLevel)
    : undefined
}

/**
 * Shape-coerce an untrusted authoring `history[]` (same discipline as the edit
 * route): keep `{instruction: string}` turns (carry a string `outcome`), drop the
 * rest, clip to the last 12. The host service owns trimming / turn caps.
 */
function coerceArchitectHistory(raw: unknown): Array<{ instruction: string; outcome?: string }> {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (t): t is { instruction: string; outcome?: unknown } =>
        !!t && typeof t === 'object' && typeof (t as { instruction?: unknown }).instruction === 'string',
    )
    .slice(-12)
    .map((t) => ({
      instruction: t.instruction,
      ...(typeof t.outcome === 'string' ? { outcome: t.outcome } : {}),
    }))
}

function statusForCreateReason(reason: string): number {
  switch (reason) {
    case 'cross_hub':
    case 'id_exists':
      return 409
    case 'draft_cap':
      return 429
    case 'assistant_failed':
    case 'parse_failed':
    case 'structure_failed':
      return 422
    case 'assistant_unavailable':
      return 503
    default:
      return 400
  }
}

function statusForExplainReason(reason: string): number {
  switch (reason) {
    case 'forbidden':
      return 403
    case 'not_found':
      return 404
    case 'no_source':
      return 409
    case 'assistant_failed':
      return 422
    case 'assistant_unavailable':
      return 503
    default:
      return 400
  }
}

/**
 * ARCH-M6 — `POST /api/me/workflows/create`, body `{ instruction, detail?,
 * history?, stream? }`. Authors a brand-new workflow from plain language: the
 * host service runs the architect (author mode), REJECTS any cross-hub egress
 * (members are local-only), and saves a DRAFT owned by the member. The creating
 * userId is the SESSION user, never a client value.
 */
async function handleMeWorkflowCreate(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.workflowCreate) {
    sendJson(res, { error: '工作流新建暂未启用(需要 AI 助手)。', code: 'not_wired' }, 503)
    return
  }
  // Authoring drives one assistant LLM call — same quota concern as edit / dispatch.
  if (!checkMeRateLimit(ctx, userId, 'me-wf-create')) {
    sendRateLimited(res, '建得太频繁了,过一会儿再试。')
    return
  }
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
    sendJson(res, { error: '请用一句话描述你想要的工作流。', code: 'bad_request' }, 400)
    return
  }
  const rawHistory = body && typeof body === 'object' ? (body as { history?: unknown }).history : undefined
  if (rawHistory !== undefined && !Array.isArray(rawHistory)) {
    sendJson(res, { error: 'history 必须是一个数组。', code: 'bad_request' }, 400)
    return
  }
  const history = coerceArchitectHistory(rawHistory)
  const detail = coerceWorkflowDetail(
    body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined,
  )
  const stream = !!(body && typeof body === 'object' && (body as { stream?: unknown }).stream === true)

  // Streaming mode (body `stream: true`): NDJSON over THIS response. Chunks only
  // ever flow into the member's own request/response pair → member-safe by
  // construction (no global stream, nothing to mis-scope).
  if (stream) {
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    })
    const writeLine = (obj: unknown) => {
      try {
        res.write(JSON.stringify(obj) + '\n')
      } catch {
        /* ignore — client may have hung up; the draft save still finishes */
      }
    }
    let r: MeWorkflowCreateResult
    try {
      r = await ctx.workflowCreate.create({
        instruction,
        userId,
        ...(detail ? { detail } : {}),
        ...(history.length ? { history } : {}),
        onChunk: (chunk) => writeLine({ kind: 'chunk', text: chunk }),
      })
    } catch (err) {
      writeLine({
        kind: 'result',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'internal',
      })
      res.end()
      return
    }
    if (r.ok) {
      writeLine({ kind: 'result', ...r })
    } else {
      writeLine({
        kind: 'result',
        ok: false,
        error: r.message,
        code: r.reason,
        ...(r.detail ? { detail: r.detail } : {}),
        ...(r.draftStatus ? { draftStatus: r.draftStatus } : {}),
      })
    }
    res.end()
    return
  }

  const r = await ctx.workflowCreate.create({
    instruction,
    userId,
    ...(detail ? { detail } : {}),
    ...(history.length ? { history } : {}),
  })
  if (r.ok) {
    sendJson(res, r, 200)
    return
  }
  sendJson(
    res,
    {
      error: r.message,
      code: r.reason,
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.draftStatus ? { draftStatus: r.draftStatus } : {}),
    },
    statusForCreateReason(r.reason),
  )
}

/**
 * ARCH-M6 — `POST /api/me/workflows/:id/explain`, body `{ detail?, focus?,
 * stream? }`. Narrates a workflow at an adjustable depth + emits its flowchart.
 * VISIBILITY-GATED: the id must resolve through `resolveMeWorkflow` (published +
 * surface.me + the caller's role), exactly like dispatch — null → 403, so a
 * member can only explain workflows visible in THEIR catalog and an unknown /
 * hidden id never leaks its existence.
 */
async function handleMeWorkflowExplain(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  role: string,
  workflowId: string,
): Promise<void> {
  if (!ctx.workflowCreate) {
    sendJson(res, { error: '工作流讲解暂未启用(需要 AI 助手)。', code: 'not_wired' }, 503)
    return
  }
  // Explaining drives one assistant LLM call — same quota concern as edit / dispatch.
  if (!checkMeRateLimit(ctx, userId, 'me-wf-explain')) {
    sendRateLimited(res, '问得太频繁了,过一会儿再试。')
    return
  }
  // ★ Visibility gate — a member can only explain a workflow visible in THEIR
  //   catalog (the SAME gate dispatch uses); null → 403, never leak which ids exist.
  const visible = await resolveMeWorkflow(ctx, workflowId, role)
  if (!visible) {
    sendJson(res, { error: '找不到这个工作流,或者你没有权限查看。', code: 'forbidden' }, 403)
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'bad body', code: 'bad_request' }, 400)
    return
  }
  const detail = coerceWorkflowDetail(
    body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined,
  )
  const focus =
    body && typeof body === 'object' && typeof (body as { focus?: unknown }).focus === 'string'
      ? (body as { focus: string }).focus
      : undefined
  const stream = !!(body && typeof body === 'object' && (body as { stream?: unknown }).stream === true)

  if (stream) {
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    })
    const writeLine = (obj: unknown) => {
      try {
        res.write(JSON.stringify(obj) + '\n')
      } catch {
        /* ignore */
      }
    }
    let r: MeWorkflowExplainResult
    try {
      r = await ctx.workflowCreate.explain({
        workflowId,
        userId,
        ...(detail ? { detail } : {}),
        ...(focus !== undefined ? { focus } : {}),
        onChunk: (chunk) => writeLine({ kind: 'chunk', text: chunk }),
      })
    } catch (err) {
      writeLine({
        kind: 'result',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'internal',
      })
      res.end()
      return
    }
    if (r.ok) {
      writeLine({ kind: 'result', ...r })
    } else {
      writeLine({
        kind: 'result',
        ok: false,
        error: r.message,
        code: r.reason,
        ...(r.detail ? { detail: r.detail } : {}),
      })
    }
    res.end()
    return
  }

  const r = await ctx.workflowCreate.explain({
    workflowId,
    userId,
    ...(detail ? { detail } : {}),
    ...(focus !== undefined ? { focus } : {}),
  })
  if (r.ok) {
    sendJson(res, r, 200)
    return
  }
  sendJson(
    res,
    { error: r.message, code: r.reason, ...(r.detail ? { detail: r.detail } : {}) },
    statusForExplainReason(r.reason),
  )
}

// ---------------------------------------------------------------------------
// POST /api/me/steward/plan  +  POST /api/me/steward/apply  (SW-M6)
// The hub steward ("管家"): a member talks to it to manage THEIR OWN agents +
// workflows. `plan` proposes (zero side effects); `apply` executes ONE accepted
// action, validated + re-classified server-side, routing dangerous / cross-hub
// actions to the approval inbox. userId is server-forced (never client-supplied).
// ---------------------------------------------------------------------------

/**
 * Shape-coerce a `{kind,status,subject?}`-shaped turn `result` from an untrusted
 * body. The web only checks the field types are strings — the host service
 * re-validates `kind`/`status` against the real action enum, drops unknowns, and
 * renders the line itself, so this can't smuggle narrative into the prompt.
 */
function coerceStewardTurnResult(
  raw: unknown,
): { kind: string; status: string; subject?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const kind = (raw as { kind?: unknown }).kind
  const status = (raw as { status?: unknown }).status
  if (typeof kind !== 'string' || typeof status !== 'string') return undefined
  const out: { kind: string; status: string; subject?: string } = { kind, status }
  const subject = (raw as { subject?: unknown }).subject
  if (typeof subject === 'string') out.subject = subject
  return out
}

/**
 * Shape-coerce an untrusted `history[]` from a steward request body: keep
 * well-formed `{role,content}` turns, carry a `{kind,status,subject?}`-shaped
 * `result` when present, drop the rest, clip to the last 12. Shared by the member
 * (`/api/me/steward`) and operator (`/api/admin/steward`) plan routes so the two
 * coercions never drift; the host service stays the trimming/validation authority.
 */
export function coerceStewardHistory(raw: unknown): StewardHistoryTurn[] {
  if (!Array.isArray(raw)) return []
  const out: StewardHistoryTurn[] = []
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue
    const role = (t as { role?: unknown }).role
    if (role !== 'user' && role !== 'assistant') continue
    const content = (t as { content?: unknown }).content
    if (typeof content !== 'string') continue
    const turn: StewardHistoryTurn = { role, content }
    const result = coerceStewardTurnResult((t as { result?: unknown }).result)
    if (result) turn.result = result
    out.push(turn)
  }
  return out.slice(-12)
}

async function handleMeStewardPlan(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.hubSteward) {
    sendJson(res, { error: '管家暂未启用(需要 AI 助手)。', code: 'not_wired' }, 503)
    return
  }
  // A plan drives one steward LLM call — same quota concern as dispatch / edit.
  if (!checkMeRateLimit(ctx, userId, 'me-steward-plan')) {
    sendRateLimited(res, '问得太频繁了,过一会儿再试。')
    return
  }
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
  // Optional conversation history. Web only shape-coerces (duck discipline): keep
  // `{role,content}` turns + a `{kind,status,subject?}`-shaped `result`, drop the
  // rest, clip to the last 12; the host service is the trimming/validation authority.
  const rawHistory = body && typeof body === 'object' ? (body as { history?: unknown }).history : undefined
  if (rawHistory !== undefined && !Array.isArray(rawHistory)) {
    sendJson(res, { error: 'history 必须是一个数组。', code: 'bad_request' }, 400)
    return
  }
  const history = coerceStewardHistory(rawHistory)
  try {
    const out = await ctx.hubSteward.plan({
      userId,
      instruction,
      ...(history.length ? { history } : {}),
    })
    sendJson(res, out, 200)
  } catch (err) {
    // plan throws only when hub.dispatch resolved non-ok (the steward LLM failed
    // outright) — a server-side fault, not the member's, so 500.
    sendJson(res, { error: err instanceof Error ? err.message : String(err), code: 'steward_failed' }, 500)
  }
}

async function handleMeStewardApply(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.hubSteward) {
    sendJson(res, { error: '管家暂未启用(需要 AI 助手)。', code: 'not_wired' }, 503)
    return
  }
  // Apply can drive an LLM call too (a safe `edit_workflow` runs the WFEDIT
  // assistant), so it shares the member rate limit.
  if (!checkMeRateLimit(ctx, userId, 'me-steward-apply')) {
    sendRateLimited(res, '操作太频繁了,过一会儿再试。')
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'bad body', code: 'bad_request' }, 400)
    return
  }
  // The action is forwarded VERBATIM as `unknown` — the host's `apply` is the
  // validation authority (validateStewardAction → `invalid` on a bad shape), so
  // the web layer only checks it's present at all.
  const action = body && typeof body === 'object' ? (body as { action?: unknown }).action : undefined
  if (action === undefined || action === null) {
    sendJson(res, { error: '缺少要执行的动作(action)。', code: 'bad_request' }, 400)
    return
  }
  try {
    const out = await ctx.hubSteward.apply({ userId, action })
    // The body always carries `status`; the SPA branches on it. A malformed /
    // unrecognized action shape → 400 (it never came from a real proposal); every
    // other status (done / refused / pending_approval / needs_approval) is a
    // well-formed 200 the client renders.
    sendJson(res, out, out.status === 'invalid' ? 400 : 200)
  } catch (err) {
    // The member services throw `{ status: 4xx }` on RBAC / not-found / validation
    // (403/404/400); meAgentErrStatus reads it, else 500.
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
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
// Member agent ownership + self-service CRUD (v5 A-M2)
//
// The web layer shape-checks the body and maps the host's status-coded errors
// to HTTP; every privileged decision (id namespacing, ownership, provider
// availability, grant writes) stays in the host surface.
// ---------------------------------------------------------------------------

/** Map a host surface error to an HTTP status (default 500). */
function meAgentErrStatus(err: unknown): number {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status?: unknown }).status
    if (typeof s === 'number' && s >= 400 && s < 600) return s
  }
  return 500
}

/** Parse + shape-check a member create/update body. `partial` relaxes required
 * fields for PUT (only the supplied fields are validated + returned). */
function parseMeAgentInput(
  body: Record<string, unknown>,
  partial: boolean,
): Partial<MeAgentInput> {
  const out: Partial<MeAgentInput> = {}
  const wantId = !partial
  if (wantId || body.id !== undefined) {
    if (typeof body.id !== 'string' || body.id.length === 0) {
      throw httpError(400, 'id is required (a short handle)')
    }
    if (body.id.length > 48 || !/^[a-zA-Z0-9_.-]+$/.test(body.id)) {
      throw httpError(400, "id may only contain letters, digits, '_', '.', '-' (max 48)")
    }
    out.id = body.id
  }
  if (!partial || body.label !== undefined) {
    if (typeof body.label !== 'string' || body.label.trim().length === 0) {
      throw httpError(400, 'label is required')
    }
    out.label = body.label.trim()
  }
  if (!partial || body.capabilities !== undefined) {
    if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) {
      throw httpError(400, 'capabilities must be a non-empty array')
    }
    const caps: string[] = []
    for (const c of body.capabilities) {
      if (typeof c !== 'string' || c.trim().length === 0) {
        throw httpError(400, 'capabilities must contain non-empty strings')
      }
      caps.push(c.trim())
    }
    out.capabilities = caps
  }
  if (!partial || body.system !== undefined) {
    if (typeof body.system !== 'string' || body.system.trim().length === 0) {
      throw httpError(400, 'system (the prompt) is required')
    }
    out.system = body.system
  }
  if (!partial || body.provider !== undefined) {
    if (typeof body.provider !== 'string' || body.provider.length === 0) {
      throw httpError(400, 'provider is required')
    }
    out.provider = body.provider
  }
  if (body.model !== undefined) {
    if (typeof body.model !== 'string') throw httpError(400, 'model must be a string')
    const m = body.model.trim()
    if (m.length > 0) out.model = m
  }
  return out
}

/** A plain Error carrying an HTTP status for the route's catch to read. */
function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

async function handleMeAgentProviders(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.meAgentAdmin) {
    sendJson(res, { providers: [] })
    return
  }
  try {
    sendJson(res, { providers: await ctx.meAgentAdmin.availableProviders(userId) })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

async function handleMeListOwnedAgents(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.meAgentAdmin) {
    sendJson(res, { agents: [] })
    return
  }
  try {
    sendJson(res, { agents: await ctx.meAgentAdmin.listOwned(userId) })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

async function handleMeReadAgent(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
  agentId: string,
): Promise<void> {
  if (!ctx.meAgentAdmin) {
    sendJson(res, { error: 'agent self-service unavailable (identity not wired)' }, 503)
    return
  }
  try {
    sendJson(res, { agent: await ctx.meAgentAdmin.read(userId, agentId) })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

async function handleMeCreateAgent(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.meAgentAdmin) {
    sendJson(res, { error: 'agent self-service unavailable (identity not wired)' }, 503)
    return
  }
  const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
  try {
    const input = parseMeAgentInput(body, false) as MeAgentInput
    const agent = await ctx.meAgentAdmin.create(userId, input)
    sendJson(res, { ok: true, agent }, 201)
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

async function handleMeUpdateAgent(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  agentId: string,
): Promise<void> {
  if (!ctx.meAgentAdmin) {
    sendJson(res, { error: 'agent self-service unavailable (identity not wired)' }, 503)
    return
  }
  const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
  try {
    const patch = parseMeAgentInput(body, true)
    delete (patch as { id?: unknown }).id // id is immutable; ignore any client value
    const agent = await ctx.meAgentAdmin.update(userId, agentId, patch)
    sendJson(res, { ok: true, agent })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

async function handleMeDeleteAgent(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
  agentId: string,
): Promise<void> {
  if (!ctx.meAgentAdmin) {
    sendJson(res, { error: 'agent self-service unavailable (identity not wired)' }, 503)
    return
  }
  try {
    const removed = await ctx.meAgentAdmin.remove(userId, agentId)
    sendJson(res, { ok: true, removed })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

// ---------------------------------------------------------------------------
// Member agent access grants (v5 A-M4)
//
// Shape-check only. The principal-kind / perm allow-lists are stable wire
// contracts mirrored here so the web layer needs no identity dep; the host
// re-validates authoritatively against the real Principal / perm enums and
// owns the owner gate + orphan guard.
// ---------------------------------------------------------------------------

const GRANT_PRINCIPAL_KINDS = new Set(['hub', 'user', 'agent', 'peer'])
const GRANT_PERM_LEVELS = new Set(['viewer', 'editor', 'owner'])

/** Parse + shape-check a grant-set body. */
function parseMeGrantInput(body: Record<string, unknown>): MeGrantInput {
  if (typeof body.principalKind !== 'string' || !GRANT_PRINCIPAL_KINDS.has(body.principalKind)) {
    throw httpError(400, `principalKind must be one of ${[...GRANT_PRINCIPAL_KINDS].join(', ')}`)
  }
  if (typeof body.principalId !== 'string' || body.principalId.trim().length === 0) {
    throw httpError(400, 'principalId is required')
  }
  if (typeof body.perm !== 'string' || !GRANT_PERM_LEVELS.has(body.perm)) {
    throw httpError(400, `perm must be one of ${[...GRANT_PERM_LEVELS].join(', ')}`)
  }
  return {
    principalKind: body.principalKind,
    principalId: body.principalId.trim(),
    perm: body.perm,
  }
}

async function handleMeListAgentGrants(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
  agentId: string,
): Promise<void> {
  if (!ctx.meAgentGrants) {
    sendJson(res, { grants: [] })
    return
  }
  try {
    sendJson(res, { grants: await ctx.meAgentGrants.list(userId, agentId) })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

async function handleMeSetAgentGrant(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  agentId: string,
): Promise<void> {
  if (!ctx.meAgentGrants) {
    sendJson(res, { error: 'grant management unavailable (identity not wired)' }, 503)
    return
  }
  const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
  try {
    const input = parseMeGrantInput(body)
    const grant = await ctx.meAgentGrants.set(userId, agentId, input)
    sendJson(res, { ok: true, grant }, 201)
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

async function handleMeRemoveAgentGrant(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
  agentId: string,
  principalKey: string,
): Promise<void> {
  if (!ctx.meAgentGrants) {
    sendJson(res, { error: 'grant management unavailable (identity not wired)' }, 503)
    return
  }
  try {
    const removed = await ctx.meAgentGrants.remove(userId, agentId, principalKey)
    sendJson(res, { ok: true, removed })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

// ---------------------------------------------------------------------------
// Member API credentials — "bring your own key" (v5 A-M3)
// ---------------------------------------------------------------------------

/** Parse + shape-check a member credential create body. */
function parseMeCredentialInput(body: Record<string, unknown>): MeCredentialInput {
  if (typeof body.provider !== 'string' || body.provider.length === 0) {
    throw httpError(400, 'provider is required')
  }
  if (typeof body.apiKey !== 'string' || body.apiKey.trim().length === 0) {
    throw httpError(400, 'apiKey is required')
  }
  const apiKey = body.apiKey.trim()
  if (apiKey.length > 800) {
    throw httpError(400, 'apiKey is too long (max 800 chars)')
  }
  const out: MeCredentialInput = { provider: body.provider, apiKey }
  if (body.label !== undefined) {
    if (typeof body.label !== 'string') throw httpError(400, 'label must be a string')
    const l = body.label.trim()
    if (l.length > 0) out.label = l
  }
  return out
}

async function handleMeListCredentials(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.meCredentials) {
    sendJson(res, { credentials: [], providers: [] })
    return
  }
  try {
    const [credentials, providers] = await Promise.all([
      ctx.meCredentials.list(userId),
      ctx.meCredentials.providers(),
    ])
    sendJson(res, { credentials, providers })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

async function handleMeCreateCredential(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.meCredentials) {
    sendJson(res, { error: 'credential management unavailable (identity not wired)' }, 503)
    return
  }
  const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
  try {
    const input = parseMeCredentialInput(body)
    const credential = await ctx.meCredentials.create(userId, input)
    sendJson(res, { ok: true, credential }, 201)
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

async function handleMeDeleteCredential(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
  credentialId: string,
): Promise<void> {
  if (!ctx.meCredentials) {
    sendJson(res, { error: 'credential management unavailable (identity not wired)' }, 503)
    return
  }
  try {
    const removed = await ctx.meCredentials.remove(userId, credentialId)
    sendJson(res, { ok: true, removed })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

// ---------------------------------------------------------------------------
// Member butler-memory privacy view (Personal Butler M6c — 被遗忘权)
//
// GET reads the snapshot, GET /export returns everything, DELETE forgets one or
// all. The host (HostButlerMemoryService) opens the per-user memory handle by
// the SESSION userId — never a client-supplied id — so the no-leak namespace
// boundary holds at the route layer. Undefined surface → empty (GET) / 503.
// ---------------------------------------------------------------------------

async function handleMeButlerMemoryRead(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.butlerMemory) {
    sendJson(res, { profile: [], recent: [] })
    return
  }
  try {
    const snapshot = await ctx.butlerMemory.read(userId)
    sendJson(res, snapshot)
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

async function handleMeButlerMemoryExport(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.butlerMemory) {
    sendJson(res, { entries: [] })
    return
  }
  try {
    const entries = await ctx.butlerMemory.export(userId)
    sendJson(res, { entries })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

async function handleMeButlerMemoryForgetAll(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.butlerMemory) {
    sendJson(res, { error: 'butler memory unavailable (not wired)' }, 503)
    return
  }
  try {
    await ctx.butlerMemory.forgetAll(userId)
    sendJson(res, { ok: true })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

async function handleMeButlerMemoryForget(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
  id: string,
): Promise<void> {
  if (!ctx.butlerMemory) {
    sendJson(res, { error: 'butler memory unavailable (not wired)' }, 503)
    return
  }
  try {
    const removed = await ctx.butlerMemory.forget(userId, id)
    sendJson(res, { ok: true, removed })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

/**
 * ease-of-use ①TC-ME — POST /api/me/test-llm-key. A member verifies a BYO key
 * works (one tiny provider ping) BEFORE saving it, so a wrong key / empty
 * balance is caught here instead of silently failing a workflow later. Mirror
 * of the setup-wizard / admin probe, but member-scoped and SAFER: provider is
 * restricted to the BYO set (anthropic/openai), no baseURL is accepted, the key
 * is never stored, and the response echoes only the structured verdict the UI's
 * describeKeyTest() reads — never the key, never a free-text diagnostic.
 */
async function handleMeTestLlmKey(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  // Each probe is an outbound LLM request; rate-limit per-user (same budget
  // machinery as /me/dispatch) so a member can't loop it to hammer a provider.
  if (!checkMeRateLimit(ctx, userId, 'me-test-key')) {
    sendRateLimited(res, 'too many connection tests; try again in a minute')
    return
  }
  if (!ctx.llmKeyTest) {
    sendJson(res, { error: 'connection test unavailable (key-test surface not wired)' }, 503)
    return
  }
  const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
  const provider = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : ''
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  // Mirror HostMeCredentialsService.MEMBER_CREDENTIAL_PROVIDERS: a member may
  // only bring a RAW bearer key for these two first-party providers. Both have
  // fixed endpoints, so we never accept/forward a baseURL → no SSRF probe.
  if (provider !== 'anthropic' && provider !== 'openai') {
    sendJson(res, { error: 'provider must be one of anthropic, openai' }, 400)
    return
  }
  if (!apiKey) {
    sendJson(res, { error: 'apiKey required' }, 400)
    return
  }
  try {
    const result = await ctx.llmKeyTest.testLlmKey({ provider, apiKey })
    sendJson(res, {
      ok: result.ok,
      model: result.model,
      latencyMs: result.latencyMs,
      ...(result.code ? { code: result.code } : {}),
    })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

/**
 * ease-of-use ②TC-ME — POST /api/me/agents/:id/chat. After a member builds
 * their assistant (打造我的助手) and tests the key (①TC-ME), THIS is the payoff:
 * actually talk to it in the UI, with no detour through a workflow. Mirror of
 * the admin post-create quick-chat (server.ts /api/admin/dispatch wait:true),
 * but member-scoped:
 *
 *  - Ownership gate = meAgentAdmin.read (the read FLOOR of the grant ladder):
 *    the caller must hold at least 'viewer' on this agent, else 403/404 (anti-
 *    enumeration). So you can only chat with an agent you can already see.
 *  - Quota debits the CALLER (origin.userId), exactly like /me/dispatch, so one
 *    member can't burn another's budget. (Which per-user KEY a member-owned
 *    agent runs on is resolved host-side from the agent's OWNER grant — that's
 *    unchanged A-M3 attribution; chat opens no new spend path beyond what the
 *    grant already permits, since a viewer-granted member can already cause the
 *    agent to run via other dispatch paths.)
 *  - Synchronous (Promise.race + timeout, the same idiom as the admin wait:true
 *    path) so the reply returns in this response. The body is { ok, result } so
 *    the SPA renders it with the SAME logic the admin quick-chat uses, including
 *    the ③TC friendly-error folding (describeError).
 */
async function handleMeChatAgent(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  agentId: string,
): Promise<void> {
  // Each chat is an outbound LLM call; rate-limit per-user (same machinery as
  // /me/dispatch + ①TC-ME) so a member can't loop it to hammer a provider.
  if (!checkMeRateLimit(ctx, userId, 'me-chat')) {
    sendRateLimited(res, 'too many messages; try again in a minute')
    return
  }
  if (!ctx.meAgentAdmin) {
    sendJson(res, { error: 'agent chat unavailable (agent surface not wired)' }, 503)
    return
  }
  // Ownership gate — the ONLY access decision. read() throws (status 403/404)
  // if the caller doesn't hold at least 'viewer', so a non-grantee can neither
  // chat with nor enumerate ids.
  try {
    await ctx.meAgentAdmin.read(userId, agentId)
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
    return
  }
  const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) {
    sendJson(res, { error: 'prompt required' }, 400)
    return
  }
  const rawTimeout = typeof body.timeoutMs === 'number' ? body.timeoutMs : 60_000
  const timeoutMs = Math.max(1000, Math.min(600_000, rawTimeout))
  try {
    const result = await Promise.race([
      ctx.hub.dispatch({
        from: userId,
        // Stamp the dispatcher so the org quota gate debits per-user — same
        // attribution as /me/dispatch. orgId 'local' marks same-hub origin.
        origin: { orgId: 'local', userId },
        strategy: { kind: 'explicit', to: agentId },
        payload: { prompt },
        title: `chat — ${userId}`,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('chat wait timeout')), timeoutMs),
      ),
    ])
    sendJson(res, { ok: true, result })
  } catch (err) {
    // 504 = timed out, or dispatch rejected (eg. quota fail-closed). The SPA
    // folds this through describeError, so a timeout / refused key reads as
    // plain words + a fix rather than a raw stack.
    sendJson(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 504)
  }
}

// ---------------------------------------------------------------------------
// /api/me/im/* — member IM-account linking (GO-LIVE GL-1c)
//
// Same shape as the credential handlers: GET degrades to an empty list when no
// surface is wired; POST/DELETE return 503; host status-coded errors map to
// HTTP via meAgentErrStatus (notably 404 for a binding the caller doesn't own).
// ---------------------------------------------------------------------------

async function handleMeListIm(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.meIm) {
    sendJson(res, { enabled: false, bindings: [] })
    return
  }
  try {
    const bindings = await ctx.meIm.listBindings(userId)
    sendJson(res, { enabled: ctx.meIm.enabled(), bindings })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

async function handleMeIssueImCode(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.meIm) {
    sendJson(res, { error: 'IM linking unavailable (identity not wired)' }, 503)
    return
  }
  try {
    const { code, expiresAt } = await ctx.meIm.issueCode(userId)
    sendJson(res, { ok: true, code, expiresAt }, 201)
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

async function handleMeRemoveImBinding(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
  platform: string,
  platformUserId: string,
): Promise<void> {
  if (!ctx.meIm) {
    sendJson(res, { error: 'IM linking unavailable (identity not wired)' }, 503)
    return
  }
  try {
    const removed = await ctx.meIm.removeBinding(userId, platform, platformUserId)
    sendJson(res, { ok: true, removed })
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, meAgentErrStatus(err))
  }
}

// ---------------------------------------------------------------------------
// /api/me/totp/* — member MFA (TOTP) self-service (Route B P1-M3e)
// ---------------------------------------------------------------------------

/**
 * Read a `{ code }` body, tolerating a missing/empty/garbled body as no code.
 * readJsonBody resolves to `undefined` for an empty body (a bare POST with no
 * payload, e.g. "disable" with no code), so guard the object before indexing.
 */
async function readTotpCode(req: IncomingMessage): Promise<string> {
  const body = (await readJsonBody(req).catch(() => null)) as { code?: unknown } | null
  return body && typeof body.code === 'string' ? body.code.trim() : ''
}

async function handleMeTotpState(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (typeof ctx.identity.totpState !== 'function') {
    sendJson(res, { error: 'MFA unavailable on this host', code: 'totp_unavailable' }, 503)
    return
  }
  sendJson(res, { state: ctx.identity.totpState(userId) })
}

async function handleMeTotpEnroll(
  ctx: HandleMeRouteCtx,
  res: ServerResponse,
  userId: string,
  email: string,
): Promise<void> {
  if (typeof ctx.identity.enrollTotp !== 'function') {
    sendJson(res, { error: 'MFA unavailable on this host', code: 'totp_unavailable' }, 503)
    return
  }
  try {
    // account = the member's own email (server-side, never client-supplied);
    // issuer is the app name shown in the authenticator. The plaintext secret
    // is returned ONCE here for the QR code — it lives encrypted in the vault.
    const e = ctx.identity.enrollTotp({ userId, account: email, issuer: 'AipeHub' })
    sendJson(res, { ok: true, secretBase32: e.secretBase32, otpauthUri: e.otpauthUri })
  } catch (err) {
    // No master key configured → the vault can't encrypt the secret. That's a
    // host-config gap, not a client error: surface 503 so the UI says "ask
    // the operator to enable encryption" rather than a generic failure.
    const code = (err as { code?: string } | null)?.code
    if (code === 'vault_not_configured') {
      sendJson(res, { error: 'MFA requires the host to configure encryption', code }, 503)
      return
    }
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

async function handleMeTotpConfirm(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (typeof ctx.identity.confirmTotp !== 'function') {
    sendJson(res, { error: 'MFA unavailable on this host', code: 'totp_unavailable' }, 503)
    return
  }
  const code = await readTotpCode(req)
  if (!code) {
    sendJson(res, { error: 'code required', code: 'invalid_input' }, 400)
    return
  }
  try {
    const ok = ctx.identity.confirmTotp({ userId, code })
    if (!ok) {
      sendJson(res, { ok: false, error: 'invalid code', code: 'invalid_code' }, 400)
      return
    }
    sendJson(res, { ok: true, state: 'active' })
  } catch (err) {
    // invalid_input == "no pending enrollment to confirm" / "already active".
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 409)
  }
}

async function handleMeTotpDisable(
  ctx: HandleMeRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (
    typeof ctx.identity.disableTotp !== 'function' ||
    typeof ctx.identity.totpState !== 'function'
  ) {
    sendJson(res, { error: 'MFA unavailable on this host', code: 'totp_unavailable' }, 503)
    return
  }
  const state = ctx.identity.totpState(userId)
  if (state === 'none') {
    sendJson(res, { ok: false, error: 'no MFA enrollment', code: 'no_enrollment' }, 400)
    return
  }
  if (state === 'active') {
    // Turning OFF an active factor requires proving current possession — a
    // stolen session cookie alone must not be enough to drop 2FA. (A pending,
    // never-confirmed enrollment protects nothing, so it can just be cancelled.)
    if (typeof ctx.identity.verifyTotpForLogin !== 'function') {
      sendJson(res, { error: 'MFA unavailable on this host', code: 'totp_unavailable' }, 503)
      return
    }
    const code = await readTotpCode(req)
    if (!code || !ctx.identity.verifyTotpForLogin({ userId, code })) {
      sendJson(res, { ok: false, error: 'invalid code', code: 'invalid_code' }, 400)
      return
    }
  }
  const removed = ctx.identity.disableTotp(userId)
  sendJson(res, { ok: removed, state: 'none' })
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
    // Reject `..` BEFORE the prefix check: the host-side artifact store
    // normalises the path (folding `../`), so a naive
    // `uploads/me/<me>/../<other>/…` id satisfies startsWith(prefix) yet
    // resolves into a sibling member's (or admin's) scope. Refuse traversal up
    // front — same guard as the report download (parseCaseIdFromReportPath).
    if (id.includes('..') || !id.startsWith(prefix)) {
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
  if (!checkMeRateLimit(ctx, userId, 'me-upload')) {
    sendRateLimited(res, 'too many uploads; try again in a minute')
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
  // looping member can force full-table scans. Own per-action bucket
  // (`me-reports`) so a reader doesn't share a budget with dispatch.
  if (!checkMeRateLimit(ctx, userId, 'me-reports')) {
    sendRateLimited(res, 'too many report-list requests; try again in a minute')
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
