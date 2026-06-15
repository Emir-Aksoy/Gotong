/**
 * @aipehub/hub-steward — the "管家" (hub steward) action vocabulary.
 *
 * The steward is an LLM that turns a member's plain-language instruction into a
 * STRUCTURED PROPOSAL — it NEVER executes writes itself. The host re-classifies
 * each action and executes it behind the existing member services
 * (`HostMeAgentService` / `MeWorkflowEditService`) + a Phase 16 approval inbox.
 * These types are the contract between the LLM (which emits `StewardAction[]`)
 * and the host executor (which performs them).
 *
 * Pure data — no core / llm / host deps — so the agent (which DOES use `@aipehub/llm`)
 * and the host executor share one vocabulary without a dependency cycle.
 */

/**
 * A provider a member may pick when the steward builds an agent for them.
 * Mirrors `HostMeAgentService` MEMBER_PROVIDERS, kept as a plain union here so
 * this package stays host-free; the host re-validates against its live key pool
 * (a provider with no key is rejected there, not here).
 */
export type StewardAgentProvider = 'anthropic' | 'openai' | 'mock'

/**
 * The fields for creating / editing a member agent. Mirror the `/me/agents`
 * create form WITHOUT importing host — the host maps `handle` → the composed id
 * `me.<userId>.<handle>` and the rest straight onto `MeAgentInput`.
 */
export interface StewardAgentFields {
  /** The member's short handle; the host composes the real participant id. */
  handle: string
  label: string
  provider: StewardAgentProvider
  model?: string
  system: string
  capabilities: string[]
}

/**
 * A single concrete action the steward proposes, discriminated by `kind`.
 *
 *   - `inspect`       — a read-only answer to a question; nothing to execute.
 *   - `create_agent`  — build a new managed agent for the member.
 *   - `edit_agent`    — change an existing owned agent's config.
 *   - `delete_agent`  — remove an owned agent (DESTRUCTIVE → dangerous tier).
 *   - `edit_workflow` — change a workflow in plain language (delegated to
 *                       `MeWorkflowEditService.edit`; cross-hub workflows →
 *                       cross_hub tier).
 *
 * The SENSITIVE writes (Phase B) — OPERATOR-ONLY, and every one ALWAYS routes
 * through the approval inbox (stricter than `delete_agent`). A member steward
 * never receives the dependencies to execute these, and the classifier tiers
 * them `forbidden` for a non-operator caller — so they are doubly gated:
 *
 *   - `set_credential_ref`  — register a provider credential whose secret the
 *                             host reads from a named ENV VAR (see below).
 *   - `revoke_credential`   — remove a stored credential by id.
 *   - `set_peer_policy`     — change a peer (cross-org) link's trust contract.
 *   - `set_security_quota`  — set a security-relevant usage quota.
 *
 *   - `refuse`        — an out-of-scope / sensitive ask the steward will not do
 *                       (RBAC grants / billing, or any sensitive write a NON-
 *                       operator asked for) — never executed.
 *
 * ── The one security invariant for the sensitive writes ──────────────────────
 * A steward action NEVER carries a plaintext secret. `set_credential_ref` names
 * `envVarName` — the name of a host environment variable the operator set OUT OF
 * BAND — and the executor (the only plaintext holder) resolves `process.env[name]`
 * at apply time. So no proposal / apply body / inbox item / transcript / history
 * ever contains a key. The validator REJECTS the whole action if it carries any
 * key-shaped field (`secret` / `apiKey` / `token` / …) — see `validateStewardAction`.
 */
export type StewardAction =
  | { kind: 'inspect'; answer: string }
  | ({ kind: 'create_agent' } & StewardAgentFields)
  | { kind: 'edit_agent'; agentId: string; changes: Partial<StewardAgentFields> }
  | { kind: 'delete_agent'; agentId: string }
  | { kind: 'edit_workflow'; workflowId: string; instruction: string }
  | ({ kind: 'set_credential_ref' } & StewardCredentialRef)
  | { kind: 'revoke_credential'; credentialId: string }
  | ({ kind: 'set_peer_policy' } & StewardPeerPolicy)
  | ({ kind: 'set_security_quota' } & StewardSecurityQuota)
  | { kind: 'refuse'; reason: string }

/**
 * The fields for registering a provider credential WITHOUT ever naming the
 * secret. `envVarName` is the host environment variable the operator set out of
 * band; the host executor resolves `process.env[envVarName]` and stores it in
 * the vault. The plaintext NEVER appears in this object (the validator drops the
 * whole action if a key-shaped field is present).
 */
export interface StewardCredentialRef {
  /** Which provider this key is for (e.g. `anthropic` / `openai`). Host re-validates. */
  provider: string
  /** The NAME of the host env var holding the secret — never the secret itself. */
  envVarName: string
  /** Optional human label for the stored credential. */
  label?: string
}

/**
 * A subset of a peer (cross-org) link's trust-contract fields the steward may
 * set. These mirror the real per-link policy columns (P4-M4 data classes +
 * quota, E5 share-summary) — all non-secret. The host maps them onto
 * `PeerStore.updatePeer`; an omitted field is left unchanged.
 */
export interface StewardPeerPolicy {
  /** The peer link id whose policy to change. */
  peerId: string
  /** Allowed outbound data classes (null/omitted = leave unchanged). */
  allowedDataClasses?: string[]
  /** Per-link quota budget (omitted = leave unchanged). */
  perLinkQuotaBudget?: number
  /** Whether this peer may pull privacy-safe summary counts (omitted = unchanged). */
  shareSummary?: boolean
}

/**
 * A security-relevant usage quota the steward may set. Plain scalars — no
 * secret. The host re-validates `metric` / `period` against the real quota
 * enums; an out-of-range value is rejected there, not here.
 */
export interface StewardSecurityQuota {
  /** What the quota scopes to (e.g. a user id, agent id, or `hub`). */
  scope: string
  /** The metered dimension (e.g. `llm_tokens` / `llm_cost_micros` / `dispatch`). */
  metric: string
  /** The reset window (e.g. `day` / `month`). */
  period: string
  /** The ceiling. */
  limit: number
}

export type StewardActionKind = StewardAction['kind']

/**
 * Every action kind, as a runtime-checkable flag map. The Record literal is the
 * exhaustiveness guard: if a kind is added to the `StewardAction` union without a
 * key here, TS errors — so the runtime whitelist can NEVER silently drift from
 * the type. Used (Phase C) to validate a structured turn-result echoed back by an
 * untrusted SPA before it is rendered into the next prompt.
 */
const STEWARD_ACTION_KIND_FLAGS: Record<StewardActionKind, true> = {
  inspect: true,
  create_agent: true,
  edit_agent: true,
  delete_agent: true,
  edit_workflow: true,
  set_credential_ref: true,
  revoke_credential: true,
  set_peer_policy: true,
  set_security_quota: true,
  refuse: true,
}

/** All steward action kinds (runtime list; declaration order). */
export const STEWARD_ACTION_KINDS = Object.keys(
  STEWARD_ACTION_KIND_FLAGS,
) as StewardActionKind[]

/** True iff `x` is a known steward action kind — a runtime whitelist guard. */
export function isStewardActionKind(x: unknown): x is StewardActionKind {
  return (
    typeof x === 'string' &&
    Object.prototype.hasOwnProperty.call(STEWARD_ACTION_KIND_FLAGS, x)
  )
}

/**
 * The risk tier the HOST assigns each action — server-authoritative, the
 * client's claim is never trusted.
 *
 *   - `safe`      — one confirmation (the member previews the proposal, then applies).
 *   - `dangerous` — a SECOND confirmation via the approval inbox (delete_agent).
 *   - `cross_hub` — a SECOND confirmation: the workflow leaves this hub.
 *   - `forbidden` — never executed; the steward only explains + points to settings.
 */
export type StewardActionTier = 'safe' | 'dangerous' | 'cross_hub' | 'forbidden'

/** An action plus the host-assigned tier + a member-readable one-line summary. */
export interface ClassifiedAction {
  action: StewardAction
  tier: StewardActionTier
  /** One-line, member-readable (zh) description of what this action will do. */
  summary: string
}

/**
 * The raw structured output the steward LLM returns for one instruction: a
 * conversational reply plus zero or more concrete actions. `actions` is empty
 * for pure chit-chat; an `inspect` answer rides as an action so the reply stays
 * a short acknowledgement.
 */
export interface StewardProposal {
  /** The steward's conversational reply (always present). */
  reply: string
  /** The concrete actions proposed (may be empty). */
  actions: StewardAction[]
}

/**
 * What the host's `plan()` returns: the LLM reply + each action wrapped with its
 * host-assigned tier + summary, ready for the member to preview before `apply`.
 */
export interface ClassifiedProposal {
  reply: string
  actions: ClassifiedAction[]
}

// ---------------------------------------------------------------------------
// Agent input contract — what the host's `plan()` packs into `Task.payload`
// when it dispatches to the steward, plus the read-only snapshot of what the
// member owns. Pure data so the host (which builds the snapshot from
// `HostMeAgentService.listOwned` + the workflow catalog) and the agent (which
// renders it into the prompt) share one shape without a dependency cycle.
// ---------------------------------------------------------------------------

/** One of the member's owned managed agents, as the snapshot describes it. */
export interface StewardSnapshotAgent {
  /** The composed participant id, e.g. `me.<userId>.<handle>`. */
  id: string
  /** The short handle the member named it (the suffix of `id`). */
  handle?: string
  /** Human label. */
  label?: string
  /** Capability tags it answers to. */
  capabilities: ReadonlyArray<string>
  /** Provider backing it (anthropic / openai / mock) — surfaced for context only. */
  provider?: string
}

/** One of the member's workflows the steward may propose edits to. */
export interface StewardSnapshotWorkflow {
  id: string
  name?: string
  /**
   * True when this workflow has cross-hub egress steps. The host derives it
   * from `editableView().crossHub`; the steward uses it to phrase the reply
   * ("this leaves your hub, I'll prepare it for confirmation") and the host's
   * classifier independently tiers an `edit_workflow` on it as `cross_hub`.
   */
  crossHub?: boolean
}

/**
 * A read-only snapshot of what the calling member owns, injected by the host so
 * the steward proposes against REAL ids / capabilities instead of inventing
 * plausible-but-nonexistent ones (same discipline as the workflow assistant's
 * `contextHints`). The steward only ever acts on what's listed here.
 */
export interface StewardSnapshot {
  /** The member's owned managed agents. */
  agents?: ReadonlyArray<StewardSnapshotAgent>
  /** The member's editable workflows, each flagged cross-hub or not. */
  workflows?: ReadonlyArray<StewardSnapshotWorkflow>
  /** Providers the member may pick (only those with a usable key on this hub). */
  providers?: ReadonlyArray<StewardAgentProvider>
}

/**
 * The outcome of applying one steward action, as a turn records it (Phase C —
 * "结果感知"). The SPA appends this after each `apply` so the steward's NEXT
 * proposal builds on what ACTUALLY happened, not what it merely proposed.
 *
 *   - `done`             — a SAFE action executed inline.
 *   - `pending_approval` — a dangerous / cross-hub / sensitive action was sent to
 *                          the approval inbox (NOT yet executed).
 *   - `refused`          — the host refused it (out of scope for this caller).
 *   - `invalid`          — the action was malformed / failed validation.
 *
 * Purely advisory context: the host re-classifies + re-executes the NEXT action
 * independently, so a forged result cannot make anything run. The host also
 * RE-RENDERS this into a fixed-format line from the whitelisted fields below
 * (`sanitizeStewardHistory`) — the client never supplies the rendered text, so it
 * can't inject a "succeeded" narrative the model would read as ground truth.
 */
export interface StewardTurnResult {
  /** Which action this was the outcome of (validated against `STEWARD_ACTION_KINDS`). */
  kind: StewardActionKind
  /** What happened to it. */
  status: 'done' | 'pending_approval' | 'refused' | 'invalid'
  /**
   * The subject the action touched (an agent id, workflow id, provider, …) — for
   * a readable "create_agent ✓ → support-bot" line. Non-secret by construction
   * (the sensitive actions only ever name env vars / ids). Clipped by the host.
   */
  subject?: string
}

/** One prior conversational turn, for multi-step ("再礼貌一点") steward edits. */
export interface StewardTurn {
  role: 'user' | 'assistant'
  content: string
  /**
   * The structured outcome of the action this turn applied, if any (Phase C).
   * The host validates + folds it into the rendered prompt; the agent itself
   * never reads this field (it only sees `role` + `content`).
   */
  result?: StewardTurnResult
}

/**
 * What the host packs into `Task.payload` when dispatching to the steward.
 * The host fills `snapshot` from the member's owned resources; the member only
 * ever supplies `instruction` (+ the running `history` the SPA keeps).
 */
export interface HubStewardPayload {
  /** Required. The member's plain-language instruction. */
  instruction: string
  /** The member's owned-resource snapshot (host-built). */
  snapshot?: StewardSnapshot
  /** Prior turns of this conversation, for follow-up instructions. */
  history?: ReadonlyArray<StewardTurn>
}

/**
 * The verdict on extracting a `StewardProposal` from the LLM's raw reply.
 *
 *   - `'ok'`      — a JSON object was parsed; `actions` are the well-formed ones
 *                   (malformed entries are silently dropped — they never execute).
 *   - `'no_json'` — no JSON-like content; the raw text is a plain reply
 *                   (chit-chat / clarifying question). `actions` is empty.
 *   - `'invalid'` — JSON-like content was present but unparseable. `actions` is
 *                   empty; the raw text rides as the reply.
 *
 * Mirrors the workflow assistant's `WorkflowDraftStatus` three-state design so
 * callers can tell "steward proposed", "steward just chatted", and "steward
 * botched the JSON" apart without re-parsing.
 */
export type StewardParseStatus = 'ok' | 'no_json' | 'invalid'
