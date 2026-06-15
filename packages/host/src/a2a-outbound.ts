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
import type { Hub, Logger, ParticipantId } from '@aipehub/core'
import type { A2aOutboundAgent } from '@aipehub/identity'
import type { InboxStore } from '@aipehub/inbox'

import { ApprovalGatedParticipant } from './outbound-approval.js'
import { FixedWindowLimiter } from './peer-registry.js'

/** The narrow identity slice this manager needs (the real IdentityStore satisfies it). */
export interface A2aAgentSource {
  listA2aAgents(): A2aOutboundAgent[]
  getA2aAgent(id: string): A2aOutboundAgent | null
}

/**
 * Why a given agent is NOT live on the hub right now (for admin feedback / logs).
 * `approval_unconfigured` (Item 2 Y): the row requires outbound approval but the
 * host has no approver wired (no inbox / no owner) — fail-closed to inactive
 * rather than send ungated.
 */
export type A2aInactiveReason =
  | 'disabled'
  | 'token_env_unset'
  | 'id_conflict'
  | 'not_found'
  | 'approval_unconfigured'

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
  /**
   * Item 2 — window for the per-agent OUTBOUND quota counter
   * (`outboundQuotaBudget` sends per window). Default 60_000. Main.ts passes
   * `AIPE_A2A_OUTBOUND_QUOTA_WINDOW_MS`; tests inject a small value.
   */
  quotaWindowMs?: number
  /**
   * Item 2 (Y) — outbound approval wiring. When an agent row carries
   * `requireApprovalOutbound`, its A2A edge is wrapped in an
   * `ApprovalGatedParticipant` so a person must approve each outbound send from
   * their `/me` inbox before it crosses the boundary (the same machinery the
   * Phase 18 mesh outbound gate uses). BOTH must be present for the gate to
   * engage; main.ts injects the shared inbox store + the org owner (the same
   * approver the ACP escalation uses). If a row requires approval but these are
   * absent, the row is persisted-but-inactive (`approval_unconfigured`) —
   * fail-closed, never an ungated send.
   */
  approvalInbox?: InboxStore
  approver?: ParticipantId
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
  private readonly quotaWindowMs: number
  /** Item 2 (Y) — where a required-approval send parks; undefined → no approver. */
  private readonly approvalInbox: InboxStore | undefined
  /** Item 2 (Y) — the user who approves outbound sends (the org owner). */
  private readonly approver: ParticipantId | undefined
  /** ids this manager has live on the hub (a subset of all participant ids). */
  private readonly live = new Set<string>()
  /**
   * Item 2 — per-agent OUTBOUND quota counters, keyed by agent id. Mirrors
   * peer-registry's `linkQuota`: one `FixedWindowLimiter` per agent, kept across
   * `refresh()` (an edit/toggle must NOT reset the window) and rebuilt ONLY when
   * the operator changes the budget value (tracked alongside). Dropped only when
   * the row truly vanishes (`remove`). An agent with no/zero budget has no entry.
   */
  private readonly outboundQuota = new Map<string, { limiter: FixedWindowLimiter; budget: number }>()

  constructor(opts: A2aOutboundManagerOptions) {
    this.hub = opts.hub
    this.source = opts.source
    this.log = opts.logger
    this.readEnv = opts.readEnv ?? defaultReadEnv
    this.quotaWindowMs = opts.quotaWindowMs ?? 60_000
    this.approvalInbox = opts.approvalInbox
    this.approver = opts.approver
  }

  /** True iff this host can engage an outbound approval gate (inbox + approver). */
  private get canApprove(): boolean {
    return this.approvalInbox !== undefined && this.approver !== undefined
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
    // The row is gone for good → drop its outbound quota counter. (A `refresh`
    // edit/toggle goes through `unregister` too but KEEPS the counter so the
    // window survives; only a real delete reaches here.)
    this.outboundQuota.delete(id)
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
    if (agent.requireApprovalOutbound && !this.canApprove) {
      return { active: false, reason: 'approval_unconfigured' }
    }
    // Enabled with its token present, yet not live → its id is owned by another
    // participant (a managed agent / broker) that won the registration race.
    return { active: false, reason: 'id_conflict' }
  }

  /**
   * Stream H — off-hub capability view for the workflow controller: the stored
   * agents currently LIVE on the hub (`statusOf().active`) with their advertised
   * capabilities, so a workflow step whose capability only an external A2A agent
   * serves can be flagged "leaves the hub". Read-only; a disabled / token-less
   * row is excluded (it's not a reachable destination).
   */
  liveCapabilities(): Array<{ peer: string; label: string | null; capabilities: readonly string[] }> {
    return this.source
      .listA2aAgents()
      .filter((a) => this.statusOf(a.id).active)
      .map((a) => ({ peer: a.id, label: a.label, capabilities: a.capabilities }))
  }

  private unregister(id: string): void {
    if (!this.live.has(id)) return
    this.hub.unregister(id)
    this.live.delete(id)
  }

  /**
   * Item 2 — the outbound quota gate closure for one agent, or undefined when it
   * has no budget. Mirrors peer-registry's `inboundQuotaGate`: a per-agent
   * `FixedWindowLimiter` reused across refreshes, rebuilt only when the budget
   * changes. The closure debits one send per call; over budget → false, which the
   * participant turns into a fail-closed `outbound_quota_exceeded`. A 0/cleared
   * budget drops any stale counter and leaves the gate off (legacy accept-all).
   */
  private outboundQuotaGateFor(agent: A2aOutboundAgent): (() => boolean) | undefined {
    const budget = agent.outboundQuotaBudget
    if (!budget || budget <= 0) {
      this.outboundQuota.delete(agent.id)
      return undefined
    }
    const existing = this.outboundQuota.get(agent.id)
    let limiter: FixedWindowLimiter
    if (existing && existing.budget === budget) {
      limiter = existing.limiter
    } else {
      limiter = new FixedWindowLimiter(budget, this.quotaWindowMs)
      this.outboundQuota.set(agent.id, { limiter, budget })
    }
    const id = agent.id
    return () => limiter.attempt(id)
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
    // Item 2 (Y) — an agent that requires outbound approval but has no approver
    // wired must NOT register ungated (that would silently bypass the gate the
    // operator asked for). Persisted-but-inactive, surfaced in the admin UI.
    if (agent.requireApprovalOutbound && !this.canApprove) {
      this.log.warn('outbound A2A agent inactive: approval required but no approver configured', {
        id: agent.id,
      })
      return { active: false, reason: 'approval_unconfigured' }
    }
    const inner = new A2aRemoteParticipant({
      id: agent.id,
      capabilities: agent.capabilities,
      url: agent.url,
      token,
      ...(agent.peerId ? { peerId: agent.peerId } : {}),
      ...(agent.targetSkill ? { targetSkill: agent.targetSkill } : {}),
      // Stream H2-OUT — opt into the long-running poll lifecycle iff the row
      // carries it (NULL = blocking, the legacy default). The column maps 1:1
      // to the participant's `lifecycle?` option ({pollIntervalMs?,maxAttempts?}),
      // so a stored `{}` reaches here and opts in with participant defaults.
      ...(agent.lifecycle ? { lifecycle: agent.lifecycle } : {}),
      // Item 2 — route this outbound edge through the SAME P4-M4 chokepoint
      // mesh peers use: per-step data-class gate (reuses core
      // `checkOutboundDataClasses`, no drift) + per-agent outbound quota.
      // null/undefined allowedDataClasses = no contract (legacy accept-all);
      // the quota gate is undefined unless a budget is set.
      allowedDataClasses: agent.allowedDataClasses,
      outboundQuotaGate: this.outboundQuotaGateFor(agent),
    })
    // Item 2 (Y) — wrap in the outbound approval gate when the row asks for it.
    // The gate delegates id + capabilities to `inner`, so the hub still routes
    // this edge for the agent's capabilities; it parks each send for a `/me`
    // approval first (and — via the D4 onResume delegation — still relays a
    // lifecycle inner's `tasks/get` polls after approval). `canApprove` is
    // guaranteed true here by the precondition above.
    const participant =
      agent.requireApprovalOutbound && this.approvalInbox && this.approver
        ? new ApprovalGatedParticipant({
            inner,
            store: this.approvalInbox,
            approver: this.approver,
            peerLabel: agent.label ?? agent.id,
          })
        : inner
    try {
      this.hub.register(participant)
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
