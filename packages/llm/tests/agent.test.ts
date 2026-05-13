import { describe, it, expect } from 'vitest'
import { Hub } from '@aipehub/core'
import { LlmAgent, MockLlmProvider, type LlmRequest } from '../src/index.js'

function makeTask(payload: unknown, capabilities = ['draft']) {
  return {
    from: 'system' as const,
    strategy: { kind: 'capability' as const, capabilities },
    payload,
  }
}

describe('LlmAgent — payload handling', () => {
  it('string payload becomes the user message verbatim', async () => {
    let captured: LlmRequest | undefined
    const provider = new MockLlmProvider({
      reply: (req) => {
        captured = req
        return 'ok'
      },
    })
    const hub = new Hub()
    await hub.start()
    hub.register(new LlmAgent({ id: 'a', capabilities: ['draft'], provider }))

    const result = await hub.dispatch(makeTask('write a haiku'))
    await hub.stop()

    expect(result.kind).toBe('ok')
    expect(captured?.messages).toEqual([{ role: 'user', content: 'write a haiku' }])
    expect(captured?.system).toBeUndefined()
  })

  it('object payload with prompt field is honored', async () => {
    let captured: LlmRequest | undefined
    const provider = new MockLlmProvider({
      reply: (req) => {
        captured = req
        return 'done'
      },
    })
    const hub = new Hub()
    await hub.start()
    hub.register(new LlmAgent({ id: 'a', capabilities: ['draft'], provider }))

    await hub.dispatch(makeTask({ prompt: 'explain TS' }))
    await hub.stop()

    expect(captured?.messages[0]).toEqual({ role: 'user', content: 'explain TS' })
  })

  it('object payload with only topic wraps it in a request sentence', async () => {
    let captured: LlmRequest | undefined
    const provider = new MockLlmProvider({
      reply: (req) => {
        captured = req
        return 'done'
      },
    })
    const hub = new Hub()
    await hub.start()
    hub.register(new LlmAgent({ id: 'a', capabilities: ['draft'], provider }))

    await hub.dispatch(makeTask({ topic: 'why TS' }))
    await hub.stop()

    expect(captured?.messages[0]?.content).toBe('Please write about: why TS')
  })

  it('history is prepended to the user message', async () => {
    let captured: LlmRequest | undefined
    const provider = new MockLlmProvider({
      reply: (req) => {
        captured = req
        return 'done'
      },
    })
    const hub = new Hub()
    await hub.start()
    hub.register(new LlmAgent({ id: 'a', capabilities: ['draft'], provider }))

    await hub.dispatch(
      makeTask({
        prompt: 'and now what?',
        history: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      }),
    )
    await hub.stop()

    expect(captured?.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'and now what?' },
    ])
  })
})

describe('LlmAgent — system and parameter resolution', () => {
  it('agent-level system prompt flows through', async () => {
    let captured: LlmRequest | undefined
    const provider = new MockLlmProvider({
      reply: (req) => {
        captured = req
        return 'done'
      },
    })
    const hub = new Hub()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        system: 'You are a poet.',
        maxTokens: 100,
        temperature: 0.5,
        model: 'mock-model-v1',
      }),
    )

    await hub.dispatch(makeTask('haiku'))
    await hub.stop()

    expect(captured?.system).toBe('You are a poet.')
    expect(captured?.maxTokens).toBe(100)
    expect(captured?.temperature).toBe(0.5)
    expect(captured?.model).toBe('mock-model-v1')
  })

  it('per-task overrides win over agent-level defaults', async () => {
    let captured: LlmRequest | undefined
    const provider = new MockLlmProvider({
      reply: (req) => {
        captured = req
        return 'done'
      },
    })
    const hub = new Hub()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        system: 'You are a poet.',
        maxTokens: 100,
        temperature: 0.5,
      }),
    )

    await hub.dispatch(
      makeTask({
        prompt: 'x',
        system: 'You are a critic.',
        maxTokens: 50,
        temperature: 0.1,
        model: 'override-model',
      }),
    )
    await hub.stop()

    expect(captured?.system).toBe('You are a critic.')
    expect(captured?.maxTokens).toBe(50)
    expect(captured?.temperature).toBe(0.1)
    expect(captured?.model).toBe('override-model')
  })
})

describe('LlmAgent — output and error mapping', () => {
  it('parseResponse default returns text + stopReason + by + usage', async () => {
    const provider = new MockLlmProvider({
      name: 'mock-A',
      reply: 'hello world',
    })
    const hub = new Hub()
    await hub.start()
    hub.register(new LlmAgent({ id: 'a', capabilities: ['draft'], provider }))

    const result = await hub.dispatch(makeTask('hi'))
    await hub.stop()

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      const out = result.output as {
        text: string
        stopReason: string
        by: string
        usage?: { inputTokens: number; outputTokens: number }
      }
      expect(out.text).toBe('hello world')
      expect(out.stopReason).toBe('end_turn')
      expect(out.by).toBe('mock-A')
      expect(out.usage?.outputTokens).toBeGreaterThan(0)
    }
  })

  it('provider error becomes a failed TaskResult, not a thrown promise', async () => {
    const provider = new MockLlmProvider({
      reply: 'unused',
      throwError: 'auth_denied',
    })
    const hub = new Hub()
    await hub.start()
    hub.register(new LlmAgent({ id: 'a', capabilities: ['draft'], provider }))

    const result = await hub.dispatch(makeTask('hi'))
    await hub.stop()

    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toContain('auth_denied')
    }
  })
})

describe('LlmAgent — subclass hooks', () => {
  it('subclass can override buildRequest to inject extra system prompt', async () => {
    let captured: LlmRequest | undefined
    const provider = new MockLlmProvider({
      reply: (req) => {
        captured = req
        return 'done'
      },
    })

    class MyAgent extends LlmAgent {
      protected override buildRequest(task: import('@aipehub/core').Task) {
        const base = super.buildRequest(task)
        return { ...base, system: 'INJECTED SYSTEM' }
      }
    }

    const hub = new Hub()
    await hub.start()
    hub.register(new MyAgent({ id: 'a', capabilities: ['draft'], provider }))

    await hub.dispatch(makeTask('go'))
    await hub.stop()

    expect(captured?.system).toBe('INJECTED SYSTEM')
  })

  it('subclass can override parseResponse to return arbitrary shape', async () => {
    const provider = new MockLlmProvider({ reply: '   trimmed   ' })

    class TrimmingAgent extends LlmAgent {
      protected override parseResponse(
        response: import('../src/index.js').LlmResponse,
      ): { trimmed: string } {
        return { trimmed: response.text.trim() }
      }
    }

    const hub = new Hub()
    await hub.start()
    hub.register(new TrimmingAgent({ id: 'a', capabilities: ['draft'], provider }))

    const result = await hub.dispatch(makeTask('x'))
    await hub.stop()

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.output).toEqual({ trimmed: 'trimmed' })
    }
  })
})
