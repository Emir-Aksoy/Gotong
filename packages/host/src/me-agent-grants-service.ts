/**
 * HostMeAgentGrantsService — v5 A-M4. Backs `/api/me/agents/:id/grants` so an
 * agent's OWNER can SHARE it with other principals (user / agent / peer-hub) at
 * viewer / editor / owner, using the unified `resource_grants` table (A-M1).
 *
 * Granting another USER 'owner' is co-ownership: that user then sees the agent
 * in their own `/me` and can manage it (HostMeAgentService gates the very same
 * grant). The viewer < editor < owner ladder is ENFORCED as of Route B P1-M1:
 * an editor can change the agent (M1a) but sharing it stays owner-only here.
 *
 * The constrained door (mirrors HostMeAgentService / HostMeCredentialsService),
 * via the shared `assertResourceGrant` gate:
 *   - sharing requires perm='owner'; a viewer / editor who holds a LOWER grant
 *     over-reaches → 403 + a denial audit row (they hold a grant, so the agent's
 *     existence is already known to them — 403 leaks nothing);
 *   - a caller with NO grant at all → 404, so a member can't enumerate other
 *     members' agent ids (anti-enumeration), and the probe is not audited;
 *   - the host parses + validates the principal against the real Principal enum
 *     (the web layer only shape-checks strings, it has no identity dep);
 *   - an ORPHAN GUARD refuses any set / remove that would leave the resource
 *     with ZERO owners — a member can never accidentally lock everyone out of an
 *     agent (including stripping their own last owner grant).
 *
 * Best-effort audit (`resource_grant_set` / `resource_grant_revoke`) records who
 * shared what with whom — a fault in the audit write never blocks the mutation.
 */

import { createLogger } from '@aipehub/core'
import {
  AUDIT_ACTIONS,
  GRANT_PERMS,
  isPrincipalKind,
  parsePrincipalKey,
  principalKey,
  userPrincipal,
  type GrantPerm,
  type Principal,
  type ResourceGrant,
  type ResourceKind,
  type SetResourceGrantInput,
  type WriteAuditLogInput,
} from '@aipehub/identity'
import type { WebServerOptions } from '@aipehub/web'

import { assertResourceGrant } from './resource-access.js'

const log = createLogger('me-agent-grants')

// Derive the surface contract from the web opts — single source of truth, no
// re-export needed (same pattern as HostMeAgentService / HostMeCredentialsService).
type MeAgentGrantsSurface = NonNullable<WebServerOptions['meAgentGrants']>
type MeGrantView = Awaited<ReturnType<MeAgentGrantsSurface['list']>>[number]
type MeGrantInput = Parameters<MeAgentGrantsSurface['set']>[2]

/** The narrow slice of IdentityStore this service needs (real store satisfies). */
export interface MeAgentGrantsIdentityStore {
  // General ResourceKind + GrantPerm (not the 'agent'/'owner' literals) so this
  // slice satisfies the shared `ResourceGrantGateStore` the access gate consumes
  // — the gate probes the 'viewer' floor to split 403 (over-reach) from 404.
  hasResourceGrant(
    resourceKind: ResourceKind,
    resourceId: string,
    principal: Principal,
    min: GrantPerm,
  ): boolean
  listResourceGrants(resourceKind: 'agent', resourceId: string): ResourceGrant[]
  setResourceGrant(input: SetResourceGrantInput): ResourceGrant
  removeResourceGrant(resourceKind: 'agent', resourceId: string, principal: Principal): boolean
  writeAuditLog?(input: WriteAuditLogInput): unknown
}

export interface HostMeAgentGrantsServiceOpts {
  identity: MeAgentGrantsIdentityStore
}

export class HostMeAgentGrantsService implements MeAgentGrantsSurface {
  private readonly identity: MeAgentGrantsIdentityStore

  constructor(opts: HostMeAgentGrantsServiceOpts) {
    this.identity = opts.identity
  }

  async list(userId: string, agentId: string): Promise<MeGrantView[]> {
    this.assertOwns(userId, agentId)
    return this.identity
      .listResourceGrants('agent', agentId)
      .map((g) => projectGrant(g, userId))
  }

  async set(userId: string, agentId: string, input: MeGrantInput): Promise<MeGrantView> {
    this.assertOwns(userId, agentId)
    const principal = parsePrincipalParts(input.principalKind, input.principalId)
    const perm = assertPerm(input.perm)
    // Orphan guard: a set that moves the LAST owner off 'owner' would leave the
    // agent with zero owners — refuse rather than strand it.
    this.guardOrphan(agentId, principal, perm)
    const g = this.identity.setResourceGrant({
      resourceKind: 'agent',
      resourceId: agentId,
      principal,
      perm,
      grantedBy: userId,
    })
    this.audit(userId, AUDIT_ACTIONS.RESOURCE_GRANT_SET, agentId, principal, perm)
    log.info('member shared agent', { userId, agentId, principal: principalKey(principal), perm })
    return projectGrant(g, userId)
  }

  async remove(userId: string, agentId: string, key: string): Promise<boolean> {
    this.assertOwns(userId, agentId)
    const principal = parseKey(key)
    // Orphan guard: removing the agent's only owner would strand it.
    this.guardOrphan(agentId, principal, null)
    const removed = this.identity.removeResourceGrant('agent', agentId, principal)
    if (removed) this.audit(userId, AUDIT_ACTIONS.RESOURCE_GRANT_REVOKE, agentId, principal, null)
    log.info('member revoked agent grant', { userId, agentId, principal: principalKey(principal), removed })
    return removed
  }

  // -- internals ----------------------------------------------------------

  /**
   * Sharing (list / set / remove grants) is an OWNER-only act. Via the shared
   * gate: an owner passes; a viewer / editor who tries to re-share over-reaches
   * → 403 + a denial audit row (they hold a grant, so existence is known — no
   * enumeration leak); someone with no grant at all → 404 (anti-enumeration).
   */
  private assertOwns(userId: string, agentId: string): void {
    assertResourceGrant(this.identity, userPrincipal(userId), 'agent', agentId, 'owner', {
      notFoundMessage: 'agent not found',
    })
  }

  /**
   * Refuse a mutation that would leave the resource with zero owners.
   * `nextPerm` is the grant's perm AFTER the mutation, or null for a removal.
   * Compute the owner set as it would be post-mutation; empty → reject.
   */
  private guardOrphan(agentId: string, principal: Principal, nextPerm: GrantPerm | null): void {
    const target = principalKey(principal)
    const owners = new Set(
      this.identity
        .listResourceGrants('agent', agentId)
        .filter((g) => g.perm === 'owner')
        .map((g) => principalKey(g.principal)),
    )
    if (nextPerm === 'owner') owners.add(target)
    else owners.delete(target) // a downgrade or a removal both drop target's owner-ness
    if (owners.size === 0) {
      throw httpError(400, 'cannot leave this agent without an owner — grant someone else owner first')
    }
  }

  /** Best-effort audit — a fault here never blocks the grant mutation. */
  private audit(
    userId: string,
    action: string,
    agentId: string,
    principal: Principal,
    perm: GrantPerm | null,
  ): void {
    if (typeof this.identity.writeAuditLog !== 'function') return
    try {
      this.identity.writeAuditLog({
        action,
        // Member acted through their /me session (same as HostInboxService).
        actorSource: 'v4-session',
        actorUserId: userId,
        metadata: {
          resourceKind: 'agent',
          resourceId: agentId,
          principal: principalKey(principal),
          ...(perm ? { perm } : {}),
        },
      })
    } catch (err) {
      log.warn('grant audit write failed', { userId, action, agentId, err })
    }
  }
}

// -- helpers --------------------------------------------------------------

function projectGrant(g: ResourceGrant, callerUserId: string): MeGrantView {
  const key = principalKey(g.principal)
  return {
    principalKind: g.principal.kind,
    principalId: g.principal.id,
    perm: g.perm,
    principalKey: key,
    grantedBy: g.grantedBy,
    grantedAt: g.grantedAt,
    isSelf: g.principal.kind === 'user' && g.principal.id === callerUserId,
  }
}

/** Build + validate a principal from the (already shape-checked) wire parts. */
function parsePrincipalParts(kind: string, id: string): Principal {
  if (!isPrincipalKind(kind)) {
    throw httpError(400, `principalKind must be one of hub, user, agent, peer; got ${JSON.stringify(kind)}`)
  }
  const trimmed = id.trim()
  if (trimmed.length === 0) throw httpError(400, 'principalId is required')
  return { kind, id: trimmed }
}

/** Parse a principalKey ("<kind>:<id>") from the DELETE path; 400 on malformed. */
function parseKey(key: string): Principal {
  try {
    return parsePrincipalKey(key)
  } catch {
    throw httpError(400, `malformed principal key: ${JSON.stringify(key)}`)
  }
}

function assertPerm(perm: string): GrantPerm {
  if (!(GRANT_PERMS as readonly string[]).includes(perm)) {
    throw httpError(400, `perm must be one of ${GRANT_PERMS.join(', ')}`)
  }
  return perm as GrantPerm
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}
