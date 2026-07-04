/**
 * v5 Stream G-M1 — a peer's curated OUTBOUND capability allowlist doubles as
 * the wrapper's ADVERTISED capabilities, so a local capability dispatch (e.g. a
 * workflow step) can ROUTE across the link and the SAME allowlist AUTHORIZES
 * the cross. This is the linchpin that makes cross-hub workflow orchestration
 * possible at all: before G-M1 the wrapper advertised nothing, so no capability
 * dispatch could ever select a peer.
 *
 * Like peer-policy-acl.test.ts, this pins the HOST seam by threading
 * installPeerLink options EXACTLY the way PeerRegistry now does
 * (peer-registry.ts dialOne + installInboundLink):
 *   ...(row.outboundCaps ? { remoteCapabilities: row.outboundCaps } : {})
 *   ...(row.outboundCaps ? { outboundCaps:      row.outboundCaps } : {})
 * over an inproc HubLink pair (no ws) — an assertion about the identity→core
 * advertise/authorize bridge, not transport.
 *
 *   - outboundCaps ['greet']  → 'greet' ROUTES to the peer wrapper AND the
 *       allowlist authorizes the cross → reaches the receiver's agent.
 *   - outboundCaps null (unset row) → no remoteCapabilities → the wrapper
 *       advertises nothing → 'greet' finds no_participant (the secure default:
 *       a peer you didn't curate is NOT orchestrable by capability).
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
import { MASTER_KEY_LEN_BYTES, openIdentityStore, type IdentityStore } from '@gotong/identity'

/** Receiver-side worker that records every task it's handed. */
class RecordingAgent extends AgentParticipant {
  readonly captured: Task[] = []
  protected async handleTask(task: Task): Promise<unknown> {
    this.captured.push(task)
    return { greeted: true }
  }
}

describe('v5 Stream G-M1 — outboundCaps advertise the peer wrapper for cross-hub workflow routing', () => {
  let store: IdentityStore
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-peer-advertise-'))
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
   * Wire sender hubA → receiver hubB over an inproc pair, threading the peer
   * row's outboundCaps into BOTH remoteCapabilities (advertise) and outboundCaps
   * (authorize) the verbatim way peer-registry does.
   */
  async function linkedPair(peerId: string) {
    const row = store.getPeerByPeerId(peerId)!
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const recorder = new RecordingAgent({ id: 'b-greeter', capabilities: ['greet'] })
    hubB.register(recorder)

    const { a, b } = createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
    installPeerLink({
      hub: hubA,
      link: a,
      selfHubId: 'orgA-hub',
      // Verbatim peer-registry G-M1 (advertise) + P4-M1 (authorize) threading.
      ...(row.outboundCaps ? { remoteCapabilities: row.outboundCaps } : {}),
      ...(row.outboundCaps ? { outboundCaps: row.outboundCaps } : {}),
    })
    installPeerLink({ hub: hubB, link: b, selfHubId: 'orgB-hub' })
    return {
      hubA,
      recorder,
      stop: async () => {
        await hubA.stop()
        await hubB.stop()
      },
    }
  }

  it('curated outboundCaps advertise the wrapper → a capability dispatch routes cross-hub AND is authorized', async () => {
    store.addPeer({
      peerId: 'hub_greet',
      endpointUrl: 'wss://greet.example',
      peerToken: 'tok-greet-12345678',
      kind: 'organization',
      outboundCaps: ['greet'],
    })
    const { hubA, recorder, stop } = await linkedPair('hub_greet')

    // A workflow step is just another dispatcher (from = `workflow:<id>`); a
    // plain capability dispatch is exactly what `runner.dispatchOne` emits.
    const r = await hubA.dispatch({
      from: 'workflow:demo-flow',
      strategy: { kind: 'capability', capabilities: ['greet'] },
      payload: { hello: 'world' },
    })
    expect(r.kind).toBe('ok')
    // It actually crossed the link to the peer's agent (not handled locally —
    // hubA has no 'greet' agent of its own).
    expect(recorder.captured).toHaveLength(1)
    expect(recorder.captured[0]!.payload).toEqual({ hello: 'world' })
    await stop()
  })

  it('a peer with no curated outboundCaps advertises nothing → capability dispatch finds no_participant', async () => {
    store.addPeer({
      peerId: 'hub_silent',
      endpointUrl: 'wss://silent.example',
      peerToken: 'tok-silent-12345678',
      // no outboundCaps → row.outboundCaps null → wrapper advertises nothing
    })
    const { hubA, recorder, stop } = await linkedPair('hub_silent')

    const r = await hubA.dispatch({
      from: 'workflow:demo-flow',
      strategy: { kind: 'capability', capabilities: ['greet'] },
      payload: { hello: 'world' },
    })
    // The peer wrapper carries no caps and hubA has no local 'greet' agent, so
    // nobody covers the capability — the task never crosses (secure default).
    expect(r.kind).toBe('no_participant')
    expect(recorder.captured).toHaveLength(0)
    await stop()
  })
})
