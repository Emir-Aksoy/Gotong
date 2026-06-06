/**
 * Peer transcript — provider + per-link gate + consumer (v5 Stream G day-5 M4).
 *
 * `buildTaskTranscriptSlice` filters this hub's transcript to the ONE task the
 * caller asks about (by id), keeping only the five task-scoped kinds and
 * excluding everything else — most importantly the hub's OWN internal
 * sub-dispatches, which carry different ids. `PeerTranscriptHost.respond`
 * answers the single wire method; `denyPeerTranscriptRpc` is the fail-closed
 * per-link gate; `fetchPeerTranscript` + `normalizePeerTranscriptSlice` defend
 * the consumer against a hostile / older reply.
 */

import { describe, expect, it } from 'vitest'

import type { HubLink, TranscriptEntry } from '@aipehub/core'

import {
  PeerTranscriptHost,
  PEER_TRANSCRIPT_METHODS,
  PEER_TRANSCRIPT_VERSION,
  buildTaskTranscriptSlice,
  denyPeerTranscriptRpc,
  fetchPeerTranscript,
  normalizePeerTranscriptSlice,
  taskIdOfEntry,
  type TranscriptHubView,
} from '../src/peer-transcript.js'

/** Build a transcript with two interleaved task ids plus non-task-scoped noise. */
function fixtureEntries(): TranscriptEntry[] {
  // Cast each literal through unknown — we only exercise the fields the slice
  // reads (kind + the per-kind task id + seq/ts), not the full wire shape.
  const e = (seq: number, kind: string, data: unknown): TranscriptEntry =>
    ({ seq, ts: seq * 10, kind, data }) as unknown as TranscriptEntry
  return [
    e(1, 'task', { id: 'task-A', from: 'sys', strategy: {}, payload: 'a' }),
    e(2, 'task', { id: 'task-B', from: 'sys', strategy: {}, payload: 'b' }),
    e(3, 'message', { id: 'm1' }), // non-task-scoped → excluded
    e(4, 'llm_stream_chunk', { taskId: 'task-A', agentId: 'agent-1', chunk: { type: 'text' } }),
    e(5, 'llm_stream_chunk', { taskId: 'task-B', agentId: 'agent-2', chunk: { type: 'text' } }),
    e(6, 'participant_joined', { id: 'agent-3' }), // non-task-scoped → excluded
    e(7, 'task_resumed', { taskId: 'task-A', by: 'agent-1' }),
    e(8, 'evaluation', { taskId: 'task-A', by: 'agent-1', rating: 5 }),
    e(9, 'task_result', { kind: 'ok', taskId: 'task-A', by: 'agent-1', output: 'done', ts: 90 }),
    e(10, 'task_result', { kind: 'ok', taskId: 'task-B', by: 'agent-2', output: 'done', ts: 100 }),
  ]
}

function viewOf(entries: TranscriptEntry[]): TranscriptHubView {
  return { transcript: { all: () => entries } }
}

describe('taskIdOfEntry — only the five task-scoped kinds resolve', () => {
  it('maps each task-scoped kind to its id and everything else to null', () => {
    const e = (kind: string, data: unknown): TranscriptEntry =>
      ({ seq: 1, ts: 1, kind, data }) as unknown as TranscriptEntry
    expect(taskIdOfEntry(e('task', { id: 'T' }))).toBe('T')
    expect(taskIdOfEntry(e('task_result', { kind: 'ok', taskId: 'T', by: 'a' }))).toBe('T')
    expect(taskIdOfEntry(e('llm_stream_chunk', { taskId: 'T', agentId: 'a', chunk: {} }))).toBe('T')
    expect(taskIdOfEntry(e('task_resumed', { taskId: 'T', by: 'a' }))).toBe('T')
    expect(taskIdOfEntry(e('evaluation', { taskId: 'T', by: 'a' }))).toBe('T')
    // Non-task-scoped kinds have no id → excluded from any slice.
    expect(taskIdOfEntry(e('message', { id: 'm1' }))).toBeNull()
    expect(taskIdOfEntry(e('participant_joined', { id: 'a' }))).toBeNull()
  })
})

describe('buildTaskTranscriptSlice — one task only, sub-dispatches excluded', () => {
  it('keeps only the asked task, in seq order, with the right kinds', () => {
    const slice = buildTaskTranscriptSlice({
      hubId: 'hub_self',
      hub: viewOf(fixtureEntries()),
      taskId: 'task-A',
      now: () => 12345,
    })
    expect(slice.hubId).toBe('hub_self')
    expect(slice.protocolVersion).toBe(PEER_TRANSCRIPT_VERSION)
    expect(slice.taskId).toBe('task-A')
    expect(slice.generatedAt).toBe(12345)
    expect(slice.truncated).toBe(false)
    // task + llm_stream_chunk + task_resumed + evaluation + task_result, NONE of
    // task-B's entries and NONE of the non-task-scoped noise.
    expect(slice.events.map((x) => x.seq)).toEqual([1, 4, 7, 8, 9])
    expect(slice.events.map((x) => x.kind)).toEqual([
      'task',
      'llm_stream_chunk',
      'task_resumed',
      'evaluation',
      'task_result',
    ])
    // data rides through verbatim — the caller wants the trace, not a summary.
    const chunk = slice.events.find((x) => x.kind === 'llm_stream_chunk')!
    expect((chunk.data as { agentId: string }).agentId).toBe('agent-1')
  })

  it('a task that produced nothing yields an empty, non-truncated slice', () => {
    const slice = buildTaskTranscriptSlice({
      hubId: 'hub_self',
      hub: viewOf(fixtureEntries()),
      taskId: 'task-NONE',
    })
    expect(slice.events).toEqual([])
    expect(slice.truncated).toBe(false)
  })

  it('a throwing transcript read degrades to an empty slice, never rejects', () => {
    const view: TranscriptHubView = {
      transcript: {
        all: () => {
          throw new Error('boom')
        },
      },
    }
    const slice = buildTaskTranscriptSlice({ hubId: 'h', hub: view, taskId: 'task-A' })
    expect(slice.events).toEqual([])
  })

  it('caps events and sets truncated, keeping the chronological prefix', () => {
    const many: TranscriptEntry[] = []
    for (let i = 1; i <= 5; i++) {
      many.push({
        seq: i,
        ts: i,
        kind: 'llm_stream_chunk',
        data: { taskId: 'task-A', agentId: 'a', chunk: i },
      } as unknown as TranscriptEntry)
    }
    const slice = buildTaskTranscriptSlice({
      hubId: 'h',
      hub: viewOf(many),
      taskId: 'task-A',
      cap: 3,
    })
    expect(slice.truncated).toBe(true)
    expect(slice.events.map((x) => x.seq)).toEqual([1, 2, 3]) // prefix kept
  })
})

describe('PeerTranscriptHost.respond — the single wire method', () => {
  const host = new PeerTranscriptHost({
    hubId: 'hub_self',
    hub: viewOf(fixtureEntries()),
    now: () => 999,
  })

  it('answers peer.transcript for a valid taskId', async () => {
    const out = (await host.respond({
      method: PEER_TRANSCRIPT_METHODS.get,
      params: { taskId: 'task-B' },
    })) as { taskId: string; events: unknown[] }
    expect(out.taskId).toBe('task-B')
    expect(out.events).toHaveLength(3) // task + llm_stream_chunk + task_result for B
  })

  it('rejects a missing / non-string taskId', async () => {
    await expect(host.respond({ method: PEER_TRANSCRIPT_METHODS.get, params: {} })).rejects.toThrow(
      /taskId/,
    )
    await expect(
      host.respond({ method: PEER_TRANSCRIPT_METHODS.get, params: { taskId: 42 } }),
    ).rejects.toThrow(/taskId/)
    await expect(
      host.respond({ method: PEER_TRANSCRIPT_METHODS.get, params: { taskId: '' } }),
    ).rejects.toThrow(/taskId/)
  })

  it('rejects an unknown method', async () => {
    await expect(host.respond({ method: 'peer.bogus', params: {} })).rejects.toThrow(/unknown/)
  })
})

describe('denyPeerTranscriptRpc — fail-closed per-link gate', () => {
  it('denies peer.transcript and passes everything else through', async () => {
    let innerCalls = 0
    const inner = async (call: { method: string; params: unknown }) => {
      innerCalls++
      return { ok: call.method }
    }
    const gated = denyPeerTranscriptRpc(inner)
    await expect(
      gated({ method: PEER_TRANSCRIPT_METHODS.get, params: { taskId: 't' } }),
    ).rejects.toThrow(/not shared/)
    expect(innerCalls).toBe(0) // inner never reached for the gated method
    await expect(gated({ method: 'peer.summary', params: {} })).resolves.toEqual({
      ok: 'peer.summary',
    })
    await expect(gated({ method: 'mcp.listShared', params: {} })).resolves.toEqual({
      ok: 'mcp.listShared',
    })
  })
})

describe('normalizePeerTranscriptSlice — consumer defense', () => {
  it('coerces a hostile / partial reply into a well-formed slice', () => {
    const s = normalizePeerTranscriptSlice({
      hubId: 'h',
      taskId: 'task-A',
      events: [
        { seq: 1, ts: 10, kind: 'task', data: { id: 'task-A' } },
        'junk', // dropped
        { kind: 42 }, // kind coerced to 'unknown', seq/ts → 0
      ],
      truncated: 'yes', // not boolean true → false
      generatedAt: 'soon', // not number → 0
    })
    expect(s.events).toHaveLength(2)
    expect(s.events[0]!.kind).toBe('task')
    expect(s.events[1]!.kind).toBe('unknown')
    expect(s.events[1]!.seq).toBe(0)
    expect(s.truncated).toBe(false)
    expect(s.generatedAt).toBe(0)
    expect(s.protocolVersion).toBe(PEER_TRANSCRIPT_VERSION)
  })

  it('a non-array events field becomes []', () => {
    expect(normalizePeerTranscriptSlice({ events: 'nope' }).events).toEqual([])
    expect(normalizePeerTranscriptSlice(null).events).toEqual([])
  })
})

describe('fetchPeerTranscript — consumer over a link', () => {
  it('passes the taskId and normalizes the reply', async () => {
    let seenMethod = ''
    let seenParams: unknown
    const link = {
      rpc: async (method: string, params: unknown) => {
        seenMethod = method
        seenParams = params
        return { hubId: 'peer', taskId: 'task-A', events: [{ seq: 1, ts: 1, kind: 'task' }] }
      },
    } as unknown as HubLink
    const slice = await fetchPeerTranscript(link, 'task-A')
    expect(seenMethod).toBe(PEER_TRANSCRIPT_METHODS.get)
    expect(seenParams).toEqual({ taskId: 'task-A' })
    expect(slice?.taskId).toBe('task-A')
    expect(slice?.events).toHaveLength(1)
  })

  it('returns null when the peer answers nothing', async () => {
    const link = { rpc: async () => null } as unknown as HubLink
    expect(await fetchPeerTranscript(link, 't')).toBeNull()
  })
})
