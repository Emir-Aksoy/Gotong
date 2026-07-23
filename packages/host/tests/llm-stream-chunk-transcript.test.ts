/**
 * Phase 8 M6 + perf audit A③ — LocalAgentPool wires LlmAgent.onStreamChunk
 * into the Hub transcript's EPHEMERAL channel: streaming output is observable
 * live (hub.onEvent → the web SSE forwarder, the stdout line renderer, chunk
 * sinks) but is never recorded — no in-memory transcript entry, no
 * transcript.jsonl line. The final task_result carries the full text, so
 * persisted chunks were pure redundancy growing RAM + disk without bound.
 *
 * Strategy: we don't go through LocalAgentPool.spawn (which insists on
 * a real provider name + manifest entry — too much fixture surface
 * for a pure-wiring test). Instead we mirror the exact onStreamChunk
 * closure the pool installs, plug it into a hand-built LlmAgent +
 * MockLlmProvider, dispatch a task, and assert both sides of the A③
 * contract:
 *   - hub.onEvent (the SSE upstream) sees every chunk, in wire order
 *   - the recorded transcript holds ZERO llm_stream_chunk entries
 *   - nothing under the space directory contains a chunk payload
 *
 * The pool's actual closure lives inline in local-agent-pool.ts; if it
 * drifts from this mirror the workspace build will catch the
 * structural mismatch (TranscriptEntry discriminator).
 */

import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space, type Task, type TranscriptEntry } from '@gotong/core'
import {
  LlmAgent,
  MockLlmProvider,
  type LlmStreamChunk,
} from '@gotong/llm'

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
 * Mirror of `LocalAgentPool.spawn`'s onStreamChunk closure (the ephemeral
 * emit). Anything we change here must change in `host/src/local-agent-pool.ts`
 * too.
 */
function buildStreamChunkHook(hub: Hub, agentId: string) {
  return (chunk: unknown, task: Task): void => {
    hub.transcript.emitEphemeral({
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

describe('Phase 8 M6 + A③ — LlmAgent stream chunks are live-only', () => {
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

  it('no chunk payload ever reaches disk under the space directory', async () => {
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
    expect(recordedChunkKinds(b.hub)).toEqual([])
  })
})
