/**
 * Route B P1-M9 — real-WebSocket cross-org isolation acceptance gate.
 *
 * `peer-isolation-e2e.test.ts` (Phase 19 P4-M4) pins the per-link trust
 * invariants over INPROC link pairs. This file proves the SAME invariants hold
 * when the edge is the REAL WebSocket transport (`acceptHubLinks` /
 * `connectHubLink`) rather than an in-memory shortcut — i.e. real frame
 * round-trips never sidestep the outbound data-class / capability gates or the
 * inbound per-link quota. The enforcement primitives themselves are unit-tested
 * in core (outbound-allowlist.test.ts); what THIS adds is "the wire doesn't
 * bypass them" — across BOTH frame types: `MESH_TASK` (dispatch, first
 * describe) and `MESH_RPC_CALL` (KB allowlist, second describe).
 *
 * One home hub dials TWO org hubs over real ws:
 *   - orgX is clamped (outbound data-class allowlist ['public'], outbound cap
 *     allowlist ['svc-x'], inbound quota budget 1).
 *   - orgY is wide open (legacy accept-all).
 *
 * Then the P4 north-star is asserted over the wire — restricting orgX must
 * never bleed onto orgY:
 *   1. a `pii` task to orgX is refused at the home-side wrapper BEFORE the wire
 *      (outbound_data_class_denied); the IDENTICAL task to orgY crosses ws and
 *      lands on its agent.
 *   2. orgX may push exactly ONE inbound task across ws; the 2nd fail-closes at
 *      home's inbound gate (per_link_quota_exceeded) while orgY streams freely.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import {
  AgentParticipant,
  Hub,
  installPeerLink,
  type HubLink,
  type Task,
} from '@gotong/core'
import { acceptHubLinks, connectHubLink } from '@gotong/transport-ws'

import { FixedWindowLimiter } from '../src/peer-registry.js'
import { gateKnowledgeBaseRpc, type RpcResponder } from '../src/peer-kb-gate.js'
import { MCP_PROXY_METHODS } from '../src/mcp-proxy.js'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** Let any post-handshake frames settle before dispatching. */
const drain = async () => {
  for (let i = 0; i < 10; i++) await delay(5)
}

/** Records every task it runs so a test can count what crossed each edge. */
class RecordingAgent extends AgentParticipant {
  readonly captured: Task[] = []
  protected async handleTask(task: Task): Promise<unknown> {
    this.captured.push(task)
    return { seen: true }
  }
}

/**
 * Mirror `PeerRegistry.inboundQuotaGate` using the registry's OWN limiter
 * class. A test installs once, so a fresh limiter is equivalent to the
 * registry's per-row-kept one.
 */
function inboundQuotaGate(
  id: string,
  budget: number,
): { inboundGate?: (task: Task) => { ok: true } | { ok: false; reason: string } } {
  if (budget <= 0) return {}
  const limiter = new FixedWindowLimiter(budget, 60_000)
  return {
    inboundGate: () =>
      limiter.attempt(id) ? { ok: true } : { ok: false, reason: 'per_link_quota_exceeded' },
  }
}

interface ServerNode {
  selfId: string
  hub: Hub
  wss: WebSocketServer
  url: string
  /** Links accepted on this hub's ws server (the home→here edge). */
  inboundLinks: HubLink[]
  stop: () => Promise<void>
}

/** A peer org hub: real Hub + real ws server accepting one link from home. */
async function startServerNode(selfId: string): Promise<ServerNode> {
  const hub = Hub.inMemory()
  await hub.start()

  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const addr = wss.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0

  const inboundLinks: HubLink[] = []
  acceptHubLinks({ server: wss, selfId, onLink: (link) => inboundLinks.push(link) })

  return {
    selfId,
    hub,
    wss,
    url: `ws://127.0.0.1:${port}`,
    inboundLinks,
    stop: async () => {
      for (const link of inboundLinks) await link.close().catch(() => {})
      for (const c of wss.clients) {
        try {
          c.terminate()
        } catch {
          /* swallow */
        }
      }
      await new Promise<void>((r) => wss.close(() => r()))
      await hub.stop()
    },
  }
}

/** Dial home → `to` over real ws; returns home's local link (remote = to.selfId). */
async function dialOut(homeSelfId: string, to: ServerNode): Promise<HubLink> {
  const link = await connectHubLink({
    url: to.url,
    selfId: homeSelfId,
    expectedPeerId: to.selfId,
  })
  // onLink fires after the IN-side handshake resolves (a Promise.race tick).
  for (let i = 0; i < 20 && to.inboundLinks.length === 0; i++) await delay(10)
  return link
}

describe('Route B P1-M9 — per-link isolation holds over real WebSocket transport', () => {
  let home: Hub
  let hubX: ServerNode
  let hubY: ServerNode
  const homeLinks: HubLink[] = []

  beforeEach(async () => {
    home = Hub.inMemory()
    await home.start()
    hubX = await startServerNode('orgX')
    hubY = await startServerNode('orgY')
  })

  afterEach(async () => {
    for (const link of homeLinks) await link.close().catch(() => {})
    homeLinks.length = 0
    await hubX.stop()
    await hubY.stop()
    await home.stop()
  })

  it('restricting orgX (data class + inbound quota) leaves orgY unaffected — over ws', async () => {
    // Agents receiving the OUTBOUND (home → peer) traffic.
    const xAgent = new RecordingAgent({ id: 'x-agent', capabilities: ['svc-x'] })
    const yAgent = new RecordingAgent({ id: 'y-agent', capabilities: ['svc-y'] })
    hubX.hub.register(xAgent)
    hubY.hub.register(yAgent)
    // Agent receiving the INBOUND (peer → home) traffic for the quota test.
    const homeAgent = new RecordingAgent({ id: 'home-agent', capabilities: ['home-task'] })
    home.register(homeAgent)

    // home dials both orgs over REAL ws.
    const linkHomeToX = await dialOut('orgHome', hubX)
    const linkHomeToY = await dialOut('orgHome', hubY)
    homeLinks.push(linkHomeToX, linkHomeToY)
    const linkXToHome = hubX.inboundLinks[0]!
    const linkYToHome = hubY.inboundLinks[0]!

    // home's edges: the wrapper carries the OUTBOUND contract; the inbound
    // handler carries the per-link quota. orgX clamped, orgY wide open.
    installPeerLink({
      hub: home,
      link: linkHomeToX,
      remoteCapabilities: ['svc-x'],
      selfHubId: 'orgHome',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
      outboundCaps: ['svc-x'],
      allowedDataClasses: ['public'],
      ...inboundQuotaGate('orgX', 1),
    })
    installPeerLink({
      hub: home,
      link: linkHomeToY,
      remoteCapabilities: ['svc-y'],
      // GT-M2: even the "wide open" peer needs an explicit cap allowlist now.
      outboundCaps: ['svc-y'],
      selfHubId: 'orgHome',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
    })
    // peer edges back to home advertise `home-task` so each peer can push an
    // inbound task that the home quota gate (or lack of one) then judges.
    // GT-M2: the pushing side must allowlist `home-task` to dispatch it out.
    installPeerLink({
      hub: hubX.hub,
      link: linkXToHome,
      remoteCapabilities: ['home-task'],
      outboundCaps: ['home-task'],
      selfHubId: 'orgX',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
    })
    installPeerLink({
      hub: hubY.hub,
      link: linkYToHome,
      remoteCapabilities: ['home-task'],
      outboundCaps: ['home-task'],
      selfHubId: 'orgY',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
    })

    await drain()

    // --- (1) OUTBOUND data-class isolation, over the wire ---------------------
    // A `pii` task to the clamped orgX is refused at the home wrapper, before ws.
    const piiToX = await home.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['svc-x'] },
      payload: { ssn: '...' },
      dataClasses: ['pii'],
    })
    expect(piiToX.kind).toBe('failed')
    if (piiToX.kind === 'failed') expect(piiToX.error).toMatch(/outbound_data_class_denied:pii/)
    expect(xAgent.captured).toHaveLength(0) // never crossed the wire to orgX

    // The IDENTICAL `pii` task to the open orgY crosses real ws and lands.
    const piiToY = await home.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['svc-y'] },
      payload: { ssn: '...' },
      dataClasses: ['pii'],
    })
    expect(piiToY.kind).toBe('ok')
    expect(yAgent.captured).toHaveLength(1)

    // A `public` task to orgX DOES cross — the clamp is class-specific.
    const publicToX = await home.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['svc-x'] },
      payload: { note: 'hi' },
      dataClasses: ['public'],
    })
    expect(publicToX.kind).toBe('ok')
    expect(xAgent.captured).toHaveLength(1)

    // --- (2) INBOUND per-link quota isolation, over the wire ------------------
    // orgX may push exactly ONE inbound task across ws; the 2nd fail-closes at
    // home's inbound gate.
    const x1 = await hubX.hub.dispatch({
      from: 'x-user',
      strategy: { kind: 'capability', capabilities: ['home-task'] },
      payload: { n: 1 },
    })
    expect(x1.kind).toBe('ok')
    const x2 = await hubX.hub.dispatch({
      from: 'x-user',
      strategy: { kind: 'capability', capabilities: ['home-task'] },
      payload: { n: 2 },
    })
    expect(x2.kind).toBe('failed')
    if (x2.kind === 'failed') {
      expect(x2.error).toMatch(/cross_org_policy_denied/)
      expect(x2.error).toMatch(/per_link_quota_exceeded/)
    }

    // orgY has no budget — three inbound tasks all land over ws. The home agent
    // saw orgX's single allowed task + all three of orgY's = 4, proving the
    // orgX clamp never touched the orgY edge.
    for (let i = 0; i < 3; i++) {
      const r = await hubY.hub.dispatch({
        from: 'y-user',
        strategy: { kind: 'capability', capabilities: ['home-task'] },
        payload: { n: i },
      })
      expect(r.kind).toBe('ok')
    }
    expect(homeAgent.captured).toHaveLength(4)
  })
})

/**
 * The KB axis (Stream C-M1) rides a DIFFERENT transport path than dispatch:
 * `link.rpc()` → `MESH_RPC_CALL` frame → the gated `rpcResponder` on the
 * receiver, vs `link.dispatch()` → `MESH_TASK`. Proving the KB allowlist holds
 * over real ws RPC frames is the transport guarantee the dispatch test above
 * can't show. (The C-M2 node-I/O axis is the same `MESH_TASK` data-class gate
 * the dispatch test already covers — just workflow-wrapped — so it's omitted.)
 */
const sharedResponder: RpcResponder = async (call) => {
  switch (call.method) {
    case MCP_PROXY_METHODS.listShared:
      return [
        { name: 'kb-a', description: 'A' },
        { name: 'kb-b', description: 'B' },
      ]
    case MCP_PROXY_METHODS.callTool:
      return { ok: true, server: (call.params as { server: string }).server }
    default:
      throw new Error(`shared: unknown method ${call.method}`)
  }
}

describe('Route B P1-M9 — per-link KB allowlist holds over real WebSocket RPC frames', () => {
  let home: Hub
  let hubX: ServerNode
  let hubY: ServerNode
  const homeLinks: HubLink[] = []

  beforeEach(async () => {
    home = Hub.inMemory()
    await home.start()
    hubX = await startServerNode('orgX')
    hubY = await startServerNode('orgY')
  })

  afterEach(async () => {
    for (const link of homeLinks) await link.close().catch(() => {})
    homeLinks.length = 0
    await hubX.stop()
    await hubY.stop()
    await home.stop()
  })

  it('clamping orgX to [kb-a] leaves orgY seeing+calling both — over ws rpc', async () => {
    const linkHomeToX = await dialOut('orgHome', hubX)
    const linkHomeToY = await dialOut('orgHome', hubY)
    homeLinks.push(linkHomeToX, linkHomeToY)
    const linkXToHome = hubX.inboundLinks[0]!
    const linkYToHome = hubY.inboundLinks[0]!

    // home's edges carry the per-link KB allowlist on the rpc responder: orgX
    // clamped to [kb-a], orgY ungated (sees+calls both).
    installPeerLink({
      hub: home,
      link: linkHomeToX,
      remoteCapabilities: [],
      selfHubId: 'orgHome',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
      rpcResponder: gateKnowledgeBaseRpc(sharedResponder, ['kb-a']),
    })
    installPeerLink({
      hub: home,
      link: linkHomeToY,
      remoteCapabilities: [],
      selfHubId: 'orgHome',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
      rpcResponder: sharedResponder,
    })
    installPeerLink({
      hub: hubX.hub,
      link: linkXToHome,
      remoteCapabilities: [],
      selfHubId: 'orgX',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
    })
    installPeerLink({
      hub: hubY.hub,
      link: linkYToHome,
      remoteCapabilities: [],
      selfHubId: 'orgY',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
    })

    await drain()

    // orgX side: discovery filtered to [kb-a]; calling the off-list kb-b rejects
    // — both over real ws rpc frames.
    const xShared = (await linkXToHome.rpc(MCP_PROXY_METHODS.listShared, {})) as Array<{
      name: string
    }>
    expect(xShared.map((r) => r.name)).toEqual(['kb-a'])
    await expect(
      linkXToHome.rpc(MCP_PROXY_METHODS.callTool, { server: 'kb-b', name: 'q', args: {} }),
    ).rejects.toThrow(/kb-b.*not callable/)

    // orgY side (ungated): sees both, calls kb-b fine — the orgX clamp never
    // touched the orgY edge.
    const yShared = (await linkYToHome.rpc(MCP_PROXY_METHODS.listShared, {})) as Array<{
      name: string
    }>
    expect(yShared.map((r) => r.name).sort()).toEqual(['kb-a', 'kb-b'])
    expect(
      await linkYToHome.rpc(MCP_PROXY_METHODS.callTool, { server: 'kb-b', name: 'q', args: {} }),
    ).toEqual({ ok: true, server: 'kb-b' })
  })
})
