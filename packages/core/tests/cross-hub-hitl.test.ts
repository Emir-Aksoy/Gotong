/**
 * D2 — end-to-end cross-hub HITL through real Hubs + inproc HubLink.
 *
 * Scenario:
 *
 *     hub_B ──link──► hub_A
 *      │                  │
 *   user_b           agent X (registered locally)
 *
 *   1. hub_B dispatches a task at the 'research' capability — wrapper
 *      for hub_A claims it, so the dispatch crosses the link.
 *   2. hub_A's installPeerLink re-dispatches into hub_A; the task
 *      carries `origin={orgId:'hub_B', userId:'user_b'}` (FED-M2).
 *   3. Agent X's onTask runs and explicitly dispatches a follow-up
 *      question at 'user_b' — NOT registered locally on hub_A.
 *   4. hub_A's `crossHubResolver` kicks in (target='user_b', origin
 *      matches hub_B's link) and forwards over the link back to hub_B.
 *   5. user_b on hub_B answers; the answer flows back through the link
 *      to agent X, which returns the final result.
 *
 * This proves the resolver + PeerRegistry-style routing primitive
 * works end-to-end without needing real PeerRegistry / WebSocket /
 * vault — the inproc link substitutes for the wire transport.
 */

import { describe, expect, it } from 'vitest'

import { Hub } from '../src/hub.js'
import { createInprocHubLinkPair, type HubLink } from '../src/hub-link.js'
import { installPeerLink } from '../src/peer-link-install.js'
import { AgentParticipant } from '../src/participants/agent.js'
import { HumanParticipant } from '../src/participants/human.js'
import type { Task, TaskResult } from '../src/types.js'

/**
 * Mock agent: on first call dispatches a follow-up explicit task at
 * 'user_b' (which lives on the OTHER hub) and returns the answer
 * verbatim. Mirrors what PersonalGrowthAgent does after parsing a
 * NEED_INPUT marker, minus the LLM round-trip.
 */
class HitlAgent extends AgentParticipant {
  constructor(
    id: string,
    capabilities: readonly string[],
    private readonly hub: Hub,
    private readonly askingUserId: string,
  ) {
    super({ id, capabilities })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    // Reverse-dispatch a question at the originating user. With the
    // crossHubResolver wired on this hub, the dispatch crosses the
    // link to the user's home hub.
    const followUp = await this.hub.dispatch({
      from: this.id,
      strategy: { kind: 'explicit', to: this.askingUserId },
      payload: { kind: 'agent-question', q: 'what is 2+2?' },
      // FED — propagate origin so the resolver can find the right link
      // back. In the host's wiring this happens automatically via the
      // re-dispatch in installPeerLink; here we forward task.origin
      // explicitly so the resolver has it.
      ...(task.origin ? { origin: task.origin } : {}),
    })
    if (followUp.kind === 'ok') {
      return { agent: this.id, answer: followUp.output }
    }
    return { agent: this.id, error: 'follow-up failed', kind: followUp.kind }
  }
}

describe('cross-hub HITL — end-to-end with inproc HubLink (D2)', () => {
  it('agent on hub_A asks user_b on hub_B; answer flows back through the link', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    // user_b lives on hub_B (the originating hub). It answers '4'
    // to whatever question it gets.
    const userB = new HumanParticipant({ id: 'user_b' })
    userB.onTask = async (t: Task): Promise<TaskResult> => ({
      kind: 'ok',
      taskId: t.id,
      by: 'user_b',
      output: { answers: { q: '4' } },
      ts: Date.now(),
    })
    hubB.register(userB)

    // Set up the link. linkA is hub_A's view of hub_B; linkB the
    // reverse. The wrapper on hub_A advertises capability 'research'
    // (which is what hub_B's user dispatches against).
    let linkAtoB: HubLink
    let linkBtoA: HubLink
    {
      const pair = createInprocHubLinkPair({
        aPeerId: 'hub_B',
        bPeerId: 'hub_A',
      })
      linkAtoB = pair.a // hub_A's link TO hub_B (peerId='hub_B')
      linkBtoA = pair.b // hub_B's link TO hub_A (peerId='hub_A')
    }

    // hub_A side: register agent + the cross-hub resolver. Resolver
    // returns linkAtoB.dispatch whenever the task's origin matches
    // hub_B (the peer at the other end of linkAtoB).
    //
    // We re-construct hub_A here so the resolver can be wired in
    // construction. (Pre-built hubA above only exists to show that
    // started state works — we throw it away.)
    await hubA.stop()
    const hubA2 = Hub.inMemory({
      crossHubResolver: (_to, task) => {
        if (task.origin?.orgId !== 'hub_B') return null
        return (t) => linkAtoB.dispatch(t)
      },
    })
    await hubA2.start()
    const agentX = new HitlAgent('agent-x', ['research'], hubA2, 'user_b')
    hubA2.register(agentX)

    // installPeerLink on BOTH sides:
    //   - on hub_A: incoming tasks from hub_B re-dispatch locally,
    //     and the wrapper representing hub_B carries no capabilities
    //     (hub_B doesn't host any worker capabilities).
    //   - on hub_B: the wrapper representing hub_A carries 'research'
    //     so capability dispatch lands on it and forwards to hub_A.
    //
    // FED-M2 originResolver on hub_B's side stamps origin on outbound
    // tasks. For HumanParticipant in this test we use a trivial
    // resolver that maps every local id to a deterministic origin.
    installPeerLink({
      hub: hubA2,
      link: linkAtoB,
      remoteCapabilities: [],
      selfHubId: 'hub_A',
    })
    installPeerLink({
      hub: hubB,
      link: linkBtoA,
      remoteCapabilities: ['research'],
      outboundCaps: ['research'],
      selfHubId: 'hub_B',
      originResolver: () => ({ orgId: 'hub_B', userId: 'user_b' }),
    })

    // hub_B dispatches at 'research'. Capability mesh picks the
    // wrapper-of-hub_A → task crosses to hub_A → agent X runs →
    // agent X dispatches at 'user_b' → resolver → back to hub_B →
    // user_b answers → answer rides back → agent X output → final.
    const r = await hubB.dispatch({
      from: 'user_b',
      strategy: { kind: 'capability', capabilities: ['research'] },
      payload: { topic: 'arithmetic' },
    })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      const out = r.output as { agent: string; answer: { answers: { q: string } } }
      expect(out.agent).toBe('agent-x')
      expect(out.answer).toEqual({ answers: { q: '4' } })
    }

    await hubA2.stop()
    await hubB.stop()
  })

  it('falls through to no_participant when resolver does not match', async () => {
    // Same setup but the resolver only matches a hub id we never use,
    // so the cross-hub jump fails and the parent dispatch ends up
    // returning a failed (no_participant) result.
    const hubA = Hub.inMemory({
      crossHubResolver: () => null, // always punt
    })
    await hubA.start()
    const agentX = new HitlAgent('agent-x', ['research'], hubA, 'user_b')
    hubA.register(agentX)

    const r = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['research'] },
      payload: { topic: 'arithmetic' },
      // Force a federated-looking task so the agent's reverse-
      // dispatch carries an origin to the resolver.
      origin: { orgId: 'hub_B', userId: 'user_b' },
    })
    expect(r.kind).toBe('ok') // agent itself completes ok
    if (r.kind === 'ok') {
      const out = r.output as { error?: string; kind?: string }
      expect(out.error).toBe('follow-up failed')
      expect(out.kind).toBe('no_participant')
    }
    await hubA.stop()
  })
})
