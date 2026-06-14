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
  buildOperatorStewardSystemPrompt,
  buildStewardSystemPrompt,
  HUB_STEWARD_CAPABILITY,
  HUB_STEWARD_DEFAULT_ID,
  HubStewardAgent,
  OPERATOR_STEWARD_SYSTEM_PROMPT,
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

// ---------------------------------------------------------------------------
// Operator console prompt variant (SW-M9 A-M5). Same output contract + hard
// rules as the member prompt (so the ONE parser handles both), but framed
// site-wide with a VERBATIM create_agent handle. The two properties that must
// hold: the operator prompt still honours the ```json fence contract, and the
// MEMBER prompt is untouched.
// ---------------------------------------------------------------------------

describe('buildOperatorStewardSystemPrompt (A-M5)', () => {
  it('returns the operator prompt and keeps the SAME hard rules as the member prompt', () => {
    const p = buildOperatorStewardSystemPrompt()
    expect(p).toBe(OPERATOR_STEWARD_SYSTEM_PROMPT)
    // The dangerous/cross-hub second-confirmation contract is identical — the
    // host re-classifies both prompts' output through the same gate.
    expect(p).toContain('second human confirmation')
    expect(p).toContain('OUT OF SCOPE')
    expect(p).toContain('delete_agent')
    expect(p).toContain('CROSS-HUB')
  })

  it('still honours the ```json fence OUTPUT CONTRACT (one parser for both prompts)', () => {
    // The operator prompt documents the exact same single-fence shape, so a
    // reply produced under it parses through the shared security gate. The
    // create_agent handle here is a VERBATIM site-wide id ("support-bot"), which
    // the validator accepts as a plain string — the operator's documented shape.
    const p = buildOperatorStewardSystemPrompt()
    expect(p).toContain('```json')
    expect(p).toContain('exactly one')

    const proposal: StewardProposal = {
      reply: '我来为这个 hub 建一个客服助手。',
      actions: [
        {
          kind: 'create_agent',
          handle: 'support-bot', // a full site-wide id, used verbatim — not me.<user>.<slug>
          label: '客服助手',
          provider: 'anthropic',
          system: '你负责回答客服问题。',
          capabilities: ['support'],
        },
      ],
    }
    const { proposal: got, status } = parseStewardProposal(
      '```json\n' + JSON.stringify(proposal) + '\n```',
    )
    expect(status).toBe('ok')
    expect(got).toEqual(proposal)
  })

  it('diverges from the member prompt in the site-wide / verbatim-handle framing', () => {
    // Operator-only framing.
    expect(OPERATOR_STEWARD_SYSTEM_PROMPT).not.toBe(STEWARD_SYSTEM_PROMPT)
    expect(OPERATOR_STEWARD_SYSTEM_PROMPT).toContain('OPERATOR console')
    expect(OPERATOR_STEWARD_SYSTEM_PROMPT).toContain("WHOLE HUB'S resources")
    expect(OPERATOR_STEWARD_SYSTEM_PROMPT).toContain('VERBATIM')
    // The member prompt must NOT have leaked operator framing.
    expect(STEWARD_SYSTEM_PROMPT).not.toContain('OPERATOR console')
    expect(STEWARD_SYSTEM_PROMPT).not.toContain('VERBATIM')
  })

  it('leaves the MEMBER prompt unchanged (THEIR OWN resources, host-namespaced handle)', () => {
    // Regression guard: A-M5 only ADDS the operator variant. The member prompt
    // still frames per-member ownership and the host-namespaced handle.
    expect(buildStewardSystemPrompt()).toBe(STEWARD_SYSTEM_PROMPT)
    expect(STEWARD_SYSTEM_PROMPT).toContain('THEIR OWN resources')
    expect(STEWARD_SYSTEM_PROMPT).toContain('short slug')
    expect(STEWARD_SYSTEM_PROMPT).toContain('turns it into the real id')
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
// validateStewardAction — Phase B sensitive writes (B-M1)
//   The security invariant: a sensitive action NEVER carries a plaintext secret.
//   It only ever names an env var. Any key-shaped field drops the WHOLE action.
// ---------------------------------------------------------------------------

describe('validateStewardAction — sensitive writes (B-M1)', () => {
  it('accepts a well-formed set_credential_ref (env-var name only, optional label)', () => {
    expect(
      validateStewardAction({ kind: 'set_credential_ref', provider: 'openai', envVarName: 'OPENAI_KEY' }),
    ).toEqual({ kind: 'set_credential_ref', provider: 'openai', envVarName: 'OPENAI_KEY' })
    expect(
      validateStewardAction({
        kind: 'set_credential_ref',
        provider: 'anthropic',
        envVarName: 'ANTHROPIC_KEY',
        label: 'main key',
      }),
    ).toEqual({
      kind: 'set_credential_ref',
      provider: 'anthropic',
      envVarName: 'ANTHROPIC_KEY',
      label: 'main key',
    })
  })

  it('accepts revoke_credential / set_security_quota', () => {
    expect(validateStewardAction({ kind: 'revoke_credential', credentialId: 'cred_1' })).toEqual({
      kind: 'revoke_credential',
      credentialId: 'cred_1',
    })
    expect(
      validateStewardAction({
        kind: 'set_security_quota',
        scope: 'u1',
        metric: 'llm_tokens',
        period: 'day',
        limit: 100000,
      }),
    ).toEqual({ kind: 'set_security_quota', scope: 'u1', metric: 'llm_tokens', period: 'day', limit: 100000 })
  })

  it('accepts set_peer_policy with any subset of policy fields', () => {
    expect(
      validateStewardAction({ kind: 'set_peer_policy', peerId: 'orgX', allowedDataClasses: ['public'] }),
    ).toEqual({ kind: 'set_peer_policy', peerId: 'orgX', allowedDataClasses: ['public'] })
    expect(
      validateStewardAction({
        kind: 'set_peer_policy',
        peerId: 'orgX',
        perLinkQuotaBudget: 500,
        shareSummary: true,
      }),
    ).toEqual({ kind: 'set_peer_policy', peerId: 'orgX', perLinkQuotaBudget: 500, shareSummary: true })
  })

  it('★ DROPS any sensitive action carrying a key-shaped field (no plaintext secret survives)', () => {
    // The whole action is rejected — we never strip-and-execute a half-trusted one.
    for (const leak of [
      { secret: 'sk-xxx' },
      { apiKey: 'sk-xxx' },
      { api_key: 'sk-xxx' },
      { API_KEY: 'sk-xxx' },
      { token: 'sk-xxx' },
      { key: 'sk-xxx' },
      { bearer: 'sk-xxx' },
      { password: 'hunter2' },
      { clientSecret: 'sk-xxx' },
    ]) {
      expect(
        validateStewardAction({ kind: 'set_credential_ref', provider: 'openai', envVarName: 'X', ...leak }),
      ).toBeNull()
    }
    // …and on the other sensitive kinds too.
    expect(
      validateStewardAction({ kind: 'revoke_credential', credentialId: 'c1', token: 'sk-xxx' }),
    ).toBeNull()
    expect(
      validateStewardAction({ kind: 'set_peer_policy', peerId: 'orgX', shareSummary: true, secret: 's' }),
    ).toBeNull()
    expect(
      validateStewardAction({ kind: 'set_security_quota', scope: 'u1', metric: 'm', period: 'day', limit: 1, apiKey: 'k' }),
    ).toBeNull()
  })

  it('does NOT false-positive legit fields (credentialId / envVarName / perLinkQuotaBudget)', () => {
    // `credentialId` must not be flagged for containing "credential"; the guard
    // matches EXACT normalized names, not substrings.
    expect(validateStewardAction({ kind: 'revoke_credential', credentialId: 'cred_1' })).not.toBeNull()
    expect(
      validateStewardAction({ kind: 'set_credential_ref', provider: 'openai', envVarName: 'OPENAI_KEY' }),
    ).not.toBeNull()
    expect(
      validateStewardAction({ kind: 'set_peer_policy', peerId: 'orgX', perLinkQuotaBudget: 10 }),
    ).not.toBeNull()
  })

  it('rejects malformed sensitive actions', () => {
    expect(validateStewardAction({ kind: 'set_credential_ref', provider: 'openai' })).toBeNull() // no envVarName
    expect(validateStewardAction({ kind: 'set_credential_ref', envVarName: 'X' })).toBeNull() // no provider
    expect(validateStewardAction({ kind: 'revoke_credential' })).toBeNull() // no id
    expect(validateStewardAction({ kind: 'set_peer_policy', peerId: 'orgX' })).toBeNull() // no policy field = no-op
    expect(
      validateStewardAction({ kind: 'set_peer_policy', peerId: 'orgX', perLinkQuotaBudget: -1 }),
    ).toBeNull() // negative budget
    expect(
      validateStewardAction({ kind: 'set_peer_policy', peerId: 'orgX', allowedDataClasses: 'public' }),
    ).toBeNull() // not an array
    expect(
      validateStewardAction({ kind: 'set_security_quota', scope: 'u1', metric: 'm', period: 'day' }),
    ).toBeNull() // no limit
    expect(
      validateStewardAction({ kind: 'set_security_quota', scope: 'u1', metric: 'm', period: 'day', limit: 'lots' }),
    ).toBeNull() // limit not a number
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
