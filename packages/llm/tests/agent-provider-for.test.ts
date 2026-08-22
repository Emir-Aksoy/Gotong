/**
 * LONG-M4b — `LlmAgent.providerFor(task)`: the ONE seam every provider read
 * funnels through. Pins two things:
 * (1) default = byte-identical — the constructor's provider streams, is named
 *     in the usage-sink attribution, and signs the output's `by`;
 * (2) a subclass that routes ONE task elsewhere changes ALL THREE reads at
 *     once — the routed provider streams, the ledger attribution names it,
 *     the output's `by` names it — so a slot-routed call can never be billed
 *     or labelled as the primary.
 */

import { describe, it, expect } from 'vitest'
import { Hub, type Task } from '@gotong/core'
import {
  LlmAgent,
  type LlmProvider,
  type LlmRequest,
  type LlmStreamChunk,
  type LlmUsage,
  type LlmUsageSinkMeta,
} from '../src/index.js'

/** A counting provider that yields text + usage + end (what real providers do). */
class Counting implements LlmProvider {
  calls = 0
  requests: LlmRequest[] = []
  constructor(readonly name: string, private readonly reply: string) {}
  stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.calls++
    this.requests.push(req)
    const reply = this.reply
    return (async function* () {
      yield { type: 'text', text: reply } as LlmStreamChunk
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } } as LlmStreamChunk
      yield { type: 'end', stopReason: 'end_turn' } as LlmStreamChunk
    })()
  }
}

function makeTask(payload: unknown) {
  return {
    from: 'system' as const,
    strategy: { kind: 'capability' as const, capabilities: ['draft'] },
    payload,
  }
}

describe('LlmAgent.providerFor — the one provider seam', () => {
  it('default: the constructor provider streams, is attributed in the usage sink and signs `by`', async () => {
    const primary = new Counting('primary', 'from primary')
    const metas: LlmUsageSinkMeta[] = []
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider: primary,
        usageSink: async (_task: Task, _usage: LlmUsage, meta: LlmUsageSinkMeta) => {
          metas.push(meta)
        },
      }),
    )
    const r = await hub.dispatch(makeTask('hi'))
    await hub.stop()
    expect(r.kind).toBe('ok')
    const out = (r as { output: { text: string; by: string } }).output
    expect(out.text).toBe('from primary')
    expect(out.by).toBe('primary')
    expect(primary.calls).toBe(1)
    expect(metas).toHaveLength(1)
    expect(metas[0]!.provider).toBe('primary')
  })

  it('a subclass override routes ONE task: stream source, sink attribution and `by` all follow it', async () => {
    const primary = new Counting('primary', 'from primary')
    const slot = new Counting('slot', 'from slot')
    const metas: LlmUsageSinkMeta[] = []
    class Routed extends LlmAgent {
      protected override providerFor(task: Task): LlmProvider {
        const p = task.payload as { useSlot?: boolean } | string
        return typeof p === 'object' && p.useSlot ? slot : super.providerFor(task)
      }
    }
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new Routed({
        id: 'a',
        capabilities: ['draft'],
        provider: primary,
        usageSink: async (_task: Task, _usage: LlmUsage, meta: LlmUsageSinkMeta) => {
          metas.push(meta)
        },
      }),
    )

    const routed = await hub.dispatch(makeTask({ prompt: 'go', useSlot: true }))
    expect(routed.kind).toBe('ok')
    const routedOut = (routed as { output: { text: string; by: string } }).output
    expect(routedOut.text).toBe('from slot')
    expect(routedOut.by).toBe('slot')
    expect(slot.calls).toBe(1)
    expect(primary.calls).toBe(0)
    expect(metas.at(-1)!.provider).toBe('slot')

    // The routing is per task, not sticky: the next unrouted task is the
    // primary's again, in all three places.
    const plain = await hub.dispatch(makeTask({ prompt: 'again' }))
    await hub.stop()
    expect(plain.kind).toBe('ok')
    const plainOut = (plain as { output: { text: string; by: string } }).output
    expect(plainOut.text).toBe('from primary')
    expect(plainOut.by).toBe('primary')
    expect(primary.calls).toBe(1)
    expect(slot.calls).toBe(1)
    expect(metas.at(-1)!.provider).toBe('primary')
  })
})
