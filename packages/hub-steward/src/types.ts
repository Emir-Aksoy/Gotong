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
