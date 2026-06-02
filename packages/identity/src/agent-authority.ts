/**
 * v5 Stream 0-M2 — the agent-as-owner authority boundary.
 *
 * Stream 0-M1 made `agent` a first-class {@link Principal} (it can own and be
 * granted resources, equal to a user). But an agent-owner is NOT equal to a
 * human owner in what it may do UNILATERALLY — decision #2:
 *
 *   > A prompt-injected agent-owner is too dangerous to hand the keys. Give it
 *   > "manage its own resources + spend within budget + send outward", but the
 *   > highest-blast-radius actions — 改最高权限 / 加 owner / 删审计 / 改安全设置 —
 *   > still need a HUMAN second-confirmation, captured as a `requires_human`
 *   > action list.
 *
 * This module is that list + the pure gate. It is intentionally a POLICY, not
 * an enforcement point: the actual wiring (route an agent's sensitive op
 * through a Phase 16 approval inbox before executing) lands with Stream A,
 * when agent-owned resources first exist. Until then the gate is the single
 * source of truth for "what must a human confirm", unit-tested in isolation.
 *
 * The complement is deliberate: anything NOT on this list, an agent-owner does
 * alone. We enumerate the dangerous few, not the safe many — a closed list of
 * human-gated actions is auditable; an open list of agent-allowed actions
 * would silently widen as features land.
 */

import type { Principal } from './principal.js'

/**
 * The high-blast-radius actions an agent principal may NOT perform on its own —
 * each needs a human owner's second confirmation. Verbs are abstract (not tied
 * to a specific table/route) so the same gate guards every enforcement point.
 *
 *   - `modify_owner_grant` — 加 owner + 改最高权限 collapse here: granting,
 *     changing, or revoking OWNER-level access to any principal (the owner tier
 *     is the keys-to-the-kingdom tier; one verb, one enforcement point).
 *   - `delete_audit`       — 删审计: deleting or redacting audit-log entries
 *     (an agent must never be able to erase its own trail).
 *   - `change_security`    — 改安全设置: peer trust policy, vault master key,
 *     security-relevant quotas, and similar hub-safety settings.
 */
export const AGENT_HUMAN_CONFIRM_ACTIONS = [
  'modify_owner_grant',
  'delete_audit',
  'change_security',
] as const
export type AgentHumanConfirmAction = (typeof AGENT_HUMAN_CONFIRM_ACTIONS)[number]

/** Type guard: is `action` one of the human-confirm-required verbs? */
export function isHumanConfirmAction(action: string): action is AgentHumanConfirmAction {
  return (AGENT_HUMAN_CONFIRM_ACTIONS as readonly string[]).includes(action)
}

/**
 * The verdict of the agent-authority gate.
 *   - `allow`          — proceed (a non-agent principal, or a non-sensitive action).
 *   - `requires_human` — an agent tried a high-risk action; the runtime must
 *     route it through a human owner's approval (Phase 16 inbox) before doing it.
 *     `reason` is ready to drop into an approval prompt.
 */
export type AuthorityDecision =
  | { kind: 'allow' }
  | { kind: 'requires_human'; action: AgentHumanConfirmAction; reason: string }

const HUMAN_CONFIRM_REASONS: Record<AgentHumanConfirmAction, string> = {
  modify_owner_grant:
    'An agent cannot grant, change, or revoke owner-level access on its own — a human owner must confirm.',
  delete_audit:
    'An agent cannot delete or redact audit-log entries on its own — a human owner must confirm.',
  change_security:
    'An agent cannot change security settings (peer trust, master key, security quotas) on its own — a human owner must confirm.',
}

/** The human-readable reason a given sensitive action needs confirmation. */
export function describeHumanConfirmAction(action: AgentHumanConfirmAction): string {
  return HUMAN_CONFIRM_REASONS[action]
}

/**
 * Decide whether `principal` may perform `action` UNILATERALLY.
 *
 *   - Non-agent principals (user / hub / peer) → always `allow`: a human owner
 *     IS the human confirmation, and the hub itself / peers are governed by
 *     their own RBAC + federation policy. This gate's whole job is the
 *     agent-owner case.
 *   - An `agent` principal → `allow` for everything EXCEPT the closed
 *     {@link AGENT_HUMAN_CONFIRM_ACTIONS} set, which returns `requires_human`.
 *
 * Note: this gate is about WHAT an agent may do alone, layered ON TOP of the
 * ordinary resource grant check (does the principal have access at all?). A
 * caller runs the grant check first, then this gate for the agent-owner case.
 */
export function authorizeAgentAction(principal: Principal, action: string): AuthorityDecision {
  if (principal.kind !== 'agent') return { kind: 'allow' }
  if (isHumanConfirmAction(action)) {
    return { kind: 'requires_human', action, reason: describeHumanConfirmAction(action) }
  }
  return { kind: 'allow' }
}
