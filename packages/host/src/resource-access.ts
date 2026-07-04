/**
 * resource-access.ts — Route B P1-M1. The single chokepoint for enforcing the
 * viewer < editor < owner grant ladder behind a member action, so every /me
 * surface gates identically instead of each re-deriving "owner-only, 404 if
 * not". The plan's "接到所有受保护路由" — one primitive, every protected route.
 *
 * `assertResourceGrant` resolves an action to one of three outcomes:
 *   - holds >= `min`        → returns (allowed).
 *   - holds a LOWER grant   → throws 403 + writes a `resource_access_denied`
 *                             audit row. They already hold *a* grant, so the
 *                             resource's existence is known to them; 403 leaks
 *                             nothing and is the honest answer to over-reach.
 *   - holds NO grant at all  → throws 404, indistinguishable from "doesn't
 *                             exist". Never confirm a resource a member has no
 *                             relationship with (anti-enumeration). This path is
 *                             NOT audited: a blind probe is noise, not an event.
 *
 * The store slice is the general `ResourceKind` signature (the real
 * IdentityStore satisfies it), so the gate is reusable across agent / workflow /
 * credential surfaces, not bound to one kind.
 */

import { createLogger } from '@gotong/core'
import {
  AUDIT_ACTIONS,
  principalKey,
  type GrantPerm,
  type Principal,
  type ResourceKind,
  type WriteAuditLogInput,
} from '@gotong/identity'

const log = createLogger('resource-access')

/** The narrow identity slice the gate needs (the real IdentityStore satisfies). */
export interface ResourceGrantGateStore {
  hasResourceGrant(
    resourceKind: ResourceKind,
    resourceId: string,
    principal: Principal,
    min: GrantPerm,
  ): boolean
  /** Best-effort denial audit. Optional — absent in lean fakes. */
  writeAuditLog?(input: WriteAuditLogInput): unknown
}

/** A plain Error carrying an HTTP status for the route's catch to surface. */
export interface HttpStatusError extends Error {
  status: number
}

function httpError(status: number, message: string): HttpStatusError {
  return Object.assign(new Error(message), { status })
}

/**
 * Gate an action behind a minimum grant level. `actor` is the principal whose
 * grant is checked (a user today, an agent / peer once those subjects act). On
 * over-privilege the denial is attributed to `actor` in the audit row.
 */
export function assertResourceGrant(
  store: ResourceGrantGateStore,
  actor: Principal,
  resourceKind: ResourceKind,
  resourceId: string,
  min: GrantPerm,
  opts?: { notFoundMessage?: string },
): void {
  if (store.hasResourceGrant(resourceKind, resourceId, actor, min)) return
  // Insufficient. Does the actor hold ANY grant (>= viewer, the floor)?
  if (store.hasResourceGrant(resourceKind, resourceId, actor, 'viewer')) {
    auditDenied(store, actor, resourceKind, resourceId, min)
    throw httpError(403, `requires '${min}' permission on this ${resourceKind}`)
  }
  throw httpError(404, opts?.notFoundMessage ?? `${resourceKind} not found`)
}

/** Best-effort over-privilege audit — a fault here never changes the 403. */
function auditDenied(
  store: ResourceGrantGateStore,
  actor: Principal,
  resourceKind: ResourceKind,
  resourceId: string,
  required: GrantPerm,
): void {
  if (typeof store.writeAuditLog !== 'function') return
  try {
    store.writeAuditLog({
      action: AUDIT_ACTIONS.RESOURCE_ACCESS_DENIED,
      actorSource: 'v4-session',
      // actorUserId is the human column; a non-user subject rides metadata.actor.
      actorUserId: actor.kind === 'user' ? actor.id : null,
      success: false, // an explicit authorization failure, like login_failure
      metadata: { resourceKind, resourceId, required, actor: principalKey(actor) },
    })
  } catch (err) {
    log.warn('denial audit write failed', { resourceKind, resourceId, required, err })
  }
}
