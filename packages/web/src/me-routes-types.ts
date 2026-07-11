/**
 * me-routes-types.ts — the /me member surface's declaration set, split out of
 * me-routes.ts to keep it within the assembly-layer line budget (GUARD
 * line-budget gate). Almost entirely pure types: the member-facing `*Surface`
 * duck types the host implements + injects, their public `*View` projections,
 * and the `*Result` unions the routes map to HTTP status. The one runtime
 * export is `memberUploadScope` — a tiny pure path-scope helper documented
 * together with (and only used alongside) `MeUploadSurface`, so it rides here
 * with its type.
 *
 * me-routes.ts imports back what its handler signatures + `HandleMeRouteCtx`
 * name locally, and re-exports ALL of these so './me-routes.js' stays the one
 * import point server.ts and the web tests use. `HandleMeRouteCtx` itself
 * stays in me-routes.ts — it is the runtime request context, not part of the
 * injected surface.
 */
import type { Hub } from '@gotong/core'

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
// Duck-typed so the web layer takes no runtime dep on `@gotong/workflow`. The
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

/** A one-line summary of the butler's most recent background dreaming sweep (MR2). */
export interface ButlerDreamSummary {
  /** Epoch ms the sweep ran. */
  firedAt: number
  /** How many memories it promoted into the durable profile. */
  promoted: number
  /** How many stale memories it pruned. */
  pruned: number
  /** Size (chars) of the curated profile written, if any were promoted. */
  profileBytes?: number
}

/** A one-line summary of the butler's most recent 6h maintenance pass (MR4 ④写状态). */
export interface ButlerStatusSummary {
  /** Epoch ms the maintenance pass ran. */
  writtenAt: number
  /** What the pass did this tick (the composed reviewer's summary; '' when nothing changed). */
  summary: string
}

/** What the privacy panel shows: the distilled profile + recent captured turns. */
export interface ButlerMemorySnapshot {
  /** Semantic entries — the durable "what the butler knows about me". */
  profile: ButlerMemoryView[]
  /** Episodic entries — recently captured turns, newest first. */
  recent: ButlerMemoryView[]
  /**
   * The last background "复盘" (dreaming sweep), if one has run. Read-only — the
   * member sees that the butler tidies its own memory and what the last pass did
   * ("提升 X 条 / 封存 Y 条"). Omitted when no sweep has run yet.
   */
  lastDream?: ButlerDreamSummary
  /**
   * The last 6h "维护" (maintenance pass), if one has run. Read-only liveness — the
   * member sees the butler self-maintains on a heartbeat and what the last tick
   * did. Omitted until a maintenance pass has run.
   */
  lastStatus?: ButlerStatusSummary
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
export function memberUploadScope(userId: string): string {
  return `me/${userId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

// ---------------------------------------------------------------------------
// Member task inbox surface (Phase 16)
//
// Duck-typed so the web layer takes no runtime dep on `@gotong/inbox`; the
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
 * takes NO runtime dep on `@gotong/workflow-assistant`. Same duck-typing
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
  /**
   * WIZ-M4 — persist the wizard's user-approved YAML through exactly the same
   * member gates as `create` (draft cap / local-only / id collision / structure
   * hard-gate / owner seed), with NO LLM call. Optional: absent ⇒ the wizard
   * approve route degrades to 503 while create/explain keep working.
   */
  createFromYaml?(req: { yaml: string; userId: string }): Promise<MeWorkflowCreateResult>
}

// ---------------------------------------------------------------------------
// SW-M6 — the hub steward ("管家"). A member manages THEIR OWN agents +
// workflows by talking to it in plain language. Duck-typed so the web layer
// takes NO runtime dep on `@gotong/hub-steward` (mirroring InboxSurface /
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
    /**
     * NA-M6a — live LLM chunks for THIS call only (WFEDIT-D4 pattern; the host
     * routes them via a one-shot private key, never the global transcript).
     * Note the steward's raw output is a JSON proposal — callers treat chunks
     * as a typing preview, the returned result stays authoritative.
     */
    onChunk?: (chunk: string) => void
  }): Promise<MeHubStewardPlanResult>
  /** Apply ONE accepted action (validated + re-classified server-side). */
  apply(input: { userId: string; action: unknown }): Promise<MeHubStewardApplyResult>
}
