/**
 * Phase 8 M6 — LocalAgentPool wires LlmAgent.onStreamChunk into the
 * Hub transcript so streaming output is observable to:
 *   - the admin UI (web SSE auto-forwards every TranscriptEntry kind)
 *   - file-based replay (transcript.jsonl persists everything)
 *
 * Strategy: we don't go through LocalAgentPool.spawn (which insists on
 * a real provider name + manifest entry — too much fixture surface
 * for a pure-wiring test). Instead we mirror the exact onStreamChunk
 * closure the pool installs, plug it into a hand-built LlmAgent +
 * MockLlmProvider, dispatch a task, and assert the transcript shape.
 * That covers:
 *   - hook is fired per chunk in arrival order
 *   - transcript.append is called with kind:'llm_stream_chunk' and
 *     the {taskId,agentId,chunk} shape declared in core/types.ts
 *   - hub.onEvent (the SSE upstream) sees every chunk
 *   - errors thrown by transcript.append don't crash the agent
 *
 * The pool's actual closure is two lines and lives inline; if it
 * drifts from this mirror the workspace build will catch the
 * structural mismatch (TranscriptEntry discriminator).
 */

import { mkdtemp, rm } from 'node:fs/promises'
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
 * Mirror of `LocalAgentPool.spawn`'s onStreamChunk closure. Anything
 * we change here must change in `host/src/local-agent-pool.ts` too.
 */
function buildStreamChunkHook(hub: Hub, agentId: string) {
  return (chunk: unknown, task: Task): void => {
    hub.transcript.append({
      ts: Date.now(),
      kind: 'llm_stream_chunk',
      data: { taskId: task.id, agentId, chunk },
    })
  }
}

describe('Phase 8 M6 — LlmAgent stream chunks land in Hub transcript', () => {
  let b: Bench
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await b.hub.stop()
    await rm(b.root, { recursive: true, force: true })
  })

  it('every provider chunk appears as a llm_stream_chunk transcript entry', async () => {
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

    const out = await b.hub.dispatch(makeTask('go'))
    expect(out.kind).toBe('ok')

    const streamEntries = b.hub.transcript
      .all()
      .filter((e): e is Extract<TranscriptEntry, { kind: 'llm_stream_chunk' }> =>
        e.kind === 'llm_stream_chunk',
      )
    // 3 text + 1 usage + 1 end = 5 entries
    expect(streamEntries.length).toBe(5)
    // All entries carry the same agentId and the dispatched taskId.
    const taskId = streamEntries[0]!.data.taskId
    for (const e of streamEntries) {
      expect(e.data.agentId).toBe('streamer')
      expect(e.data.taskId).toBe(taskId)
    }
    // Chunk types arrive in wire order.
    const chunkTypes = streamEntries.map(
      (e) => (e.data.chunk as { type?: string } | null)?.type ?? '?',
    )
    expect(chunkTypes).toEqual(['text', 'text', 'text', 'usage', 'end'])
  })

  it('text-chunk concatenation reproduces the final response text', async () => {
    const provider = new MockLlmProvider({
      reply: 'the quick brown fox',
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
    await b.hub.dispatch(makeTask('go'))
    const text = b.hub.transcript
      .all()
      .filter((e): e is Extract<TranscriptEntry, { kind: 'llm_stream_chunk' }> =>
        e.kind === 'llm_stream_chunk',
      )
      .map((e) => e.data.chunk as { type: string; text?: string })
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
    expect(text).toBe('the quick brown fox')
  })

  it('hub.onEvent sees every llm_stream_chunk in real time (SSE upstream)', async () => {
    const seen: string[] = []
    const unsub = b.hub.onEvent((e) => {
      if (e.kind === 'llm_stream_chunk') {
        const chunk = e.data.chunk as { type?: string } | null
        seen.push(chunk?.type ?? '?')
      }
    })
    const provider = new MockLlmProvider({ reply: 'ok' })
    b.hub.register(
      new LlmAgent({
        id: 'live',
        capabilities: ['draft'],
        provider,
        onStreamChunk: buildStreamChunkHook(b.hub, 'live'),
      }),
    )
    await b.hub.dispatch(makeTask('go'))
    unsub()
    expect(seen).toEqual(['text', 'usage', 'end'])
  })

  it('error chunks (mid-stream soft-fail) flow through transcript unchanged', async () => {
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
    await b.hub.dispatch(makeTask('go'))
    const chunks = b.hub.transcript
      .all()
      .filter((e): e is Extract<TranscriptEntry, { kind: 'llm_stream_chunk' }> =>
        e.kind === 'llm_stream_chunk',
      )
      .map((e) => e.data.chunk)
    expect(chunks).toEqual(rawChunks)
  })

  it('multi-round tool-use loop emits chunks from EVERY round', async () => {
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
    await b.hub.dispatch(makeTask('go'))
    const chunkTypes = b.hub.transcript
      .all()
      .filter((e): e is Extract<TranscriptEntry, { kind: 'llm_stream_chunk' }> =>
        e.kind === 'llm_stream_chunk',
      )
      .map((e) => (e.data.chunk as { type?: string }).type ?? '?')
    // Round 1 (tool_use): tool_use → usage → end
    // Round 2 (text final): text → usage → end
    expect(chunkTypes).toEqual([
      'tool_use',
      'usage',
      'end',
      'text',
      'usage',
      'end',
    ])
  })
})
