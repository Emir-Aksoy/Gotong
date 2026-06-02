/**
 * v5 C-M2 — workflow node-level I/O authorization acceptance gate.
 *
 * P4-M4 put an OUTBOUND data-class contract on each federation link
 * (`PeerRegistration.allowedDataClasses`, enforced in `RemoteHubViaLink`), but
 * the workflow runner never stamped `Task.dataClasses` — so a workflow's
 * federated dispatches were invisible to that gate. C-M2 closes the loop: a
 * dispatch node declares the data classes its I/O carries, the runner stamps
 * them, and the per-link contract authorizes federated dispatch at the NODE
 * level — finer than the per-link capability allowlist.
 *
 * This wires a real `WorkflowRunner` on a home hub to a remote peer over an
 * inproc link clamped to `allowedDataClasses: ['public']`, and proves:
 *   1. a workflow with a `public` node + a `pii` node — the public node crosses,
 *      the pii node is refused (`outbound_data_class_denied:pii`). ONE workflow,
 *      two verdicts: node-level, not workflow-level.
 *   2. an all-`public` workflow crosses entirely — the clamp is class-specific,
 *      not a blanket block.
 *
 * The runner-side stamp is unit-tested in workflow/runner.test.ts; the gate
 * primitive in core/outbound-allowlist.test.ts. THIS pins the seam between
 * them — a declared node I/O class actually reaching the federation gate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AgentParticipant,
  Hub,
  createInprocHubLinkPair,
  installPeerLink,
  type Task,
} from '@aipehub/core'
import { WorkflowRunner, parseWorkflow } from '@aipehub/workflow'

/** Remote agent: records every task that actually crossed the link to it. */
class RecordingAgent extends AgentParticipant {
  readonly captured: Task[] = []
  protected async handleTask(task: Task): Promise<unknown> {
    this.captured.push(task)
    return { seen: true }
  }
}

describe('v5 C-M2 — workflow node-level I/O authorization over a clamped link', () => {
  let home: Hub
  let remote: Hub
  let remoteAgent: RecordingAgent

  beforeEach(async () => {
    home = Hub.inMemory()
    remote = Hub.inMemory()
    await Promise.all([home.start(), remote.start()])
    remoteAgent = new RecordingAgent({ id: 'remote-svc-agent', capabilities: ['remote-svc'] })
    remote.register(remoteAgent)

    // home → remote, clamped so only `public` data may leave to this peer.
    const pair = createInprocHubLinkPair({ aPeerId: 'orgRemote', bPeerId: 'orgHome' })
    installPeerLink({
      hub: home,
      link: pair.a,
      remoteCapabilities: ['remote-svc'],
      selfHubId: 'orgHome',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
      allowedDataClasses: ['public'],
    })
    installPeerLink({
      hub: remote,
      link: pair.b,
      remoteCapabilities: [],
      selfHubId: 'orgRemote',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
    })
  })
  afterEach(async () => {
    await Promise.all([home.stop(), remote.stop()])
  })

  it('refuses the pii node but lets the public node of the SAME workflow cross', async () => {
    const wf = parseWorkflow(`
schema: aipehub.workflow/v1
workflow:
  id: mixed-io
  trigger: { capability: run-mixed }
  steps:
    - id: public-step
      dispatch:
        strategy: { kind: capability, capabilities: [remote-svc] }
        payload: { note: hi }
        dataClasses: [public]
    - id: pii-step
      dispatch:
        strategy: { kind: capability, capabilities: [remote-svc] }
        payload: { ssn: '123' }
        dataClasses: [pii]
`)
    home.register(new WorkflowRunner({ definition: wf, hub: home }))

    const run = await home.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['run-mixed'] },
      payload: {},
    })

    // The run halts at the pii step (default onFailure) → overall failure that
    // names the node-level refusal.
    expect(run.kind).toBe('failed')
    if (run.kind === 'failed') expect(run.error).toMatch(/outbound_data_class_denied:pii/)

    // Only the public node ever reached the remote peer.
    expect(remoteAgent.captured).toHaveLength(1)
    expect(remoteAgent.captured[0]!.payload).toEqual({ note: 'hi' })
  })

  it('lets an all-public workflow cross entirely (clamp is class-specific)', async () => {
    const wf = parseWorkflow(`
schema: aipehub.workflow/v1
workflow:
  id: all-public
  trigger: { capability: run-public }
  steps:
    - id: a
      dispatch:
        strategy: { kind: capability, capabilities: [remote-svc] }
        payload: { n: 1 }
        dataClasses: [public]
    - id: b
      dispatch:
        strategy: { kind: capability, capabilities: [remote-svc] }
        payload: { n: 2 }
        dataClasses: [public]
`)
    home.register(new WorkflowRunner({ definition: wf, hub: home }))

    const run = await home.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['run-public'] },
      payload: {},
    })

    expect(run.kind).toBe('ok')
    expect(remoteAgent.captured.map((t) => t.payload)).toEqual([{ n: 1 }, { n: 2 }])
  })
})
