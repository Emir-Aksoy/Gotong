/**
 * v5 Stream G day-5 M7 — cross-hub transcript CHAIN acceptance gate (E2E).
 *
 * THE test this milestone exists to pass: run the ENTIRE transcript chain
 * end-to-end over a REAL link and prove it CONNECTS. The point is the wiring,
 * not the payloads — so the assertions confirm the chain ran THROUGH (a handle
 * was persisted, the fetch reached the peer, the peer's own events came back),
 * not the exact content of any event.
 *
 * The chain, hop by hop (every wire-crossing component is real):
 *   1. hub A's workflow dispatches a step to a CAPABILITY that lives on peer hub
 *      B (G-M1 makes the wrapper advertise it, so the `{kind:capability}` step
 *      routes across the org boundary).
 *   2. The inbound link handler on hub B re-dispatches into hub B, which runs
 *      its agent and records `task` + `task_result` in ITS OWN transcript under
 *      a fresh internal id. day-5 M1 stamps that pre-relabel id onto the result
 *      as `peerTaskId`; M2 persists it on the workflow StepRecord. That is the
 *      durable thread the chain later pulls on.
 *   3. On demand, `WorkflowController.fetchPeerStepTranscript` resolves the
 *      step's `executedBy` (the peer-hub id) to the live link, calls the opt-in
 *      `peer.transcript` rpc over it (day-5 M4), and hub B's producer slices its
 *      transcript by `peerTaskId` and answers.
 *
 * Two cases prove the chain AND its gate:
 *   - shared    — the slice comes back over the real link, keyed to the same
 *                 handle, carrying the peer's events. The chain ran through.
 *   - not shared— the SAME chain reaches the peer, but its per-link gate
 *                 (`denyPeerTranscriptRpc`, the peer-registry way) rejects the
 *                 fetch fail-closed; the controller surfaces a soft
 *                 `fetch_failed` verdict rather than throwing.
 *
 * No approval gate here: outbound approval (day-4) is orthogonal to the
 * transcript chain, so this uses the synchronous un-gated cross-hub path to keep
 * the chain itself in focus. No new workflow schema — the step is a plain
 * dispatch whose capability happens to live on a peer.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AgentParticipant,
  Hub,
  createInprocHubLinkPair,
  installPeerLink,
  type HubLink,
  type Task,
} from '@aipehub/core'

import { WorkflowController } from '../src/workflow-controller.js'
import { PeerTranscriptHost, denyPeerTranscriptRpc } from '../src/peer-transcript.js'

const PEER_CAP = 'contract-review'

// A plain dispatch step whose capability lives on a peer. The runner emits an
// ordinary `{kind:capability}` dispatch — cross-hub orchestration is just
// capability dispatch where the capability lives on a peer.
const WORKFLOW_YAML = `
schema: aipehub.workflow/v1
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

describe('v5 Stream G day-5 M7 — cross-hub transcript chain end-to-end', () => {
  let tmp: string
  let hubA: Hub // orchestrator (runs the workflow + pulls the chain)
  let hubB: Hub // provider (owns the capability + the transcript)
  let controller: WorkflowController
  // Set by installCrossHubPeer; the controller's resolver reads it LAZILY so the
  // closure is honest before the link is wired.
  let linkToHubB: HubLink | null

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-cross-hub-tx-e2e-'))
    hubA = Hub.inMemory()
    hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])
    hubB.register(new ProviderAgent({ id: 'b-reviewer', capabilities: [PEER_CAP] }))
    linkToHubB = null

    controller = new WorkflowController({
      hub: hubA,
      definitionsDir: join(tmp, 'workflows', 'definitions'),
      spaceRoot: tmp,
      // The off-hub view the host builds from connected peers — here the 'hubB'
      // wrapper advertising PEER_CAP once the link is installed (lazy closure).
      peerCapabilities: {
        peerCapabilities: () => {
          const wrapper = hubA.participants().find((p) => p.id === 'hubB')
          return wrapper
            ? [{ peer: 'hubB', label: 'Org B', capabilities: [...wrapper.capabilities], kind: 'peer' as const }]
            : []
        },
      },
      // day-5 M5 — resolve a step's persisted `executedBy` (the peer-hub id) to
      // the live link. Lazy: honest before installCrossHubPeer wires it.
      peerLinkResolver: (peerId) => (peerId === 'hubB' ? linkToHubB : null),
    })
  })

  afterEach(async () => {
    await Promise.all([hubA.stop(), hubB.stop()])
    rmSync(tmp, { recursive: true, force: true })
  })

  /**
   * Wire orchestrator hub A → provider hub B over an inproc pair. hub B answers
   * `peer.transcript` over its inbound link, gated by `share` exactly the
   * peer-registry way: `denyPeerTranscriptRpc` wraps the host UNLESS the peer
   * opted in. An rpc sent over `a` is answered by the responder on `b`.
   */
  function installCrossHubPeer(share: boolean): void {
    const { a, b } = createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
    installPeerLink({
      hub: hubA,
      link: a,
      selfHubId: 'orgA',
      remoteCapabilities: [PEER_CAP], // G-M1 — advertise so the step routes here
      outboundCaps: [PEER_CAP], // P4-M1 — the same allowlist authorizes the cross
    })
    const host = new PeerTranscriptHost({ hub: hubB, hubId: 'orgB' })
    const responder = share ? host.respond : denyPeerTranscriptRpc(host.respond)
    installPeerLink({ hub: hubB, link: b, selfHubId: 'orgB', rpcResponder: responder })
    linkToHubB = a
  }

  /** Import the workflow, fire its trigger, return the (single) run id. */
  async function runCrossHubStep(doc: string): Promise<string> {
    await controller.importFromText(WORKFLOW_YAML)
    const fired = await hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['cx:start'] },
      payload: { doc },
    })
    // Un-gated cross-hub step resolves synchronously; the run never parks.
    expect(fired.kind).toBe('ok')
    const runs = await controller.listRuns({ workflowId: 'cross-hub-flow' })
    return runs[0]!.runId
  }

  it('shared → the whole chain runs through: step crosses, peerTaskId persists, the peer transcript comes back over the real link', async () => {
    installCrossHubPeer(true)
    const runId = await runCrossHubStep('NDA.txt')

    // The cross-hub step recorded WHO ran it and the durable handle to ITS trace
    // — the id hub B recorded its own task under. This is the thread the chain
    // pulls on; without it there is nothing to correlate.
    const run = await controller.readRun(runId)
    const step = run?.steps.find((s) => s.stepId === 'review')
    expect(step?.executedBy).toBe('hubB')
    expect(typeof step?.peerTaskId).toBe('string')
    expect((step?.peerTaskId ?? '').length).toBeGreaterThan(0)

    // Pull the chain: executedBy→link, `peer.transcript` over the REAL inproc
    // link, hub B slices its transcript by peerTaskId and answers.
    const out = (await controller.fetchPeerStepTranscript(runId, 'review')) as {
      ok: boolean
      slice?: { taskId: string; events: unknown[] }
    }

    // The chain connected end-to-end: a slice came back, keyed to the SAME
    // handle, carrying the peer's own events for that task. We assert the chain
    // RAN THROUGH — a handle resolved, the link answered, events returned — not
    // the exact event payloads.
    expect(out.ok).toBe(true)
    expect(out.slice!.taskId).toBe(step!.peerTaskId)
    expect(out.slice!.events.length).toBeGreaterThan(0)
  })

  it('not shared → the same chain is fail-closed: the opt-in gate rejects the fetch', async () => {
    installCrossHubPeer(false)
    const runId = await runCrossHubStep('NDA.txt')

    // The step still crossed and recorded peerTaskId — only transcript SHARING is
    // off. So the chain reaches the peer, but its per-link gate throws; the
    // controller turns that rejection into the soft `fetch_failed` verdict rather
    // than letting it escape as an exception.
    const out = (await controller.fetchPeerStepTranscript(runId, 'review')) as {
      ok: boolean
      code?: string
    }
    expect(out.ok).toBe(false)
    expect(out.code).toBe('fetch_failed')
  })
})
