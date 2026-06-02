/**
 * v5 C-M3 — Stream C combined multi-org isolation acceptance gate.
 *
 * The P4 gate (peer-isolation-e2e.test.ts) proved the "free graph, not a tree"
 * invariant for the data-class + quota dimensions. Stream C added TWO more
 * per-link dimensions:
 *   - C-M1: which shared knowledge bases (MCP servers) a peer may discover+call
 *           (the rpc path: mcp.listShared / mcp.callTool).
 *   - C-M2: which data classes a workflow NODE's I/O may carry across the link
 *           (the dispatch path: Task.dataClasses vs allowedDataClasses).
 *
 * This gate wires ONE home hub to TWO peers — orgX clamped on BOTH new
 * dimensions, orgY wide open — and proves a restriction on orgX never bleeds
 * onto orgY, across BOTH dimensions at once. It's the composition no
 * single-dimension test shows: the two new contract axes are independent AND
 * per-link.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AgentParticipant,
  Hub,
  createInprocHubLinkPair,
  installPeerLink,
  type Task,
} from '@aipehub/core'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
  type PeerRegistration,
} from '@aipehub/identity'
import { WorkflowRunner, parseWorkflow } from '@aipehub/workflow'

import { gateKnowledgeBaseRpc, type RpcResponder } from '../src/peer-kb-gate.js'
import { MCP_PROXY_METHODS } from '../src/mcp-proxy.js'

class RecordingAgent extends AgentParticipant {
  readonly captured: Task[] = []
  protected async handleTask(task: Task): Promise<unknown> {
    this.captured.push(task)
    return { seen: true }
  }
}

/** The single shared, peer-AGNOSTIC KB responder (McpProxyHost.respond shape). */
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

/** Thread a row into the rpc responder the verbatim PeerRegistry C-M1 way. */
function rpcOptsFromRow(row: PeerRegistration): { rpcResponder: RpcResponder } {
  if (!row.allowedKnowledgeBases) return { rpcResponder: sharedResponder }
  return { rpcResponder: gateKnowledgeBaseRpc(sharedResponder, row.allowedKnowledgeBases) }
}

describe('v5 C-M3 — Stream C contracts (KB + node I/O) are isolated across peers', () => {
  let store: IdentityStore
  let tmp: string
  let home: Hub
  let hubX: Hub
  let hubY: Hub
  let xAgent: RecordingAgent
  let yAgent: RecordingAgent
  let pairX: ReturnType<typeof createInprocHubLinkPair>
  let pairY: ReturnType<typeof createInprocHubLinkPair>

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'aipe-stream-c-iso-'))
    store = openIdentityStore({
      dbPath: join(tmp, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })

    // orgX — clamped on BOTH new axes: only kb-a callable, only `public` leaves.
    store.addPeer({
      peerId: 'orgX',
      endpointUrl: 'wss://x.example',
      peerToken: 'tok-orgx-12345678',
      kind: 'organization',
      allowedKnowledgeBases: ['kb-a'],
      allowedDataClasses: ['public'],
    })
    // orgY — wide open on both (null rows → legacy all-allowed).
    store.addPeer({
      peerId: 'orgY',
      endpointUrl: 'wss://y.example',
      peerToken: 'tok-orgy-12345678',
      kind: 'organization',
    })
    const rowX = store.getPeerByPeerId('orgX')!
    const rowY = store.getPeerByPeerId('orgY')!

    home = Hub.inMemory()
    hubX = Hub.inMemory()
    hubY = Hub.inMemory()
    await Promise.all([home.start(), hubX.start(), hubY.start()])
    xAgent = new RecordingAgent({ id: 'x-agent', capabilities: ['svc-x'] })
    yAgent = new RecordingAgent({ id: 'y-agent', capabilities: ['svc-y'] })
    hubX.register(xAgent)
    hubY.register(yAgent)

    pairX = createInprocHubLinkPair({ aPeerId: 'orgX', bPeerId: 'orgHome' })
    pairY = createInprocHubLinkPair({ aPeerId: 'orgY', bPeerId: 'orgHome' })

    // home edges: each wrapper carries the OUTBOUND data-class contract; the rpc
    // responder carries the per-link KB allowlist — both from the row.
    installPeerLink({
      hub: home,
      link: pairX.a,
      remoteCapabilities: ['svc-x'],
      selfHubId: 'orgHome',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
      ...(rowX.allowedDataClasses ? { allowedDataClasses: rowX.allowedDataClasses } : {}),
      ...rpcOptsFromRow(rowX),
    })
    installPeerLink({
      hub: home,
      link: pairY.a,
      remoteCapabilities: ['svc-y'],
      selfHubId: 'orgHome',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
      ...(rowY.allowedDataClasses ? { allowedDataClasses: rowY.allowedDataClasses } : {}),
      ...rpcOptsFromRow(rowY),
    })
    // peer edges back: register the inbound 'task' handler so a forwarded task
    // reaches the peer hub's agent (the peers don't dispatch back here).
    installPeerLink({
      hub: hubX,
      link: pairX.b,
      remoteCapabilities: [],
      selfHubId: 'orgX',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
    })
    installPeerLink({
      hub: hubY,
      link: pairY.b,
      remoteCapabilities: [],
      selfHubId: 'orgY',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
    })
  })
  afterEach(async () => {
    store.close()
    await Promise.all([home.stop(), hubX.stop(), hubY.stop()])
    await rm(tmp, { recursive: true, force: true })
  })

  it('C-M1 KB axis — clamping orgX to [kb-a] leaves orgY seeing+calling both', async () => {
    const xShared = (await pairX.b.rpc(MCP_PROXY_METHODS.listShared, {})) as Array<{ name: string }>
    expect(xShared.map((r) => r.name)).toEqual(['kb-a'])
    await expect(
      pairX.b.rpc(MCP_PROXY_METHODS.callTool, { server: 'kb-b', name: 'q', args: {} }),
    ).rejects.toThrow(/kb-b.*not callable/)

    const yShared = (await pairY.b.rpc(MCP_PROXY_METHODS.listShared, {})) as Array<{ name: string }>
    expect(yShared.map((r) => r.name).sort()).toEqual(['kb-a', 'kb-b'])
    expect(await pairY.b.rpc(MCP_PROXY_METHODS.callTool, { server: 'kb-b', name: 'q', args: {} })).toEqual({
      ok: true,
      server: 'kb-b',
    })
  })

  it('C-M2 node-I/O axis — a pii node is refused to orgX but the SAME class crosses to orgY', async () => {
    // Workflow → orgX: public node crosses, pii node refused (orgX clamped).
    const wfX = parseWorkflow(`
schema: aipehub.workflow/v1
workflow:
  id: to-x
  trigger: { capability: run-x }
  steps:
    - id: pub
      dispatch:
        strategy: { kind: capability, capabilities: [svc-x] }
        payload: { note: hi }
        dataClasses: [public]
    - id: pii
      dispatch:
        strategy: { kind: capability, capabilities: [svc-x] }
        payload: { ssn: x }
        dataClasses: [pii]
`)
    // Workflow → orgY: the identical pii node sails through (orgY open).
    const wfY = parseWorkflow(`
schema: aipehub.workflow/v1
workflow:
  id: to-y
  trigger: { capability: run-y }
  steps:
    - id: pii
      dispatch:
        strategy: { kind: capability, capabilities: [svc-y] }
        payload: { ssn: x }
        dataClasses: [pii]
`)
    home.register(new WorkflowRunner({ definition: wfX, hub: home }))
    home.register(new WorkflowRunner({ definition: wfY, hub: home }))

    const runX = await home.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['run-x'] },
      payload: {},
    })
    expect(runX.kind).toBe('failed') // halts at the refused pii node
    if (runX.kind === 'failed') expect(runX.error).toMatch(/outbound_data_class_denied:pii/)

    const runY = await home.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['run-y'] },
      payload: {},
    })
    expect(runY.kind).toBe('ok')

    // orgX saw ONLY its public task; orgY saw the pii task — the orgX clamp
    // never touched the orgY edge.
    expect(xAgent.captured.map((t) => t.payload)).toEqual([{ note: 'hi' }])
    expect(yAgent.captured.map((t) => t.payload)).toEqual([{ ssn: 'x' }])
  })
})
