import { describe, it, expect } from 'vitest'
import { Hub } from '@aipehub/core'
import { EMPTY_SERVICE_CTX, type ServiceCtx } from '@aipehub/services-sdk'
import {
  LlmAgent,
  MockLlmProvider,
  drainStream,
  type LlmRequest,
  type LlmStreamChunk,
} from '../src/index.js'

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
        const res = await drainStream(this.provider.stream({ ...base, system: sys }))
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

// v0.3: LlmAgent learned to drive a multi-turn tool-use loop when an
// `LlmAgentToolset` is attached. These tests use the `script` shortcut
// on MockLlmProvider to stage a 2-3 round conversation deterministically.
describe('LlmAgent — tool-use loop (v0.3)', () => {
  /**
   * Trivial in-memory toolset that satisfies `LlmAgentToolset` without
   * pulling in @aipehub/mcp-client. Lets us assert the loop's wiring
   * without spawning a child process or mocking the MCP SDK.
   */
  function makeFakeToolset(opts: {
    tools: Array<{
      name: string
      description?: string
      inputSchema: Record<string, unknown>
    }>
    handlers: Record<
      string,
      (
        args: Record<string, unknown>,
      ) => { content: ReadonlyArray<unknown>; isError?: boolean } | Promise<{
        content: ReadonlyArray<unknown>
        isError?: boolean
      }> | Promise<never>
    >
    listToolsThrows?: string
  }) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const toolset = {
      async listTools() {
        if (opts.listToolsThrows) throw new Error(opts.listToolsThrows)
        return opts.tools
      },
      async callTool(name: string, args: Record<string, unknown>) {
        calls.push({ name, args })
        const h = opts.handlers[name]
        if (!h) throw new Error(`fake-toolset: no handler for ${name}`)
        return h(args)
      },
    }
    return { toolset, calls }
  }

  it('no toolset attached → behaves like v0.2 (single-shot, no tools in request)', async () => {
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

    const out = await hub.dispatch(makeTask('write me a poem'))
    await hub.stop()

    expect(out.kind).toBe('ok')
    expect(captured?.tools).toBeUndefined()
    if (out.kind !== 'ok') throw new Error('unreachable')
    const result = out.output as { toolRounds?: number; text: string }
    // toolRounds=0 is suppressed from the output for legacy compatibility.
    expect(result.toolRounds).toBeUndefined()
    expect(result.text).toBe('done')
  })

  it('with toolset, model returns end_turn on first turn → no tool call', async () => {
    const { toolset, calls } = makeFakeToolset({
      tools: [{ name: 'fs__read', inputSchema: { type: 'object' } }],
      handlers: {},
    })
    let capturedReqs: LlmRequest[] = []
    const provider = new MockLlmProvider({
      reply: (req) => {
        capturedReqs.push(req)
        return 'no tool needed'
      },
    })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        tools: toolset,
      }),
    )

    const out = await hub.dispatch(makeTask('hi'))
    await hub.stop()

    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') throw new Error('unreachable')
    expect(calls).toEqual([])
    expect(capturedReqs).toHaveLength(1)
    // Tools were declared to the model on the request.
    expect(capturedReqs[0]!.tools).toEqual([
      { name: 'fs__read', inputSchema: { type: 'object' } },
    ])
    const result = out.output as { toolRounds?: number; text: string }
    expect(result.toolRounds).toBeUndefined() // 0 rounds = not surfaced
    expect(result.text).toBe('no tool needed')
  })

  it('single round: tool_use → tool_result → final text', async () => {
    const { toolset, calls } = makeFakeToolset({
      tools: [
        {
          name: 'fs__read',
          description: 'read a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      ],
      handlers: {
        fs__read: ({ path }) => ({
          content: [{ type: 'text', text: `[contents of ${path}]` }],
        }),
      },
    })

    const capturedReqs: LlmRequest[] = []
    const provider = new MockLlmProvider({
      reply: 'unused', // overridden by script
      script: [
        {
          kind: 'tool_use',
          toolUses: [
            {
              type: 'tool_use',
              id: 'toolu_01',
              name: 'fs__read',
              input: { path: 'README.md' },
            },
          ],
          text: 'let me check',
        },
        {
          kind: 'text',
          text: 'README starts with a hash sign',
        },
      ],
    })
    // Wrap so we can also capture the request seen on each round.
    const wrappedProvider = {
      name: provider.name,
      stream: (req: LlmRequest) => {
        capturedReqs.push(req)
        return provider.stream(req)
      },
    }

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider: wrappedProvider,
        tools: toolset,
      }),
    )

    const out = await hub.dispatch(makeTask('read README'))
    await hub.stop()

    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') throw new Error('unreachable')
    expect(calls).toEqual([{ name: 'fs__read', args: { path: 'README.md' } }])
    expect(capturedReqs).toHaveLength(2)
    // Round 2's messages should include: original user, assistant w/ tool_use, user w/ tool_result
    const round2 = capturedReqs[1]!
    expect(round2.messages).toHaveLength(3)
    const assistantMsg = round2.messages[1]!
    expect(assistantMsg.role).toBe('assistant')
    expect(Array.isArray(assistantMsg.content)).toBe(true)
    const blocks = assistantMsg.content as Array<{ type: string }>
    expect(blocks.find((b) => b.type === 'text')).toBeDefined()
    expect(blocks.find((b) => b.type === 'tool_use')).toMatchObject({
      type: 'tool_use',
      id: 'toolu_01',
    })
    const toolResultMsg = round2.messages[2]!
    expect(toolResultMsg.role).toBe('user')
    expect((toolResultMsg.content as Array<unknown>)[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'toolu_01',
      content: '[contents of README.md]',
    })
    const result = out.output as { toolRounds?: number; text: string }
    expect(result.toolRounds).toBe(1)
    expect(result.text).toBe('README starts with a hash sign')
  })

  it('tool error becomes isError:true tool_result and the loop keeps going', async () => {
    const { toolset, calls } = makeFakeToolset({
      tools: [{ name: 'fs__read', inputSchema: { type: 'object' } }],
      handlers: {
        fs__read: async () => {
          throw new Error('ENOENT: no such file')
        },
      },
    })

    const capturedReqs: LlmRequest[] = []
    const provider = new MockLlmProvider({
      reply: 'unused',
      script: [
        {
          kind: 'tool_use',
          toolUses: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'fs__read',
              input: { path: 'nope.md' },
            },
          ],
        },
        {
          kind: 'text',
          text: 'I will try a different approach',
        },
      ],
    })
    const wrapped = {
      name: provider.name,
      stream: (req: LlmRequest) => {
        capturedReqs.push(req)
        return provider.stream(req)
      },
    }

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider: wrapped,
        tools: toolset,
      }),
    )

    const out = await hub.dispatch(makeTask('read missing file'))
    await hub.stop()

    expect(out.kind).toBe('ok')
    expect(calls).toHaveLength(1)
    const round2 = capturedReqs[1]!
    const toolResult = (round2.messages[2]!.content as Array<Record<string, unknown>>)[0]!
    expect(toolResult.isError).toBe(true)
    expect(toolResult.content).toContain('ENOENT')
  })

  it('aborts after maxToolRounds with an error stopReason rather than looping forever', async () => {
    const { toolset } = makeFakeToolset({
      tools: [{ name: 'fs__read', inputSchema: { type: 'object' } }],
      handlers: {
        fs__read: () => ({ content: [{ type: 'text', text: 'still here' }] }),
      },
    })

    // Always returns tool_use → would loop forever absent the cap.
    const provider = {
      name: 'loop-forever',
      // eslint-disable-next-line require-yield -- async generator IS the contract
      stream: async function* (): AsyncIterable<LlmStreamChunk> {
        yield { type: 'text', text: 'thinking' }
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'tx', name: 'fs__read', input: {} },
        }
        yield { type: 'end', stopReason: 'tool_use' }
      },
    }

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        tools: toolset,
        maxToolRounds: 3,
      }),
    )

    const out = await hub.dispatch(makeTask('loop please'))
    await hub.stop()

    expect(out.kind).toBe('ok') // soft-fail: still a successful TaskResult
    if (out.kind !== 'ok') throw new Error('unreachable')
    const result = out.output as { stopReason: string; text: string; toolRounds: number }
    expect(result.stopReason).toBe('error')
    expect(result.toolRounds).toBe(4) // 3 successful rounds + 1 over-the-cap that triggers abort
    expect(result.text).toContain('aborted after 3 tool-use rounds')
  })

  it('flattenToolResult concatenates text blocks; non-text content is JSON-dumped', async () => {
    const { toolset, calls } = makeFakeToolset({
      tools: [{ name: 'fs__multi', inputSchema: { type: 'object' } }],
      handlers: {
        fs__multi: () => ({
          content: [
            { type: 'text', text: 'part-1\n' },
            { type: 'text', text: 'part-2' },
            // A non-text block: should NOT contribute to flattened text
            // when other text exists.
            { type: 'image', data: 'base64data...' },
          ],
        }),
      },
    })

    const capturedReqs: LlmRequest[] = []
    const provider = new MockLlmProvider({
      reply: 'unused',
      script: [
        {
          kind: 'tool_use',
          toolUses: [{ type: 'tool_use', id: 'm1', name: 'fs__multi', input: {} }],
        },
        { kind: 'text', text: 'got it' },
      ],
    })
    const wrapped = {
      name: provider.name,
      stream: (req: LlmRequest) => {
        capturedReqs.push(req)
        return provider.stream(req)
      },
    }

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider: wrapped,
        tools: toolset,
      }),
    )
    await hub.dispatch(makeTask('hi'))
    await hub.stop()

    expect(calls).toHaveLength(1)
    const toolResult = (capturedReqs[1]!.messages[2]!.content as Array<Record<string, unknown>>)[0]!
    expect(toolResult.content).toBe('part-1\npart-2')
  })
})

// =========================================================================
// B2.2 — preCallHook: invoked before every provider.stream (including
// each round of the tool-use loop). Used by host wiring (OrgApiPool's
// makeLlmQuotaGate) to charge usage / enforce caps.
// =========================================================================

describe('LlmAgent — preCallHook (B2.2)', () => {
  it('no hook → provider is invoked normally', async () => {
    let providerCalled = 0
    const provider = new MockLlmProvider({
      reply: () => {
        providerCalled++
        return 'ok'
      },
    })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({ id: 'a', capabilities: ['draft'], provider }),
    )
    const out = await hub.dispatch(makeTask('hi'))
    await hub.stop()
    expect(out.kind).toBe('ok')
    expect(providerCalled).toBe(1)
  })

  it('sync hook is awaited before provider.stream; receives the task', async () => {
    const order: string[] = []
    let hookSawTask: unknown
    const provider = new MockLlmProvider({
      reply: () => {
        order.push('provider')
        return 'ok'
      },
    })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        preCallHook: (task) => {
          order.push('hook')
          hookSawTask = task
        },
      }),
    )
    await hub.dispatch(makeTask('hi'))
    await hub.stop()
    expect(order).toEqual(['hook', 'provider'])
    expect((hookSawTask as { payload: unknown }).payload).toBe('hi')
  })

  it('async hook is awaited (resolves before provider is called)', async () => {
    const order: string[] = []
    const provider = new MockLlmProvider({
      reply: () => {
        order.push('provider')
        return 'ok'
      },
    })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        preCallHook: async () => {
          await new Promise((r) => setTimeout(r, 5))
          order.push('hook')
        },
      }),
    )
    await hub.dispatch(makeTask('hi'))
    await hub.stop()
    expect(order).toEqual(['hook', 'provider'])
  })

  it('hook throwing fails the task; provider is never called', async () => {
    let providerCalled = 0
    const provider = new MockLlmProvider({
      reply: () => {
        providerCalled++
        return 'ok'
      },
    })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        preCallHook: () => {
          throw new Error('quota_exceeded: simulated')
        },
      }),
    )
    const out = await hub.dispatch(makeTask('hi'))
    await hub.stop()
    expect(out.kind).toBe('failed')
    if (out.kind !== 'failed') throw new Error('unreachable')
    expect(out.error).toMatch(/quota_exceeded/)
    expect(providerCalled).toBe(0)
  })

  it('async hook rejection fails the task too', async () => {
    const provider = new MockLlmProvider({ reply: 'ok' })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        preCallHook: async () => {
          throw new Error('async_rejection')
        },
      }),
    )
    const out = await hub.dispatch(makeTask('hi'))
    await hub.stop()
    expect(out.kind).toBe('failed')
    if (out.kind !== 'failed') throw new Error('unreachable')
    expect(out.error).toMatch(/async_rejection/)
  })

  it('tool-use loop: hook invoked once per round (NOT just first call)', async () => {
    // Critical for quota: a runaway tool-use loop must charge usage
    // on every provider hop, not just the first. Mock script returns
    // tool_use, tool_use, text — 3 rounds = 3 hook invocations.
    let hookCount = 0
    const provider = new MockLlmProvider({
      reply: 'final',
      script: [
        {
          kind: 'tool_use',
          toolUses: [
            { id: 't1', name: 'fs__read', input: { path: '/a' } },
          ],
        },
        {
          kind: 'tool_use',
          toolUses: [
            { id: 't2', name: 'fs__read', input: { path: '/b' } },
          ],
        },
        { kind: 'text', text: 'done' },
      ],
    })
    const fakeToolset = {
      async listTools() {
        return [{ name: 'fs__read', inputSchema: { type: 'object' } }]
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'tool-output' }] }
      },
    }
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        tools: fakeToolset,
        preCallHook: () => {
          hookCount++
        },
      }),
    )
    await hub.dispatch(makeTask('go'))
    await hub.stop()
    expect(hookCount).toBe(3)
  })

  it('hook sees task.origin when dispatcher attached one', async () => {
    let seenOrigin: unknown
    const provider = new MockLlmProvider({ reply: 'ok' })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        preCallHook: (task) => {
          seenOrigin = task.origin
        },
      }),
    )
    await hub.dispatch({
      ...makeTask('hi'),
      origin: { orgId: 'self', userId: 'alice' },
    })
    await hub.stop()
    expect(seenOrigin).toEqual({ orgId: 'self', userId: 'alice' })
  })

  it('hook tolerates absent task.origin (local dispatch without attribution)', async () => {
    let seenOrigin: unknown = 'unset'
    const provider = new MockLlmProvider({ reply: 'ok' })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        preCallHook: (task) => {
          seenOrigin = task.origin // expected undefined for plain hub.dispatch
        },
      }),
    )
    await hub.dispatch(makeTask('hi'))
    await hub.stop()
    expect(seenOrigin).toBeUndefined()
  })
})
