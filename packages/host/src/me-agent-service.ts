/**
 * HostMeAgentService — v5 A-M2. Backs `/api/me/agents` create / list-owned /
 * update / delete so a member can build and manage THEIR OWN helpers (not just
 * see the read-only directory).
 *
 * Ownership is a `resource_grants` row (kind='agent', perm='owner', principal=
 * the member's user) — the one grant model from v5 A-M1, never a field on the
 * agent record. The agent itself rides the exact same machinery admin-created
 * agents do: `space.upsertAgent` to persist, `lifecycle.start` to spawn. The
 * member just gets a constrained door:
 *
 *   - the participant id is HOST-composed `me.<userId>.<handle>` — a member
 *     can't squat or reach into another member's namespace, the same "scope
 *     from the session, never a client value" rule the uploads surface uses;
 *   - no inline API key / baseURL / services / MCP — those are admin infra or
 *     credentials (A-M3); a member agent draws on the org / workspace key pool,
 *     so its spend is quota-gated by Phase 17 via task.origin like any dispatch;
 *   - the provider must be one the host already has a key for;
 *   - a per-member count cap keeps the roster from being a DoS vector.
 *
 * Every privileged check lives here, behind the web layer's shape-check. Errors
 * carry an HTTP `status` for the route to surface; "not yours" is reported as
 * 404 (not 403) so a member can't enumerate other members' agent ids.
 */

import type {
  AgentRecord,
  Hub,
  ManagedAgentLifecycle,
  ManagedAgentSpec,
  Space,
  ParticipantId,
} from '@aipehub/core'
import { createLogger } from '@aipehub/core'
import { userPrincipal, type Principal, type ResourceGrant } from '@aipehub/identity'
import type { WebServerOptions } from '@aipehub/web'

const log = createLogger('me-agent')

// Derive the exact surface contract from the web opts so this stays the single
// source of truth — web need not re-export the interface.
type MeAgentAdminSurface = NonNullable<WebServerOptions['meAgentAdmin']>
type MeOwnedAgentView = Awaited<ReturnType<MeAgentAdminSurface['create']>>
type MeAgentInput = Parameters<MeAgentAdminSurface['create']>[1]

/** The narrow slice of IdentityStore this service needs (real store satisfies). */
export interface MeAgentOwnershipStore {
  setResourceGrant(input: {
    resourceKind: 'agent'
    resourceId: string
    principal: Principal
    perm: 'owner'
    grantedBy?: string | null
  }): unknown
  hasResourceGrant(
    resourceKind: 'agent',
    resourceId: string,
    principal: Principal,
    min: 'owner',
  ): boolean
  listPrincipalGrants(principal: Principal): ResourceGrant[]
  removeAllResourceGrants(resourceKind: 'agent', resourceId: string): number
}

/** Providers a MEMBER may pick. `openai-compatible` is excluded — it needs a
 * baseURL, which is operator infra, not a member choice. */
const MEMBER_PROVIDERS = new Set(['anthropic', 'openai', 'mock'])

export interface HostMeAgentServiceOpts {
  space: Space
  hub: Hub
  identity: MeAgentOwnershipStore
  lifecycle: ManagedAgentLifecycle
  /** Max agents one member may own. Default 20 — an anti-DoS ceiling, not policy. */
  maxPerMember?: number
}

export class HostMeAgentService implements MeAgentAdminSurface {
  private readonly space: Space
  private readonly hub: Hub
  private readonly identity: MeAgentOwnershipStore
  private readonly lifecycle: ManagedAgentLifecycle
  private readonly maxPerMember: number

  constructor(opts: HostMeAgentServiceOpts) {
    this.space = opts.space
    this.hub = opts.hub
    this.identity = opts.identity
    this.lifecycle = opts.lifecycle
    this.maxPerMember = opts.maxPerMember ?? 20
  }

  async availableProviders(): Promise<string[]> {
    const avail = await this.lifecycle.availableProviders()
    // Intersect with member-allowable providers; 'mock' is always available.
    return avail.filter((p) => MEMBER_PROVIDERS.has(p))
  }

  async listOwned(userId: string): Promise<MeOwnedAgentView[]> {
    const ownedIds = this.ownedAgentIds(userId)
    if (ownedIds.size === 0) return []
    const recs = await this.space.agents()
    const live = this.liveIds()
    const out: MeOwnedAgentView[] = []
    for (const rec of recs) {
      if (ownedIds.has(rec.id)) out.push(projectOwned(rec, live.has(rec.id)))
    }
    return out
  }

  async create(userId: string, input: MeAgentInput): Promise<MeOwnedAgentView> {
    const provider = this.assertMemberProvider(input.provider)
    await this.assertProviderHasKey(provider)
    const id = composeAgentId(userId, input.id)

    const existing = await this.space.agents()
    if (existing.some((a) => a.id === id)) {
      throw httpError(409, `you already have an agent named '${input.id}'`)
    }
    if (this.ownedAgentIds(userId).size >= this.maxPerMember) {
      throw httpError(400, `agent limit reached (${this.maxPerMember} per member)`)
    }

    const managed: ManagedAgentSpec = { kind: 'llm', provider, system: input.system }
    if (input.model) managed.model = input.model
    const persisted = await this.space.upsertAgent({
      id,
      allowedCapabilities: [...input.capabilities],
      managed,
      displayName: input.label,
    })

    // Record ownership BEFORE spawning so a spawn failure still leaves a clean
    // owner row we can roll back. grantedBy = the member (they own it).
    this.identity.setResourceGrant({
      resourceKind: 'agent',
      resourceId: id,
      principal: userPrincipal(userId),
      perm: 'owner',
      grantedBy: userId,
    })

    try {
      await this.lifecycle.start(persisted)
    } catch (err) {
      // Undo: a half-created agent the member can't run is worse than none.
      await this.space.removeAgent(id).catch(() => {})
      try {
        this.identity.removeAllResourceGrants('agent', id)
      } catch (e) {
        log.warn('rollback grant remove failed', { id, err: e })
      }
      throw httpError(400, `could not start agent: ${errMsg(err)}`)
    }
    log.info('member created agent', { userId, id, provider })
    return projectOwned(persisted, this.liveIds().has(id))
  }

  async update(
    userId: string,
    agentId: string,
    input: Partial<Omit<MeAgentInput, 'id'>>,
  ): Promise<MeOwnedAgentView> {
    this.assertOwns(userId, agentId)
    const recs = await this.space.agents()
    const rec = recs.find((a) => a.id === agentId)
    if (!rec || !rec.managed) {
      // Grant exists but the record is gone (or not a managed agent) — ghost.
      throw httpError(404, 'agent not found')
    }

    const managed: ManagedAgentSpec = { ...rec.managed }
    if (input.provider !== undefined) {
      const provider = this.assertMemberProvider(input.provider)
      await this.assertProviderHasKey(provider)
      managed.provider = provider
    }
    if (input.system !== undefined) managed.system = input.system
    if (input.model !== undefined) {
      if (input.model) managed.model = input.model
      else delete managed.model
    }

    const next: Omit<AgentRecord, 'createdAt'> & { createdAt?: string } = {
      id: agentId,
      allowedCapabilities: input.capabilities ? [...input.capabilities] : [...rec.allowedCapabilities],
      managed,
      displayName: input.label ?? rec.displayName,
      createdAt: rec.createdAt,
    }
    const persisted = await this.space.upsertAgent(next)
    await this.lifecycle.start(persisted) // respawn with the new config
    log.info('member updated agent', { userId, id: agentId })
    return projectOwned(persisted, this.liveIds().has(agentId))
  }

  async remove(userId: string, agentId: string): Promise<boolean> {
    this.assertOwns(userId, agentId)
    // Tear down the live participant first (best-effort), then persistence,
    // then grants, then per-plugin service data (best-effort cleanup hook).
    await this.lifecycle.stop(agentId).catch((err) => log.warn('stop failed', { agentId, err }))
    const removed = await this.space.removeAgent(agentId)
    try {
      this.identity.removeAllResourceGrants('agent', agentId)
    } catch (err) {
      log.warn('grant cleanup failed', { agentId, err })
    }
    if (this.lifecycle.onAgentRemoved) {
      await this.lifecycle.onAgentRemoved(agentId).catch((err) =>
        log.warn('onAgentRemoved failed', { agentId, err }),
      )
    }
    log.info('member removed agent', { userId, id: agentId, removed })
    return removed
  }

  // -- internals ----------------------------------------------------------

  /** Throw 404 (not 403) when `userId` doesn't own `agentId` — no enumeration. */
  private assertOwns(userId: string, agentId: string): void {
    if (!this.identity.hasResourceGrant('agent', agentId, userPrincipal(userId), 'owner')) {
      throw httpError(404, 'agent not found')
    }
  }

  private ownedAgentIds(userId: string): Set<string> {
    const grants = this.identity.listPrincipalGrants(userPrincipal(userId))
    const ids = new Set<string>()
    for (const g of grants) {
      if (g.resourceKind === 'agent' && g.perm === 'owner') ids.add(g.resourceId)
    }
    return ids
  }

  private liveIds(): Set<ParticipantId> {
    return new Set(this.hub.participants().map((p) => p.id))
  }

  private assertMemberProvider(provider: string): ManagedAgentSpec['provider'] {
    if (!MEMBER_PROVIDERS.has(provider)) {
      throw httpError(400, `provider must be one of ${[...MEMBER_PROVIDERS].join(', ')}`)
    }
    return provider as ManagedAgentSpec['provider']
  }

  private async assertProviderHasKey(provider: string): Promise<void> {
    if (provider === 'mock') return
    const avail = await this.lifecycle.availableProviders()
    if (!avail.includes(provider)) {
      throw httpError(400, `no API key configured for provider '${provider}'`)
    }
  }
}

// -- helpers --------------------------------------------------------------

/** Compose + validate the namespaced participant id. The whole id must match
 * the agent-id charset; a userId with odd characters fails loudly here. */
function composeAgentId(userId: string, handle: string): string {
  const id = `me.${userId}.${handle}`
  if (id.length > 120 || !/^[a-zA-Z0-9_.:-]+$/.test(id)) {
    throw httpError(400, 'could not derive a valid agent id from your account + handle')
  }
  return id
}

function projectOwned(rec: AgentRecord, online: boolean): MeOwnedAgentView {
  const m = rec.managed
  return {
    id: rec.id,
    label: rec.displayName ?? rec.id,
    capabilities: [...rec.allowedCapabilities],
    online,
    provider: m?.provider ?? '',
    ...(m?.model ? { model: m.model } : {}),
    system: m?.system ?? '',
    createdAt: rec.createdAt,
  }
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
