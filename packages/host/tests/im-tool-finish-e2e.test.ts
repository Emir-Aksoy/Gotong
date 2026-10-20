import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hub, type Logger } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import { GovernedActionToolset, PersonalButlerAgent } from '@gotong/personal-butler'
import { OpenAIProvider } from '@gotong/llm-openai'
import type { ImBridge, ImMessage } from '@gotong/im-adapter'
import { handleImMessage, makeIdentityImBindingResolver, type HostImConfig } from '../src/im-bridge.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'

describe('IM -> butler -> OpenAI-compatible tools -> reply', () => {
  let hub: Hub
  let identity: IdentityStore
  let tmp: string
  let config: HostImConfig
  let bridge: ImBridge
  let userId: string
  let replies: string[]
  const warn = vi.fn()
  const log: Logger = { trace() {}, debug() {}, info() {}, warn, error() {}, fatal() {}, child() { return log } }
  const msg: ImMessage = { messageId: 'probe-message', from: { platform: 'lark', platformUserId: 'probe-user' }, text: 'Run the synthetic probe.', ts: 1 }
  const tool = { name: 'deployment_probe', description: 'Synthetic test only.', inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] } }

  beforeEach(async () => {
    warn.mockClear()
    tmp = mkdtempSync(join(tmpdir(), 'gotong-im-tool-finish-'))
    hub = Hub.inMemory()
    await hub.start()
    identity = openIdentityStore({ dbPath: ':memory:' })
    userId = identity.createUser({ email: 'probe@example.test', displayName: 'Probe' }).id
    identity.claimImBindingCode({ code: identity.issueImBindingCode({ userId }).code, platform: 'lark', platformUserId: 'probe-user' })
    replies = []
    bridge = {
      platform: 'lark', async start() {}, async stop() {}, onMessage: () => () => {},
      async sendMessage(_to, text) {
        // Reproduce Feishu's empty-message rejection without any network call.
        if (!text.trim()) throw new Error('invalid message content')
        replies.push(text)
      },
    }
    config = { hub, resolver: makeIdentityImBindingResolver(identity), freeTextCapability: 'chat', onUnbind: async () => ({ removed: false }), log }
  })

  afterEach(async () => {
    await hub.stop()
    identity.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function register(mode: 'tool' | 'empty' | 'duplicate-id', governed = false) {
    const execute = vi.fn(async () => ({ text: 'PROBE_OK' }))
    const create = vi.fn(async function* (body: Record<string, any>) {
      const hasResult = body.messages.some((m: { role: string }) => m.role === 'tool')
      if (mode === 'empty') {
        yield { choices: [{ delta: { content: ' \n ' }, finish_reason: 'stop' }] }
      } else if (hasResult) {
        yield { choices: [{ delta: { content: 'PROBE_OK' }, finish_reason: 'stop' }] }
      } else {
        const toolCalls = [{ index: 0, id: 'call_probe', function: { name: tool.name, arguments: '{"value":7}' } }]
        if (mode === 'duplicate-id') toolCalls.push({ index: 1, id: 'call_probe', function: { name: tool.name, arguments: '{"value":0}' } })
        yield { choices: [{ delta: { tool_calls: toolCalls }, finish_reason: 'tool_calls' }] }
        yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8 } }
      }
    })
    const provider = new OpenAIProvider({ client: { chat: { completions: { create } } } as any })
    const memory = openButlerMemory({ rootDir: tmp, userId, logger: log })
    hub.register(new PersonalButlerAgent({
      id: 'assistant', capabilities: ['chat'], provider, memory, captureTurns: false,
      ...(governed
        ? { governed: new GovernedActionToolset({ tools: [tool], execute,
          classify: (_name, args) => args.value === 0 ? { decision: 'allow' } : { decision: 'approve', reason: 'Synthetic sensitive action.' },
        }) }
        : { benign: { listTools: () => [tool], callTool: async () => ({ content: [{ type: 'text', text: (await execute()).text }] }) } }),
    }))
    return { execute, create }
  }

  it('executes a complete tool call once and delivers its final answer despite a trailing stop marker', async () => {
    const { execute, create } = register('tool')
    await handleImMessage(bridge, msg, config)
    expect(replies).toEqual(['PROBE_OK'])
    expect(create.mock.calls[1]?.[0].messages.find((m: { role: string }) => m.role === 'tool')?.content).toBe('PROBE_OK')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('preserves the approval gate for the same corrected tool response', async () => {
    const { execute, create } = register('tool', true)
    await handleImMessage(bridge, msg, config)
    expect(execute).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    expect(replies[0]).toContain('这件事需要你先确认一下')
  })

  it('does not let a duplicate ID replace an approval verdict with allow', async () => {
    const { execute, create } = register('duplicate-id', true)
    await handleImMessage(bridge, msg, config)
    expect(execute).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    expect(replies[0]).toContain('invalid_tool_call')
  })

  it('delivers and records an honest nonempty fallback without retrying an empty successful answer', async () => {
    const { create } = register('empty')
    const append = vi.fn(async () => {})
    config.sessions = { history: async () => [], append }
    await handleImMessage(bridge, msg, config)
    expect(create).toHaveBeenCalledTimes(1)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toContain('没有生成可发送的回复')
    expect(append).toHaveBeenLastCalledWith(userId, 'assistant', replies[0])
    expect(warn).toHaveBeenCalledWith('im agent returned empty reply', expect.objectContaining({ platform: 'lark' }))
  })
})
