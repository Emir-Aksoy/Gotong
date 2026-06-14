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

import { agentPrincipal, authorizeAgentAction } from '@aipehub/identity'

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
}

/**
 * Map a steward action to the abstract authority verb it would perform, IFF that
 * verb is one of the human-confirm-required ones (`agent-authority.ts`). The MVP
 * action set touches only member agents + workflows — none of which map to
 * `modify_owner_grant` / `delete_audit` / `change_security` — so this returns
 * `null` for every MVP action today. It is a FORWARD-LOOKING backstop: the day a
 * steward action whose verb lands in that closed set is added, it is
 * auto-escalated to a human here, exactly as `agent-authority.ts` predicted
 * ("the actual wiring … lands … when agent-owned resources first exist").
 */
function authorityVerbFor(action: StewardAction): string | null {
  switch (action.kind) {
    // No MVP action maps to a human-confirm verb. Future sensitive actions
    // (e.g. an `add_owner` / `change_security` kind) add their case here.
    default:
      return null
  }
}

/**
 * Classify a proposed action into one of four risk tiers.
 *
 * The order matters: the authority backstop runs FIRST so a future
 * highest-blast-radius action can't slip through as `safe`. Then the explicit
 * per-kind tiering: only `inspect` / `create_agent` / `edit_agent` / a
 * purely-local `edit_workflow` are `safe`; `delete_agent` is `dangerous`; a
 * cross-hub `edit_workflow` is `cross_hub`; `refuse` is `forbidden`.
 */
export function classifyStewardAction(
  action: StewardAction,
  ctx: StewardClassifyContext,
): StewardActionTier {
  const verb = authorityVerbFor(action)
  if (verb && authorizeAgentAction(agentPrincipal(ctx.stewardId), verb).kind === 'requires_human') {
    // An agent-principal steward may not do this alone → at least a human gate.
    return 'dangerous'
  }

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
      // Phase B sensitive writes. B-M1 ships them FAIL-CLOSED as `forbidden` (no
      // operator context exists here yet — a member must never reach them). B-M2
      // adds the `operator` flag to `ctx` that tiers them to the highest second-
      // confirmation tier for an operator while keeping `forbidden` for a member.
      return 'forbidden'
    case 'refuse':
      return 'forbidden' // out-of-scope / sensitive — never executed
  }
}
