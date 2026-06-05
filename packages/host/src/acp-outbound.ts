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
 * Gate posture (MVP, fail-closed): every registered participant gets
 * `dangerousToolGate(undefined, { onMatch: 'deny' })` — benign tool calls (file
 * writes, reads) pass inline; destructive patterns (rm -rf / git push / sudo / …)
 * are DENIED inline rather than escalated. Inline-deny avoids a stuck park,
 * because nothing in the host yet turns an ACP permission park into a `/me` inbox
 * item (that escalate→inbox wiring is the documented follow-up). The agent simply
 * finishes the turn without the denied tool.
 */

import { AcpParticipant, dangerousToolGate } from '@aipehub/acp-agent'
import type { Hub, Logger } from '@aipehub/core'
import type { AcpOutboundAgent } from '@aipehub/identity'

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
  /** ids this manager has live on the hub (a subset of all participant ids). */
  private readonly live = new Set<string>()

  constructor(opts: AcpOutboundManagerOptions) {
    this.hub = opts.hub
    this.source = opts.source
    this.log = opts.logger
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
          // MVP fail-closed: destructive tool calls denied inline (no escalate→park,
          // since no host wiring turns an ACP park into a /me inbox item yet).
          gate: dangerousToolGate(undefined, { onMatch: 'deny' }),
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
