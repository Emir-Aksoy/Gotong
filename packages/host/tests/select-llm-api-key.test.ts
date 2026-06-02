/**
 * B1.2 — `selectLlmApiKey` is the pure key-selection logic extracted
 * from `LocalAgentPool.resolveApiKey`. Testing it directly (instead of
 * booting a full pool) keeps the cases short and avoids needing Space
 * / Hub fixtures just to assert "the chain is in the right order".
 *
 * The org pool is faked here — it only needs to satisfy
 * `resolveLlmKey(provider) → ResolvedLlmKey | null`. The real
 * `OrgApiPool` × identity vault round-trip is covered by
 * `org-api-pool.test.ts` (B1.1).
 *
 * Phase 6 #2: return shape carries `{apiKey, source}`. We assert both
 * the key (priority chain) AND the source kind (so the spawn-site
 * knows whether to wire onAuthFailure).
 */

import { describe, expect, it } from 'vitest'

import { selectLlmApiKey } from '../src/local-agent-pool.js'
import type { OrgApiPool, ResolvedLlmKey } from '../src/org-api-pool.js'

/**
 * Build a stand-in `OrgApiPool`. `table` is the org-scope key map; the
 * optional `userTable` (keyed `<userId>:<provider>`) is the v5 A-M3
 * per-user "bring your own" map consulted by `resolveUserLlmKey`.
 */
function fakeOrgPool(
  table: Record<string, string>,
  userTable: Record<string, string> = {},
): OrgApiPool {
  return {
    resolveLlmKey(provider: string): ResolvedLlmKey | null {
      const apiKey = table[provider]
      return apiKey
        ? { provider, apiKey, entryId: `entry-${provider}`, label: null }
        : null
    },
    resolveUserLlmKey(provider: string, userId: string): ResolvedLlmKey | null {
      const apiKey = userTable[`${userId}:${provider}`]
      return apiKey
        ? { provider, apiKey, entryId: `user-entry-${userId}-${provider}`, label: null }
        : null
    },
  } as unknown as OrgApiPool
}

describe('selectLlmApiKey — priority chain', () => {
  it('mock always returns undefined regardless of sources', () => {
    expect(
      selectLlmApiKey({
        provider: 'mock',
        perAgent: 'sk-per-agent',
        orgPool: fakeOrgPool({ mock: 'sk-org' }),
        workspace: 'sk-workspace',
        env: 'sk-env',
      }),
    ).toBeUndefined()
  })

  it('per-agent wins when present (highest priority)', () => {
    const r = selectLlmApiKey({
      provider: 'anthropic',
      perAgent: 'sk-per-agent',
      orgPool: fakeOrgPool({ anthropic: 'sk-org' }),
      workspace: 'sk-workspace',
      env: 'sk-env',
    })
    expect(r?.apiKey).toBe('sk-per-agent')
    expect(r?.source).toEqual({ kind: 'per-agent' })
  })

  it('org pool wins over workspace + env when per-agent is absent', () => {
    const r = selectLlmApiKey({
      provider: 'anthropic',
      perAgent: null,
      orgPool: fakeOrgPool({ anthropic: 'sk-org' }),
      workspace: 'sk-workspace',
      env: 'sk-env',
    })
    expect(r?.apiKey).toBe('sk-org')
    // Phase 6 #2 — source carries vaultEntryId so onAuthFailure can revoke.
    expect(r?.source).toEqual({ kind: 'org-pool', vaultEntryId: 'entry-anthropic' })
  })

  it('workspace is consulted only when per-agent + org pool are empty', () => {
    const r = selectLlmApiKey({
      provider: 'openai',
      perAgent: null,
      orgPool: fakeOrgPool({ anthropic: 'sk-org-anthropic' }), // wrong provider
      workspace: 'sk-workspace',
      env: 'sk-env',
    })
    expect(r?.apiKey).toBe('sk-workspace')
    expect(r?.source).toEqual({ kind: 'workspace' })
  })

  it('env is the last-resort fallback', () => {
    const r = selectLlmApiKey({
      provider: 'anthropic',
      perAgent: null,
      orgPool: fakeOrgPool({}),
      workspace: null,
      env: 'sk-env',
    })
    expect(r?.apiKey).toBe('sk-env')
    expect(r?.source).toEqual({ kind: 'env' })
  })

  it('returns undefined when every source is empty', () => {
    expect(
      selectLlmApiKey({
        provider: 'anthropic',
        perAgent: null,
        orgPool: fakeOrgPool({}),
        workspace: null,
        env: null,
      }),
    ).toBeUndefined()
  })

  it('tolerates a null org pool (host without identity)', () => {
    // Degrade path: IdentityStore failed to open at boot → orgApiPool
    // is undefined → caller passes null here. Chain still works.
    const r = selectLlmApiKey({
      provider: 'anthropic',
      perAgent: null,
      orgPool: null,
      workspace: 'sk-workspace',
      env: 'sk-env',
    })
    expect(r?.apiKey).toBe('sk-workspace')
    expect(r?.source).toEqual({ kind: 'workspace' })
  })

  it("openai-compatible still honours org pool (vendor key may live there)", () => {
    // The caller passes workspace=null + env=null for openai-compatible
    // (vendor ambiguity), but a vault row with metadata.provider set
    // to 'openai-compatible' is a legitimate way to scope a specific
    // vendor's key org-wide. Pool tier remains active.
    const r = selectLlmApiKey({
      provider: 'openai-compatible',
      perAgent: null,
      orgPool: fakeOrgPool({ 'openai-compatible': 'sk-deepseek-org' }),
      workspace: null,
      env: null,
    })
    expect(r?.apiKey).toBe('sk-deepseek-org')
    expect(r?.source).toEqual({
      kind: 'org-pool',
      vaultEntryId: 'entry-openai-compatible',
    })
  })

  it("openai-compatible without per-agent and without org pool yields undefined", () => {
    // This is the documented failure mode — caller must surface a
    // clear error at spawn time.
    expect(
      selectLlmApiKey({
        provider: 'openai-compatible',
        perAgent: null,
        orgPool: null,
        workspace: null,
        env: null,
      }),
    ).toBeUndefined()
  })

  it('per-agent override beats org pool even when org pool has a match', () => {
    // Important: per-agent is an explicit admin choice ("this agent
    // uses its own key"). Org-wide rotation MUST NOT silently
    // override a per-agent assignment.
    const r = selectLlmApiKey({
      provider: 'anthropic',
      perAgent: 'sk-agent-explicit',
      orgPool: fakeOrgPool({ anthropic: 'sk-org' }),
      workspace: null,
      env: null,
    })
    expect(r?.apiKey).toBe('sk-agent-explicit')
    expect(r?.source).toEqual({ kind: 'per-agent' })
  })

  // -- v5 A-M3: per-user "bring your own key" tier (org primary, user fallback)

  it('org pool wins over the owner per-user key (central billing default)', () => {
    const r = selectLlmApiKey({
      provider: 'anthropic',
      perAgent: null,
      orgPool: fakeOrgPool({ anthropic: 'sk-org' }, { 'u-alice:anthropic': 'sk-alice' }),
      ownerUserId: 'u-alice',
      workspace: null,
      env: null,
    })
    expect(r?.apiKey).toBe('sk-org')
    expect(r?.source).toEqual({ kind: 'org-pool', vaultEntryId: 'entry-anthropic' })
  })

  it("owner's per-user key is the fallback when the org has none for the provider", () => {
    const r = selectLlmApiKey({
      provider: 'anthropic',
      perAgent: null,
      orgPool: fakeOrgPool({}, { 'u-alice:anthropic': 'sk-alice' }),
      ownerUserId: 'u-alice',
      workspace: 'sk-workspace',
      env: 'sk-env',
    })
    expect(r?.apiKey).toBe('sk-alice')
    expect(r?.source).toEqual({
      kind: 'user-pool',
      vaultEntryId: 'user-entry-u-alice-anthropic',
      userId: 'u-alice',
    })
  })

  it('the user tier is skipped when the agent has no owner (operator agents unchanged)', () => {
    const r = selectLlmApiKey({
      provider: 'anthropic',
      perAgent: null,
      orgPool: fakeOrgPool({}, { 'u-alice:anthropic': 'sk-alice' }),
      ownerUserId: null, // operator agent — no owning member
      workspace: 'sk-workspace',
      env: null,
    })
    expect(r?.apiKey).toBe('sk-workspace')
    expect(r?.source).toEqual({ kind: 'workspace' })
  })

  it('a member key for a DIFFERENT user is not used (per-user isolation)', () => {
    const r = selectLlmApiKey({
      provider: 'anthropic',
      perAgent: null,
      orgPool: fakeOrgPool({}, { 'u-bob:anthropic': 'sk-bob' }),
      ownerUserId: 'u-alice', // alice owns this agent; only bob has a key
      workspace: null,
      env: 'sk-env',
    })
    expect(r?.apiKey).toBe('sk-env')
    expect(r?.source).toEqual({ kind: 'env' })
  })

  it('the owner per-user key beats workspace + env', () => {
    const r = selectLlmApiKey({
      provider: 'openai',
      perAgent: null,
      orgPool: fakeOrgPool({}, { 'u-alice:openai': 'sk-alice-openai' }),
      ownerUserId: 'u-alice',
      workspace: 'sk-workspace',
      env: 'sk-env',
    })
    expect(r?.apiKey).toBe('sk-alice-openai')
    expect(r?.source).toMatchObject({ kind: 'user-pool', userId: 'u-alice' })
  })

  it('empty-string sources are treated as absent', () => {
    // Defense in depth: a bug elsewhere passing '' instead of null
    // shouldn't shadow a real downstream key.
    const r = selectLlmApiKey({
      provider: 'anthropic',
      perAgent: '',
      orgPool: fakeOrgPool({}),
      workspace: '',
      env: 'sk-env',
    })
    expect(r?.apiKey).toBe('sk-env')
    expect(r?.source).toEqual({ kind: 'env' })
  })
})
