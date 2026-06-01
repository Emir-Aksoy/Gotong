/**
 * outbound-allowlist.test.ts — Phase 19 P4-M1.
 *
 * The OUTBOUND capability allowlist is the sending-edge mirror of the inbound
 * `PeerLinkAcl.capabilities` gate. Phase 18 persisted `outboundCaps` per peer
 * but enforced nothing — a peer row could carry an allowlist and every
 * capability still left the hub. This closes that gap: `RemoteHubViaLink`
 * refuses any task whose required capabilities aren't all in the allowlist,
 * BEFORE the task touches the wire.
 *
 * Two layers:
 *   1. `checkOutboundCapabilities` — the pure verdict (shared with inbound
 *      `evaluateAcl` via `extractRequiredCapabilities`, so the two gates can't
 *      drift on what "the task's required capabilities" means).
 *   2. A real inproc mesh edge (`installPeerLink({ outboundCaps })`) proving a
 *      denied capability returns `failed` and the REMOTE agent is never run.
 */

import { describe, expect, it } from 'vitest'

import { Hub } from '../src/hub.js'
import { createInprocHubLinkPair } from '../src/hub-link.js'
import { checkOutboundCapabilities } from '../src/peer-acl.js'
import { installPeerLink } from '../src/peer-link-install.js'
import { AgentParticipant } from '../src/participants/agent.js'
import type { DispatchStrategy, Task } from '../src/types.js'

function makeTask(strategy: DispatchStrategy): Task {
  return {
    id: 't-1',
    from: 'system',
    strategy,
    payload: {},
    createdAt: 0,
  }
}

describe('checkOutboundCapabilities — pure verdict', () => {
  const cap = (caps: string[]): DispatchStrategy => ({ kind: 'capability', capabilities: caps })

  it('no allowlist (undefined / null) → accept anything (legacy)', () => {
    expect(checkOutboundCapabilities(makeTask(cap(['draft'])), undefined).ok).toBe(true)
    expect(checkOutboundCapabilities(makeTask(cap(['draft'])), null).ok).toBe(true)
  })

  it('required caps ⊆ allowlist → ok', () => {
    expect(checkOutboundCapabilities(makeTask(cap(['draft'])), ['draft', 'review']).ok).toBe(true)
    // multiple required, all present
    expect(checkOutboundCapabilities(makeTask(cap(['draft', 'review'])), ['draft', 'review']).ok).toBe(
      true,
    )
  })

  it('a required cap outside the allowlist → denied, reason names the cap', () => {
    const v = checkOutboundCapabilities(makeTask(cap(['review'])), ['draft'])
    expect(v).toEqual({ ok: false, reason: 'review' })
  })

  it('empty allowlist [] → deny everything (explicit lockdown)', () => {
    expect(checkOutboundCapabilities(makeTask(cap(['draft'])), [])).toEqual({
      ok: false,
      reason: 'draft',
    })
  })

  it('explicit strategy is un-allowlistable when an allowlist is set', () => {
    const v = checkOutboundCapabilities(makeTask({ kind: 'explicit', to: 'b-writer' }), ['draft'])
    expect(v).toEqual({ ok: false, reason: 'strategy_not_allowlisted' })
  })

  it('unfiltered broadcast is un-allowlistable; a filtered subset passes', () => {
    expect(checkOutboundCapabilities(makeTask({ kind: 'broadcast' }), ['draft'])).toEqual({
      ok: false,
      reason: 'strategy_not_allowlisted',
    })
    expect(
      checkOutboundCapabilities(makeTask({ kind: 'broadcast', capabilities: ['draft'] }), ['draft'])
        .ok,
    ).toBe(true)
  })
})

class CountingEcho extends AgentParticipant {
  invocations = 0
  constructor(id: string, capabilities: readonly string[]) {
    super({ id, capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    this.invocations++
    return { echoedFrom: this.id, payload: task.payload }
  }
}

describe('installPeerLink — outbound allowlist enforcement (mesh edge)', () => {
  it('allowlisted cap reaches the peer; non-allowlisted is refused before the wire', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const bAgent = new CountingEcho('b-agent', ['draft', 'review'])
    hubB.register(bAgent)

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    // The wrapper ADVERTISES both caps (so the scheduler routes both to it),
    // but our outbound allowlist only permits 'draft'.
    installPeerLink({
      hub: hubA,
      link: linkAtoB,
      remoteCapabilities: ['draft', 'review'],
      outboundCaps: ['draft'],
    })
    installPeerLink({ hub: hubB, link: linkBtoA, remoteCapabilities: [] })

    // 'draft' is allowlisted → crosses the edge, runs on hubB.
    const okRes = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: { topic: 'allowed' },
    })
    expect(okRes.kind).toBe('ok')
    if (okRes.kind === 'ok') expect(okRes.output).toMatchObject({ echoedFrom: 'b-agent' })
    expect(bAgent.invocations).toBe(1)

    // 'review' is NOT allowlisted → refused locally, remote never invoked.
    const denied = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['review'] },
      payload: { topic: 'blocked' },
    })
    expect(denied.kind).toBe('failed')
    if (denied.kind === 'failed') expect(denied.error).toContain('outbound_capability_denied:review')
    // The whole point: nothing crossed the wire.
    expect(bAgent.invocations).toBe(1)

    await hubA.stop()
    await hubB.stop()
  })

  it('no allowlist configured → legacy accept-all (the cap that was blocked above now passes)', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const bAgent = new CountingEcho('b-agent', ['review'])
    hubB.register(bAgent)

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    // outboundCaps omitted → no allowlist → send anything.
    installPeerLink({ hub: hubA, link: linkAtoB, remoteCapabilities: ['review'] })
    installPeerLink({ hub: hubB, link: linkBtoA, remoteCapabilities: [] })

    const res = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['review'] },
      payload: { topic: 'legacy' },
    })
    expect(res.kind).toBe('ok')
    expect(bAgent.invocations).toBe(1)

    await hubA.stop()
    await hubB.stop()
  })
})
