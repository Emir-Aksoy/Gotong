/**
 * v5 Stream G day-5 — cross-hub transcript correlation handle (`peerTaskId`).
 *
 * When a task crosses an inproc HubLink and a participant runs it on the far
 * side, the result that comes back carries `peerTaskId` = the id under which
 * the FAR hub recorded that task in its own transcript. The caller persists
 * this handle (on the workflow StepRecord) and later uses it to fetch that one
 * task's transcript from the peer (`peer.transcript` RPC). These tests pin:
 *
 *   1. the handle is present and EQUALS the id the peer agent actually saw,
 *      and DIFFERS from the caller's wire id (the relabelled `taskId`);
 *   2. a SAME-hub result has no handle — nothing crossed, nothing to correlate;
 *   3. a relay A→B→C overwrites the handle at each hop, so A receives B's id
 *      (its DIRECT peer), never C's — the deeper trace stays B↔C's business.
 */
import { describe, expect, it } from 'vitest'

import { Hub } from '../src/hub.js'
import { createInprocHubLinkPair } from '../src/hub-link.js'
import { installPeerLink } from '../src/peer-link-install.js'
import { AgentParticipant } from '../src/participants/agent.js'
import type { ParticipantId, Task, TaskId } from '../src/types.js'

class IdCaptureAgent extends AgentParticipant {
  public capturedTaskId: TaskId | undefined
  constructor(id: string, capabilities: readonly string[]) {
    super({ id, capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    this.capturedTaskId = task.id
    return 'done'
  }
}

describe('installPeerLink — cross-hub transcript correlation handle', () => {
  it('stamps peerTaskId = the id the peer agent saw, distinct from the wire id', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const worker = new IdCaptureAgent('b-worker', ['draft'])
    hubB.register(worker)

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
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    // The handle is the far hub's internal id — exactly the id the worker saw.
    expect(result.peerTaskId).toBeDefined()
    expect(result.peerTaskId).toBe(worker.capturedTaskId)
    // ...and it is NOT the caller's wire id (the relabelled taskId), which is
    // what the local pending-dispatch table matches on.
    expect(result.peerTaskId).not.toBe(result.taskId)
  })

  it('leaves peerTaskId absent for a same-hub result (nothing crossed)', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new IdCaptureAgent('local', ['draft']))

    const result = await hub.dispatch({
      from: 'system' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'x',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    // No relabel happened → no correlation handle. The run UI shows no
    // "view peer transcript" affordance for a step that stayed local.
    expect(result.peerTaskId).toBeUndefined()

    await hub.stop()
  })

  it('relay A→B→C overwrites the handle so A gets B (its direct peer), not C', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    const hubC = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start(), hubC.start()])

    const svc = new IdCaptureAgent('c-svc', ['remote-svc'])
    hubC.register(svc)

    // B ↔ C (B relays onward to C).
    const bc = createInprocHubLinkPair({ aPeerId: 'hubC', bPeerId: 'hubB' })
    installPeerLink({ hub: hubB, link: bc.a, remoteCapabilities: ['remote-svc'] })
    installPeerLink({ hub: hubC, link: bc.b, remoteCapabilities: [] })

    // A ↔ B.
    const ab = createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
    installPeerLink({ hub: hubA, link: ab.a, remoteCapabilities: ['remote-svc'] })
    installPeerLink({ hub: hubB, link: ab.b, remoteCapabilities: [] })

    const result = await hubA.dispatch({
      from: 'system' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['remote-svc'] },
      payload: 'x',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(svc.capturedTaskId).toBeDefined() // C actually ran
    expect(result.peerTaskId).toBeDefined()
    // A correlates to its DIRECT peer B's transcript, never to C's id — the
    // A↔B boundary must not leak the deeper B↔C hop's internal id.
    expect(result.peerTaskId).not.toBe(svc.capturedTaskId)
    expect(result.peerTaskId).not.toBe(result.taskId)

    await Promise.all([hubA.stop(), hubB.stop(), hubC.stop()])
  })
})
