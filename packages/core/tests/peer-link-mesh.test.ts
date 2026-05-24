/**
 * Peer-link mesh routing — M4 of the hub-mesh implementation.
 *
 * Validates that `installPeerLink` correctly wires a HubLink into a
 * local Hub so capability dispatch crosses the mesh edge transparently.
 *
 * The key scenario per the design doc (§4.2):
 *
 *           hubA ◄──link──► hubB
 *             ▲                ▲
 *             │                │
 *           link             link
 *             │                │
 *             ▼                ▼
 *                   hubC
 *
 * In the triangle below: only hubC owns an agent with capability
 * `'long-form-research'`. hubA, connected to both hubB and hubC, must
 * route a capability dispatch for it through to hubC. hubB is a red
 * herring (no such agent), and the wrapper for hubB declares `[]`
 * capabilities — so the scheduler's candidate set is `[wrapper-of-C]`
 * only.
 *
 * MVP routing is 1-hop: hubA → hubC (direct link). Transitive A → B → C
 * is OUT OF SCOPE; if A only had a link to B, hubA's dispatch would
 * return no_participant.
 */

import { describe, expect, it } from 'vitest'

import { Hub } from '../src/hub.js'
import { createInprocHubLinkPair } from '../src/hub-link.js'
import { installPeerLink } from '../src/peer-link-install.js'
import { AgentParticipant } from '../src/participants/agent.js'
import type { Message, Task } from '../src/types.js'

class EchoAgent extends AgentParticipant {
  constructor(id: string, capabilities: readonly string[]) {
    super({ id, capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    return { echoedFrom: this.id, payload: task.payload }
  }
}

const flush = () => new Promise<void>((r) => setImmediate(r))

describe('installPeerLink — minimal A ↔ B', () => {
  it('A dispatches a capability owned by B; routed through the link', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    hubB.register(new EchoAgent('b-writer', ['draft']))

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({ hub: hubA, link: linkAtoB, remoteCapabilities: ['draft'] })
    installPeerLink({ hub: hubB, link: linkBtoA, remoteCapabilities: [] })

    const result = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: { topic: 'mesh' },
    })

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('hubB') // wrapper id from A's perspective
      expect(result.output).toMatchObject({ echoedFrom: 'b-writer' })
    }

    await hubA.stop()
    await hubB.stop()
  })

  it('symmetric: B dispatches a capability owned by A', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    hubA.register(new EchoAgent('a-reviewer', ['review']))

    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({ hub: hubA, link: a, remoteCapabilities: [] })
    installPeerLink({ hub: hubB, link: b, remoteCapabilities: ['review'] })

    const result = await hubB.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['review'] },
      payload: {},
    })

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('hubA')
      expect(result.output).toMatchObject({ echoedFrom: 'a-reviewer' })
    }

    await hubA.stop()
    await hubB.stop()
  })

  it('uninstall: dispatch falls back to no_participant', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    hubB.register(new EchoAgent('b-writer', ['draft']))

    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    const installed = installPeerLink({
      hub: hubA,
      link: a,
      remoteCapabilities: ['draft'],
    })
    installPeerLink({ hub: hubB, link: b })

    await installed.uninstall()

    const result = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: {},
    })

    expect(result.kind).toBe('no_participant')

    await hubA.stop()
    await hubB.stop()
  })
})

describe('mesh triangle: 3 hubs, capability lives on C', () => {
  it('hubA dispatches through the C-link, NOT the B-link', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    const hubC = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start(), hubC.start()])

    // Only C has the agent.
    hubC.register(new EchoAgent('c-researcher', ['long-form-research']))

    // A pulls TWO edges: one to B (offers nothing relevant), one to C
    // (offers the capability).
    const ab = createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
    const ac = createInprocHubLinkPair({ aPeerId: 'hubC', bPeerId: 'hubA' })

    installPeerLink({
      hub: hubA,
      link: ab.a,
      remoteCapabilities: [], // B claims nothing
    })
    installPeerLink({ hub: hubB, link: ab.b, remoteCapabilities: [] })

    installPeerLink({
      hub: hubA,
      link: ac.a,
      remoteCapabilities: ['long-form-research'], // C claims this
    })
    installPeerLink({ hub: hubC, link: ac.b, remoteCapabilities: [] })

    const result = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['long-form-research'] },
      payload: { question: 'mesh triangle' },
    })

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('hubC') // routed via the C wrapper, not B
      expect(result.output).toMatchObject({ echoedFrom: 'c-researcher' })
    }

    await hubA.stop()
    await hubB.stop()
    await hubC.stop()
  })

  it('MVP is 1-hop: A→B→C does NOT route transitively', async () => {
    // Same topology as above but A only has an edge to B; C is only
    // reachable via B. Per design §2.3, the MVP refuses transitive
    // routing — A returns no_participant rather than asking B to relay.
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    const hubC = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start(), hubC.start()])

    hubC.register(new EchoAgent('c-researcher', ['long-form-research']))

    // A ↔ B only
    const ab = createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
    installPeerLink({ hub: hubA, link: ab.a, remoteCapabilities: [] })
    installPeerLink({
      hub: hubB,
      link: ab.b,
      remoteCapabilities: [],
    })

    // B ↔ C (B knows about C but A doesn't)
    const bc = createInprocHubLinkPair({ aPeerId: 'hubC', bPeerId: 'hubB' })
    installPeerLink({
      hub: hubB,
      link: bc.a,
      remoteCapabilities: ['long-form-research'],
    })
    installPeerLink({ hub: hubC, link: bc.b, remoteCapabilities: [] })

    const result = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['long-form-research'] },
      payload: {},
    })

    // A's wrapper for B declared `[]` capabilities, so capability
    // dispatch for `long-form-research` finds no candidates in A's
    // registry. (B could fulfill it but only because B routes its own
    // dispatches transitively — A's dispatch never asks B to relay.)
    expect(result.kind).toBe('no_participant')

    await hubA.stop()
    await hubB.stop()
    await hubC.stop()
  })
})

describe('installPeerLink — message bus bridge', () => {
  it('publish on A reaches subscribers on B', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const received: Message[] = []
    class Listener extends AgentParticipant {
      protected async handleTask(): Promise<unknown> {
        return {}
      }
      protected handleMessage(msg: Message): void {
        received.push(msg)
      }
    }
    const listener = new Listener({ id: 'b-listener' })
    hubB.register(listener)
    hubB.subscribe('b-listener', 'announcements')

    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    // A wants to MIRROR its 'announcements' channel to B (i.e. B should
    // see whatever A publishes there). The B side doesn't need to
    // mirror back for this test.
    installPeerLink({
      hub: hubA,
      link: a,
      mirrorChannels: ['announcements'],
    })
    installPeerLink({ hub: hubB, link: b })

    hubA.publish({
      from: 'system',
      channel: 'announcements',
      body: { hello: 'mesh' },
    })

    await flush()
    await flush()

    expect(received.length).toBeGreaterThanOrEqual(1)
    expect(received[0].body).toMatchObject({ hello: 'mesh' })

    await hubA.stop()
    await hubB.stop()
  })
})
