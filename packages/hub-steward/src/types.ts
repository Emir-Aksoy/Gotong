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
 *   - `refuse`        — an out-of-scope / sensitive ask the steward will not do
 *                       (credentials / peers / security / RBAC) — never executed.
 */
export type StewardAction =
  | { kind: 'inspect'; answer: string }
  | ({ kind: 'create_agent' } & StewardAgentFields)
  | { kind: 'edit_agent'; agentId: string; changes: Partial<StewardAgentFields> }
  | { kind: 'delete_agent'; agentId: string }
  | { kind: 'edit_workflow'; workflowId: string; instruction: string }
  | { kind: 'refuse'; reason: string }

export type StewardActionKind = StewardAction['kind']

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

/** One prior conversational turn, for multi-step ("再礼貌一点") steward edits. */
export interface StewardTurn {
  role: 'user' | 'assistant'
  content: string
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
