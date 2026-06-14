/**
 * Unit tests for `HubStewardAgent` and its prompt / proposal-extraction pipeline.
 *
 * Exercised with a `MockLlmProvider` — NOT against real Anthropic / OpenAI. The
 * point is to pin three things deterministically:
 *   1. The prompt helpers (`renderStewardUserMessage` / `buildStewardSystemPrompt`)
 *      render the instruction + owned-resource snapshot the way the host feeds them.
 *   2. `parseStewardProposal` is a tight security gate: only well-formed actions
 *      survive, malformed ones are dropped, and the three parse states
 *      (ok / no_json / invalid) are distinguished.
 *   3. Dispatching a `hub:steward` payload through a real Hub returns the right
 *      `HubStewardOutput` shape.
 */

import { describe, expect, it } from 'vitest'
import { Hub } from '@aipehub/core'
import { MockLlmProvider } from '@aipehub/llm'

import {
  buildStewardSystemPrompt,
  HUB_STEWARD_CAPABILITY,
  HUB_STEWARD_DEFAULT_ID,
  HubStewardAgent,
  parseStewardProposal,
  renderStewardUserMessage,
  STEWARD_SYSTEM_PROMPT,
  validateStewardAction,
  type HubStewardOutput,
  type HubStewardPayload,
  type StewardProposal,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// Sample proposal the mock pretends the LLM produced.
// ---------------------------------------------------------------------------

const SAMPLE_PROPOSAL: StewardProposal = {
  reply: '好的，我帮你建一个总结邮件的助手。',
  actions: [
    {
      kind: 'create_agent',
      handle: 'emailer',
      label: '邮件总结助手',
      provider: 'anthropic',
      system: '你负责把邮件总结成要点。',
      capabilities: ['summarize-email'],
    },
  ],
}

const SAMPLE_RESPONSE = `我来帮你建一个助手。\n\n\`\`\`json\n${JSON.stringify(SAMPLE_PROPOSAL, null, 2)}\n\`\`\``

function makeStewardTask(payload: HubStewardPayload) {
  return {
    from: 'admin' as const,
    strategy: { kind: 'capability' as const, capabilities: [HUB_STEWARD_CAPABILITY] },
    payload,
  }
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

describe('buildStewardSystemPrompt', () => {
  it('defaults to the built-in contract prompt', () => {
    const p = buildStewardSystemPrompt()
    expect(p).toBe(STEWARD_SYSTEM_PROMPT)
    // It must carry the two hard rules + the out-of-scope list.
    expect(p).toContain('second human confirmation')
    expect(p).toContain('OUT OF SCOPE')
    expect(p).toContain('delete_agent')
    expect(p).toContain('CROSS-HUB')
  })

  it('honours an override', () => {
    expect(buildStewardSystemPrompt('custom')).toBe('custom')
  })
})

describe('renderStewardUserMessage', () => {
  it('renders the instruction alone when there is no snapshot', () => {
    expect(renderStewardUserMessage({ instruction: '建一个助手' })).toBe('建一个助手')
  })

  it('appends owned agents / workflows / providers after a divider', () => {
    const msg = renderStewardUserMessage({
      instruction: '把工单工作流改礼貌些',
      snapshot: {
        agents: [{ id: 'me.u1.emailer', label: '邮件助手', capabilities: ['summarize'], provider: 'anthropic' }],
        workflows: [
          { id: 'wf-local', name: '本地流' },
          { id: 'wf-cross', name: '跨组织流', crossHub: true },
        ],
        providers: ['anthropic', 'openai'],
      },
    })
    expect(msg).toContain('把工单工作流改礼貌些')
    expect(msg).toContain('---')
    expect(msg).toContain('me.u1.emailer')
    expect(msg).toContain('[summarize]')
    // The cross-hub workflow is flagged so the model phrases the reply right.
    expect(msg).toContain('wf-cross')
    expect(msg).toContain('CROSS-HUB')
    expect(msg).not.toContain('wf-local [CROSS-HUB') // local one is NOT flagged
    expect(msg).toContain('Providers you can use: anthropic, openai')
  })

  it('says "(none yet)" when the member owns no agents', () => {
    const msg = renderStewardUserMessage({ instruction: 'x', snapshot: { agents: [] } })
    expect(msg).toContain('(none yet)')
  })
})

// ---------------------------------------------------------------------------
// parseStewardProposal — the security gate
// ---------------------------------------------------------------------------

describe('parseStewardProposal', () => {
  it('extracts a ```json fenced proposal (status ok)', () => {
    const { proposal, status } = parseStewardProposal(SAMPLE_RESPONSE)
    expect(status).toBe('ok')
    expect(proposal.reply).toBe(SAMPLE_PROPOSAL.reply)
    expect(proposal.actions).toEqual(SAMPLE_PROPOSAL.actions)
  })

  it('parses bare JSON with no fence', () => {
    const { proposal, status } = parseStewardProposal(JSON.stringify(SAMPLE_PROPOSAL))
    expect(status).toBe('ok')
    expect(proposal.actions).toHaveLength(1)
  })

  it('parses JSON embedded in surrounding prose (brace span)', () => {
    const raw = `Sure — here you go: ${JSON.stringify(SAMPLE_PROPOSAL)} hope that helps!`
    const { proposal, status } = parseStewardProposal(raw)
    expect(status).toBe('ok')
    expect(proposal.actions).toHaveLength(1)
  })

  it('treats pure prose (no brace) as a plain reply (no_json)', () => {
    const { proposal, status } = parseStewardProposal('你好，请问你想做什么？')
    expect(status).toBe('no_json')
    expect(proposal.reply).toBe('你好，请问你想做什么？')
    expect(proposal.actions).toEqual([])
  })

  it('flags brace-bearing but unparseable text as invalid', () => {
    const { proposal, status } = parseStewardProposal('{ this is not: valid json ')
    expect(status).toBe('invalid')
    expect(proposal.actions).toEqual([])
  })

  it('DROPS a malformed action but keeps the well-formed ones (status stays ok)', () => {
    const raw = JSON.stringify({
      reply: 'mixed bag',
      actions: [
        { kind: 'create_agent', handle: 'good', label: 'Good', provider: 'openai', system: 'do good', capabilities: ['x'] },
        { kind: 'create_agent', handle: 'bad', label: 'Bad', provider: 'anthropic' }, // missing system + capabilities
        { kind: 'totally_unknown', foo: 1 }, // unknown kind
        { kind: 'delete_agent' }, // missing agentId
      ],
    })
    const { proposal, status } = parseStewardProposal(raw)
    expect(status).toBe('ok')
    expect(proposal.actions).toHaveLength(1)
    expect(proposal.actions[0]).toMatchObject({ kind: 'create_agent', handle: 'good' })
  })

  it('falls back to raw text as the reply when the object has no string reply', () => {
    const { proposal } = parseStewardProposal(JSON.stringify({ actions: [] }))
    // No `reply` field → the raw JSON text rides as the reply (better than empty).
    expect(proposal.reply.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// validateStewardAction — per-kind shape gate
// ---------------------------------------------------------------------------

describe('validateStewardAction', () => {
  it('accepts a well-formed action of each kind', () => {
    expect(validateStewardAction({ kind: 'inspect', answer: 'you own 2' })).toEqual({
      kind: 'inspect',
      answer: 'you own 2',
    })
    expect(
      validateStewardAction({ kind: 'delete_agent', agentId: 'me.u1.x' }),
    ).toEqual({ kind: 'delete_agent', agentId: 'me.u1.x' })
    expect(
      validateStewardAction({ kind: 'edit_workflow', workflowId: 'wf', instruction: 'be nicer' }),
    ).toEqual({ kind: 'edit_workflow', workflowId: 'wf', instruction: 'be nicer' })
    expect(validateStewardAction({ kind: 'refuse', reason: 'out of scope' })).toEqual({
      kind: 'refuse',
      reason: 'out of scope',
    })
  })

  it('accepts edit_agent with a non-empty changes subset, dropping a non-editable handle', () => {
    const v = validateStewardAction({
      kind: 'edit_agent',
      agentId: 'me.u1.x',
      changes: { label: 'New label', handle: 'ignored', capabilities: ['a'] },
    })
    expect(v).toEqual({
      kind: 'edit_agent',
      agentId: 'me.u1.x',
      changes: { label: 'New label', capabilities: ['a'] },
    })
  })

  it('rejects malformed actions', () => {
    expect(validateStewardAction(null)).toBeNull()
    expect(validateStewardAction({ kind: 'inspect' })).toBeNull() // no answer
    expect(validateStewardAction({ kind: 'edit_agent', agentId: 'x', changes: {} })).toBeNull() // empty changes
    expect(validateStewardAction({ kind: 'edit_agent', agentId: 'x', changes: { handle: 'only-handle' } })).toBeNull() // handle-only = no real change
    expect(validateStewardAction({ kind: 'create_agent', handle: 'h', label: 'l', provider: 'gemini', system: 's', capabilities: ['c'] })).toBeNull() // bad provider
    expect(validateStewardAction({ kind: 'create_agent', handle: 'h', label: 'l', provider: 'openai', system: 's', capabilities: [] })).toBeNull() // empty caps
    expect(validateStewardAction({ kind: 'edit_workflow', workflowId: 'wf' })).toBeNull() // no instruction
    expect(validateStewardAction({ kind: 'whatever' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// round-trip: a proposal → JSON → parse must come back equal
// ---------------------------------------------------------------------------

describe('round-trip', () => {
  it('JSON.stringify(proposal) parses back to the same actions', () => {
    const original: StewardProposal = {
      reply: 'doing four things',
      actions: [
        { kind: 'inspect', answer: 'a' },
        { kind: 'create_agent', handle: 'h', label: 'L', provider: 'openai', model: 'gpt-x', system: 's', capabilities: ['c1', 'c2'] },
        { kind: 'edit_agent', agentId: 'me.u1.h', changes: { system: 'new' } },
        { kind: 'edit_workflow', workflowId: 'wf', instruction: 'tweak' },
      ],
    }
    const { proposal, status } = parseStewardProposal('```json\n' + JSON.stringify(original) + '\n```')
    expect(status).toBe('ok')
    expect(proposal).toEqual(original)
  })
})

// ---------------------------------------------------------------------------
// Agent defaults + dispatch through a real Hub
// ---------------------------------------------------------------------------

describe('HubStewardAgent — defaults', () => {
  it('default id and capability', () => {
    const a = new HubStewardAgent({ provider: new MockLlmProvider({ reply: '' }) })
    expect(a.id).toBe(HUB_STEWARD_DEFAULT_ID)
    expect(a.capabilities).toEqual([HUB_STEWARD_CAPABILITY])
  })

  it('custom id / capabilities still work', () => {
    const a = new HubStewardAgent({
      provider: new MockLlmProvider({ reply: '' }),
      id: 'my-steward',
      capabilities: ['custom:steward'],
    })
    expect(a.id).toBe('my-steward')
    expect(a.capabilities).toEqual(['custom:steward'])
  })
})

describe('HubStewardAgent — dispatch', () => {
  it('feeds the instruction + snapshot to the provider and returns a HubStewardOutput', async () => {
    let captured: { system?: string; userMsg: string } = { userMsg: '' }
    const provider = new MockLlmProvider({
      reply: (req) => {
        captured = {
          system: req.system,
          userMsg: typeof req.messages.at(-1)?.content === 'string' ? (req.messages.at(-1)!.content as string) : '',
        }
        return SAMPLE_RESPONSE
      },
    })

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new HubStewardAgent({ provider }))

    const result = await hub.dispatch(
      makeStewardTask({
        instruction: '给我建一个总结邮件的助手',
        snapshot: { agents: [], providers: ['anthropic', 'openai'] },
      }),
    )
    await hub.stop()

    expect(result.kind).toBe('ok')
    // The system prompt carries the contract.
    expect(captured.system).toContain('hub steward')
    expect(captured.system).toContain('OUT OF SCOPE')
    // The user message carries the instruction + snapshot.
    expect(captured.userMsg).toContain('给我建一个总结邮件的助手')
    expect(captured.userMsg).toContain('Providers you can use: anthropic, openai')

    const out = result.output as HubStewardOutput
    expect(out.parseStatus).toBe('ok')
    expect(out.reply).toBe(SAMPLE_PROPOSAL.reply)
    expect(out.text).toBe(SAMPLE_PROPOSAL.reply) // LlmTaskOutput.text == reply
    expect(out.actions).toEqual(SAMPLE_PROPOSAL.actions)
    expect(out.by).toBe('mock')
    expect(out.raw).toBe(SAMPLE_RESPONSE)
  })

  it('prior history turns are sent before the current instruction', async () => {
    let roles: string[] = []
    const provider = new MockLlmProvider({
      reply: (req) => {
        roles = req.messages.map((m) => m.role)
        return SAMPLE_RESPONSE
      },
    })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new HubStewardAgent({ provider }))
    await hub.dispatch(
      makeStewardTask({
        instruction: '再礼貌一点',
        history: [
          { role: 'user', content: '建一个助手' },
          { role: 'assistant', content: '好的，已提议。' },
        ],
      }),
    )
    await hub.stop()
    expect(roles).toEqual(['user', 'assistant', 'user'])
  })

  it('a no-JSON reply comes back as no_json with empty actions (ok result)', async () => {
    const provider = new MockLlmProvider({ reply: '你想给这个助手起什么名字？' })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new HubStewardAgent({ provider }))
    const result = await hub.dispatch(makeStewardTask({ instruction: '建个助手' }))
    await hub.stop()
    expect(result.kind).toBe('ok')
    const out = result.output as HubStewardOutput
    expect(out.parseStatus).toBe('no_json')
    expect(out.actions).toEqual([])
    expect(out.reply).toBe('你想给这个助手起什么名字？')
  })

  it('rejects a payload with no / empty instruction', async () => {
    const provider = new MockLlmProvider({ reply: SAMPLE_RESPONSE })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new HubStewardAgent({ provider }))

    const missing = await hub.dispatch(makeStewardTask({} as HubStewardPayload))
    expect(missing.kind).toBe('failed')

    const empty = await hub.dispatch(makeStewardTask({ instruction: '   ' }))
    expect(empty.kind).toBe('failed')

    await hub.stop()
  })
})
