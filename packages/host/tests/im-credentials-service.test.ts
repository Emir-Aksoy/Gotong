/**
 * HANDS-M3a — `ImCredentialsService` coverage.
 *
 * The load-bearing test in this file is not any single behaviour; it is
 * `expectNoSecret`, applied to every outcome, every log call and every audit
 * row on every path. The one promise this face makes is "the key reaches the
 * store and nothing else", and a promise that isn't asserted on the failure
 * paths isn't a promise — the failure paths are exactly where a future
 * "helpful" error message would echo what the member typed.
 *
 * Everything else here is about refusing to write a key that could not take
 * effect (an env-pinned agent, a mock provider, the `openai-compatible`
 * umbrella) and about reporting the respawn honestly.
 */

import { describe, expect, it } from 'vitest'

import type { AgentRecord } from '@gotong/core'

import {
  IM_KEY_PRIORITY,
  IM_SHARED_KEY_PROVIDERS,
  ImCredentialsService,
  buildAgentRestarter,
  type ImCredentialsIdentity,
  type ImCredentialsSpace,
} from '../src/im-credentials-service.js'
import { selectLlmApiKey } from '../src/local-agent-pool.js'

/** The value that must never turn up anywhere but `setAgentApiKey` / the vault. */
const SECRET = 'sk-ant-test-0123456789abcdef'

function agent(
  id: string,
  provider: AgentRecord['managed'] extends infer M ? string : string,
  over: Record<string, unknown> = {},
): AgentRecord {
  return {
    id,
    allowedCapabilities: ['chat'],
    createdAt: '2026-01-01T00:00:00.000Z',
    managed: { kind: 'llm', provider, model: 'm', ...over },
  } as unknown as AgentRecord
}

interface Harness {
  svc: ImCredentialsService
  setKeyCalls: Array<{ agentId: string; plaintext: string }>
  vaultCreated: Array<Record<string, unknown>>
  revoked: string[]
  audits: Array<Record<string, unknown>>
  logs: Array<{ msg: string; meta?: Record<string, unknown> }>
  restartCalls: string[][]
}

function harness(opts: {
  agents?: AgentRecord[]
  perAgentKeys?: Record<string, string>
  workspaceKeys?: Record<string, string>
  vaultRows?: Array<{ id: string; metadata: Record<string, unknown> | null }>
  allowed?: boolean
  restart?: (ids: string[]) => Promise<{ restarted: string[]; failed: string[] }>
  noRestartLeg?: boolean
} = {}): Harness {
  const setKeyCalls: Harness['setKeyCalls'] = []
  const vaultCreated: Harness['vaultCreated'] = []
  const revoked: string[] = []
  const audits: Harness['audits'] = []
  const logs: Harness['logs'] = []
  const restartCalls: string[][] = []

  const space: ImCredentialsSpace = {
    agents: async () => opts.agents ?? [],
    listAgentApiKeys: async () => opts.perAgentKeys ?? {},
    listProviderApiKeys: async () => opts.workspaceKeys ?? {},
    setAgentApiKey: async (agentId, plaintext) => {
      setKeyCalls.push({ agentId, plaintext })
    },
  }
  const identity: ImCredentialsIdentity = {
    createVaultEntry: (input) => {
      vaultCreated.push({ ...input })
      return { id: 'v-new' } as never
    },
    listVaultEntries: () => (opts.vaultRows ?? []) as never,
    revokeVaultEntry: (id) => {
      revoked.push(id)
      return true
    },
    writeAuditLog: (input) => {
      audits.push({ ...input })
      return undefined
    },
  }
  const svc = new ImCredentialsService({
    allowed: () => opts.allowed ?? true,
    space,
    identity,
    ...(opts.noRestartLeg
      ? {}
      : {
          restartAgents: async (ids) => {
            restartCalls.push([...ids])
            return opts.restart
              ? await opts.restart(ids)
              : { restarted: [...ids], failed: [] }
          },
        }),
    log: { info: (msg, meta) => logs.push({ msg, ...(meta ? { meta } : {}) }) },
  })
  return { svc, setKeyCalls, vaultCreated, revoked, audits, logs, restartCalls }
}

/**
 * The whole point of the milestone in one assertion. Applied to outcomes, logs
 * and audit rows — anything the secret could ride out on.
 */
function expectNoSecret(h: Harness, ...alsoCheck: unknown[]): void {
  const haystack = JSON.stringify({
    logs: h.logs,
    audits: h.audits,
    // The vault/store calls are the ONE legitimate destination, so they are
    // deliberately excluded here and asserted positively where relevant.
    also: alsoCheck,
  })
  expect(haystack).not.toContain(SECRET)
  // Not even a prefix: a truncated key is still key material.
  expect(haystack).not.toContain(SECRET.slice(0, 12))
}

describe('ImCredentialsService — the secret goes exactly one place', () => {
  it('per-agent write: reaches setAgentApiKey verbatim and nothing else', async () => {
    const h = harness({ agents: [agent('assistant', 'openai-compatible')] })
    const out = await h.svc.setKey({
      userId: 'u1',
      target: 'assistant',
      secret: SECRET,
      via: 'im:lark',
    })

    expect(out).toMatchObject({ ok: true, slot: 'agent', agentId: 'assistant' })
    expect(h.setKeyCalls).toEqual([{ agentId: 'assistant', plaintext: SECRET }])
    expect(h.vaultCreated).toHaveLength(0)
    expectNoSecret(h, out)
  })

  it('shared write: lands as an org vault row tagged with the provider', async () => {
    const h = harness({ agents: [agent('a', 'anthropic')] })
    const out = await h.svc.setKey({
      userId: 'u1',
      target: 'anthropic',
      secret: SECRET,
      via: 'im:lark',
    })

    expect(out).toMatchObject({ ok: true, slot: 'shared', provider: 'anthropic' })
    expect(h.vaultCreated).toHaveLength(1)
    expect(h.vaultCreated[0]).toMatchObject({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: null,
      secret: SECRET,
      metadata: { provider: 'anthropic', registeredBy: 'im-setkey' },
    })
    expect(h.setKeyCalls).toHaveLength(0)
    expectNoSecret(h, out)
  })

  // Every refusal is driven with a secret that CONTAINS the sentinel — including
  // the malformed-secret row, which is the path most likely to sprout a helpful
  // "you typed …" echo one day. A table that fed the malformed row some short
  // throwaway string would let exactly that regression through.
  it.each([
    ['unknown target', 'nope', SECRET],
    ['env-pinned agent', 'pinned', SECRET],
    ['mock agent', 'mocky', SECRET],
    ['openai-compatible as a shared tag', 'openai-compatible', SECRET],
    // Sentinel + a newline: fails the character check while still being the
    // exact material an echo would leak.
    ['malformed secret', 'assistant', `${SECRET}${String.fromCharCode(10)}x`],
  ])('refusal path leaks nothing: %s', async (_label, target, secret) => {
    const h = harness({
      agents: [
        agent('assistant', 'openai-compatible'),
        agent('pinned', 'anthropic', { apiKeyEnv: 'PINNED_KEY' }),
        agent('mocky', 'mock'),
      ],
    })
    const out = await h.svc.setKey({ userId: 'u1', target, secret, via: 'im:lark' })

    expect(out.ok).toBe(false)
    // A refusal must not write — half a write here is a stored key nobody
    // knows about.
    expect(h.setKeyCalls).toHaveLength(0)
    expect(h.vaultCreated).toHaveLength(0)
    expect(h.audits).toHaveLength(0)
    expectNoSecret(h, out)
  })
})

describe('ImCredentialsService — refusing writes that could not take effect', () => {
  it('an env-pinned agent is refused, naming the variable that actually wins', async () => {
    const h = harness({ agents: [agent('a', 'anthropic', { apiKeyEnv: 'MIMO_API_KEY' })] })
    const out = await h.svc.setKey({ userId: 'u1', target: 'a', secret: SECRET, via: 'im' })
    expect(out).toEqual({ ok: false, code: 'env_pinned', agentId: 'a', envName: 'MIMO_API_KEY' })
  })

  it('a mock agent is refused (no provider, no key)', async () => {
    const h = harness({ agents: [agent('m', 'mock')] })
    const out = await h.svc.setKey({ userId: 'u1', target: 'm', secret: SECRET, via: 'im' })
    expect(out).toEqual({ ok: false, code: 'mock_agent', agentId: 'm' })
  })

  it('`openai-compatible` is refused as a SHARED tag and points at the per-agent form', async () => {
    // One shared row under this umbrella would hand a DeepSeek key to a MiMo
    // endpoint; the per-agent form is the unambiguous one, so the refusal
    // must carry the agents it applies to.
    const h = harness({
      agents: [agent('deepseek-bot', 'openai-compatible'), agent('mimo-bot', 'openai-compatible')],
    })
    const out = await h.svc.setKey({
      userId: 'u1',
      target: 'openai-compatible',
      secret: SECRET,
      via: 'im',
    })
    expect(out).toEqual({
      ok: false,
      code: 'vendor_ambiguous',
      agents: ['deepseek-bot', 'mimo-bot'],
    })
    expect(IM_SHARED_KEY_PROVIDERS).not.toContain('openai-compatible')
  })

  it('the per-agent form still works for an openai-compatible agent', async () => {
    const h = harness({ agents: [agent('mimo-bot', 'openai-compatible')] })
    const out = await h.svc.setKey({ userId: 'u1', target: 'mimo-bot', secret: SECRET, via: 'im' })
    expect(out).toMatchObject({ ok: true, slot: 'agent', agentId: 'mimo-bot' })
  })

  it.each([
    ['too_short', 'sk-abc'],
    ['too_long', 'k'.repeat(5000)],
    ['bad_chars', `sk-abc${String.fromCharCode(10)}def-more`],
  ])('rejects a %s secret before touching anything', async (reason, secret) => {
    const h = harness({ agents: [agent('a', 'anthropic')] })
    const out = await h.svc.setKey({ userId: 'u1', target: 'a', secret, via: 'im' })
    expect(out).toEqual({ ok: false, code: 'bad_secret', reason })
    expect(h.setKeyCalls).toHaveLength(0)
  })
})

describe('ImCredentialsService — target resolution', () => {
  it('an unknown target lists what IS available, so the member can retry', async () => {
    const h = harness({ agents: [agent('b', 'anthropic'), agent('a', 'openai')] })
    const out = await h.svc.setKey({ userId: 'u1', target: 'ghost', secret: SECRET, via: 'im' })
    expect(out).toEqual({
      ok: false,
      code: 'unknown_target',
      agents: ['a', 'b'],
      providers: ['anthropic', 'openai'],
    })
  })

  it('a name that is BOTH an agent and a provider refuses rather than guessing', async () => {
    // Guessing here would silently write to the wrong slot; the member is one
    // prefix away from being unambiguous.
    const h = harness({ agents: [agent('anthropic', 'anthropic')] })
    const out = await h.svc.setKey({ userId: 'u1', target: 'anthropic', secret: SECRET, via: 'im' })
    expect(out).toEqual({ ok: false, code: 'ambiguous_target', target: 'anthropic' })
    expect(h.setKeyCalls).toHaveLength(0)
    expect(h.vaultCreated).toHaveLength(0)
  })

  it('`agent:` / `provider:` prefixes disambiguate in both directions', async () => {
    const h1 = harness({ agents: [agent('anthropic', 'anthropic')] })
    expect(
      await h1.svc.setKey({ userId: 'u', target: 'agent:anthropic', secret: SECRET, via: 'im' }),
    ).toMatchObject({ ok: true, slot: 'agent', agentId: 'anthropic' })
    expect(h1.setKeyCalls).toHaveLength(1)

    const h2 = harness({ agents: [agent('anthropic', 'anthropic')] })
    expect(
      await h2.svc.setKey({ userId: 'u', target: 'provider:anthropic', secret: SECRET, via: 'im' }),
    ).toMatchObject({ ok: true, slot: 'shared', provider: 'anthropic' })
    expect(h2.vaultCreated).toHaveLength(1)
  })
})

describe('ImCredentialsService — the shared row', () => {
  it('revokes prior active rows carrying the same tag, and leaves other tags alone', async () => {
    const h = harness({
      agents: [agent('a', 'anthropic')],
      vaultRows: [
        { id: 'old-anthropic', metadata: { provider: 'anthropic' } },
        { id: 'openai-row', metadata: { provider: 'openai' } },
        { id: 'untagged', metadata: null },
      ],
    })
    await h.svc.setKey({ userId: 'u1', target: 'anthropic', secret: SECRET, via: 'im' })
    expect(h.revoked).toEqual(['old-anthropic'])
  })

  it('names the agents that will NOT pick it up, and does not restart them', async () => {
    // Restarting a shadowed agent would interrupt a working one to change
    // nothing — and the member deserves to know the key they just pasted is
    // not what those agents use.
    const h = harness({
      agents: [
        agent('plain', 'anthropic'),
        agent('own-key', 'anthropic'),
        agent('pinned', 'anthropic', { apiKeyEnv: 'X_KEY' }),
        agent('elsewhere', 'openai'),
      ],
      perAgentKeys: { 'own-key': '2026-01-01T00:00:00.000Z' },
    })
    const out = await h.svc.setKey({ userId: 'u1', target: 'anthropic', secret: SECRET, via: 'im' })

    expect(out).toMatchObject({ ok: true, slot: 'shared' })
    if (!out.ok || out.slot !== 'shared') throw new Error('unreachable')
    expect(out.shadowed).toEqual([
      { agentId: 'own-key', reason: 'per-agent' },
      { agentId: 'pinned', reason: 'env-pinned' },
    ])
    expect(h.restartCalls).toEqual([['plain']])
  })
})

describe('ImCredentialsService — the respawn is reported, not assumed', () => {
  it('a per-agent write respawns exactly that agent', async () => {
    const h = harness({ agents: [agent('a', 'anthropic'), agent('b', 'anthropic')] })
    const out = await h.svc.setKey({ userId: 'u', target: 'a', secret: SECRET, via: 'im' })
    expect(h.restartCalls).toEqual([['a']])
    expect(out).toMatchObject({ restart: { restarted: ['a'], failed: [] } })
  })

  it('no lifecycle wired → says so instead of implying the key is live', async () => {
    const h = harness({ agents: [agent('a', 'anthropic')], noRestartLeg: true })
    const out = await h.svc.setKey({ userId: 'u', target: 'a', secret: SECRET, via: 'im' })
    expect(out).toMatchObject({ ok: true, restart: { unavailable: true, restarted: [] } })
  })

  it('a failed respawn is reported, not swallowed into a clean success', async () => {
    const h = harness({
      agents: [agent('a', 'anthropic')],
      restart: async () => {
        throw new Error('spawn exploded')
      },
    })
    const out = await h.svc.setKey({ userId: 'u', target: 'a', secret: SECRET, via: 'im' })
    // The key IS written — telling the member it failed would send them to
    // paste the secret a second time.
    expect(h.setKeyCalls).toHaveLength(1)
    expect(out).toMatchObject({ ok: true, restart: { restarted: [], failed: ['a'] } })
  })

  it('buildAgentRestarter reports per-agent outcomes, one bad apple at a time', async () => {
    const restart = buildAgentRestarter(
      { agents: async () => [agent('good', 'anthropic'), agent('bad', 'anthropic')] },
      {
        start: async (rec) => {
          if (rec.id === 'bad') throw new Error('nope')
        },
      },
    )
    expect(await restart(['good', 'bad', 'missing'])).toEqual({
      restarted: ['good'],
      failed: ['bad', 'missing'],
    })
  })
})

describe('ImCredentialsService — audit + gate', () => {
  it('writes a VAULT_CREATE row attributing the change to IM, with no secret in it', async () => {
    const h = harness({ agents: [agent('a', 'anthropic')] })
    await h.svc.setKey({ userId: 'alice', target: 'a', secret: SECRET, via: 'im:lark' })
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0]).toMatchObject({
      action: 'vault_create',
      actorSource: 'im',
      actorUserId: 'alice',
      metadata: { slot: 'agent', agentId: 'a', via: 'im:lark' },
    })
    expectNoSecret(h)
  })

  it('an audit sink that throws does not cost the member the write', async () => {
    const h = harness({ agents: [agent('a', 'anthropic')] })
    // Re-wrap with a hostile audit sink.
    const svc = new ImCredentialsService({
      allowed: () => true,
      space: {
        agents: async () => [agent('a', 'anthropic')],
        listAgentApiKeys: async () => ({}),
        listProviderApiKeys: async () => ({}),
        setAgentApiKey: async () => {
          h.setKeyCalls.push({ agentId: 'a', plaintext: SECRET })
        },
      },
      identity: {
        createVaultEntry: () => ({ id: 'x' }) as never,
        listVaultEntries: () => [],
        writeAuditLog: () => {
          throw new Error('audit down')
        },
      },
      log: { info: () => {} },
    })
    const out = await svc.setKey({ userId: 'u', target: 'a', secret: SECRET, via: 'im' })
    expect(out.ok).toBe(true)
    expect(h.setKeyCalls).toHaveLength(1)
  })

  it('`allowed` is whatever the assembly layer supplied — the service never re-derives a role', async () => {
    const h = harness({ allowed: false })
    expect(await h.svc.allowed('anyone')).toBe(false)
    const yes = harness({ allowed: true })
    expect(await yes.svc.allowed('anyone')).toBe(true)
  })
})

describe('ImCredentialsService — /keys shows slots, never values', () => {
  it('renders env pins (with and without a value), per-agent keys, and empties', async () => {
    process.env.SLOT_TEST_PRESENT = 'yes'
    delete process.env.SLOT_TEST_ABSENT
    try {
      const h = harness({
        agents: [
          agent('pinned-ok', 'anthropic', { apiKeyEnv: 'SLOT_TEST_PRESENT' }),
          agent('pinned-empty', 'anthropic', { apiKeyEnv: 'SLOT_TEST_ABSENT' }),
          agent('has-own', 'openai'),
          agent('bare', 'openai'),
        ],
        perAgentKeys: { 'has-own': '2026-02-03T04:05:06.000Z' },
      })
      const view = await h.svc.list()
      expect(view.agents).toEqual([
        {
          agentId: 'pinned-ok',
          provider: 'anthropic',
          envName: 'SLOT_TEST_PRESENT',
          envPresent: true,
        },
        {
          agentId: 'pinned-empty',
          provider: 'anthropic',
          envName: 'SLOT_TEST_ABSENT',
          envPresent: false,
        },
        {
          agentId: 'has-own',
          provider: 'openai',
          perAgentUpdatedAt: '2026-02-03T04:05:06.000Z',
        },
        { agentId: 'bare', provider: 'openai' },
      ])
      // Presence, never material: the view carries timestamps and booleans.
      expect(JSON.stringify(view)).not.toContain('sk-')
    } finally {
      delete process.env.SLOT_TEST_PRESENT
    }
  })

  it('reports workspace + host-env ONLY where those tiers are consulted', async () => {
    // `resolveApiKey` passes null for both when the provider is
    // openai-compatible, so a workspace row under that tag can never be
    // reached — printing it would advertise a key that does nothing.
    const h = harness({
      agents: [agent('x', 'openai-compatible')],
      workspaceKeys: {
        anthropic: '2026-01-01T00:00:00.000Z',
        'openai-compatible': '2026-01-01T00:00:00.000Z',
      },
    })
    const view = await h.svc.list()
    expect(Object.keys(view.workspace).sort()).toEqual(['anthropic', 'openai'])
    expect(Object.keys(view.hostEnv).sort()).toEqual(['anthropic', 'openai'])
    expect(view.workspace.anthropic).toBe(true)
    // The umbrella tag still shows in `shared`, where an org row IS consulted.
    expect(Object.keys(view.shared)).toContain('openai-compatible')
  })

  it('an unreadable vault means "we cannot say a shared row exists", not a crash', async () => {
    const svc = new ImCredentialsService({
      allowed: () => true,
      space: {
        agents: async () => [agent('a', 'anthropic')],
        listAgentApiKeys: async () => ({}),
        listProviderApiKeys: async () => ({}),
        setAgentApiKey: async () => {},
      },
      identity: {
        createVaultEntry: () => ({ id: 'x' }) as never,
        listVaultEntries: () => {
          throw new Error('vault locked')
        },
      },
      log: { info: () => {} },
    })
    const view = await svc.list()
    expect(view.shared.anthropic).toBe(false)
  })
})

describe('IM_KEY_PRIORITY — the printed order must be the real one', () => {
  /**
   * Anti-drift gate. `/keys` prints a resolution order, and a member acts on
   * it; if `selectLlmApiKey` is ever reordered, this derives the real order
   * from the real selector and fails rather than letting the printed line
   * quietly become fiction.
   *
   * Method: give every tier a distinguishable sentinel, then remove them one
   * at a time — whichever tier answers first IS the head of the remaining
   * order.
   */
  it('matches selectLlmApiKey, derived by driving the real selector', () => {
    const orgPool = {
      resolveLlmKey: (_p: string) => ({ apiKey: 'ORG', entryId: 'e1' }),
      resolveUserLlmKey: (_p: string, _u: string) => ({ apiKey: 'USER', entryId: 'e2' }),
    }
    const tiers = ['per-agent', 'org-pool', 'user-pool', 'workspace', 'env']
    const derived: string[] = []
    const disabled = new Set<string>()
    for (let i = 0; i < tiers.length; i++) {
      const res = selectLlmApiKey({
        provider: 'anthropic',
        perAgent: disabled.has('per-agent') ? null : 'PER_AGENT',
        // Dropping org-pool alone would also drop user-pool (same object), so
        // each is silenced individually by returning undefined.
        orgPool: {
          resolveLlmKey: disabled.has('org-pool') ? () => undefined : orgPool.resolveLlmKey,
          resolveUserLlmKey: disabled.has('user-pool')
            ? () => undefined
            : orgPool.resolveUserLlmKey,
        } as never,
        ownerUserId: 'owner-1',
        workspace: disabled.has('workspace') ? null : 'WORKSPACE',
        env: disabled.has('env') ? null : 'ENV',
      })
      if (!res) break
      derived.push(res.source.kind)
      disabled.add(res.source.kind)
    }
    expect(derived).toEqual(tiers)
    // The head of the printed list is MR-M6's exclusive `apiKeyEnv` branch,
    // which returns before the tier list is consulted at all — it is not one
    // of the tiers above, which is why it is asserted separately.
    expect(IM_KEY_PRIORITY[0]).toBe('pinned-env')
    expect([...IM_KEY_PRIORITY].slice(1)).toEqual(derived)
  })
})
