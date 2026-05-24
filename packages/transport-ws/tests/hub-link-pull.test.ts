/**
 * WebSocketHubLink pull protocol (M6).
 *
 * Verifies the same contract as the inproc version: pullFeedbackFor()
 * on one side reaches the peer's 'pull' handler over the wire and the
 * returned entries flow back. Includes round-trips with multiple
 * entries, empty results, and "peer has no handler" → empty.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import type { FeedbackEntry, HubLink } from '@aipehub/core'

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

function fakeEntry(id: string, rating = 5): FeedbackEntry {
  return {
    id,
    toHub: 'hubA',
    toParticipant: 'a-something',
    taskRunId: 'run-' + id,
    scope: 'whole-task',
    rating,
    evaluatorHub: 'hubB',
    evaluatorParticipant: 'b-admin',
    createdAt: 1000 + parseInt(id.replace(/\D/g, ''), 10),
  }
}

describe('WebSocketHubLink — pull protocol', () => {
  let bench: Bench
  beforeEach(async () => {
    bench = await startBench('hubB')
  })
  afterEach(async () => {
    await bench.stop()
  })

  it('selfId is exposed correctly on each side', async () => {
    const a = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const b = await bench.nextLink()
    expect(a.selfId).toBe('hubA')
    expect(b.selfId).toBe('hubB')
    expect(a.peerId).toBe('hubB')
    expect(b.peerId).toBe('hubA')
    await a.close()
  })

  it('pullFeedbackFor returns peer-supplied entries over the wire', async () => {
    const a = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const b = await bench.nextLink()

    const supply = [fakeEntry('e1'), fakeEntry('e2', 3)]
    b.on('pull', async (forPeerId) => {
      expect(forPeerId).toBe('hubA')
      return supply
    })

    const pulled = await a.pullFeedbackFor()
    expect(pulled.length).toBe(2)
    expect(pulled.map((e) => e.id).sort()).toEqual(['e1', 'e2'])
    expect(pulled[0].evaluatorHub).toBe('hubB')

    await a.close()
  })

  it('pull returns empty array when peer has no handler registered', async () => {
    const a = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    await bench.nextLink() // no handler

    const pulled = await a.pullFeedbackFor()
    expect(pulled).toEqual([])

    await a.close()
  })

  it('peer handler throwing degrades to empty result (best-effort)', async () => {
    const a = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const b = await bench.nextLink()
    b.on('pull', async () => {
      throw new Error('handler boom')
    })

    const pulled = await a.pullFeedbackFor()
    expect(pulled).toEqual([])

    await a.close()
  })

  it('pull after close returns empty (no hang)', async () => {
    const a = await connectHubLink({ url: bench.url, selfId: 'hubA' })
    await bench.nextLink()
    await a.close()
    // small delay for close to propagate
    await delay(20)
    const pulled = await a.pullFeedbackFor()
    expect(pulled).toEqual([])
  })

  it('registering pull handler twice throws', async () => {
    await connectHubLink({ url: bench.url, selfId: 'hubA' })
    const b = await bench.nextLink()
    b.on('pull', async () => [])
    expect(() => b.on('pull', async () => [])).toThrow(/already registered/)
  })
})
