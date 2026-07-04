/**
 * acp-outbound.ts — ACP-OUT-M2, store-driven outbound ACP agent wiring.
 *
 * Folds the OpenClaw-style ACP adapter into the production host so a
 * workflow-loaded hub can drive Claude Code / Codex from admin config — not just
 * from example glue on a terminal. Outbound ACP agents live in identity
 * (`acp_outbound_agents`, M1) and are materialised onto the hub from there: at
 * boot AND at runtime when an admin edits one (the same "config changes take
 * effect without a restart" seam the A2A / MCP registries use).
 *
 * The twin of `a2a-outbound.ts`, one step PURER on the credential axis: an
 * outbound ACP agent has NO secret and not even an env-var pointer. ACP bridges
 * authenticate with the underlying agent's OWN login (`claude` / `codex` already
 * logged in on this machine); the hub injects no key. So there is no
 * `token_env_unset` state here — a row is inactive only because it's `disabled`,
 * its id `id_conflict`s with another participant, or it's `not_found`.
 *
 * Gate posture (fail-closed, configurable): benign tool calls (file writes,
 * reads) pass inline; destructive patterns (rm -rf / git push / sudo / …) are
 * gated. `escalateDanger` (set by main.ts when a member inbox + an owner exist)
 * decides HOW:
 *   - false → `onMatch:'deny'`: the destructive tool is refused inline; the agent
 *     finishes the turn without it. The unattended-hub default — no one to ask.
 *   - true  → `onMatch:'escalate'`: the task PARKS and the host's suspendNotifier
 *     turns the park into a `/me` approval item (acp-escalation.ts); a person
 *     approves and the held turn resumes (or rejects → fail-closed). This is the
 *     OpenClaw-style human-in-the-loop the inbox enables.
 */

import { AcpParticipant, dangerousToolGate } from '@gotong/acp-agent'
import type { Hub, Logger } from '@gotong/core'
import type { AcpOutboundAgent } from '@gotong/identity'

import { FixedWindowLimiter } from './peer-registry.js'

/** The narrow identity slice this manager needs (the real IdentityStore satisfies it). */
export interface AcpAgentSource {
  listAcpAgents(): AcpOutboundAgent[]
  getAcpAgent(id: string): AcpOutboundAgent | null
}

/**
 * Why a given agent is NOT live on the hub right now (for admin feedback / logs).
 * Deliberately has no `token_env_unset` member — ACP carries no secret, so the
 * "configured but secret not provisioned" state that A2A has cannot occur.
 */
export type AcpInactiveReason = 'disabled' | 'id_conflict' | 'not_found'

export interface AcpRegisterResult {
  /** True iff the agent is registered on the hub after this call. */
  active: boolean
  reason?: AcpInactiveReason
}

export interface AcpOutboundManagerOptions {
  hub: Hub
  source: AcpAgentSource
  logger: Logger
  /**
   * When true, a destructive tool call ESCALATES (parks for a `/me` approval)
   * instead of being denied inline. main.ts sets this only when a member inbox +
   * an owner exist to receive the approval; otherwise it stays false (deny), so a
   * park can never wait forever for an approver who doesn't exist. Default false.
   */
  escalateDanger?: boolean
  /**
   * Item 2 — window for the per-agent OUTBOUND quota counter
   * (`outboundQuotaBudget` sends per window). Default 60_000. Main.ts passes
   * `GOTONG_ACP_OUTBOUND_QUOTA_WINDOW_MS`; tests inject a small value.
   */
  quotaWindowMs?: number
}

/**
 * Owns the set of outbound ACP participants WE registered, so it can re-sync a
 * single agent (unregister the old wrapper, register the new one) without
 * touching managed agents, brokers, or any other participant on the hub.
 */
export class AcpOutboundManager {
  private readonly hub: Hub
  private readonly source: AcpAgentSource
  private readonly log: Logger
  private readonly escalateDanger: boolean
  private readonly quotaWindowMs: number
  /** ids this manager has live on the hub (a subset of all participant ids). */
  private readonly live = new Set<string>()
  /**
   * Item 2 — per-agent OUTBOUND quota counters, keyed by agent id. Same
   * discipline as A2aOutboundManager / peer-registry's `linkQuota`: kept across
   * `refresh()` (an edit/toggle must NOT reset the window), rebuilt only when the
   * operator changes the budget, dropped only when the row vanishes (`remove`).
   */
  private readonly outboundQuota = new Map<string, { limiter: FixedWindowLimiter; budget: number }>()

  constructor(opts: AcpOutboundManagerOptions) {
    this.hub = opts.hub
    this.source = opts.source
    this.log = opts.logger
    this.escalateDanger = opts.escalateDanger ?? false
    this.quotaWindowMs = opts.quotaWindowMs ?? 60_000
  }

  /** Boot: materialise every stored agent. Returns the count actually registered. */
  registerAllFromStore(): number {
    let count = 0
    for (const agent of this.source.listAcpAgents()) {
      if (this.tryRegister(agent).active) count++
    }
    if (count > 0) this.log.info('outbound ACP agents registered', { count })
    return count
  }

  /**
   * Re-sync ONE agent to its current stored state — call after an admin
   * add/update. Unregisters any wrapper we had for this id, then registers a
   * fresh one iff the row is enabled. Returns whether it's live (and if not,
   * why) so the route can surface "saved but inactive".
   */
  refresh(id: string): AcpRegisterResult {
    this.unregister(id)
    const agent = this.source.getAcpAgent(id)
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

  /** True iff this id is currently a live outbound ACP participant we manage. */
  isLive(id: string): boolean {
    return this.live.has(id)
  }

  /**
   * Read-only liveness probe — answers "is this stored agent live, and if not,
   * why?" WITHOUT mutating the hub. The admin list uses it to render an honest
   * status per row. Mirrors the reason `tryRegister` would return, but touches
   * nothing.
   */
  statusOf(id: string): AcpRegisterResult {
    if (this.live.has(id)) return { active: true }
    const agent = this.source.getAcpAgent(id)
    if (!agent) return { active: false, reason: 'not_found' }
    if (!agent.enabled) return { active: false, reason: 'disabled' }
    // Enabled, yet not live → its id is owned by another participant (a managed
    // agent / broker) that won the registration race.
    return { active: false, reason: 'id_conflict' }
  }

  private unregister(id: string): void {
    if (!this.live.has(id)) return
    const p = this.hub.unregister(id)
    this.live.delete(id)
    // Hub.unregister drops the participant from the registry but does NOT fire
    // its onShutdown hook — that runs only on whole-hub stop(). An outbound ACP
    // participant holds a long-lived child subprocess (the codex/claude bridge),
    // so unless we terminate it here, every admin delete/disable/edit leaks the
    // process. (Caught in real-machine integration: the codex-acp child survived
    // a DELETE because nothing sent it a signal.) Best-effort + fire-and-forget:
    // the SIGTERM→SIGKILL ladder runs async, and we must NOT block the admin call
    // — or a refresh's immediate re-register of a fresh, independent session — on
    // the old child's death.
    void Promise.resolve(p?.onShutdown?.()).catch((err) => {
      this.log.warn('outbound ACP agent shutdown failed', {
        id,
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /**
   * Item 2 — the outbound quota gate closure for one agent, or undefined when it
   * has no budget. Twin of A2aOutboundManager.outboundQuotaGateFor: a per-agent
   * `FixedWindowLimiter` reused across refreshes, rebuilt only when the budget
   * changes. For ACP the quota is a run-away guardrail (a parked coding agent
   * can't be dispatched-to faster than the budget). Over budget → false → the
   * participant raises a fail-closed `outbound_quota_exceeded` before any spawn.
   */
  private outboundQuotaGateFor(agent: AcpOutboundAgent): (() => boolean) | undefined {
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

  private tryRegister(agent: AcpOutboundAgent): AcpRegisterResult {
    if (!agent.enabled) return { active: false, reason: 'disabled' }
    try {
      this.hub.register(
        new AcpParticipant({
          id: agent.id,
          capabilities: agent.capabilities,
          command: agent.command,
          ...(agent.args.length ? { args: agent.args } : {}),
          ...(agent.cwd ? { cwd: agent.cwd } : {}),
          // Destructive tool calls either park for a /me approval (escalateDanger)
          // or are denied inline. See the file header's "Gate posture".
          gate: dangerousToolGate(undefined, { onMatch: this.escalateDanger ? 'escalate' : 'deny' }),
          // Item 2 — route this outbound edge through the SAME P4-M4 chokepoint
          // mesh peers use: per-step data-class gate (reuses core
          // `checkOutboundDataClasses`, no drift) + per-agent outbound quota. The
          // data-class gate runs BEFORE the ACP session spawns, so a denied task
          // never starts the subprocess. For ACP this is a GOVERNANCE control over
          // what class of context may feed the third-party coding agent (D6).
          allowedDataClasses: agent.allowedDataClasses,
          outboundQuotaGate: this.outboundQuotaGateFor(agent),
          onChunk: (taskId, chunk) => this.emitChunk(agent.id, taskId, chunk.text),
        }),
      )
    } catch (err) {
      // The id collides with an already-registered participant (managed agent,
      // broker, …). Don't crash boot / the admin call — report it.
      this.log.error('outbound ACP agent id conflicts with an existing participant', {
        id: agent.id,
        err: err instanceof Error ? err.message : String(err),
      })
      return { active: false, reason: 'id_conflict' }
    }
    this.live.add(agent.id)
    return { active: true }
  }

  /**
   * OBSERVE seam → transcript. Best-effort: the agent's streamed message text is
   * appended as an `llm_stream_chunk` event so the admin UI's existing typewriter
   * renderer shows ACP output in real time — the same pipeline LlmAgent streaming
   * already uses, no new plumbing. An ACP coding agent IS LLM-backed, so the chunk
   * is genuinely streamed model text; we shape it `{type:'text'}` so the SSE
   * forwarder and "show the final text" aggregators treat it identically. Non-text
   * updates (tool_call / plan) carry no text and are skipped (still observable via
   * the adapter's raw chunk).
   */
  private emitChunk(agentId: string, taskId: string, text: string | undefined): void {
    if (!text) return
    try {
      this.hub.transcript.append({
        ts: Date.now(),
        kind: 'llm_stream_chunk',
        data: { taskId, agentId, chunk: { type: 'text', text } },
      })
    } catch (err) {
      this.log.warn('transcript append failed for acp stream chunk', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
