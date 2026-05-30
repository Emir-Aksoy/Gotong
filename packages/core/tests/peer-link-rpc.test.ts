/**
 * HubLink generic RPC seam — inproc impl + installPeerLink wiring (#2-M3.1).
 *
 * The inproc link mirrors the ws contract (transport-ws has its own
 * round-trip suite): rpc() reaches the peer's 'rpc' handler and the
 * value flows back; REJECTS on missing handler / throwing handler /
 * closed link. Plus: installPeerLink wires an optional `rpcResponder`
 * as the link's single 'rpc' handler, leaving the seam inert when unset.
 */

import { describe, expect, it } from 'vitest'

import { Hub } from '../src/hub.js'
import { createInprocHubLinkPair } from '../src/hub-link.js'
import { installPeerLink } from '../src/peer-link-install.js'

function pair() {
  return createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
}

describe('InprocHubLink — rpc seam (#2-M3.1)', () => {
  it('round-trips method + params and returns the handler value', async () => {
    const { a, b } = pair()
    const seen: Array<{ method: string; params: unknown }> = []
    b.on('rpc', async ({ method, params }) => {
      seen.push({ method, params })
      return { echoed: params }
    })
    const out = await a.rpc('mcp.callTool', { name: 'read', args: { p: 1 } })
    expect(out).toEqual({ echoed: { name: 'read', args: { p: 1 } } })
    expect(seen).toEqual([{ method: 'mcp.callTool', params: { name: 'read', args: { p: 1 } } }])
  })

  it('rejects when the peer registered no rpc handler', async () => {
    const { a } = pair()
    await expect(a.rpc('m', {})).rejects.toThrow(/no rpc handler/)
  })

  it('rejects with the handler error when the handler throws', async () => {
    const { a, b } = pair()
    b.on('rpc', async () => {
      throw new Error('not shared')
    })
    await expect(a.rpc('m', {})).rejects.toThrow(/not shared/)
  })

  it('rejects after the link is closed', async () => {
    const { a, b } = pair()
    b.on('rpc', async () => 'ok')
    await a.close()
    await expect(a.rpc('m', {})).rejects.toThrow(/link_closed/)
  })

  it('only serializable params cross (parity with the wire)', async () => {
    const { a, b } = pair()
    let received: unknown
    b.on('rpc', async ({ params }) => {
      received = params
      return null
    })
    // A function on the params is dropped by the JSON round-trip, exactly
    // as it would be over ws — keeps inproc tests honest.
    await a.rpc('m', { keep: 1, fn: () => 2 } as unknown)
    expect(received).toEqual({ keep: 1 })
  })

  it('registering an rpc handler twice throws', async () => {
    const { b } = pair()
    b.on('rpc', async () => 'ok')
    expect(() => b.on('rpc', async () => 'ok')).toThrow(/already registered/)
  })
})

describe('installPeerLink — rpcResponder wiring (#2-M3.1)', () => {
  it('wires the responder so the peer can rpc into it', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const { a: linkAtoB, b: linkBtoA } = pair()
    const calls: Array<{ method: string; params: unknown }> = []
    // B exposes a responder; A installs a plain link.
    installPeerLink({
      hub: hubB,
      link: linkBtoA,
      rpcResponder: async ({ method, params }) => {
        calls.push({ method, params })
        return { ok: true, method }
      },
    })
    installPeerLink({ hub: hubA, link: linkAtoB })

    const out = await linkAtoB.rpc('mcp.listTools', { server: 'fs' })
    expect(out).toEqual({ ok: true, method: 'mcp.listTools' })
    expect(calls).toEqual([{ method: 'mcp.listTools', params: { server: 'fs' } }])

    await hubA.stop()
    await hubB.stop()
  })

  it('leaves the seam inert when no responder is supplied', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const { a: linkAtoB, b: linkBtoA } = pair()
    installPeerLink({ hub: hubB, link: linkBtoA }) // no rpcResponder
    installPeerLink({ hub: hubA, link: linkAtoB })

    await expect(linkAtoB.rpc('mcp.listTools', {})).rejects.toThrow(/no rpc handler/)

    await hubA.stop()
    await hubB.stop()
  })
})
