/**
 * WebSocketHubLink generic RPC seam (#2-M3.1).
 *
 * `rpc(method, params)` on one side reaches the peer's `'rpc'` handler
 * over the wire; the handler's return value comes back as the resolved
 * value. Unlike pull (best-effort → empty) and dispatch (soft failure
 * result), rpc has a HARD contract: it REJECTS on a missing handler, a
 * throwing handler, a timeout, or a closed link. This underpins the
 * cross-hub MCP proxy (M3.3) but carries no MCP semantics here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import type { HubLink } from '@aipehub/core'

import { acceptHubLinks, connectHubLink } from '../src/hub-link.js'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface Bench {
  url: string
  nextLink: () => Promise<HubLink>
  stop: () => Promise<void>
}

async function startBench(selfId: string): Promise<Bench> {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const addr = wss.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const url = `ws://127.0.0.1:${port}`

  const pendingLinks: HubLink[] = []
  const waiters: Array<(l: HubLink) => void> = []
  acceptHubLinks({
    server: wss,
    selfId,
    onLink: (link) => {
      const w = waiters.shift()
      if (w) w(link)
      else pendingLinks.push(link)
    },
  })

  return {
    url,
    nextLink: () =>
      new Promise<HubLink>((resolve) => {
        const ready = pendingLinks.shift()
        if (ready) resolve(ready)
        else waiters.push(resolve)
      }),
    stop: async () => {
      for (const link of pendingLinks.splice(0)) {
        await link.close().catch(() => {})
      }
      for (const c of wss.clients) {
        try {
          c.terminate()
        } catch {
          /* swallow */
        }
      }
      await new Promise<void>((r) => wss.close(() => r()))
    },
  }
}

describe('WebSocketHubLink — rpc seam (#2-M3.1)', () => {
  let bench: Bench
  beforeEach(async () => {
    bench = await startBench('hubB')
  })
  afterEach(async () => {
    await bench.stop()
  })

  it('round-trips method + params and returns the handler value', async () => {
    const a = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const b = await bench.nextLink()

    const seen: Array<{ method: string; params: unknown }> = []
    b.on('rpc', async ({ method, params }) => {
      seen.push({ method, params })
      return { echoed: params, by: 'hubB' }
    })

    const out = await a.rpc('mcp.listTools', { server: 'fs' })
    expect(out).toEqual({ echoed: { server: 'fs' }, by: 'hubB' })
    expect(seen).toEqual([{ method: 'mcp.listTools', params: { server: 'fs' } }])

    await a.close()
  })

  it('rejects when the peer registered no rpc handler', async () => {
    const a = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    await bench.nextLink() // no handler wired

    await expect(a.rpc('mcp.listTools', {})).rejects.toThrow(/no rpc handler/)

    await a.close()
  })

  it('rejects with the handler error message when the handler throws', async () => {
    const a = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const b = await bench.nextLink()
    b.on('rpc', async () => {
      throw new Error('server not shared')
    })

    await expect(a.rpc('mcp.callTool', { name: 'x' })).rejects.toThrow(/server not shared/)

    await a.close()
  })

  it('rejects on timeout when the handler never resolves', async () => {
    const a = await connectHubLink({ url: bench.url, selfId: 'hubA', rpcTimeoutMs: 60 })
    const b = await bench.nextLink()
    b.on('rpc', () => new Promise<unknown>(() => {})) // never settles

    await expect(a.rpc('mcp.listTools', {})).rejects.toThrow(/rpc_timeout/)

    await a.close()
  })

  it('rejects after the link closes (no hang)', async () => {
    const a = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    await bench.nextLink()
    await a.close()
    await delay(20)
    await expect(a.rpc('mcp.listTools', {})).rejects.toThrow(/link_/)
  })

  it('rejects an in-flight rpc when the link closes mid-call', async () => {
    const a = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const b = await bench.nextLink()
    let release: (() => void) | undefined
    b.on('rpc', () => new Promise<unknown>((res) => { release = () => res('late') }))

    const pending = a.rpc('mcp.callTool', {})
    await delay(20)
    await a.close()
    await expect(pending).rejects.toThrow(/link_closed/)
    release?.() // unblock the handler so it doesn't dangle
  })

  it('registering an rpc handler twice throws', async () => {
    await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const b = await bench.nextLink()
    b.on('rpc', async () => 'ok')
    expect(() => b.on('rpc', async () => 'ok')).toThrow(/already registered/)
  })
})
