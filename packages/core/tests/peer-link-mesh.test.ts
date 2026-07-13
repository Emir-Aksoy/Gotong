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
    installPeerLink({ hub: hubA, link: linkAtoB, remoteCapabilities: ['draft'], outboundCaps: ['draft'] })
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
    installPeerLink({ hub: hubB, link: b, remoteCapabilities: ['review'], outboundCaps: ['review'] })

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
      outboundCaps: ['draft'],
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
      outboundCaps: ['long-form-research'],
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
      outboundCaps: ['long-form-research'],
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

// ---------------------------------------------------------------------------
// FED-M2 — Task.origin stamping across the link
//
// Receiver-side inspection technique: register a participant on hubB
// whose `handleTask` records the incoming task, then dispatch from hubA
// over the link and assert what the participant saw.
// ---------------------------------------------------------------------------

class RecordingAgent extends AgentParticipant {
  // Captures every task the agent receives; tests pop from this.
  readonly captured: Task[] = []
  protected async handleTask(task: Task): Promise<unknown> {
    this.captured.push(task)
    return { seen: true }
  }
}

describe('installPeerLink — FED-M2 origin stamping', () => {
  async function makeLinkedPair(opts: {
    aOriginResolver?: ConstructorParameters<typeof RemoteHubViaLink>[0]['originResolver']
    aSelfHubId?: string
  } = {}) {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const recorder = new RecordingAgent({
      id: 'b-record',
      capabilities: ['probe'],
    })
    hubB.register(recorder)

    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({
      hub: hubA,
      link: a,
      remoteCapabilities: ['probe'],
      outboundCaps: ['probe'],
      ...(opts.aSelfHubId !== undefined ? { selfHubId: opts.aSelfHubId } : {}),
      ...(opts.aOriginResolver !== undefined ? { originResolver: opts.aOriginResolver } : {}),
    })
    installPeerLink({ hub: hubB, link: b })

    return {
      hubA,
      hubB,
      recorder,
      stop: async () => {
        await hubA.stop()
        await hubB.stop()
      },
    }
  }

  it('no resolver configured → forwarded task has NO origin field', async () => {
    const { hubA, recorder, stop } = await makeLinkedPair()
    await hubA.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['probe'] },
      payload: {},
    })
    expect(recorder.captured).toHaveLength(1)
    expect(recorder.captured[0]!.origin).toBeUndefined()
    await stop()
  })

  it('resolver returning user info → origin stamped with {orgId, userId, userRole, userEmail}', async () => {
    const { hubA, recorder, stop } = await makeLinkedPair({
      aSelfHubId: 'orgA-hub',
      aOriginResolver: (from) => {
        if (from === 'alice')
          return { userId: 'alice', userRole: 'member', userEmail: 'alice@orga.test' }
        return null
      },
    })
    await hubA.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['probe'] },
      payload: { hello: 'world' },
    })
    expect(recorder.captured).toHaveLength(1)
    const origin = recorder.captured[0]!.origin
    expect(origin).toBeDefined()
    expect(origin?.orgId).toBe('orgA-hub')
    expect(origin?.userId).toBe('alice')
    expect(origin?.userRole).toBe('member')
    expect(origin?.userEmail).toBe('alice@orga.test')
    await stop()
  })

  it('resolver returning null → forwarded task has NO origin (unidentified actor)', async () => {
    const { hubA, recorder, stop } = await makeLinkedPair({
      aSelfHubId: 'orgA-hub',
      aOriginResolver: () => null,
    })
    await hubA.dispatch({
      from: 'v3-admin',
      strategy: { kind: 'capability', capabilities: ['probe'] },
      payload: {},
    })
    expect(recorder.captured).toHaveLength(1)
    expect(recorder.captured[0]!.origin).toBeUndefined()
    await stop()
  })

  it('resolver throws → forwarded task has NO origin (resilient — never blocks the task)', async () => {
    const { hubA, recorder, stop } = await makeLinkedPair({
      aSelfHubId: 'orgA-hub',
      aOriginResolver: () => {
        throw new Error('identity store offline')
      },
    })
    const result = await hubA.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['probe'] },
      payload: {},
    })
    // Task still went through end-to-end — resolver fault is not fatal.
    expect(result.kind).toBe('ok')
    expect(recorder.captured).toHaveLength(1)
    expect(recorder.captured[0]!.origin).toBeUndefined()
    await stop()
  })

  it('resolver works asynchronously (e.g. an external IdP)', async () => {
    const { hubA, recorder, stop } = await makeLinkedPair({
      aSelfHubId: 'orgA-hub',
      aOriginResolver: async (from) => {
        await new Promise<void>((r) => setImmediate(r))
        return { userId: from, userEmail: `${from}@async.test` }
      },
    })
    await hubA.dispatch({
      from: 'bob',
      strategy: { kind: 'capability', capabilities: ['probe'] },
      payload: {},
    })
    expect(recorder.captured[0]!.origin?.userId).toBe('bob')
    expect(recorder.captured[0]!.origin?.userEmail).toBe('bob@async.test')
    await stop()
  })

  it('local-only dispatch (no link traversal) leaves origin unset', async () => {
    // Even when the hub HAS a wrapper with origin config, a task that
    // matches a LOCAL participant goes straight to it without hitting
    // RemoteHubViaLink.onTask — so no origin is stamped.
    const { hubA, stop } = await makeLinkedPair({
      aSelfHubId: 'orgA-hub',
      aOriginResolver: (from) => ({ userId: from }),
    })
    const localCaptured: Task[] = []
    class LocalAgent extends AgentParticipant {
      protected async handleTask(task: Task): Promise<unknown> {
        localCaptured.push(task)
        return { ok: true }
      }
    }
    hubA.register(new LocalAgent({ id: 'local', capabilities: ['local-only'] }))
    await hubA.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['local-only'] },
      payload: {},
    })
    expect(localCaptured).toHaveLength(1)
    expect(localCaptured[0]!.origin).toBeUndefined()
    await stop()
  })
})

// RemoteHubViaLink direct import for the constructor-parameter type
// reference in makeLinkedPair above. Kept at the bottom so the wiring-
// flavored tests above stay close to their installPeerLink siblings.
import { RemoteHubViaLink } from '../src/participants/remote-hub.js'
import type { PeerLinkAcl } from '../src/peer-link-install.js'

// ---------------------------------------------------------------------------
// FED-M3 — receiver-side cross-org ACL
// ---------------------------------------------------------------------------

describe('installPeerLink — FED-M3 receiver ACL', () => {
  /**
   * Boot a pair where the receiver (hubB) configures `acl` and the
   * sender (hubA) optionally stamps origin. Returns helpers so each
   * test focuses on the verdict rather than the wiring.
   */
  async function makePair(opts: {
    acl?: PeerLinkAcl
    aOriginResolver?: ConstructorParameters<typeof RemoteHubViaLink>[0]['originResolver']
  } = {}) {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const recorder = new RecordingAgent({
      id: 'b-record',
      capabilities: ['probe', 'sensitive-op'],
    })
    hubB.register(recorder)

    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({
      hub: hubA,
      link: a,
      // Sender treats peer as covering both possible capabilities so
      // dispatch reaches the link regardless of ACL on the other side.
      remoteCapabilities: ['probe', 'sensitive-op'],
      outboundCaps: ['probe', 'sensitive-op'],
      selfHubId: 'orgA-hub',
      ...(opts.aOriginResolver !== undefined ? { originResolver: opts.aOriginResolver } : {}),
    })
    installPeerLink({
      hub: hubB,
      link: b,
      selfHubId: 'orgB-hub',
      ...(opts.acl !== undefined ? { acl: opts.acl } : {}),
    })

    return {
      hubA,
      recorder,
      stop: async () => {
        await hubA.stop()
        await hubB.stop()
      },
    }
  }

  it('no ACL → legacy behavior, all tasks pass through', async () => {
    const { hubA, recorder, stop } = await makePair({})
    const result = await hubA.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['probe'] },
      payload: {},
    })
    expect(result.kind).toBe('ok')
    expect(recorder.captured).toHaveLength(1)
    await stop()
  })

  it('capabilities allowlist matches → task accepted', async () => {
    const { hubA, recorder, stop } = await makePair({
      acl: { capabilities: ['probe'] },
    })
    const result = await hubA.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['probe'] },
      payload: {},
    })
    expect(result.kind).toBe('ok')
    expect(recorder.captured).toHaveLength(1)
    await stop()
  })

  it('capability NOT in allowlist → denied with cross_org_acl_denied (capability_denied)', async () => {
    const { hubA, recorder, stop } = await makePair({
      acl: { capabilities: ['probe'] },
    })
    const result = await hubA.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['sensitive-op'] },
      payload: {},
    })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toMatch(/cross_org_acl_denied/)
      expect(result.error).toMatch(/capability_denied:sensitive-op/)
    }
    // Recorder MUST NOT have seen the denied task — gate kept it out
    // of the local hub entirely.
    expect(recorder.captured).toHaveLength(0)
    await stop()
  })

  it('requireOrigin=true + no origin (no resolver on sender) → denied (origin_required)', async () => {
    const { hubA, recorder, stop } = await makePair({
      acl: { requireOrigin: true },
      // No aOriginResolver → outbound has no origin
    })
    const result = await hubA.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['probe'] },
      payload: {},
    })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toMatch(/origin_required/)
    }
    expect(recorder.captured).toHaveLength(0)
    await stop()
  })

  it('requireOriginRole excludes member when only owner allowed → denied', async () => {
    const { hubA, recorder, stop } = await makePair({
      acl: { requireOrigin: true, requireOriginRole: ['owner'] },
      aOriginResolver: () => ({ userId: 'alice', userRole: 'member' }),
    })
    const result = await hubA.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['probe'] },
      payload: {},
    })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toMatch(/origin_role_denied/)
    }
    expect(recorder.captured).toHaveLength(0)
    await stop()
  })

  it('requireOriginRole includes admin → admin-role task accepted', async () => {
    const { hubA, recorder, stop } = await makePair({
      acl: { requireOrigin: true, requireOriginRole: ['owner', 'admin'] },
      aOriginResolver: () => ({ userId: 'alice', userRole: 'admin' }),
    })
    const result = await hubA.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['probe'] },
      payload: {},
    })
    expect(result.kind).toBe('ok')
    expect(recorder.captured).toHaveLength(1)
    await stop()
  })

  it('explicit dispatch strategy is denied at the ACL when delivered directly to the link (anti enumeration)', async () => {
    // Note: capability-routed dispatches never use the explicit strategy,
    // so the realistic threat is a peer constructing an explicit-strategy
    // frame and sending it over the link directly (bypassing their own
    // scheduler). We simulate that by manually building a Task and
    // calling link.dispatch — same code path inbound side would see.
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const recorder = new RecordingAgent({
      id: 'b-record',
      capabilities: ['probe'],
    })
    hubB.register(recorder)

    const { a, b } = createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
    installPeerLink({ hub: hubA, link: a })
    installPeerLink({
      hub: hubB,
      link: b,
      selfHubId: 'orgB-hub',
      acl: { capabilities: ['probe'] },
    })

    // Directly inject an explicit-strategy task onto the link.
    const result = await a.dispatch({
      id: 'manual-task-1',
      from: 'attacker@orgA',
      strategy: { kind: 'explicit', to: 'b-record' },
      payload: {},
      createdAt: Date.now(),
    })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toMatch(/cross_org_acl_denied/)
      expect(result.error).toMatch(/strategy_not_allowlisted/)
    }
    // Recorder must NOT have seen the denied task.
    expect(recorder.captured).toHaveLength(0)

    await hubA.stop()
    await hubB.stop()
  })

  it('refused tasks NEVER reach the local hub — recorder stays empty across denials', async () => {
    const { hubA, recorder, stop } = await makePair({
      acl: {
        requireOrigin: true,
        requireOriginRole: ['owner'],
        capabilities: ['probe'],
      },
      aOriginResolver: () => ({ userId: 'alice', userRole: 'member' }),
    })
    // Multiple denied dispatches, all should fail-closed.
    for (let i = 0; i < 3; i++) {
      const result = await hubA.dispatch({
        from: 'alice',
        strategy: { kind: 'capability', capabilities: ['probe'] },
        payload: {},
      })
      expect(result.kind).toBe('failed')
    }
    expect(recorder.captured).toHaveLength(0)
    await stop()
  })
})
