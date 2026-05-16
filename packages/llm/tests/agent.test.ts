import { describe, it, expect } from 'vitest'
import { Hub } from '@aipehub/core'
import { EMPTY_SERVICE_CTX, type ServiceCtx } from '@aipehub/services-sdk'
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
    const hub = Hub.inMemory()
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
    const hub = Hub.inMemory()
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
    const hub = Hub.inMemory()
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
    const hub = Hub.inMemory()
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
    const hub = Hub.inMemory()
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
    const hub = Hub.inMemory()
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
    const hub = Hub.inMemory()
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
    const hub = Hub.inMemory()
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

    const hub = Hub.inMemory()
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

    const hub = Hub.inMemory()
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

/**
 * Tiny subclass that exposes the protected `services` field for
 * black-box testing without sacrificing the encapsulation on the real
 * `LlmAgent`. Every assertion below goes through this view.
 */
class ServicesPeekAgent extends LlmAgent {
  get _services(): ServiceCtx {
    return this.services
  }
}

describe('LlmAgent — services ctx injection (PR-6)', () => {
  const provider = new MockLlmProvider({ reply: 'ok' })

  it('no services opt → field is EMPTY_SERVICE_CTX (identity match)', () => {
    const agent = new ServicesPeekAgent({
      id: 'a',
      capabilities: ['draft'],
      provider,
    })
    expect(agent._services).toBe(EMPTY_SERVICE_CTX)
    // Frozen — accidental mutation would throw / be silently dropped.
    expect(Object.isFrozen(agent._services)).toBe(true)
  })

  it('services: undefined → field is EMPTY_SERVICE_CTX', () => {
    const agent = new ServicesPeekAgent({
      id: 'a',
      capabilities: ['draft'],
      provider,
      services: undefined,
    })
    expect(agent._services).toBe(EMPTY_SERVICE_CTX)
  })

  it('services: {} → field is the supplied object (caller controls identity)', () => {
    const ctx: ServiceCtx = {}
    const agent = new ServicesPeekAgent({
      id: 'a',
      capabilities: ['draft'],
      provider,
      services: ctx,
    })
    // Caller-supplied object wins (not coerced to EMPTY_SERVICE_CTX)
    expect(agent._services).toBe(ctx)
  })

  it('services with memory + artifact handles are exposed verbatim', () => {
    // Tiny stand-in handles — we only check the agent doesn't mangle them.
    const memory = { recall: async () => [], remember: async () => ({ id: 'x', kind: 'episodic' as const, text: '', ts: 0 }), list: async () => [], clear: async () => 0 }
    const artifact = { write: async () => ({ ref: 'x', mime: 'text/plain' as const, sizeBytes: 0, ts: 0 }), read: async () => ({ content: '', mime: 'text/plain' as const, sizeBytes: 0, ts: 0 }), list: async () => [], exists: async () => false, remove: async () => undefined }
    const ctx: ServiceCtx = {
      memory: memory as unknown as ServiceCtx['memory'],
      artifact: artifact as unknown as ServiceCtx['artifact'],
    }
    const agent = new ServicesPeekAgent({
      id: 'a',
      capabilities: ['draft'],
      provider,
      services: ctx,
    })
    expect(agent._services.memory).toBe(memory)
    expect(agent._services.artifact).toBe(artifact)
    expect(agent._services.datastore).toBeUndefined()
  })

  it('services.datastore is a record keyed by config.name', () => {
    const cases = { kv: {}, sql: {} } as unknown as NonNullable<ServiceCtx['datastore']>[string]
    const sessions = { kv: {}, sql: {} } as unknown as NonNullable<ServiceCtx['datastore']>[string]
    const agent = new ServicesPeekAgent({
      id: 'a',
      capabilities: ['draft'],
      provider,
      services: { datastore: { cases, sessions } },
    })
    expect(agent._services.datastore?.cases).toBe(cases)
    expect(agent._services.datastore?.sessions).toBe(sessions)
  })

  it('declaring services does NOT change buildRequest output', async () => {
    let captured: LlmRequest | undefined
    const cap = new MockLlmProvider({
      reply: (req) => {
        captured = req
        return 'ok'
      },
    })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider: cap,
        services: {
          memory: undefined,
          artifact: undefined,
        },
      }),
    )
    await hub.dispatch(makeTask('hi'))
    await hub.stop()
    // base buildRequest must stay agnostic to services — same shape as
    // an agent that never declared a ctx. PR-13 demo templates will
    // decide how to mention services in prompts.
    expect(captured?.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(captured?.system).toBeUndefined()
  })

  it('subclass can call this.services.memory.recall from buildRequest', async () => {
    let captured: LlmRequest | undefined
    const cap = new MockLlmProvider({
      reply: (req) => {
        captured = req
        return 'ok'
      },
    })

    // Hand-rolled MemoryHandle stub — only the methods we touch.
    const recalled = [
      { id: '1', kind: 'episodic' as const, text: 'last time you helped a baker', ts: 1 },
    ]
    const memory = {
      recall: async () => recalled,
      remember: async () => ({ id: 'x', kind: 'episodic' as const, text: '', ts: 0 }),
      list: async () => [],
      clear: async () => 0,
    } as unknown as NonNullable<ServiceCtx['memory']>

    class CoachAgent extends LlmAgent {
      protected override async handleTask(task: import('@aipehub/core').Task) {
        // Recall before invoking — proves the subclass can read services.
        const items = (await this.services.memory?.recall({ query: '' })) ?? []
        const base = this.buildRequest(task)
        const sys = `prior memories: ${items.map((i) => i.text).join('; ')}`
        const res = await this.provider.complete({ ...base, system: sys })
        return this.parseResponse(res, task)
      }
    }

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new CoachAgent({
        id: 'a',
        capabilities: ['draft'],
        provider: cap,
        services: { memory },
      }),
    )
    await hub.dispatch(makeTask('go'))
    await hub.stop()
    expect(captured?.system).toBe('prior memories: last time you helped a baker')
  })
})
