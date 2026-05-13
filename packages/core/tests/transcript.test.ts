import { describe, expect, it, vi } from 'vitest'

import { InMemoryStorage } from '../src/storage/memory.js'
import { Transcript } from '../src/transcript.js'
import type { TranscriptEntry } from '../src/types.js'

const flush = () => new Promise<void>((r) => setImmediate(r))

function joinEntry(id: string): Omit<TranscriptEntry, 'seq'> {
  return {
    ts: Date.now(),
    kind: 'participant_joined',
    data: { id, participantKind: 'agent', capabilities: [] },
  }
}

describe('Transcript', () => {
  it('append assigns monotonically increasing seq starting at 1', () => {
    const t = new Transcript(new InMemoryStorage())
    const a = t.append(joinEntry('a'))
    const b = t.append(joinEntry('b'))
    const c = t.append(joinEntry('c'))
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(c.seq).toBe(3)
  })

  it('after load(), the next append continues the seq (no restart at 1)', async () => {
    const storage = new InMemoryStorage()
    const first = new Transcript(storage)
    first.append(joinEntry('a'))
    first.append(joinEntry('b'))
    await flush() // let in-memory storage observe the async appends

    const reloaded = new Transcript(storage)
    await reloaded.load()
    const next = reloaded.append(joinEntry('c'))
    expect(next.seq).toBe(3)
  })

  it('tail(n) returns the last n entries', () => {
    const t = new Transcript(new InMemoryStorage())
    for (let i = 0; i < 5; i++) t.append(joinEntry(`a${i}`))
    const last2 = t.tail(2)
    expect(last2.map((e) => e.seq)).toEqual([4, 5])
  })

  it('since(seq) returns entries with seq > that value', () => {
    const t = new Transcript(new InMemoryStorage())
    for (let i = 0; i < 4; i++) t.append(joinEntry(`a${i}`))
    expect(t.since(2).map((e) => e.seq)).toEqual([3, 4])
    expect(t.since(0).map((e) => e.seq)).toEqual([1, 2, 3, 4])
    expect(t.since(4)).toEqual([])
  })

  it('onAppend handler is called for every appended entry; unsubscribe works', () => {
    const t = new Transcript(new InMemoryStorage())
    const observed: number[] = []
    const off = t.onAppend((e) => observed.push(e.seq))

    t.append(joinEntry('a'))
    t.append(joinEntry('b'))
    expect(observed).toEqual([1, 2])

    off()
    t.append(joinEntry('c'))
    expect(observed).toEqual([1, 2])
  })

  it('a throwing handler does not prevent further appends or other handlers', () => {
    const t = new Transcript(new InMemoryStorage())
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: number[] = []
    t.onAppend(() => {
      throw new Error('boom')
    })
    t.onAppend((e) => seen.push(e.seq))
    t.append(joinEntry('a'))
    t.append(joinEntry('b'))
    expect(seen).toEqual([1, 2])
    consoleErr.mockRestore()
  })
})
