/**
 * v5 Stream 0 — the unified Principal vocabulary.
 *
 * Before v5 the codebase grew several scattered "who" enumerations:
 *   - vault `OwnerKind` = 'user' | 'org' | 'peer'  (identity/types.ts)
 *   - services-sdk `Owner.kind` = 'agent' | 'workflow-run' | 'shared' | … (runtime scope)
 *   - web `WorkflowActor` = { userId, isOperator }  (RBAC context)
 *   - workflow_grants — a user-id-only "principal" (Phase 19 P2-M5)
 *
 * v5's mental model collapses the "org vs hub" distinction — a hub IS its own
 * org; there is no separate org entity (see `docs/zh/ledger/V5-0-FINAL.md`). So we
 * name ONE principal type that everything authz/ownership related speaks:
 *
 *   - 'hub'   — the hub ITSELF (the artist formerly known as 'org'): a
 *               hub-level / shared owner, not scoped to any single member.
 *   - 'user'  — a human member of this hub.
 *   - 'agent' — a managed agent on this hub. NEW in v5: this is what makes an
 *               agent a first-class owner (Stream 0-M2), so an agent can own
 *               and run a hub of its own.
 *   - 'peer'  — a federated peer hub.
 *
 * This module is PURE vocabulary + pure helpers — no table, no migration, no
 * runtime wiring. It is the foundation that:
 *   - Stream 0-M2 (agent-as-owner) builds the `requires_human` gate on;
 *   - Stream A's `resource_grants` table is BORN speaking (its principal
 *     column is a {@link principalKey}).
 * Existing vault / services owners keep their own strings and bridge through
 * {@link principalFromVaultOwner} / {@link principalToVaultOwner} — nothing
 * that exists today changes.
 */

import type { OwnerKind } from './types.js'

/** The kinds of "who" that can own, or be granted access to, a resource. */
export const PRINCIPAL_KINDS = ['hub', 'user', 'agent', 'peer'] as const
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number]

/**
 * A who — the subject of ownership or a grant. `(kind, id)` uniquely identifies
 * it within a hub. Serialize with {@link principalKey} for a single-column
 * storage form.
 */
export interface Principal {
  kind: PrincipalKind
  /**
   * The id within `kind`. For 'hub' it is the hub's self-id, or the
   * {@link HUB_SELF_ID} sentinel when referring to "this hub" without spelling
   * out a concrete id (mirrors services-sdk's `ORG_SELF_ID = 'self'`).
   */
  id: string
}

/** Sentinel id for "this hub itself" when the concrete self-id isn't needed. */
export const HUB_SELF_ID = 'self'

/** The hub-itself principal — hub-level / shared ownership (was ownerKind='org'). */
export const HUB_PRINCIPAL: Principal = { kind: 'hub', id: HUB_SELF_ID }

/** Type guard for a {@link PrincipalKind} string. */
export function isPrincipalKind(s: string): s is PrincipalKind {
  return (PRINCIPAL_KINDS as readonly string[]).includes(s)
}

// --- Convenience constructors (readability at call sites) --------------------

export const userPrincipal = (id: string): Principal => ({ kind: 'user', id })
export const agentPrincipal = (id: string): Principal => ({ kind: 'agent', id })
export const peerPrincipal = (id: string): Principal => ({ kind: 'peer', id })
/** The hub itself; pass a concrete self-id, or omit for the {@link HUB_SELF_ID} sentinel. */
export const hubPrincipal = (id: string = HUB_SELF_ID): Principal => ({ kind: 'hub', id })

// --- Storage key codec -------------------------------------------------------

/**
 * Canonical storage / dedup key for a principal — `"<kind>:<id>"`. Stable and
 * round-trippable via {@link parsePrincipalKey}. Stream A's `resource_grants`
 * uses this as its TEXT principal column so one column holds any principal.
 */
export function principalKey(p: Principal): string {
  return `${p.kind}:${p.id}`
}

/**
 * Parse a {@link principalKey}. Throws on a malformed or unknown-kind string so
 * a corrupt grant row fails VISIBLY (rather than silently granting nobody or
 * the wrong subject). Only the FIRST ':' splits — ids may themselves contain
 * colons (e.g. a peer hub id).
 */
export function parsePrincipalKey(key: string): Principal {
  const i = key.indexOf(':')
  if (i <= 0 || i === key.length - 1) {
    throw new Error(`malformed principal key: ${JSON.stringify(key)}`)
  }
  const kind = key.slice(0, i)
  if (!isPrincipalKind(kind)) {
    throw new Error(`unknown principal kind: ${JSON.stringify(kind)}`)
  }
  return { kind, id: key.slice(i + 1) }
}

// --- Bridges to the existing vault owner taxonomy ----------------------------
//
// The org→hub convergence is exactly these two functions: vault still stores
// ('org', NULL) for hub-level credentials; the unified vocabulary calls that
// the 'hub' principal. Both directions are total for the kinds vault knows
// today ('user' | 'org' | 'peer'); 'agent' is a Stream-A-onward principal that
// vault does not own yet.

/**
 * Bridge a vault {@link OwnerKind} + ownerId to a {@link Principal}. 'org'
 * (hub-level, ownerId usually NULL) → the 'hub' principal; 'user'/'peer' pass
 * straight through (NULL id → {@link HUB_SELF_ID} as a defensive default).
 */
export function principalFromVaultOwner(ownerKind: OwnerKind, ownerId: string | null): Principal {
  if (ownerKind === 'org') return { kind: 'hub', id: ownerId ?? HUB_SELF_ID }
  return { kind: ownerKind, id: ownerId ?? HUB_SELF_ID }
}

/**
 * Inverse of {@link principalFromVaultOwner}: a 'hub' principal becomes the
 * vault's legacy ('org', NULL-when-sentinel) so existing vault rows and queries
 * are unchanged. Throws for 'agent' — vault has no agent owner kind today, and
 * surfacing that as a silent miswrite would be worse than a visible error.
 */
export function principalToVaultOwner(p: Principal): { ownerKind: OwnerKind; ownerId: string | null } {
  if (p.kind === 'hub') return { ownerKind: 'org', ownerId: p.id === HUB_SELF_ID ? null : p.id }
  if (p.kind === 'agent') {
    throw new Error('agent principals are not vault owners yet (Stream A)')
  }
  return { ownerKind: p.kind, ownerId: p.id }
}
