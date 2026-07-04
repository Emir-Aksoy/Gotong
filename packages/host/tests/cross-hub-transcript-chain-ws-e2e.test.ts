/**
 * P1-M2 — cross-hub transcript CHAIN over a REAL WebSocket (E2E).
 *
 * `cross-hub-transcript-chain-e2e.test.ts` (Stream G day-5 M7) proves the
 * transcript chain connects end-to-end — step crosses, `peerTaskId` persists,
 * the peer's transcript comes back through the opt-in `peer.transcript` rpc — but
 * over an INPROC link pair. P1-M2 reruns it over the real
 * `connectHubLink`/`acceptHubLinks` transport, so the chain rides real frames:
 * a real `MESH_TASK` out for the step, then a real `MESH_RPC_CALL` for the
 * transcript pull. (The rpc-over-ws path itself is proven by the M9 KB-gate
 * sibling; this proves the transcript chain specifically rides it.)
 *
 * The point is the WIRING, not the payloads (same stance as M7): the assertions
 * confirm the chain ran THROUGH — a handle persisted, the fetch reached the peer
 * over ws, the peer's own events came back keyed to that handle — not the exact
 * content of any event.
 *
 * Two cases prove the chain AND its gate, over the wire:
 *   - shared    — hub B answers `peer.transcript`; the slice returns over ws
 *                 keyed to the same `peerTaskId`, carrying the peer's events.
 *   - not shared— the SAME chain reaches hub B, but its per-link gate
 *                 (`denyPeerTranscriptRpc`) rejects fail-closed; the controller
 *                 surfaces a soft `fetch_failed` verdict rather than throwing.
 *
 * No approval gate (orthogonal to the chain): this uses the synchronous un-gated
 * cross-hub path so the chain itself stays in focus. No identity / inbox needed —
 * nothing parks.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import { AgentParticipant, Hub, installPeerLink, type HubLink, type Task } from '@gotong/core'
import { acceptHubLinks, connectHubLink } from '@gotong/transport-ws'

import { WorkflowController } from '../src/workflow-controller.js'
import { PeerTranscriptHost, denyPeerTranscriptRpc } from '../src/peer-transcript.js'

const PEER_CAP = 'contract-review'
// hub A dials hub B with this as `expectedPeerId`; the outbound wrapper is named
// after `link.peerId`, so executedBy / the peer-link resolver key on 'orgB'.
const PEER_ID = 'orgB'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const drain = async () => {
  for (let i = 0; i < 12; i++) await delay(5)
}

const WORKFLOW_YAML = `
schema: gotong.workflow/v1
workflow:
  id: cross-hub-flow
  name: cross-hub orchestration
  trigger: { capability: cx:start }
  steps:
    - id: review
      dispatch:
        strategy: { kind: capability, capabilities: [${PEER_CAP}] }
        payload: { doc: $trigger.payload.doc }
`

/** Receiver-side worker on hub B. Running it is what writes hub B's transcript. */
class ProviderAgent extends AgentParticipant {
  protected async handleTask(task: Task): Promise<unknown> {
    return { reviewed: true, doc: (task.payload as { doc?: unknown }).doc }
  }
}

describe('P1-M2 — cross-hub transcript chain over a real WebSocket', () => {
  let tmp: string
  let hubA: Hub // orchestrator (runs the workflow + pulls the chain) — dials out
  let hubB: Hub // provider (owns the capability + the transcript) — accepts
  let wss: WebSocketServer
  let hubBUrl: string
  let controller: WorkflowController
  // Set by installCrossHubPeer; the controller's resolver reads it LAZILY.
  let linkToHubB: HubLink | null
  const homeLinks: HubLink[] = []
  const hubBInbound: HubLink[] = []

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-cross-hub-tx-ws-e2e-'))
    hubA = Hub.inMemory()
    hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])
    hubB.register(new ProviderAgent({ id: 'b-reviewer', capabilities: [PEER_CAP] }))
    linkToHubB = null

    // hub B's real ws server. The accepted link is just stashed here; its inbound
    // side (task handler + the share-dependent transcript responder) is installed
    // in installCrossHubPeer, because the responder depends on the per-test flag.
    wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const addr = wss.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    hubBUrl = `ws://127.0.0.1:${port}`
    acceptHubLinks({ server: wss, selfId: PEER_ID, onLink: (link) => hubBInbound.push(link) })

    controller = new WorkflowController({
      hub: hubA,
      definitionsDir: join(tmp, 'workflows', 'definitions'),
      spaceRoot: tmp,
      peerCapabilities: {
        peerCapabilities: () => {
          const wrapper = hubA.participants().find((p) => p.id === PEER_ID)
          return wrapper
            ? [{ peer: PEER_ID, label: 'Org B', capabilities: [...wrapper.capabilities], kind: 'peer' as const }]
            : []
        },
      },
      // day-5 M5 — resolve a step's persisted executedBy (the peer-hub id) to the
      // live link. Lazy: honest before installCrossHubPeer wires it.
      peerLinkResolver: (peerId) => (peerId === PEER_ID ? linkToHubB : null),
    })
  })

  afterEach(async () => {
    for (const link of homeLinks) await link.close().catch(() => {})
    homeLinks.length = 0
    for (const link of hubBInbound) await link.close().catch(() => {})
    hubBInbound.length = 0
    for (const c of wss.clients) {
      try {
        c.terminate()
      } catch {
        /* swallow */
      }
    }
    await new Promise<void>((r) => wss.close(() => r()))
    await Promise.all([hubA.stop(), hubB.stop()])
    rmSync(tmp, { recursive: true, force: true })
  })

  /**
   * Dial hub A → hub B over REAL ws. hub B answers `peer.transcript` over its
   * inbound link, gated by `share` exactly the peer-registry way:
   * `denyPeerTranscriptRpc` wraps the host UNLESS the peer opted in. An rpc sent
   * over hub A's link is answered by the responder on hub B's inbound link.
   */
  async function installCrossHubPeer(share: boolean): Promise<void> {
    const linkAToB = await connectHubLink({ url: hubBUrl, selfId: 'orgA', expectedPeerId: PEER_ID })
    homeLinks.push(linkAToB)
    for (let i = 0; i < 40 && hubBInbound.length === 0; i++) await delay(10)
    expect(hubBInbound.length).toBeGreaterThan(0)

    installPeerLink({
      hub: hubA,
      link: linkAToB,
      selfHubId: 'orgA',
      remoteCapabilities: [PEER_CAP], // G-M1 — advertise so the step routes here
      outboundCaps: [PEER_CAP], // P4-M1 — the same allowlist authorizes the cross
    })
    const host = new PeerTranscriptHost({ hub: hubB, hubId: 'orgB' })
    const responder = share ? host.respond : denyPeerTranscriptRpc(host.respond)
    installPeerLink({ hub: hubB, link: hubBInbound[0]!, selfHubId: 'orgB', rpcResponder: responder })
    linkToHubB = linkAToB
    await drain()
  }

  /** Import the workflow, fire its trigger over ws, return the (single) run id. */
  async function runCrossHubStep(doc: string): Promise<string> {
    await controller.importFromText(WORKFLOW_YAML)
    const fired = await hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['cx:start'] },
      payload: { doc },
    })
    expect(fired.kind).toBe('ok') // un-gated cross-hub step resolves synchronously
    await drain()
    const runs = await controller.listRuns({ workflowId: 'cross-hub-flow' })
    return runs[0]!.runId
  }

  it('shared → the whole chain runs through over ws: step crosses, peerTaskId persists, the peer transcript comes back over the real link', async () => {
    await installCrossHubPeer(true)
    const runId = await runCrossHubStep('NDA.txt')

    // The cross-hub step recorded WHO ran it and the durable handle to ITS trace —
    // the id hub B recorded its own task under, carried back over the result
    // frame. This is the thread the chain pulls on.
    const run = await controller.readRun(runId)
    const step = run?.steps.find((s) => s.stepId === 'review')
    expect(step?.executedBy).toBe(PEER_ID)
    expect(typeof step?.peerTaskId).toBe('string')
    expect((step?.peerTaskId ?? '').length).toBeGreaterThan(0)

    // Pull the chain: executedBy→link, `peer.transcript` over the REAL ws link
    // (a MESH_RPC_CALL frame), hub B slices its transcript by peerTaskId, answers.
    const out = (await controller.fetchPeerStepTranscript(runId, 'review')) as {
      ok: boolean
      slice?: { taskId: string; events: unknown[] }
    }

    // The chain connected end-to-end over the wire: a slice came back, keyed to
    // the SAME handle, carrying the peer's own events. We assert the chain RAN
    // THROUGH — a handle resolved, the link answered, events returned.
    expect(out.ok).toBe(true)
    expect(out.slice!.taskId).toBe(step!.peerTaskId)
    expect(out.slice!.events.length).toBeGreaterThan(0)
  })

  it('not shared → the same chain is fail-closed over ws: the opt-in gate rejects the fetch', async () => {
    await installCrossHubPeer(false)
    const runId = await runCrossHubStep('NDA.txt')

    // The step still crossed and recorded peerTaskId — only transcript SHARING is
    // off. So the chain reaches the peer over ws, but its per-link gate rejects;
    // the controller turns that rejection into the soft `fetch_failed` verdict.
    const out = (await controller.fetchPeerStepTranscript(runId, 'review')) as {
      ok: boolean
      code?: string
    }
    expect(out.ok).toBe(false)
    expect(out.code).toBe('fetch_failed')
  })
})
