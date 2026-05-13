import { describe, expect, it, vi } from 'vitest'

import { MessageBus, type Deliverer } from '../src/bus.js'
import type { Message } from '../src/types.js'

const flush = () => new Promise<void>((r) => queueMicrotask(r))

function makeMsg(from: string, channel: string, body: unknown = {}): Message {
  return { id: `m-${Math.random()}`, channel, from, body, ts: Date.now() }
}

describe('MessageBus', () => {
  it('subscribe + publish eventually delivers to the subscriber', async () => {
    const deliver = vi.fn<Parameters<Deliverer>, ReturnType<Deliverer>>()
    const bus = new MessageBus(deliver)
    bus.subscribe('alice', '#general')
    const msg = makeMsg('bob', '#general')
    bus.publish(msg)
    expect(deliver).not.toHaveBeenCalled()
    await flush()
    expect(deliver).toHaveBeenCalledWith('alice', msg)
  })

  it('the sender does NOT receive its own message', async () => {
    const deliver = vi.fn<Parameters<Deliverer>, ReturnType<Deliverer>>()
    const bus = new MessageBus(deliver)
    bus.subscribe('alice', '#general')
    bus.subscribe('bob', '#general')
    bus.publish(makeMsg('alice', '#general'))
    await flush()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0]?.[0]).toBe('bob')
  })

  it('after unsubscribe, no more delivery', async () => {
    const deliver = vi.fn<Parameters<Deliverer>, ReturnType<Deliverer>>()
    const bus = new MessageBus(deliver)
    bus.subscribe('alice', '#general')
    bus.unsubscribe('alice', '#general')
    bus.publish(makeMsg('bob', '#general'))
    await flush()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('unsubscribeAll removes from every channel', async () => {
    const deliver = vi.fn<Parameters<Deliverer>, ReturnType<Deliverer>>()
    const bus = new MessageBus(deliver)
    bus.subscribe('alice', '#a')
    bus.subscribe('alice', '#b')
    bus.subscribe('bob', '#a')
    bus.unsubscribeAll('alice')
    bus.publish(makeMsg('x', '#a'))
    bus.publish(makeMsg('x', '#b'))
    await flush()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0]?.[0]).toBe('bob')
  })

  it('one throwing deliverer does not prevent another from receiving', async () => {
    const received: string[] = []
    const deliver: Deliverer = (rid) => {
      if (rid === 'thrower') throw new Error('boom')
      received.push(rid)
    }
    const bus = new MessageBus(deliver)
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    bus.subscribe('thrower', '#general')
    bus.subscribe('alice', '#general')
    bus.publish(makeMsg('bob', '#general'))
    await flush()
    expect(received).toContain('alice')
    consoleErr.mockRestore()
  })

  it('onPublish observer fires synchronously on publish', () => {
    const deliver = vi.fn<Parameters<Deliverer>, ReturnType<Deliverer>>()
    const bus = new MessageBus(deliver)
    const observed: Message[] = []
    bus.onPublish((m) => observed.push(m))
    const msg = makeMsg('bob', '#general')
    bus.publish(msg)
    // sync — no flush needed
    expect(observed).toEqual([msg])
  })
})
