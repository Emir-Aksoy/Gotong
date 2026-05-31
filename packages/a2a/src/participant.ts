/**
 * A2aRemoteParticipant — Phase 18 C-M4 outbound A2A edge.
 *
 * A local `Participant` that forwards a dispatched task to an EXTERNAL A2A
 * agent's `message/send`. The mirror of the inbound `A2aServer` (C-M3): there
 * an A2A caller reaches into our hub; here our hub reaches out to an A2A agent.
 *
 * It extends `AgentParticipant` so a thrown error becomes a `failed` task
 * result via the scheduler — no bespoke error plumbing. The remote's text
 * reply becomes the task's ok output as `{ text }`.
 *
 * Registration is the host's job (main.ts reads `AIPE_A2A_AGENTS`); this class
 * is transport-only and carries the per-agent url / token / target skill.
 */

import { AgentParticipant, type ParticipantId, type Task } from '@aipehub/core'

import { a2aSend } from './client.js'

export interface A2aRemoteParticipantOptions {
  /** Local participant id (what `result.by` shows). */
  id: ParticipantId
  /** Capabilities advertised on the LOCAL hub — dispatching these routes here. */
  capabilities: string[]
  /** The remote A2A agent's `message/send` endpoint. */
  url: string
  /** Bearer token presented to the remote. */
  token: string
  /**
   * AipeHub-to-AipeHub only: OUR peer id, sent as `X-Aipe-Peer-Id`. Omit for a
   * generic external A2A agent.
   */
  peerId?: string
  /**
   * `metadata.skill` to set on the outbound message — the capability the REMOTE
   * hub should dispatch to. Omit to let the remote use its own default.
   */
  targetSkill?: string
  /** Injectable fetch for deterministic tests. */
  fetchImpl?: typeof fetch
}

export class A2aRemoteParticipant extends AgentParticipant {
  private readonly url: string
  private readonly token: string
  private readonly peerId: string | undefined
  private readonly targetSkill: string | undefined
  private readonly fetchImpl: typeof fetch | undefined

  constructor(opts: A2aRemoteParticipantOptions) {
    super({ id: opts.id, capabilities: opts.capabilities })
    this.url = opts.url
    this.token = opts.token
    this.peerId = opts.peerId
    this.targetSkill = opts.targetSkill
    this.fetchImpl = opts.fetchImpl
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const text = payloadToText(task.payload)
    // a2aSend throws A2aClientError on transport / HTTP / JSON-RPC failure;
    // AgentParticipant turns that throw into a `failed` task result.
    const reply = await a2aSend(this.url, this.token, text, {
      ...(this.peerId ? { peerId: this.peerId } : {}),
      ...(this.targetSkill ? { metadata: { skill: this.targetSkill } } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    })
    return { text: reply }
  }
}

/** Pull the text to send out of a dispatched task payload. */
function payloadToText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string') {
    return (payload as { text: string }).text
  }
  return JSON.stringify(payload ?? '')
}
