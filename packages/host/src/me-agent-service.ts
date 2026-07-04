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
 * Every privileged check lives here, behind the web layer's shape-check, and
 * enforces the viewer < editor < owner grant ladder (Route B P1-M1) via the
 * shared `assertResourceGrant` gate: read needs 'viewer', update 'editor',
 * delete 'owner'. Over-reach by someone who holds a LOWER grant is a 403 + a
 * denial audit; a caller with NO grant gets 404, so a member still can't
 * enumerate other members' agent ids (the 404 is indistinguishable from
 * "doesn't exist", and a blind probe is never audited).
 */

import type {
  AgentRecord,
  Hub,
  ManagedAgentLifecycle,
  ManagedAgentSpec,
  Space,
  ParticipantId,
} from '@gotong/core'
import { createLogger } from '@gotong/core'
import {
  userPrincipal,
  type GrantPerm,
  type Principal,
  type ResourceGrant,
  type ResourceKind,
  type WriteAuditLogInput,
} from '@gotong/identity'
import type { WebServerOptions } from '@gotong/web'

import { assertResourceGrant } from './resource-access.js'

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
  // General ResourceKind (not the 'agent' literal) so this slice satisfies the
  // shared `ResourceGrantGateStore` the access gate consumes.
  hasResourceGrant(
    resourceKind: ResourceKind,
    resourceId: string,
    principal: Principal,
    min: GrantPerm,
  ): boolean
  listPrincipalGrants(principal: Principal): ResourceGrant[]
  removeAllResourceGrants(resourceKind: 'agent', resourceId: string): number
  /**
   * The member's own BYO LLM keys (A-M3). Optional — lean fakes omit it, and
   * then only org/workspace/env providers light up the picker. The real
   * IdentityStore satisfies it, so a member who stored their own anthropic /
   * openai key under `我的密钥` can build a real agent even on a hub the owner
   * never gave an org key — the per-user key already resolves at spawn via
   * OrgApiPool (A-M3a); this just lets the create-form + spawn gate SEE it.
   */
  listVaultEntries?(query: {
    kind: 'llm_provider'
    ownerKind: 'user'
    ownerId: string
    activeOnly?: boolean
  }): Array<{ metadata?: Record<string, unknown> | null }>
  /** Best-effort denial audit (P1-M1). Optional — absent in lean fakes. */
  writeAuditLog?(input: WriteAuditLogInput): unknown
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

  async availableProviders(userId: string): Promise<string[]> {
    const avail = await this.lifecycle.availableProviders()
    // Org/workspace/env providers, narrowed to what a member may pick ('mock'
    // is always in the lifecycle list)...
    const set = new Set(avail.filter((p) => MEMBER_PROVIDERS.has(p)))
    // ...plus any provider this member holds their OWN key for. This is the
    // personal-hub unlock: no org key, but I brought my anthropic key → I can
    // build a real helper, not just a mock one.
    for (const p of this.memberKeyProviders(userId)) set.add(p)
    return [...set]
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

  async read(userId: string, agentId: string): Promise<MeOwnedAgentView> {
    // Reading is the FLOOR of the ladder (P1-M1c): a 'viewer' — or anyone above
    // them — may see the full config (system prompt, model, capabilities); a
    // caller with no grant at all gets 404, never confirming the agent exists.
    // This is what makes a 'viewer' grant do something real, not just record a
    // row: the write verbs (update/remove) already reject below their rung.
    this.assertGrant(userId, agentId, 'viewer')
    const rec = (await this.space.agents()).find((a) => a.id === agentId)
    if (!rec || !rec.managed) {
      // Grant exists but the record is gone (or isn't a managed agent) — ghost.
      throw httpError(404, 'agent not found')
    }
    return projectOwned(rec, this.liveIds().has(agentId))
  }

  async create(userId: string, input: MeAgentInput): Promise<MeOwnedAgentView> {
    const provider = this.assertMemberProvider(input.provider)
    await this.assertProviderHasKey(provider, userId)
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
    // Editing is an EDITOR-level act: a member granted 'editor' on this agent
    // can change its prompt / capabilities / model, but cannot delete it or
    // re-share it (those stay owner-only). owner satisfies 'editor' too.
    this.assertGrant(userId, agentId, 'editor')
    const recs = await this.space.agents()
    const rec = recs.find((a) => a.id === agentId)
    if (!rec || !rec.managed) {
      // Grant exists but the record is gone (or not a managed agent) — ghost.
      throw httpError(404, 'agent not found')
    }

    const managed: ManagedAgentSpec = { ...rec.managed }
    if (input.provider !== undefined) {
      const provider = this.assertMemberProvider(input.provider)
      await this.assertProviderHasKey(provider, userId)
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
    // Deletion is destructive — OWNER only. An editor gets 403, not a delete.
    this.assertGrant(userId, agentId, 'owner')
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

  /**
   * Gate an action behind a minimum grant level on the agent (P1-M1) via the
   * shared `assertResourceGrant` chokepoint: holds >= min → pass; holds a lower
   * grant → 403 + denial audit; no grant → 404 (anti-enumeration).
   */
  private assertGrant(userId: string, agentId: string, min: GrantPerm): void {
    assertResourceGrant(this.identity, userPrincipal(userId), 'agent', agentId, min, {
      notFoundMessage: 'agent not found',
    })
  }

  /** Providers the member holds their OWN vault key for (BYO, A-M3), narrowed
   * to member-allowable providers. Empty when the store slice has no vault
   * access (lean fakes) — the picker then shows only org/workspace providers. */
  private memberKeyProviders(userId: string): Set<string> {
    const out = new Set<string>()
    const rows = this.identity.listVaultEntries?.({
      kind: 'llm_provider',
      ownerKind: 'user',
      ownerId: userId,
      activeOnly: true,
    })
    if (!rows) return out
    for (const row of rows) {
      const p = readVaultProvider(row)
      if (p && MEMBER_PROVIDERS.has(p)) out.add(p)
    }
    return out
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

  private async assertProviderHasKey(provider: string, userId: string): Promise<void> {
    if (provider === 'mock') return
    const avail = await this.lifecycle.availableProviders()
    if (avail.includes(provider)) return
    // BYO fallback (A-M3): a member's own key resolves at spawn via the per-user
    // pool, so it's a valid key source even when the host has no org key here.
    if (this.memberKeyProviders(userId).has(provider)) return
    throw httpError(
      400,
      `no API key for provider '${provider}'. Add your own under 我的密钥, or ask an admin to configure one.`,
    )
  }
}

/** Read the provider tag a BYO key was stored with (vault metadata.provider). */
function readVaultProvider(row: { metadata?: Record<string, unknown> | null }): string | null {
  const m = row.metadata
  if (m && typeof m === 'object') {
    const p = (m as Record<string, unknown>).provider
    if (typeof p === 'string') return p
  }
  return null
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
