/**
 * REL-3 (audit debt #1) — mesh hub-link keepalive + lastSeenAt.
 *
 * A half-open TCP connection (peer machine power-cut, NAT entry
 * expired) used to linger as a zombie link until the next outbound
 * frame failed. These tests pin the new contract:
 *
 *   - a live pair exchanging only pings/pongs stays open, and
 *     `lastSeenAt` keeps advancing (proof the roundtrip works)
 *   - a peer that completes the handshake but then goes silent gets
 *     closed with reason `keepalive_timeout` after maxMissedPings
 *     silent intervals
 *   - `keepaliveIntervalMs: 0` disables the loop entirely
 *   - the accept side threads its keepalive options through (the
 *     in-side constructor historically only passed selfId+auth)
 *
 * The zombie is simulated with a raw WebSocketServer that answers the
 * MESH_HELLO by hand and then swallows every subsequent frame — from
 * the client's perspective that is exactly a host that stopped
 * breathing without closing the socket.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import type { HubLink } from '@gotong/core'

import { acceptHubLinks, connectHubLink } from '../src/hub-link.js'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn().catch(() => {})
})

async function listen(wss: WebSocketServer): Promise<string> {
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const addr = wss.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return `ws://127.0.0.1:${port}`
}

function trackServer(wss: WebSocketServer): void {
  cleanups.push(async () => {
    for (const client of wss.clients) {
      try {
        client.terminate()
      } catch {
        /* swallow */
      }
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })
}

function trackLink(link: HubLink): void {
  cleanups.push(() => link.close().catch(() => {}))
}

/** A peer that handshakes correctly, then never sends another frame. */
async function startZombieServer(): Promise<{ url: string }> {
  const wss = new WebSocketServer({ port: 0 })
  trackServer(wss)
  const url = await listen(wss)
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let frame: { type?: string }
      try {
        frame = JSON.parse(String(data)) as { type?: string }
      } catch {
        return
      }
      if (frame.type === 'MESH_HELLO') {
        ws.send(
          JSON.stringify({
            type: 'MESH_HELLO_ACK',
            peerId: 'zombie',
            protocolVersion: '1',
          }),
        )
      }
      // Everything after the handshake — including MESH_PING — is
      // swallowed: a half-open connection that still ACKs TCP but
      // whose application stopped breathing.
    })
  })
  return { url }
}

/** A healthy accept-side bench with configurable keepalive. */
async function startBench(opts: {
  keepaliveIntervalMs?: number
  maxMissedPings?: number
}): Promise<{ url: string; nextLink: () => Promise<HubLink> }> {
  const wss = new WebSocketServer({ port: 0 })
  trackServer(wss)
  const url = await listen(wss)
  const pending: HubLink[] = []
  const waiters: Array<(l: HubLink) => void> = []
  acceptHubLinks({
    server: wss,
    selfId: 'hubB',
    ...(opts.keepaliveIntervalMs !== undefined
      ? { keepaliveIntervalMs: opts.keepaliveIntervalMs }
      : {}),
    ...(opts.maxMissedPings !== undefined ? { maxMissedPings: opts.maxMissedPings } : {}),
    onLink: (link) => {
      trackLink(link)
      const w = waiters.shift()
      if (w) w(link)
      else pending.push(link)
    },
  })
  return {
    url,
    nextLink: () =>
      new Promise<HubLink>((resolve) => {
        const ready = pending.shift()
        if (ready) resolve(ready)
        else waiters.push(resolve)
      }),
  }
}

describe('hub-link keepalive (REL-3)', () => {
  it('a live pair stays open and lastSeenAt advances via ping/pong alone', async () => {
    const bench = await startBench({ keepaliveIntervalMs: 40, maxMissedPings: 2 })
    const aLink = await connectHubLink({
      url: bench.url,
      selfId: 'hubA',
      keepaliveIntervalMs: 40,
      maxMissedPings: 2,
    })
    trackLink(aLink)
    const bLink = await bench.nextLink()

    const aSeen0 = aLink.lastSeenAt
    const bSeen0 = bLink.lastSeenAt
    expect(aSeen0).toBeTypeOf('number') // stamped by the HELLO_ACK
    expect(bSeen0).toBeTypeOf('number') // stamped by the HELLO

    // Several keepalive intervals with zero application traffic. If the
    // ping→pong roundtrip were broken, maxMissedPings=2 would close the
    // link within ~120ms.
    await delay(300)

    expect(aLink.status).toBe('open')
    expect(bLink.status).toBe('open')
    // Pongs (and the peer's own pings) advanced the liveness stamp.
    expect(aLink.lastSeenAt!).toBeGreaterThan(aSeen0!)
    expect(bLink.lastSeenAt!).toBeGreaterThan(bSeen0!)
  })

  it('a silent half-open peer is closed with keepalive_timeout', async () => {
    const zombie = await startZombieServer()
    const link = await connectHubLink({
      url: zombie.url,
      selfId: 'hubA',
      keepaliveIntervalMs: 40,
      maxMissedPings: 2,
    })
    trackLink(link)
    expect(link.status).toBe('open')

    let closed = false
    link.on('closed', () => {
      closed = true
    })

    // tick1 → missed=1, tick2 → missed=2, tick3 → close. Give it ample
    // slack so a slow CI runner doesn't flake.
    await delay(400)

    expect(link.status).toBe('closed')
    expect(closed).toBe(true)

    // A dispatch on the dead link fails fast instead of hanging — the
    // operational payoff of detecting the zombie.
    const result = await link.dispatch({
      id: 't-zombie',
      from: 'tester',
      strategy: { kind: 'capability', capabilities: ['x'] },
      payload: {},
      createdAt: Date.now(),
    })
    expect(result.kind).toBe('failed')
    expect((result as { error?: string }).error).toContain('link_closed')
  })

  it('keepaliveIntervalMs: 0 disables the loop (link survives a silent peer)', async () => {
    const zombie = await startZombieServer()
    const link = await connectHubLink({
      url: zombie.url,
      selfId: 'hubA',
      keepaliveIntervalMs: 0,
    })
    trackLink(link)

    // Longer than the timeout window of the previous test — with the
    // loop disabled, silence is never treated as death.
    await delay(400)
    expect(link.status).toBe('open')
  })

  it('the accept side pings on its own (out side passive, options threaded through)', async () => {
    const bench = await startBench({ keepaliveIntervalMs: 40, maxMissedPings: 2 })
    // Out side has keepalive disabled — every frame after the handshake
    // originates from the accept side's loop, so an advancing
    // lastSeenAt over here proves the in-side constructor received the
    // keepalive options.
    const aLink = await connectHubLink({
      url: bench.url,
      selfId: 'hubA',
      keepaliveIntervalMs: 0,
    })
    trackLink(aLink)
    const bLink = await bench.nextLink()

    const aSeen0 = aLink.lastSeenAt
    await delay(300)

    expect(aLink.status).toBe('open')
    expect(bLink.status).toBe('open')
    expect(aLink.lastSeenAt!).toBeGreaterThan(aSeen0!) // in-side pings landed
  })
})
