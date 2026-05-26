/**
 * Audit #143 — HELLO / HELLO_ACK state-machine guard.
 *
 * Before the fix, the IN side's HELLO handler had no `_status` check.
 * An attacker (or buggy peer) could complete a legitimate handshake
 * (status='open'), then send a SECOND HELLO claiming a different
 * peerId; the handler would re-run verifyPeerToken and overwrite
 * `_peerId` on the live link. Downstream consumers (link.peerId getter,
 * Hub routing) would see the new identity even though `installPeerLink`
 * had registered the original.
 *
 * The fix: both HELLO and HELLO_ACK bail when `_status !== 'connecting'`.
 *
 * We can't easily drive HELLO_ACK from this test (would require a fake
 * server replying to a real connectHubLink), so this file focuses on
 * the IN side: bench up acceptHubLinks, drive a raw ws to send the
 * legitimate HELLO + a malicious second HELLO, then assert link.peerId
 * stayed pinned to the original.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

import {
  acceptHubLinks,
  MESH_PROTOCOL_VERSION,
  type HubLink,
} from '../src/index.js'

interface Bench {
  wss: WebSocketServer
  url: string
  nextLink: () => Promise<HubLink>
  stop: () => Promise<void>
}

async function startBench(selfId: string, peerToken: string): Promise<Bench> {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const addr = wss.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const url = `ws://127.0.0.1:${port}`

  const pending: HubLink[] = []
  const waiters: Array<(l: HubLink) => void> = []
  acceptHubLinks({
    server: wss,
    selfId,
    peerToken,
    onLink: (link) => {
      const w = waiters.shift()
      if (w) w(link)
      else pending.push(link)
    },
  })
  return {
    wss,
    url,
    nextLink: () =>
      new Promise((resolve) => {
        const r = pending.shift()
        if (r) resolve(r)
        else waiters.push(resolve)
      }),
    stop: async () => {
      for (const link of pending.splice(0)) await link.close().catch(() => {})
      for (const c of wss.clients) {
        try { c.terminate() } catch { /* swallow */ }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

describe('HubLink HELLO replay guard (Audit #143)', () => {
  let bench: Bench
  afterEach(async () => { if (bench) await bench.stop() })

  it('second HELLO on an open link is ignored — peerId stays pinned', async () => {
    bench = await startBench('hubB', 'shared-token-xyz')

    // Open a raw ws and drive the protocol manually so we can send a
    // second HELLO after the first handshake completed.
    const client = new WebSocket(bench.url)
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve())
      client.once('error', reject)
    })

    // Collect inbound frames (we expect exactly one HELLO_ACK).
    const inbound: string[] = []
    client.on('message', (data) => {
      inbound.push(typeof data === 'string' ? data : data.toString('utf8'))
    })

    // 1) Legitimate HELLO — server should ACK + open the link.
    client.send(JSON.stringify({
      type: 'MESH_HELLO',
      peerId: 'attackerVictim',
      protocolVersion: MESH_PROTOCOL_VERSION,
      peerToken: 'shared-token-xyz',
    }))

    const link = await bench.nextLink()
    expect(link.peerId).toBe('attackerVictim')

    // Wait one tick so the ACK is fully drained.
    await new Promise((r) => setTimeout(r, 20))
    const ackCountBefore = inbound.filter((m) => m.includes('MESH_HELLO_ACK')).length
    expect(ackCountBefore).toBe(1)

    // 2) Attack — send a second HELLO claiming a different peerId,
    //    even with a valid token. Before the fix this would have
    //    overwritten `_peerId` and re-emitted HELLO_ACK.
    client.send(JSON.stringify({
      type: 'MESH_HELLO',
      peerId: 'attackerHijackedId',
      protocolVersion: MESH_PROTOCOL_VERSION,
      peerToken: 'shared-token-xyz',
    }))
    await new Promise((r) => setTimeout(r, 30))

    // Assert nothing changed: peerId pinned, no second ACK, link
    // still considered open by the server (no extra teardown).
    expect(link.peerId).toBe('attackerVictim')
    const ackCountAfter = inbound.filter((m) => m.includes('MESH_HELLO_ACK')).length
    expect(ackCountAfter).toBe(1)

    client.close()
  })

  it('second HELLO with a wrong-token attacker is also silently dropped', async () => {
    // Belt-and-braces: even if the token check WOULD have rejected
    // the second HELLO via rejectHandshake() (which would have torn
    // down an already-open link!), the state guard kicks in first
    // and we never reach the token verifier.
    bench = await startBench('hubB', 'real-token-abc')

    const client = new WebSocket(bench.url)
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve())
      client.once('error', reject)
    })

    client.send(JSON.stringify({
      type: 'MESH_HELLO',
      peerId: 'realPeer',
      protocolVersion: MESH_PROTOCOL_VERSION,
      peerToken: 'real-token-abc',
    }))
    const link = await bench.nextLink()
    await new Promise((r) => setTimeout(r, 20))

    // Track whether the link closes — it should NOT, because the
    // second HELLO is ignored before token verification runs.
    let closed = false
    link.on('closed', () => { closed = true })

    client.send(JSON.stringify({
      type: 'MESH_HELLO',
      peerId: 'attackerWithBadToken',
      protocolVersion: MESH_PROTOCOL_VERSION,
      peerToken: 'WRONG-TOKEN-xyz',
    }))
    await new Promise((r) => setTimeout(r, 30))

    expect(closed).toBe(false)
    expect(link.peerId).toBe('realPeer')

    client.close()
  })
})
