/**
 * Phase 10 M3 — dispatch ancestry crosses peer-hub boundaries.
 *
 * Validates that:
 *   1. A task crossing an inproc HubLink preserves its `ancestry`
 *      on the receiver side so the chain stays correct across hubs.
 *   2. Depth gate still bites on the receiving hub — a task that
 *      arrives with `ancestry.length == MAX_DISPATCH_DEPTH` is
 *      rejected locally with `dispatch_depth_exceeded` regardless
 *      of which hub originated the chain. (Without M3's pass-through,
 *      the counter would silently reset on each hub boundary and
 *      runaway loops could escape the gate.)
 */
import { describe, expect, it } from 'vitest'

import { Hub, readMaxDispatchDepth } from '../src/hub.js'
import { createInprocHubLinkPair } from '../src/hub-link.js'
import { installPeerLink } from '../src/peer-link-install.js'
import { AgentParticipant } from '../src/participants/agent.js'
import type { AncestryNode, ParticipantId, Task } from '../src/types.js'

class CaptureAgent extends AgentParticipant {
  public capturedAncestry: readonly AncestryNode[] | undefined
  public capturedDataClasses: readonly string[] | undefined
  public called = false
  constructor(id: string, capabilities: readonly string[]) {
    super({ id, capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    this.called = true
    this.capturedAncestry = task.ancestry
    this.capturedDataClasses = task.dataClasses
    return 'ok'
  }
}

function makeChain(length: number, byPrefix = 'agent'): AncestryNode[] {
  const out: AncestryNode[] = []
  for (let i = 0; i < length; i++) {
    out.push({ taskId: `t${i}`, by: `${byPrefix}${i}` as ParticipantId })
  }
  return out
}

describe('installPeerLink — ancestry crosses the hub boundary', () => {
  it('preserves non-empty ancestry on the receiver side', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const writer = new CaptureAgent('writer', ['draft'])
    hubB.register(writer)

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({ hub: hubA, link: linkAtoB, remoteCapabilities: ['draft'] })
    installPeerLink({ hub: hubB, link: linkBtoA, remoteCapabilities: [] })

    const chain: AncestryNode[] = [
      { taskId: 'root', by: 'root' as ParticipantId },
      { taskId: 'mid', by: 'mid-agent' as ParticipantId },
    ]
    const result = await hubA.dispatch({
      from: 'system' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'x',
      ancestry: chain,
    })
    expect(result.kind).toBe('ok')
    expect(writer.capturedAncestry).toEqual(chain)

    await hubA.stop()
    await hubB.stop()
  })

  it('inbound side enforces depth gate on incoming chain', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    hubB.register(new CaptureAgent('writer', ['draft']))

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({ hub: hubA, link: linkAtoB, remoteCapabilities: ['draft'] })
    installPeerLink({ hub: hubB, link: linkBtoA, remoteCapabilities: [] })

    // ancestry already at the boundary on the sender side; once it
    // crosses into hubB the local hub.dispatch sees a chain at MAX,
    // which the depth gate rejects locally.
    const chain = makeChain(readMaxDispatchDepth())
    const result = await hubA.dispatch({
      from: 'system' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'x',
      ancestry: chain,
    })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toBe('dispatch_depth_exceeded')
    }

    await hubA.stop()
    await hubB.stop()
  })

  it('omits ancestry field when peer sends task without one (root-style)', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const writer = new CaptureAgent('writer', ['draft'])
    hubB.register(writer)

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({ hub: hubA, link: linkAtoB, remoteCapabilities: ['draft'] })
    installPeerLink({ hub: hubB, link: linkBtoA, remoteCapabilities: [] })

    const result = await hubA.dispatch({
      from: 'system' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'x',
      // no ancestry — root dispatch
    })
    expect(result.kind).toBe('ok')
    expect(writer.capturedAncestry).toBeUndefined()

    await hubA.stop()
    await hubB.stop()
  })
})

describe('installPeerLink — data-class labels cross the relay hop (audit A4)', () => {
  it('preserves task.dataClasses on the receiver side (symmetric to ancestry)', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const writer = new CaptureAgent('writer', ['draft'])
    hubB.register(writer)

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({ hub: hubA, link: linkAtoB, remoteCapabilities: ['draft'] })
    installPeerLink({ hub: hubB, link: linkBtoA, remoteCapabilities: [] })

    const result = await hubA.dispatch({
      from: 'system' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'x',
      dataClasses: ['pii'],
    })
    expect(result.kind).toBe('ok')
    // The re-dispatched task on hubB still carries the label — this is the
    // exact field the NEXT outbound gate reads. Before the fix it was dropped.
    expect(writer.capturedDataClasses).toEqual(['pii'])

    await hubA.stop()
    await hubB.stop()
  })

  it('refuses a `pii` task laundered through a relay at the second hop clamped to `public`', async () => {
    // A → B (relay) → C. The B→C edge is clamped to allowedDataClasses:
    // ['public']. A `pii` task from A, capability-routed through B to C, must
    // STILL hit C's outbound data-class gate — proving B preserved the label
    // across the relay hop. Before the fix the label vanished at B and the
    // second-hop fence saw `undefined` → the pii task reached C unchecked.
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    const hubC = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start(), hubC.start()])

    const svc = new CaptureAgent('svc', ['remote-svc'])
    hubC.register(svc)

    // B ↔ C, clamped so only `public` may leave B toward C.
    const bc = createInprocHubLinkPair({ aPeerId: 'hubC', bPeerId: 'hubB' })
    installPeerLink({
      hub: hubB,
      link: bc.a,
      remoteCapabilities: ['remote-svc'],
      allowedDataClasses: ['public'],
    })
    installPeerLink({ hub: hubC, link: bc.b, remoteCapabilities: [] })

    // A ↔ B, open (no data-class contract on this leg).
    const ab = createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
    installPeerLink({ hub: hubA, link: ab.a, remoteCapabilities: ['remote-svc'] })
    installPeerLink({ hub: hubB, link: ab.b, remoteCapabilities: [] })

    const result = await hubA.dispatch({
      from: 'system' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['remote-svc'] },
      payload: 'x',
      dataClasses: ['pii'],
    })

    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toContain('outbound_data_class_denied')
    }
    // The pii task never reached C's agent.
    expect(svc.called).toBe(false)

    await hubA.stop()
    await hubB.stop()
    await hubC.stop()
  })
})
