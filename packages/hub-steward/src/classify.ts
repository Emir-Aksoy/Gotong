/**
 * The steward action classifier — server-authoritative risk tiering.
 *
 * This is where the user's two hard constraints land:
 *   「跨 hub 间的工作流需要再次确认，危险动作都再次确认。」
 *
 * `delete_agent` → `dangerous`; a workflow that leaves this hub → `cross_hub`.
 * Both require a human's SECOND confirmation (the host routes them through the
 * Phase 16 approval inbox). Everything is CONSERVATIVE: only the explicitly-safe
 * kinds return `safe`; an out-of-scope ask is `forbidden` and never executes.
 *
 * Pure — no host / hub state beyond the small `ctx` the host supplies.
 */

import { agentPrincipal, authorizeAgentAction, type AgentHumanConfirmAction } from '@aipehub/identity'

import type { StewardAction, StewardActionTier } from './types.js'

/** What the classifier needs from the host to tier an action. */
export interface StewardClassifyContext {
  /**
   * The ids of THIS member's workflows that are cross-hub (leave this hub).
   * The host derives this from `WorkflowSummary.crossHubSteps` /
   * `editableView().crossHub`, so the editor lock and the classifier agree on
   * what "cross-hub" means — one source of truth, no drift.
   */
  crossHubWorkflowIds: ReadonlySet<string>
  /**
   * The steward agent's participant id — feeds the `authorizeAgentAction`
   * backstop below (an agent principal may not do the highest-blast-radius
   * actions alone).
   */
  stewardId: string
  /**
   * Whether THIS steward instance is the OPERATOR console (B-M2). The privilege
   * boundary is the registered participant identity + the host surface that
   * built it — NEVER a member-forgeable payload field — so the host passes this
   * per instance: the member steward omits it (`false`), the operator steward
   * passes `true`. It only changes how the four SENSITIVE writes tier: a member
   * can never do them (`forbidden`); an operator routes every one through the
   * approval inbox (`dangerous`).
   */
  operator: boolean
}

/**
 * Map a steward action to the abstract authority verb it would perform, IFF that
 * verb is one of the human-confirm-required ones (`agent-authority.ts`), else
 * `null`. The four SENSITIVE writes (credentials / peer / security quota) are all
 * hub-safety settings, so they map to `change_security` — its reason text spells
 * out the exact surface: "peer trust, vault master key, security-relevant quotas".
 * Every other kind touches only a member's own agents / workflows → `null`.
 *
 * Exported so the floor is unit-testable directly, and so a future
 * highest-blast-radius kind wires its verb here (`agent-authority.ts` predicted
 * "the actual wiring … lands … when agent-owned resources first exist").
 */
export function authorityVerbFor(action: StewardAction): AgentHumanConfirmAction | null {
  switch (action.kind) {
    case 'set_credential_ref':
    case 'revoke_credential':
    case 'set_peer_policy':
    case 'set_security_quota':
      // Vault credential write / peer trust / security quota — all `change_security`.
      return 'change_security'
    default:
      return null
  }
}

/**
 * Classify a proposed action into one of four risk tiers.
 *
 * The per-kind {@link baseTierForAction} decision is AUTHORITATIVE; the authority
 * backstop then runs as a forward-looking net — if a verb-bearing action somehow
 * came back as `safe`, it is RAISED to `dangerous` (an agent-principal steward may
 * not do a `change_security` verb alone). The backstop only ever raises a `safe`
 * result, so it never weakens a member's `forbidden` or an explicit inbox tier —
 * the per-kind decision stays the source of truth while a future mis-tiered kind
 * still can't slip through as safe.
 */
export function classifyStewardAction(
  action: StewardAction,
  ctx: StewardClassifyContext,
): StewardActionTier {
  const tier = baseTierForAction(action, ctx)
  if (tier === 'safe') {
    const verb = authorityVerbFor(action)
    if (verb && authorizeAgentAction(agentPrincipal(ctx.stewardId), verb).kind === 'requires_human') {
      return 'dangerous'
    }
  }
  return tier
}

/** The per-kind tier decision (before the authority backstop). */
function baseTierForAction(action: StewardAction, ctx: StewardClassifyContext): StewardActionTier {
  switch (action.kind) {
    case 'inspect':
      return 'safe' // read-only answer; nothing to execute
    case 'create_agent':
    case 'edit_agent':
      return 'safe'
    case 'delete_agent':
      return 'dangerous' // ★ destructive — second confirmation
    case 'edit_workflow':
      // ★ a workflow that leaves this hub re-confirms; a purely-local one is safe.
      return ctx.crossHubWorkflowIds.has(action.workflowId) ? 'cross_hub' : 'safe'
    case 'set_credential_ref':
    case 'revoke_credential':
    case 'set_peer_policy':
    case 'set_security_quota':
      // ★ OPERATOR-ONLY sensitive writes. A member steward never proposes these —
      // `forbidden` (the steward only explains + points to the settings panel). An
      // operator steward tiers every one to `dangerous` → ALWAYS through the
      // approval inbox (B-M4 makes this stricter than `delete_agent`: never an
      // inline path). The `authorityVerbFor` backstop guarantees this can never be
      // downgraded to `safe`.
      return ctx.operator ? 'dangerous' : 'forbidden'
    case 'refuse':
      return 'forbidden' // out-of-scope / sensitive — never executed
  }
}
