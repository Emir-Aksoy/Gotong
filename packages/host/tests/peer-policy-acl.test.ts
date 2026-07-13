/**
 * Phase 18 B-M2 — a peer's persisted inbound ACL actually gates inbound
 * tasks.
 *
 * The receiver-side ACL ENFORCEMENT lives in core (peer-link-mesh.test.ts
 * FED-M3). What this test pins is the HOST seam B-M2 adds: a
 * `PeerInboundAcl` stored on a real identity peer row, read back, and
 * threaded into `installPeerLink({acl})` EXACTLY the way PeerRegistry now
 * does it — `...(row.acl ? { acl: row.acl } : {})` — gates a cross-hub
 * dispatch. The two hubs are wired over an inproc HubLink pair (no ws), so
 * this is an assertion about the identity→core ACL bridge, not transport.
 *
 *   - acl { capabilities: ['probe'] }  → 'probe' passes, 'sensitive-op'
 *       denied with cross_org_acl_denied (capability_denied), and the
 *       denied task never reaches the receiver's agent.
 *   - acl null (legacy / unset row)    → the `row.acl ? … : {}` spread
 *       omits the gate, so every capability passes (back-compat).
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
} from '@gotong/core'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@gotong/identity'

/** Records every task it's handed so a test can assert what crossed the gate. */
class RecordingAgent extends AgentParticipant {
  readonly captured: Task[] = []
  protected async handleTask(task: Task): Promise<unknown> {
    this.captured.push(task)
    return { seen: true }
  }
}

describe('peer inbound ACL from the identity row gates tasks (Phase 18 B-M2)', () => {
  let store: IdentityStore
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-peer-acl-'))
    store = openIdentityStore({
      dbPath: join(tmp, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
  })
  afterEach(async () => {
    store.close()
    await rm(tmp, { recursive: true, force: true })
  })

  /**
   * Wire sender hubA → receiver hubB over an inproc pair. The receiver
   * installs with the peer row's acl threaded the SAME way PeerRegistry
   * does. Returns the sender hub + the recorder so tests assert verdicts.
   */
  async function linkedPair(peerId: string) {
    const row = store.getPeerByPeerId(peerId)!
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const recorder = new RecordingAgent({ id: 'b-record', capabilities: ['probe', 'sensitive-op'] })
    hubB.register(recorder)

    const { a, b } = createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
    // Sender claims both caps so dispatch reaches the link regardless of the
    // receiver's ACL; sender stamps an origin so requireOrigin-style ACLs
    // would have something to evaluate.
    installPeerLink({
      hub: hubA,
      link: a,
      remoteCapabilities: ['probe', 'sensitive-op'],
      // GT-M2: the sender must allowlist what it sends (this test exercises the
      // RECEIVER's inbound ACL, so the outbound side is opened for both caps).
      outboundCaps: ['probe', 'sensitive-op'],
      selfHubId: 'orgA-hub',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
    })
    installPeerLink({
      hub: hubB,
      link: b,
      selfHubId: 'orgB-hub',
      // This is the verbatim B-M2 threading from peer-registry.ts.
      ...(row.acl ? { acl: row.acl } : {}),
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

  it('a capability allowlist ACL accepts an allowed cap, denies the rest', async () => {
    store.addPeer({
      peerId: 'hub_acl',
      endpointUrl: 'wss://acl.example',
      peerToken: 'tok-acl-12345678',
      kind: 'organization',
      acl: { capabilities: ['probe'] },
    })
    const { hubA, recorder, stop } = await linkedPair('hub_acl')

    const ok = await hubA.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['probe'] },
      payload: {},
    })
    expect(ok.kind).toBe('ok')

    const denied = await hubA.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['sensitive-op'] },
      payload: {},
    })
    expect(denied.kind).toBe('failed')
    if (denied.kind === 'failed') {
      expect(denied.error).toMatch(/cross_org_acl_denied/)
      expect(denied.error).toMatch(/capability_denied:sensitive-op/)
    }
    // The gate kept the denied task out of the receiver hub entirely;
    // only the allowed 'probe' task reached the agent.
    expect(recorder.captured).toHaveLength(1)
    await stop()
  })

  it('a null acl (unset row) leaves the gate off — every cap passes', async () => {
    store.addPeer({
      peerId: 'hub_open',
      endpointUrl: 'wss://open.example',
      peerToken: 'tok-open-12345678',
      // no acl → row.acl is null → no gate installed
    })
    const { hubA, recorder, stop } = await linkedPair('hub_open')

    const r1 = await hubA.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['sensitive-op'] },
      payload: {},
    })
    expect(r1.kind).toBe('ok')
    expect(recorder.captured).toHaveLength(1)
    await stop()
  })
})
