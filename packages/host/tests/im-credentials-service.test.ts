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
  redactSecret,
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
  /** Whose role was checked. On the link path this can only be the token's owner. */
  allowedAsked: string[]
}

function harness(opts: {
  agents?: AgentRecord[]
  perAgentKeys?: Record<string, string>
  workspaceKeys?: Record<string, string>
  vaultRows?: Array<{ id: string; metadata: Record<string, unknown> | null }>
  allowed?: boolean
  restart?: (ids: string[]) => Promise<{ restarted: string[]; failed: string[] }>
  noRestartLeg?: boolean
  // HANDS-M3b — the link leg. Both absent = a hub that can only do the paste path.
  links?: {
    issue(userId: string): { token: string; expiresAt: number }
    peek(token: unknown): { userId: string; expiresAt: number } | null
    consume(token: unknown): { userId: string } | null
  }
  linkBaseUrl?: string
} = {}): Harness {
  const setKeyCalls: Harness['setKeyCalls'] = []
  const vaultCreated: Harness['vaultCreated'] = []
  const revoked: string[] = []
  const audits: Harness['audits'] = []
  const logs: Harness['logs'] = []
  const restartCalls: string[][] = []
  const allowedAsked: string[] = []

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
    allowed: (userId) => {
      allowedAsked.push(userId)
      return opts.allowed ?? true
    },
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
    ...(opts.links ? { links: opts.links } : {}),
    ...(opts.linkBaseUrl ? { linkBaseUrl: opts.linkBaseUrl } : {}),
    log: {
      info: (msg, meta) => logs.push({ msg, ...(meta ? { meta } : {}) }),
      warn: (msg, meta) => logs.push({ msg, ...(meta ? { meta } : {}) }),
    },
  })
  return { svc, setKeyCalls, vaultCreated, revoked, audits, logs, restartCalls, allowedAsked }
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

describe('ImCredentialsService — a stored key is never reported as unstored', () => {
  /**
   * Two failure modes with the same root: work that happens AFTER the vault
   * write must not be able to change the answer the member gets. Telling
   * someone their key wasn't saved when it was invites them to paste the
   * secret again — the one instruction `restart()` already refuses to give
   * wrongly, applied to the two steps that sit between the write and the reply.
   */
  function sharedHarness(over: {
    revoke?: (id: string) => boolean
    listAgentApiKeys?: () => Promise<Record<string, string>>
  }): {
    svc: ImCredentialsService
    order: string[]
    audits: Array<Record<string, unknown>>
    restarts: string[][]
  } {
    const order: string[] = []
    const audits: Array<Record<string, unknown>> = []
    const restarts: string[][] = []
    const svc = new ImCredentialsService({
      allowed: () => true,
      space: {
        agents: async () => [agent('a', 'anthropic')],
        listAgentApiKeys:
          over.listAgentApiKeys ??
          (async () => {
            order.push('list-per-agent')
            return {}
          }),
        listProviderApiKeys: async () => ({}),
        setAgentApiKey: async () => {},
      },
      identity: {
        createVaultEntry: (input) => {
          order.push('create')
          return { id: 'new', ...input } as never
        },
        listVaultEntries: () => {
          order.push('list-vault')
          return [{ id: 'old', metadata: { provider: 'anthropic' } }] as never
        },
        revokeVaultEntry:
          over.revoke ??
          ((id) => {
            order.push(`revoke:${id}`)
            return true
          }),
        writeAuditLog: (input) => {
          order.push('audit')
          audits.push({ ...input })
          return undefined
        },
      },
      restartAgents: async (ids) => {
        restarts.push([...ids])
        return { restarted: [...ids], failed: [] }
      },
      log: { info: () => {}, warn: () => {} },
    })
    return { svc, order, audits, restarts }
  }

  it('WRITE-then-clean: the prior row is revoked only after the new one exists', async () => {
    // Revoke-first would mean a failed write leaves the shared pool with NO
    // key at all, while the member is told only that the NEW one wasn't saved.
    const h = sharedHarness({})
    const out = await h.svc.setKey({
      userId: 'u',
      target: 'anthropic',
      secret: SECRET,
      via: 'im:lark',
    })
    expect(out.ok).toBe(true)
    expect(h.order.indexOf('create')).toBeLessThan(h.order.indexOf('revoke:old'))
    // The snapshot may be taken first — it reads, it does not destroy.
    expect(h.order.indexOf('list-vault')).toBeLessThan(h.order.indexOf('create'))
  })

  it('a revoke that throws costs a redundant row, not the write', async () => {
    const h = sharedHarness({
      revoke: () => {
        throw new Error('vault busy')
      },
    })
    const out = await h.svc.setKey({
      userId: 'u',
      target: 'anthropic',
      secret: SECRET,
      via: 'im:lark',
    })
    expect(out.ok).toBe(true)
    // The audit belongs to the write, so it survives a failed cleanup.
    expect(h.audits).toHaveLength(1)
  })

  it('unreadable per-agent keys still audit, still restart — and shadow nobody', async () => {
    // Can't see the per-agent keys ⇒ can't rule anyone out. Restarting an agent
    // that turns out to be shadowed costs one needless respawn; NOT restarting
    // one that isn't leaves it on the old key while the reply says otherwise.
    const h = sharedHarness({
      listAgentApiKeys: async () => {
        throw new Error('space read failed')
      },
    })
    const out = await h.svc.setKey({
      userId: 'u',
      target: 'anthropic',
      secret: SECRET,
      via: 'im:lark',
    })
    expect(out).toMatchObject({ ok: true, slot: 'shared', provider: 'anthropic', shadowed: [] })
    expect(h.audits).toHaveLength(1)
    expect(h.restarts).toEqual([['a']])
    // The write already happened, so the audit cannot be gated behind a read
    // that comes after it.
    expect(h.order.indexOf('audit')).toBeLessThan(h.order.length)
    expect(h.order).toContain('create')
  })
})

describe('redactSecret — the one place that still has the secret in hand', () => {
  it('replaces the full value and a 12-character prefix', () => {
    const line = `write failed for ${SECRET} (prefix ${SECRET.slice(0, 12)})`
    // Asserted as an EXACT string, not with `not.toContain`: the prefix pass on
    // its own already removes enough to satisfy a containment check while
    // leaving the tail of the key sitting in the log. Nothing of it may survive.
    expect(redactSecret(line, SECRET)).toBe(
      'write failed for <redacted> (prefix <redacted>)',
    )
  })

  it('leaves the text alone when there is nothing real to protect', () => {
    // Below the minimum a `/setkey` would accept, blanking short strings would
    // turn every log line into confetti without protecting anything.
    expect(redactSecret('the value ab is fine', 'ab')).toBe('the value ab is fine')
    expect(redactSecret('nothing here', undefined)).toBe('nothing here')
  })

  it('treats the secret as text, not as a pattern', () => {
    // The secret is attacker-chosen; building a regex out of it is how the
    // redactor itself grows an escaping bug.
    const hostile = 'sk-.*.*.*-0123456789'
    expect(redactSecret(`err ${hostile} end`, hostile)).toBe('err <redacted> end')
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
      log: { info: () => {}, warn: () => {} },
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
      log: { info: () => {}, warn: () => {} },
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

// ── HANDS-M3b: the link path ────────────────────────────────────────────────

/**
 * A stub link store with the same three-method shape the real
 * `SetKeyLinkStore` exposes (that store has its own file of tests). What is
 * under test here is the SERVICE's use of it — in particular which failures
 * spend a link and which do not, because that ordering is the whole ergonomic
 * argument for the link path existing.
 */
function fakeLinks(userId = 'u-alice') {
  const live = new Map<string, { userId: string; expiresAt: number }>()
  let n = 0
  const calls = { issue: 0, peek: 0, consume: 0 }
  return {
    calls,
    live,
    issue(u: string) {
      calls.issue++
      const token = `tok${++n}`.padEnd(32, 'x')
      const rec = { userId: u, expiresAt: 1_700_000_600_000 }
      live.clear() // mirrors "new link kills the old"
      live.set(token, rec)
      return { token, expiresAt: rec.expiresAt }
    },
    peek(token: unknown) {
      calls.peek++
      return typeof token === 'string' ? (live.get(token) ?? null) : null
    },
    consume(token: unknown) {
      calls.consume++
      if (typeof token !== 'string') return null
      const rec = live.get(token)
      if (!rec) return null
      live.delete(token)
      return { userId: rec.userId }
    },
    seed(token: string, u = userId, expiresAt = 1_700_000_600_000) {
      live.set(token, { userId: u, expiresAt })
      return token
    },
  }
}

const TOKEN = 'tok-alice-000000000000000000000'

describe('ImCredentialsService — /setkey link (HANDS-M3b)', () => {
  it('linkAvailable needs BOTH a store and a public address', () => {
    const links = fakeLinks()
    expect(harness({ links, linkBaseUrl: 'https://hub.example' }).svc.linkAvailable()).toBe(true)
    expect(harness({ links }).svc.linkAvailable()).toBe(false)
    expect(harness({ linkBaseUrl: 'https://hub.example' }).svc.linkAvailable()).toBe(false)
    expect(harness().svc.linkAvailable()).toBe(false)
  })

  it('issueLink builds the URL from the base and the minted token', () => {
    const links = fakeLinks()
    const h = harness({ links, linkBaseUrl: 'https://hub.example/gotong' })
    const out = h.svc.issueLink('u-alice')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const [token] = [...links.live.keys()]
    expect(out.url).toBe(`https://hub.example/gotong/setkey/${token}`)
    expect(out.expiresAt).toBe(1_700_000_600_000)
  })

  it('both halves of "no link" collapse to one member-facing code; the log says which', () => {
    const noStore = harness({ linkBaseUrl: 'https://hub.example' })
    expect(noStore.svc.issueLink('u-alice')).toEqual({ ok: false, code: 'unavailable' })
    expect(noStore.logs.at(-1)).toMatchObject({ meta: { hasStore: false, hasBaseUrl: true } })

    const noBase = harness({ links: fakeLinks() })
    expect(noBase.svc.issueLink('u-alice')).toEqual({ ok: false, code: 'unavailable' })
    expect(noBase.logs.at(-1)).toMatchObject({ meta: { hasStore: true, hasBaseUrl: false } })
  })

  it('linkPage PEEKS — opening the page twice must not cost the link', async () => {
    const links = fakeLinks()
    links.seed(TOKEN)
    const h = harness({
      links,
      linkBaseUrl: 'https://hub.example',
      agents: [agent('assistant', 'openai-compatible')],
    })
    const first = await h.svc.linkPage(TOKEN)
    const second = await h.svc.linkPage(TOKEN)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(links.calls.consume).toBe(0)
  })

  it('the picker offers EXPLICIT values, flags what is already blocked, and never lists a value', async () => {
    const links = fakeLinks()
    links.seed(TOKEN)
    const h = harness({
      links,
      linkBaseUrl: 'https://hub.example',
      agents: [
        agent('assistant', 'openai-compatible'),
        agent('pinned', 'anthropic', { apiKeyEnv: 'PINNED_KEY' }),
        agent('mocky', 'mock'),
      ],
      perAgentKeys: { assistant: 'already-there' },
    })
    const page = await h.svc.linkPage(TOKEN)
    expect(page.ok).toBe(true)
    if (!page.ok) return

    const byValue = new Map(page.targets.map((t) => [t.value, t]))
    // Explicit prefixes → `ambiguous_target` is unreachable from the form.
    expect(byValue.get('agent:assistant')).toMatchObject({ kind: 'agent', filled: true })
    expect(byValue.get('agent:pinned')).toMatchObject({ blocked: 'env-pinned', envName: 'PINNED_KEY' })
    expect(byValue.get('agent:mocky')).toMatchObject({ blocked: 'mock' })
    // Shared rows only for tags a shared key can honestly serve.
    for (const p of IM_SHARED_KEY_PROVIDERS) expect(byValue.has(`provider:${p}`)).toBe(true)
    expect(byValue.has('provider:openai-compatible')).toBe(false)
    // Presence only — no key material anywhere in the page.
    expect(JSON.stringify(page)).not.toContain('already-there')
  })

  it('an unknown / expired token is link_invalid on BOTH page and submit', async () => {
    const h = harness({ links: fakeLinks(), linkBaseUrl: 'https://hub.example' })
    expect(await h.svc.linkPage('nope-nope-nope-nope-nope-nope-x')).toEqual({
      ok: false,
      code: 'link_invalid',
    })
    expect(
      await h.svc.submitLink({ token: 'nope-nope-nope-nope-nope-nope-x', target: 'agent:a', secret: SECRET }),
    ).toEqual({ ok: false, code: 'link_invalid' })
  })

  it('the role is re-read at page AND at submit — a link is not a captured permission', async () => {
    const links = fakeLinks()
    links.seed(TOKEN)
    const h = harness({
      links,
      linkBaseUrl: 'https://hub.example',
      allowed: false, // demoted after the link was minted
      agents: [agent('assistant', 'openai-compatible')],
    })
    expect(await h.svc.linkPage(TOKEN)).toEqual({ ok: false, code: 'not_allowed' })
    expect(await h.svc.submitLink({ token: TOKEN, target: 'agent:assistant', secret: SECRET })).toEqual({
      ok: false,
      code: 'not_allowed',
    })
    // And a refused submit did NOT burn the member's link.
    expect(links.calls.consume).toBe(0)
    expect(h.setKeyCalls).toHaveLength(0)
  })

  it('a truncated paste does NOT spend the link — retype on the same page', async () => {
    const links = fakeLinks()
    links.seed(TOKEN)
    const h = harness({ links, linkBaseUrl: 'https://hub.example', agents: [agent('assistant', 'openai-compatible')] })
    const out = await h.svc.submitLink({ token: TOKEN, target: 'agent:assistant', secret: 'short' })
    expect(out).toMatchObject({ ok: false, code: 'bad_secret' })
    expect(links.calls.consume).toBe(0)
    expect(links.live.has(TOKEN)).toBe(true)
  })

  it('a successful submit writes the key, spends the link, and audits via=setkey-link', async () => {
    const links = fakeLinks()
    links.seed(TOKEN)
    const h = harness({ links, linkBaseUrl: 'https://hub.example', agents: [agent('assistant', 'openai-compatible')] })
    const out = await h.svc.submitLink({ token: TOKEN, target: 'agent:assistant', secret: SECRET })

    expect(out).toMatchObject({ ok: true, slot: 'agent', agentId: 'assistant' })
    expect(h.setKeyCalls).toEqual([{ agentId: 'assistant', plaintext: SECRET }])
    expect(links.live.has(TOKEN)).toBe(false)
    expect(h.audits.at(-1)).toMatchObject({ metadata: { via: 'setkey-link' } })
    // Same promise as the paste path: the secret went one place.
    expectNoSecret(h, out)
  })

  it('SINGLE USE — the second submit of the same token cannot reach setKey', async () => {
    const links = fakeLinks()
    links.seed(TOKEN)
    const h = harness({ links, linkBaseUrl: 'https://hub.example', agents: [agent('assistant', 'openai-compatible')] })
    await h.svc.submitLink({ token: TOKEN, target: 'agent:assistant', secret: SECRET })
    const again = await h.svc.submitLink({ token: TOKEN, target: 'agent:assistant', secret: SECRET })
    expect(again).toEqual({ ok: false, code: 'link_invalid' })
    expect(h.setKeyCalls).toHaveLength(1)
  })

  it('the write happens for the LINK owner, not for whoever holds the URL', async () => {
    const links = fakeLinks()
    links.seed(TOKEN, 'u-alice')
    const h = harness({ links, linkBaseUrl: 'https://hub.example', agents: [agent('a', 'anthropic')] })
    await h.svc.submitLink({ token: TOKEN, target: 'provider:anthropic', secret: SECRET })
    // `submitLink` takes no userId: the identity is read out of the token and
    // cannot be named by the submitter. Both the role check and the audit row
    // therefore speak about the member the link was minted for.
    expect(h.allowedAsked).toEqual(['u-alice'])
    expect(h.audits.at(-1)).toMatchObject({ actorUserId: 'u-alice' })
  })

  it('a paste and a link submit are distinguishable in the audit forever after', async () => {
    const links = fakeLinks()
    links.seed(TOKEN)
    const h = harness({ links, linkBaseUrl: 'https://hub.example', agents: [agent('a', 'anthropic')] })

    await h.svc.setKey({ userId: 'u-alice', target: 'provider:anthropic', secret: SECRET, via: 'im:telegram' })
    const pasted = h.audits.at(-1)!
    await h.svc.submitLink({ token: TOKEN, target: 'provider:anthropic', secret: SECRET })
    const linked = h.audits.at(-1)!

    // Both are `actorSource: 'im'` on purpose — the actor was established by an
    // IM binding either way (see the note on `audit()`). What separates them,
    // and the only thing that answers "did this secret cross a chat window",
    // is `via`. If these two ever read the same, that answer is gone.
    expect(pasted).toMatchObject({ actorSource: 'im', metadata: { via: 'im:telegram' } })
    expect(linked).toMatchObject({ actorSource: 'im', metadata: { via: 'setkey-link' } })
    expect((linked.metadata as Record<string, unknown>).via).not.toBe(
      (pasted.metadata as Record<string, unknown>).via,
    )
  })

  it('refusals the form could not have known about still come back as refusals', async () => {
    const links = fakeLinks()
    links.seed(TOKEN)
    const h = harness({
      links,
      linkBaseUrl: 'https://hub.example',
      agents: [agent('pinned', 'anthropic', { apiKeyEnv: 'PINNED_KEY' })],
    })
    // A crafted submit for a target the picker had disabled: the picker declines
    // to offer the impossible, it does not authorise the rest.
    const out = await h.svc.submitLink({ token: TOKEN, target: 'agent:pinned', secret: SECRET })
    expect(out).toMatchObject({ ok: false, code: 'env_pinned', envName: 'PINNED_KEY' })
    expect(h.setKeyCalls).toHaveLength(0)
    expectNoSecret(h, out)
  })
})
