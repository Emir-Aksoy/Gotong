/**
 * HostOperatorAgentService — SW-M9 A-M2. The OPERATOR-console steward's agent
 * executor: the SAME `StewardAgentDirectory` contract `HostMeAgentService`
 * satisfies, but SITE-WIDE.
 *
 * Where the member service is fenced to `me.<userId>.*` agents the caller owns
 * (the resource_grants ladder + member provider narrowing + a per-member cap),
 * the operator service manages EVERY managed agent on the hub — the exact write
 * path `agents-routes.ts` runs for an admin:
 *
 *   create  → space.upsertAgent (persist) → seed the operator as owner →
 *             lifecycle.start (spawn); roll back persist + grant on a spawn fail.
 *   update  → space.upsertAgent (re-persist) → lifecycle.start (respawn).
 *   remove  → lifecycle.stop → space.removeAgent → drop grants →
 *             lifecycle.onAgentRemoved.
 *
 * The privilege gap vs the member service is DELIBERATE and bounded by WHERE this
 * is wired, not by a runtime flag: it is only ever constructed for the operator
 * steward (`OPERATOR_STEWARD_IDS`) behind `requireAdmin` + a server-resolved
 * operator userId (A-M6). The member steward NEVER receives this directory — it
 * gets `HostMeAgentService` — so a member's chat input can't reach a site-wide
 * write even if the classifier missed something. The privilege IS the injected
 * dependency (defense in depth: A-M1's disjoint ids + this disjoint executor).
 *
 * Same input / result shapes as the member service (the `StewardAgentDirectory`
 * contract), so it drops straight into `performStewardAction` with ZERO changes
 * to the chokepoint. The steward action vocabulary already keeps built agents
 * simple — anthropic / openai / mock, no baseURL / inline key / MCP — so operator
 * infra (openai-compatible, per-agent keys) stays in the admin form, not here.
 */

import type {
  AgentRecord,
  ManagedAgentLifecycle,
  ManagedAgentSpec,
  Space,
} from '@gotong/core'
import { createLogger } from '@gotong/core'
import { userPrincipal, type Principal } from '@gotong/identity'

import type { StewardAgentDirectory, StewardOwnedAgent } from './hub-steward-service.js'

const log = createLogger('operator-agent')

// Input shapes for the write verbs, DERIVED from the `StewardAgentDirectory`
// contract so this service is GUARANTEED to satisfy it (the same `Parameters<…>`
// discipline the member service tracks the web opts with). A test never
// constructs these — it only passes them in.
type OperatorAgentCreateInput = Parameters<StewardAgentDirectory['create']>[1]
type OperatorAgentUpdateInput = Parameters<StewardAgentDirectory['update']>[2]

/**
 * The narrow ownership-grant slice the operator service writes — best-effort,
 * mirroring `agents-routes.ts` `seedAgentOwner`: an operator who builds a
 * site-wide agent is recorded as its owner (so it shows up if they later share it
 * via the `/me` access UI), and the grant is dropped on delete so a re-create
 * with the same id starts clean. The real `IdentityStore` satisfies it; a lean
 * test passes a recording fake. Absent ⇒ create / delete still work (an operator
 * bypasses RBAC anyway), just without recording the owner row.
 */
export interface OperatorAgentGrantStore {
  setResourceGrant(input: {
    resourceKind: 'agent'
    resourceId: string
    principal: Principal
    perm: 'owner'
    grantedBy?: string | null
  }): unknown
  removeAllResourceGrants(resourceKind: 'agent', resourceId: string): number
}

export interface HostOperatorAgentServiceOpts {
  space: Space
  lifecycle: ManagedAgentLifecycle
  /** Best-effort owner-grant seed + cleanup (mirrors `seedAgentOwner`). Optional. */
  grants?: OperatorAgentGrantStore
  /** Best-effort heartbeat reconcile after a write (parked wake-up rows). Optional. */
  reconcileHeartbeats?: () => Promise<void>
}

export class HostOperatorAgentService implements StewardAgentDirectory {
  private readonly space: Space
  private readonly lifecycle: ManagedAgentLifecycle
  private readonly grants: OperatorAgentGrantStore | undefined
  private readonly reconcileHeartbeats: (() => Promise<void>) | undefined

  constructor(opts: HostOperatorAgentServiceOpts) {
    this.space = opts.space
    this.lifecycle = opts.lifecycle
    this.grants = opts.grants
    this.reconcileHeartbeats = opts.reconcileHeartbeats
  }

  /** The full operator provider set (org / workspace / env keys). NOT narrowed to
   * the member subset — though the steward action vocabulary still constrains a
   * built agent to anthropic / openai / mock (no baseURL field), so an
   * openai-compatible key here just never gets picked by a `create_agent`. */
  async availableProviders(): Promise<string[]> {
    return [...(await this.lifecycle.availableProviders())]
  }

  /** The operator "owns" the whole site — list EVERY managed agent. Externally
   * connected / unmanaged participants have no editable spec, so they're excluded
   * (the steward can only build / edit managed agents). */
  async listOwned(): Promise<StewardOwnedAgent[]> {
    const recs = await this.space.agents()
    const out: StewardOwnedAgent[] = []
    for (const rec of recs) {
      if (rec.managed) out.push(projectOwned(rec))
    }
    return out
  }

  async create(userId: string, input: OperatorAgentCreateInput): Promise<StewardOwnedAgent> {
    const provider = await this.assertProviderHasKey(input.provider)
    const id = validateOperatorAgentId(input.id)

    const existing = await this.space.agents()
    if (existing.some((a) => a.id === id)) {
      throw httpError(409, `agent '${id}' already exists; edit it instead`)
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
    // owner row we can roll back (mirrors the member service ordering).
    this.seedOwner(userId, id)

    try {
      await this.lifecycle.start(persisted)
    } catch (err) {
      await this.space.removeAgent(id).catch(() => {})
      this.removeGrants(id)
      throw httpError(400, `could not start agent: ${errMsg(err)}`)
    }
    await this.reconcile('create')
    log.info('operator created agent', { userId, id, provider })
    return projectOwned(persisted)
  }

  async update(
    userId: string,
    agentId: string,
    input: OperatorAgentUpdateInput,
  ): Promise<StewardOwnedAgent> {
    const recs = await this.space.agents()
    const rec = recs.find((a) => a.id === agentId)
    if (!rec || !rec.managed) {
      throw httpError(404, 'agent not found')
    }

    const managed: ManagedAgentSpec = { ...rec.managed }
    if (input.provider !== undefined) {
      managed.provider = await this.assertProviderHasKey(input.provider)
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
    await this.reconcile('edit')
    log.info('operator updated agent', { userId, id: agentId })
    return projectOwned(persisted)
  }

  async remove(userId: string, agentId: string): Promise<boolean> {
    // Tear down live participant first (best-effort), then persistence, then
    // grants, then per-plugin cleanup — the exact `agents-routes.ts` DELETE order.
    await this.lifecycle.stop(agentId).catch((err) => log.warn('stop failed', { agentId, err }))
    const removed = await this.space.removeAgent(agentId)
    this.removeGrants(agentId)
    if (this.lifecycle.onAgentRemoved) {
      await this.lifecycle
        .onAgentRemoved(agentId)
        .catch((err) => log.warn('onAgentRemoved failed', { agentId, err }))
    }
    await this.reconcile('delete')
    log.info('operator removed agent', { userId, id: agentId, removed })
    return removed
  }

  // -- internals ----------------------------------------------------------

  /** Validate the provider has a usable key (or is mock) and return it as the
   * managed-spec provider type. Operator scope = no member narrowing, but a
   * provider with no key would only fail confusingly at spawn, so reject early. */
  private async assertProviderHasKey(provider: string): Promise<ManagedAgentSpec['provider']> {
    if (provider === 'mock') return 'mock'
    const avail = await this.lifecycle.availableProviders()
    if (!avail.includes(provider)) {
      throw httpError(400, `no API key for provider '${provider}'; configure one in 设置 first`)
    }
    return provider as ManagedAgentSpec['provider']
  }

  private seedOwner(userId: string, agentId: string): void {
    if (!this.grants) return
    try {
      this.grants.setResourceGrant({
        resourceKind: 'agent',
        resourceId: agentId,
        principal: userPrincipal(userId),
        perm: 'owner',
        grantedBy: userId,
      })
    } catch (err) {
      log.warn('operator seed owner failed', { agentId, err })
    }
  }

  private removeGrants(agentId: string): void {
    if (!this.grants) return
    try {
      this.grants.removeAllResourceGrants('agent', agentId)
    } catch (err) {
      log.warn('operator grant cleanup failed', { agentId, err })
    }
  }

  private async reconcile(reason: string): Promise<void> {
    if (!this.reconcileHeartbeats) return
    await this.reconcileHeartbeats().catch((err) =>
      log.warn('operator heartbeat reconcile failed', { reason, err }),
    )
  }
}

// -- helpers --------------------------------------------------------------

/**
 * Validate a SITE-WIDE agent id. Unlike the member service (which composes a
 * namespaced `me.<userId>.<handle>`), an operator names agents directly — so the
 * id must match the same charset + length `agents-routes.ts` enforces for an
 * admin-created agent. A bad id fails loudly here rather than at persist.
 */
function validateOperatorAgentId(id: string): string {
  if (typeof id !== 'string' || id.length === 0) throw httpError(400, 'agent id is required')
  if (id.length > 80) throw httpError(400, 'agent id too long (max 80)')
  if (!/^[a-zA-Z0-9_.:-]+$/.test(id)) {
    throw httpError(400, "agent id may only contain letters, digits, '_', '.', ':', '-'")
  }
  return id
}

function projectOwned(rec: AgentRecord): StewardOwnedAgent {
  const m = rec.managed
  const out: StewardOwnedAgent = {
    id: rec.id,
    label: rec.displayName ?? rec.id,
    capabilities: [...rec.allowedCapabilities],
    provider: m?.provider ?? '',
  }
  if (m?.model) out.model = m.model
  return out
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
