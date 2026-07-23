/**
 * NA-M6b — LocalAgentPool per-call chunk sinks (`registerChatChunkSink`).
 *
 * The steward's WFEDIT-D4 discipline at pool scope: a caller registers a
 * sink under a private random key, rides the key in
 * `payload.__streamSinkKey`, and the spawn-time stream hook routes THAT
 * dispatch's text chunks to exactly that sink. Chunks fan out to live
 * transcript observers but are never RECORDED (perf audit A③ — the final
 * result carries the full text); a dispatch with no key feeds no sink,
 * and a throwing sink never breaks the agent's reply.
 *
 * Real `LocalAgentPool.spawn` + mock provider (the same boot shape as
 * local-agent-pool-dispatch.test.ts) — this is a wiring test of the real
 * closure, not a mirror.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space, type TranscriptEntry } from '@gotong/core'

import { LocalAgentPool } from '../src/local-agent-pool.js'

describe('NA-M6b — LocalAgentPool chat chunk sinks', () => {
  let root: string
  let space: Space
  let hub: Hub
  let pool: LocalAgentPool

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-lap-chunk-sink-'))
    const opened = await Space.init(root, { name: 'chunk-sink-test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()
    await space.upsertAgent({
      id: 'chatter',
      allowedCapabilities: ['chat'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'mock', system: 'you chat' },
    })
    pool = new LocalAgentPool({ hub, space })
    await pool.start()
  })

  afterEach(async () => {
    await pool.stop()
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  function recordedStreamEntries(): string[] {
    return hub.transcript
      .all()
      .filter((e): e is Extract<TranscriptEntry, { kind: 'llm_stream_chunk' }> =>
        e.kind === 'llm_stream_chunk',
      )
      .map((e) => (e.data.chunk as { type?: string }).type ?? '?')
  }

  it('routes text chunks of a keyed dispatch to the registered sink (concat = reply)', async () => {
    const got: string[] = []
    const liveKinds: string[] = []
    const unsub = hub.onEvent((e) => {
      if (e.kind === 'llm_stream_chunk') {
        liveKinds.push((e.data.chunk as { type?: string }).type ?? '?')
      }
    })
    const key = pool.registerChatChunkSink((text) => got.push(text))

    const result = await hub.dispatch({
      from: 'member-1',
      strategy: { kind: 'explicit', to: 'chatter' },
      payload: { prompt: 'hello', __streamSinkKey: key },
    })
    pool.releaseChatChunkSink(key)
    unsub()

    expect(result.kind).toBe('ok')
    const reply = (result as { output: { text: string } }).output.text
    expect(got.length).toBeGreaterThan(0)
    expect(got.join('')).toBe(reply)
    // A③ — the live observer tap (SSE upstream) still sees every chunk,
    // but nothing is recorded in the transcript log.
    expect(liveKinds).toContain('text')
    expect(recordedStreamEntries()).toEqual([])
  })

  it('feeds nothing on a dispatch without a key, and nothing after release', async () => {
    const got: string[] = []
    const key = pool.registerChatChunkSink((text) => got.push(text))

    // No key in the payload → sink untouched.
    const r1 = await hub.dispatch({
      from: 'member-1',
      strategy: { kind: 'explicit', to: 'chatter' },
      payload: { prompt: 'no key here' },
    })
    expect(r1.kind).toBe('ok')
    expect(got).toEqual([])

    // Released key riding in a payload → unknown key, no-op, still ok.
    pool.releaseChatChunkSink(key)
    const r2 = await hub.dispatch({
      from: 'member-1',
      strategy: { kind: 'explicit', to: 'chatter' },
      payload: { prompt: 'after release', __streamSinkKey: key },
    })
    expect(r2.kind).toBe('ok')
    expect(got).toEqual([])
  })

  it('a throwing sink never breaks the reply', async () => {
    const key = pool.registerChatChunkSink(() => {
      throw new Error('sink boom')
    })
    const result = await hub.dispatch({
      from: 'member-1',
      strategy: { kind: 'explicit', to: 'chatter' },
      payload: { prompt: 'resilient?', __streamSinkKey: key },
    })
    pool.releaseChatChunkSink(key)
    expect(result.kind).toBe('ok')
    expect((result as { output: { text: string } }).output.text).toContain('mock reply')
  })

  it('two concurrent keys route to their own sinks only', async () => {
    const a: string[] = []
    const b: string[] = []
    const keyA = pool.registerChatChunkSink((t) => a.push(t))
    const keyB = pool.registerChatChunkSink((t) => b.push(t))

    const [ra, rb] = await Promise.all([
      hub.dispatch({
        from: 'member-a',
        strategy: { kind: 'explicit', to: 'chatter' },
        payload: { prompt: 'AAA', __streamSinkKey: keyA },
      }),
      hub.dispatch({
        from: 'member-b',
        strategy: { kind: 'explicit', to: 'chatter' },
        payload: { prompt: 'BBB', __streamSinkKey: keyB },
      }),
    ])
    pool.releaseChatChunkSink(keyA)
    pool.releaseChatChunkSink(keyB)

    expect(ra.kind).toBe('ok')
    expect(rb.kind).toBe('ok')
    expect(a.join('')).toBe((ra as { output: { text: string } }).output.text)
    expect(b.join('')).toBe((rb as { output: { text: string } }).output.text)
    expect(a.join('')).toContain('AAA')
    expect(b.join('')).toContain('BBB')
    expect(a.join('')).not.toContain('BBB')
    expect(b.join('')).not.toContain('AAA')
  })
})
