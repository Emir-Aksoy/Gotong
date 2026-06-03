/**
 * a2a-outbound.ts — Route B P1-M11b, store-driven outbound A2A agent wiring.
 *
 * Replaces the Phase 18 C-M4 `AIPE_A2A_AGENTS` env blob: outbound A2A agents
 * now live in identity (`a2a_outbound_agents`, M11a) and are materialised onto
 * the hub from there — at boot AND at runtime when an admin edits one (the same
 * "config changes take effect without a restart" seam the MCP registry uses).
 *
 * The credential boundary is unchanged: the row stores `tokenEnv`, the NAME of
 * the env var, never the bearer. The manager resolves the actual token from
 * `process.env[tokenEnv]` at registration time. A row whose env var is unset is
 * "persisted-but-inactive" — kept in the DB, visible in the admin UI, simply
 * not registered (logged once). That is the honest state: configured, but the
 * operator hasn't provisioned its secret yet.
 */

import { A2aRemoteParticipant } from '@aipehub/a2a'
import type { Hub, Logger } from '@aipehub/core'
import type { A2aOutboundAgent } from '@aipehub/identity'

/** The narrow identity slice this manager needs (the real IdentityStore satisfies it). */
export interface A2aAgentSource {
  listA2aAgents(): A2aOutboundAgent[]
  getA2aAgent(id: string): A2aOutboundAgent | null
}

/** Why a given agent is NOT live on the hub right now (for admin feedback / logs). */
export type A2aInactiveReason = 'disabled' | 'token_env_unset' | 'id_conflict' | 'not_found'

export interface A2aRegisterResult {
  /** True iff the agent is registered on the hub after this call. */
  active: boolean
  reason?: A2aInactiveReason
}

export interface A2aOutboundManagerOptions {
  hub: Hub
  source: A2aAgentSource
  logger: Logger
  /** Injectable env reader (defaults to process.env); '' / missing → undefined. */
  readEnv?: (name: string) => string | undefined
}

function defaultReadEnv(name: string): string | undefined {
  const v = process.env[name]
  return v === undefined || v === '' ? undefined : v
}

/**
 * Owns the set of outbound A2A participants WE registered, so it can re-sync a
 * single agent (unregister the old wrapper, register the new one) without
 * touching managed agents, brokers, or any other participant on the hub.
 */
export class A2aOutboundManager {
  private readonly hub: Hub
  private readonly source: A2aAgentSource
  private readonly log: Logger
  private readonly readEnv: (name: string) => string | undefined
  /** ids this manager has live on the hub (a subset of all participant ids). */
  private readonly live = new Set<string>()

  constructor(opts: A2aOutboundManagerOptions) {
    this.hub = opts.hub
    this.source = opts.source
    this.log = opts.logger
    this.readEnv = opts.readEnv ?? defaultReadEnv
  }

  /** Boot: materialise every stored agent. Returns the count actually registered. */
  registerAllFromStore(): number {
    let count = 0
    for (const agent of this.source.listA2aAgents()) {
      if (this.tryRegister(agent).active) count++
    }
    if (count > 0) this.log.info('outbound A2A agents registered', { count })
    return count
  }

  /**
   * Re-sync ONE agent to its current stored state — call after an admin
   * add/update. Unregisters any wrapper we had for this id, then registers a
   * fresh one iff the row is enabled and its token env is set. Returns whether
   * it's live (and if not, why) so the route can surface "saved but inactive".
   */
  refresh(id: string): A2aRegisterResult {
    this.unregister(id)
    const agent = this.source.getA2aAgent(id)
    if (!agent) return { active: false, reason: 'not_found' }
    return this.tryRegister(agent)
  }

  /** Drop the wrapper for this id if we own it (after an admin delete/disable). */
  remove(id: string): void {
    this.unregister(id)
  }

  /** True iff this id is currently a live outbound A2A participant we manage. */
  isLive(id: string): boolean {
    return this.live.has(id)
  }

  /**
   * Read-only liveness probe — answers "is this stored agent live, and if not,
   * why?" WITHOUT mutating the hub. The admin list uses it to render an honest
   * status per row (a token-less row reads as `token_env_unset`, not "running").
   * Mirrors the reason `tryRegister` would return, but touches nothing.
   */
  statusOf(id: string): A2aRegisterResult {
    if (this.live.has(id)) return { active: true }
    const agent = this.source.getA2aAgent(id)
    if (!agent) return { active: false, reason: 'not_found' }
    if (!agent.enabled) return { active: false, reason: 'disabled' }
    if (!this.readEnv(agent.tokenEnv)) return { active: false, reason: 'token_env_unset' }
    // Enabled with its token present, yet not live → its id is owned by another
    // participant (a managed agent / broker) that won the registration race.
    return { active: false, reason: 'id_conflict' }
  }

  private unregister(id: string): void {
    if (!this.live.has(id)) return
    this.hub.unregister(id)
    this.live.delete(id)
  }

  private tryRegister(agent: A2aOutboundAgent): A2aRegisterResult {
    if (!agent.enabled) return { active: false, reason: 'disabled' }
    const token = this.readEnv(agent.tokenEnv)
    if (!token) {
      // Persisted-but-inactive: the operator hasn't provisioned the secret.
      this.log.warn('outbound A2A agent inactive: token env unset', {
        id: agent.id,
        tokenEnv: agent.tokenEnv,
      })
      return { active: false, reason: 'token_env_unset' }
    }
    try {
      this.hub.register(
        new A2aRemoteParticipant({
          id: agent.id,
          capabilities: agent.capabilities,
          url: agent.url,
          token,
          ...(agent.peerId ? { peerId: agent.peerId } : {}),
          ...(agent.targetSkill ? { targetSkill: agent.targetSkill } : {}),
        }),
      )
    } catch (err) {
      // The id collides with an already-registered participant (managed agent,
      // broker, …). Don't crash boot / the admin call — report it.
      this.log.error('outbound A2A agent id conflicts with an existing participant', {
        id: agent.id,
        err: err instanceof Error ? err.message : String(err),
      })
      return { active: false, reason: 'id_conflict' }
    }
    this.live.add(agent.id)
    return { active: true }
  }
}
