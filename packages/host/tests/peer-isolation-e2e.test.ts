/**
 * Phase 19 P4-M4 — multi-org isolation acceptance gate.
 *
 * The P4 north-star invariant: "a hub network is a free graph, not a hierarchy
 * tree — every link carries its OWN trust contract, and restricting one peer
 * must never bleed onto another." This test wires ONE home hub to TWO peer hubs
 * (orgX restricted, orgY open) over inproc link pairs, threading each peer's
 * contract from a real identity row the SAME way `PeerRegistry` does:
 *
 *   - outbound data-class allowlist + capability allowlist live on the
 *     `RemoteHubViaLink` wrapper (home → peer), via `allowedDataClasses` /
 *     `outboundCaps`.
 *   - the per-link inbound quota lives on the inbound handler (peer → home),
 *     via `inboundGate` backed by the registry's own `FixedWindowLimiter`.
 *
 * We then prove a restriction on orgX leaves orgY untouched:
 *   1. a `pii` task is refused to orgX (outbound_data_class_denied) but the
 *      SAME task succeeds to orgY.
 *   2. orgX's 1-task inbound budget fail-closes the 2nd inbound task
 *      (cross_org_policy_denied / per_link_quota_exceeded) while orgY accepts
 *      an unbounded stream.
 *
 * The receiver-side ENFORCEMENT primitives are covered by core
 * (outbound-allowlist.test.ts); what THIS pins is the host bridge — identity
 * row → registry threading → independent per-link verdicts — plus the
 * isolation guarantee that no existing single-edge test can show.
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

import { FixedWindowLimiter } from '../src/peer-registry.js'

/** Records every task it runs so a test can count what crossed each edge. */
class RecordingAgent extends AgentParticipant {
  readonly captured: Task[] = []
  protected async handleTask(task: Task): Promise<unknown> {
    this.captured.push(task)
    return { seen: true }
  }
}

/**
 * Mirror `PeerRegistry.inboundQuotaGate` for a row, using the registry's OWN
 * limiter class. A test installs once, so a fresh limiter is equivalent to the
 * registry's per-row-kept one.
 */
function inboundQuotaGate(
  row: PeerRegistration,
): { inboundGate?: (task: Task) => { ok: true } | { ok: false; reason: string } } {
  const budget = row.perLinkQuotaBudget
  if (!budget || budget <= 0) return {}
  const limiter = new FixedWindowLimiter(budget, 60_000)
  return {
    inboundGate: () =>
      limiter.attempt(row.id)
        ? { ok: true }
        : { ok: false, reason: 'per_link_quota_exceeded' },
  }
}

/** Thread a peer row into installPeerLink the verbatim PeerRegistry way. */
function optsFromRow(row: PeerRegistration) {
  return {
    ...(row.acl ? { acl: row.acl } : {}),
    ...(row.outboundCaps ? { outboundCaps: row.outboundCaps } : {}),
    ...(row.allowedDataClasses ? { allowedDataClasses: row.allowedDataClasses } : {}),
    ...inboundQuotaGate(row),
  }
}

describe('Phase 19 P4-M4 — per-link trust contracts are isolated across peers', () => {
  let store: IdentityStore
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'aipe-peer-isolation-'))
    store = openIdentityStore({
      dbPath: join(tmp, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
  })
  afterEach(async () => {
    store.close()
    await rm(tmp, { recursive: true, force: true })
  })

  it('restricting orgX (data class + inbound quota) leaves orgY unaffected', async () => {
    // orgX — clamped down: only `public` data may leave to it, only `svc-x`
    // capability, and at most ONE inbound task per window.
    store.addPeer({
      peerId: 'orgX',
      endpointUrl: 'wss://x.example',
      peerToken: 'tok-orgx-12345678',
      kind: 'organization',
      outboundCaps: ['svc-x'],
      allowedDataClasses: ['public'],
      perLinkQuotaBudget: 1,
    })
    // orgY — wide open (no contract); the legacy accept-all peer.
    store.addPeer({
      peerId: 'orgY',
      endpointUrl: 'wss://y.example',
      peerToken: 'tok-orgy-12345678',
      kind: 'organization',
    })
    const rowX = store.getPeerByPeerId('orgX')!
    const rowY = store.getPeerByPeerId('orgY')!

    const home = Hub.inMemory()
    const hubX = Hub.inMemory()
    const hubY = Hub.inMemory()
    await Promise.all([home.start(), hubX.start(), hubY.start()])

    // Agents that receive the OUTBOUND (home → peer) traffic.
    const xAgent = new RecordingAgent({ id: 'x-agent', capabilities: ['svc-x'] })
    const yAgent = new RecordingAgent({ id: 'y-agent', capabilities: ['svc-y'] })
    hubX.register(xAgent)
    hubY.register(yAgent)
    // Agent that receives the INBOUND (peer → home) traffic for the quota test.
    const homeAgent = new RecordingAgent({ id: 'home-agent', capabilities: ['home-task'] })
    home.register(homeAgent)

    // home ←→ orgX and home ←→ orgY, bidirectional inproc pairs.
    const pairX = createInprocHubLinkPair({ aPeerId: 'orgX', bPeerId: 'orgHome' })
    const pairY = createInprocHubLinkPair({ aPeerId: 'orgY', bPeerId: 'orgHome' })

    // home's edges: the wrapper carries the OUTBOUND contract; the inbound
    // handler carries the per-link quota — both derived from the row.
    installPeerLink({
      hub: home,
      link: pairX.a,
      remoteCapabilities: ['svc-x'],
      selfHubId: 'orgHome',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
      ...optsFromRow(rowX),
    })
    installPeerLink({
      hub: home,
      link: pairY.a,
      remoteCapabilities: ['svc-y'],
      selfHubId: 'orgHome',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
      ...optsFromRow(rowY),
    })
    // peer edges back to home advertise `home-task` so each peer can push an
    // inbound task that the home quota gate (or lack of one) then judges.
    installPeerLink({
      hub: hubX,
      link: pairX.b,
      remoteCapabilities: ['home-task'],
      selfHubId: 'orgX',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
    })
    installPeerLink({
      hub: hubY,
      link: pairY.b,
      remoteCapabilities: ['home-task'],
      selfHubId: 'orgY',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
    })

    // --- (1) OUTBOUND data-class isolation ------------------------------------
    // A `pii` task to the clamped orgX is refused before the wire.
    const piiToX = await home.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['svc-x'] },
      payload: { ssn: '...' },
      dataClasses: ['pii'],
    })
    expect(piiToX.kind).toBe('failed')
    if (piiToX.kind === 'failed') expect(piiToX.error).toMatch(/outbound_data_class_denied:pii/)
    expect(xAgent.captured).toHaveLength(0) // never reached orgX

    // The IDENTICAL `pii` task to the open orgY sails through — isolation.
    const piiToY = await home.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['svc-y'] },
      payload: { ssn: '...' },
      dataClasses: ['pii'],
    })
    expect(piiToY.kind).toBe('ok')
    expect(yAgent.captured).toHaveLength(1)

    // And a `public` task to orgX is fine — the clamp is class-specific, not a
    // blanket block.
    const publicToX = await home.dispatch({
      from: 'alice',
      strategy: { kind: 'capability', capabilities: ['svc-x'] },
      payload: { note: 'hi' },
      dataClasses: ['public'],
    })
    expect(publicToX.kind).toBe('ok')
    expect(xAgent.captured).toHaveLength(1)

    // --- (2) INBOUND per-link quota isolation ---------------------------------
    // orgX may push exactly ONE inbound task; the 2nd fail-closes.
    const x1 = await hubX.dispatch({
      from: 'x-user',
      strategy: { kind: 'capability', capabilities: ['home-task'] },
      payload: { n: 1 },
    })
    expect(x1.kind).toBe('ok')
    const x2 = await hubX.dispatch({
      from: 'x-user',
      strategy: { kind: 'capability', capabilities: ['home-task'] },
      payload: { n: 2 },
    })
    expect(x2.kind).toBe('failed')
    if (x2.kind === 'failed') {
      expect(x2.error).toMatch(/cross_org_policy_denied/)
      expect(x2.error).toMatch(/per_link_quota_exceeded/)
    }

    // orgY has no budget — three inbound tasks all land. The home agent saw
    // orgX's single allowed task + all three of orgY's = 4 total, proving the
    // orgX clamp never touched the orgY edge.
    for (let i = 0; i < 3; i++) {
      const r = await hubY.dispatch({
        from: 'y-user',
        strategy: { kind: 'capability', capabilities: ['home-task'] },
        payload: { n: i },
      })
      expect(r.kind).toBe('ok')
    }
    expect(homeAgent.captured).toHaveLength(4)

    await Promise.all([home.stop(), hubX.stop(), hubY.stop()])
  })
})
