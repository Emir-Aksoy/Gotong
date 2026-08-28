/**
 * Phase 8 M6 + perf audit A③ — LocalAgentPool wires LlmAgent.onStreamChunk
 * into `Transcript.emitChunk`, the ONE router deciding which chunks earn a
 * place on disk. Both halves of that split are pinned here:
 *
 *   - `text` / `usage` / `end` / `error` stay EPHEMERAL: observable live
 *     (hub.onEvent → the web SSE forwarder, the stdout line renderer, chunk
 *     sinks) but never recorded. The final task_result carries the full
 *     text, so persisting every token was pure redundancy growing RAM +
 *     disk without bound — that is what A③ removed, and it stays removed.
 *   - `tool_use` is PERSISTED. A③ dropped it along with the text, but its
 *     argument never covered it: a task_result carries `toolRounds`, a
 *     NUMBER. Which tool ran, with what arguments, whether it ran at all —
 *     none of it survived anywhere, so "what did this agent actually do"
 *     became a question the disk could not answer. It costs 0.3% of chunk
 *     rows to answer it.
 *
 * Strategy — two halves, and the second one is why the first is allowed
 * to be cheap:
 *
 *   1. The MATRIX (first describe) mirrors the pool's onStreamChunk closure
 *      onto a hand-built LlmAgent, so each chunk kind can be driven exactly
 *      without a spawn fixture. It pins the ROUTER's behaviour.
 *   2. The WIRING (second describe) drives the real `LocalAgentPool`, so
 *      something pins that the production emitter actually reaches the
 *      router at all.
 *
 * Half 2 exists because half 1 alone was a green light over an open hole:
 * a mutation swapping the pool's `emitChunk` back to `emitEphemeral` — i.e.
 * production stops persisting tool_use entirely — left every test in this
 * file passing, because every one of them hand-built the other side of the
 * seam. 一条缝,如果它的测试全都自己手搭对面那一半,那它就是没测过。
 */

import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space, type AgentRecord, type Task, type TranscriptEntry } from '@gotong/core'
import {
  LlmAgent,
  MockLlmProvider,
  type LlmStreamChunk,
} from '@gotong/llm'

import { LocalAgentPool } from '../src/local-agent-pool.js'

interface Bench {
  root: string
  space: Space
  hub: Hub
}

async function boot(): Promise<Bench> {
  const root = await mkdtemp(join(tmpdir(), 'gotong-stream-transcript-'))
  const { space } = await Space.init(root, { name: 'stream-transcript-test' })
  const hub = new Hub({ space })
  await hub.start()
  return { root, space, hub }
}

function makeTask(payload: unknown, capabilities = ['draft']): Omit<Task, 'id' | 'createdAt'> {
  return {
    from: 'system' as const,
    strategy: { kind: 'capability' as const, capabilities },
    payload,
  }
}

/**
 * Mirror of `LocalAgentPool.spawn`'s onStreamChunk closure (the routed
 * emit). Anything we change here must change in `host/src/local-agent-pool.ts`
 * too.
 */
function buildStreamChunkHook(hub: Hub, agentId: string) {
  return (chunk: unknown, task: Task): void => {
    hub.transcript.emitChunk({
      ts: Date.now(),
      kind: 'llm_stream_chunk',
      data: { taskId: task.id, agentId, chunk },
    })
  }
}

/** Kinds of every llm_stream_chunk currently RECORDED in the transcript. */
function recordedChunkKinds(hub: Hub): string[] {
  return hub.transcript
    .all()
    .filter((e): e is Extract<TranscriptEntry, { kind: 'llm_stream_chunk' }> =>
      e.kind === 'llm_stream_chunk',
    )
    .map((e) => (e.data.chunk as { type?: string } | null)?.type ?? '?')
}

/** Collect live chunk events from hub.onEvent for the duration of `run`. */
async function captureLive(
  hub: Hub,
  run: () => Promise<void>,
): Promise<Array<Extract<TranscriptEntry, { kind: 'llm_stream_chunk' }>>> {
  const seen: Array<Extract<TranscriptEntry, { kind: 'llm_stream_chunk' }>> = []
  const unsub = hub.onEvent((e) => {
    if (e.kind === 'llm_stream_chunk') seen.push(e)
  })
  try {
    await run()
  } finally {
    unsub()
  }
  return seen
}

/** True when any file under `dir` (recursive) contains `needle`. */
async function dirContains(dir: string, needle: string): Promise<boolean> {
  const names = await readdir(dir, { withFileTypes: true, recursive: true })
  for (const d of names) {
    if (!d.isFile()) continue
    const p = join(d.parentPath ?? (d as { path?: string }).path ?? dir, d.name)
    try {
      const body = await readFile(p, 'utf8')
      if (body.includes(needle)) return true
    } catch {
      /* binary / vanished file — not a transcript line */
    }
  }
  return false
}

/**
 * Every `llm_stream_chunk` entry that actually reached a file under `dir`.
 * Scans recursively rather than reaching for a storage-internal path — the
 * question is "did it survive to disk", not "which segment file holds it".
 */
async function diskChunkEntries(
  dir: string,
): Promise<Array<Extract<TranscriptEntry, { kind: 'llm_stream_chunk' }>>> {
  const out: Array<Extract<TranscriptEntry, { kind: 'llm_stream_chunk' }>> = []
  const names = await readdir(dir, { withFileTypes: true, recursive: true })
  for (const d of names) {
    if (!d.isFile()) continue
    const p = join(d.parentPath ?? (d as { path?: string }).path ?? dir, d.name)
    let body: string
    try {
      body = await readFile(p, 'utf8')
    } catch {
      continue /* binary / vanished file */
    }
    for (const line of body.split('\n')) {
      if (!line.includes('llm_stream_chunk')) continue
      try {
        const e = JSON.parse(line) as TranscriptEntry
        if (e.kind === 'llm_stream_chunk') out.push(e)
      } catch {
        /* not a transcript line */
      }
    }
  }
  return out
}

describe('Phase 8 M6 + A③ — stream chunks: prose live-only, actions durable', () => {
  let b: Bench
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await b.hub.stop()
    await rm(b.root, { recursive: true, force: true })
  })

  it('hub.onEvent sees every chunk in wire order; the recorded log holds none', async () => {
    const provider = new MockLlmProvider({
      reply: 'hello world',
      textChunkCount: 3, // -> 3 text chunks
    })
    b.hub.register(
      new LlmAgent({
        id: 'streamer',
        capabilities: ['draft'],
        provider,
        onStreamChunk: buildStreamChunkHook(b.hub, 'streamer'),
      }),
    )

    const live = await captureLive(b.hub, async () => {
      const out = await b.hub.dispatch(makeTask('go'))
      expect(out.kind).toBe('ok')
    })

    // Live side: 3 text + 1 usage + 1 end, all attributed, in wire order.
    expect(live.length).toBe(5)
    const taskId = live[0]!.data.taskId
    for (const e of live) {
      expect(e.data.agentId).toBe('streamer')
      expect(e.data.taskId).toBe(taskId)
    }
    expect(live.map((e) => (e.data.chunk as { type?: string }).type ?? '?')).toEqual([
      'text',
      'text',
      'text',
      'usage',
      'end',
    ])
    // Live entries carry strictly increasing seqs (shared counter).
    for (let i = 1; i < live.length; i++) {
      expect(live[i]!.seq).toBeGreaterThan(live[i - 1]!.seq)
    }

    // Recorded side: nothing — chunks are ephemeral.
    expect(recordedChunkKinds(b.hub)).toEqual([])
    // The task itself still recorded (dispatch + result persist as before).
    expect(b.hub.tasks().length).toBe(1)
    expect(b.hub.tasks()[0]!.status).toBe('done')
  })

  it('no TEXT chunk payload ever reaches disk under the space directory', async () => {
    const provider = new MockLlmProvider({
      reply: 'MARKER-the-quick-brown-fox',
      textChunkCount: 5,
    })
    b.hub.register(
      new LlmAgent({
        id: 'rebuilder',
        capabilities: ['draft'],
        provider,
        onStreamChunk: buildStreamChunkHook(b.hub, 'rebuilder'),
      }),
    )
    const live = await captureLive(b.hub, async () => {
      await b.hub.dispatch(makeTask('go'))
    })
    // Live text concat reproduces the final response (the llm contract) —
    // the typing preview loses nothing by the log losing the chunks.
    const text = live
      .map((e) => e.data.chunk as { type: string; text?: string })
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
    expect(text).toBe('MARKER-the-quick-brown-fox')

    // Give the background storage writes a beat, then sweep the space dir:
    // the final result line may carry the reply, but no llm_stream_chunk
    // line may exist anywhere.
    await new Promise((r) => setTimeout(r, 50))
    expect(await dirContains(b.root, 'llm_stream_chunk')).toBe(false)
  })

  it('a tool_use chunk DOES reach disk, carrying the tool name and input', async () => {
    // The load-bearing assertion of the whole split: after the process is
    // gone, the disk can still answer "which tool did this agent run". The
    // live channel proves nothing here — a chunk sink is in-memory and dies
    // with the process, which is exactly how the gap went unnoticed.
    const provider = new MockLlmProvider({
      reply: 'unused',
      script: [
        {
          kind: 'tool_use',
          toolUses: [
            { type: 'tool_use', id: 't1', name: 'tavily_search', input: { query: 'MARKER-q' } },
          ],
        },
        { kind: 'text', text: 'MARKER-final-prose' },
      ],
    })
    b.hub.register(
      new LlmAgent({
        id: 'searcher',
        capabilities: ['draft'],
        provider,
        tools: {
          listTools: () => [{ name: 'tavily_search', inputSchema: { type: 'object' } }],
          callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        },
        onStreamChunk: buildStreamChunkHook(b.hub, 'searcher'),
      }),
    )
    await b.hub.dispatch(makeTask('go'))
    await new Promise((r) => setTimeout(r, 50))

    const onDisk = await diskChunkEntries(b.root)
    expect(onDisk.length).toBe(1)
    const chunk = onDisk[0]!.data.chunk as {
      type: string
      toolUse?: { name?: string; input?: { query?: string } }
    }
    expect(onDisk[0]!.data.agentId).toBe('searcher')
    expect(chunk.type).toBe('tool_use')
    expect(chunk.toolUse?.name).toBe('tavily_search')
    expect(chunk.toolUse?.input?.query).toBe('MARKER-q')
    // ...and the prose of the same run stayed off disk as a chunk. (The
    // task_result line carries it — that is A③'s point, still standing.)
    expect(JSON.stringify(onDisk)).not.toContain('MARKER-final-prose')
  })

  it('error chunks (mid-stream soft-fail) flow through the live channel unchanged', async () => {
    const rawChunks: LlmStreamChunk[] = [
      { type: 'text', text: 'partial' },
      { type: 'error', code: 'sim_fail', message: 'whoops' },
    ]
    const provider = new MockLlmProvider({ reply: '', chunks: rawChunks })
    b.hub.register(
      new LlmAgent({
        id: 'sad',
        capabilities: ['draft'],
        provider,
        onStreamChunk: buildStreamChunkHook(b.hub, 'sad'),
      }),
    )
    const live = await captureLive(b.hub, async () => {
      await b.hub.dispatch(makeTask('go'))
    })
    expect(live.map((e) => e.data.chunk)).toEqual(rawChunks)
    expect(recordedChunkKinds(b.hub)).toEqual([])
  })

  it('multi-round tool-use loop emits live chunks from EVERY round', async () => {
    const provider = new MockLlmProvider({
      reply: 'unused',
      script: [
        {
          kind: 'tool_use',
          toolUses: [
            { type: 'tool_use', id: 't1', name: 'noop', input: {} },
          ],
        },
        { kind: 'text', text: 'final answer' },
      ],
    })
    const toolset = {
      listTools: () => [{ name: 'noop', inputSchema: { type: 'object' } }],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    }
    b.hub.register(
      new LlmAgent({
        id: 'looper',
        capabilities: ['draft'],
        provider,
        tools: toolset,
        onStreamChunk: buildStreamChunkHook(b.hub, 'looper'),
      }),
    )
    const live = await captureLive(b.hub, async () => {
      await b.hub.dispatch(makeTask('go'))
    })
    // Round 1 (tool_use): tool_use → usage → end
    // Round 2 (text final): text → usage → end
    expect(live.map((e) => (e.data.chunk as { type?: string }).type ?? '?')).toEqual([
      'tool_use',
      'usage',
      'end',
      'text',
      'usage',
      'end',
    ])
    // Recorded: the action, and only the action. The two rounds of prose,
    // usage and end frames stay ephemeral.
    expect(recordedChunkKinds(b.hub)).toEqual(['tool_use'])
  })
})

/**
 * 第二半：驱动真的 `LocalAgentPool`。
 *
 * 上面那一组把每一种片段都钓得很細,但它们共享一个前提：
 * `buildStreamChunkHook` 真的就是生产那只闭包。那个前提没有任何东西
 * 守着——把 `local-agent-pool.ts` 里的 `emitChunk` 换回 `emitEphemeral`
 * (也就是生产上彻底不再落盘 tool_use),本文件全绿。
 *
 * 所以这里只需要一例,而且它只回答一个问题：**那条线接上了吗**。
 * 判据选 tool_use 而不是 text,因为“没落盘”有两种廉价的假通过
 * (压根没跑起来 / 压根没发片段),而“落盘了”只有一种路径。
 */
describe('the pool itself goes through the router (not just our mirror of it)', () => {
  let b: Bench
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await b.hub.stop()
    await rm(b.root, { recursive: true, force: true })
  })

  it('a pool-spawned agent persists its tool_use chunk to disk', async () => {
    await b.space.upsertAgent({
      id: 'pool-searcher',
      allowedCapabilities: ['draft'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'mock', system: 'wired by the pool' },
    } satisfies AgentRecord)

    const pool = new LocalAgentPool({
      hub: b.hub,
      space: b.space,
      // The providerFactory seam — the pool builds every provider through
      // it (mock included), so the agent it spawns is a REAL pool-spawned
      // agent driven by a scripted stream.
      providerFactory: () =>
        new MockLlmProvider({
          reply: 'unused',
          script: [
            {
              kind: 'tool_use',
              toolUses: [
                {
                  type: 'tool_use',
                  id: 't1',
                  name: 'tavily_search',
                  input: { query: 'POOL-MARKER-q' },
                },
              ],
            },
            { kind: 'text', text: 'POOL-MARKER-prose' },
          ],
        }),
    })

    try {
      await pool.start()
      const res = await b.hub.dispatch(makeTask('go'))
      expect(res.kind).toBe('ok')
      await new Promise((r) => setTimeout(r, 50))

      const onDisk = await diskChunkEntries(b.root)
      expect(onDisk.length).toBe(1)
      const chunk = onDisk[0]!.data.chunk as {
        type: string
        toolUse?: { name?: string; input?: { query?: string } }
      }
      expect(onDisk[0]!.data.agentId).toBe('pool-searcher')
      expect(chunk.type).toBe('tool_use')
      expect(chunk.toolUse?.name).toBe('tavily_search')
      expect(chunk.toolUse?.input?.query).toBe('POOL-MARKER-q')
      // 同一跑里的散文仍然没落盘——路由器两边都在干活,不是一刀切开。
      expect(JSON.stringify(onDisk)).not.toContain('POOL-MARKER-prose')
    } finally {
      await pool.stopAll()
    }
  })
})
