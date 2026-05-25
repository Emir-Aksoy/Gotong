/**
 * B1.1 — OrgApiPool unit tests.
 *
 * Boots an in-memory-ish IdentityStore per test (tmpdir + sqlite file)
 * so the tests exercise the real vault encryption + listing path. No
 * LocalAgentPool wiring is exercised here — that lands in B1.2 with
 * the integration test on `local-agent-pool-services.test.ts`-style
 * fixtures.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  IdentityStore,
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
} from '@aipehub/identity'

import { OrgApiPool } from '../src/org-api-pool.js'

describe('OrgApiPool', () => {
  let dir: string
  let identity: IdentityStore
  let pool: OrgApiPool

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipehub-orgpool-'))
    identity = openIdentityStore({
      dbPath: join(dir, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    pool = new OrgApiPool({ identity })
  })

  afterEach(() => {
    identity.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when no org llm key is configured', () => {
    expect(pool.resolveLlmKey('anthropic')).toBeNull()
    expect(pool.listProviders()).toEqual([])
    expect(pool.listOrgLlmEntries()).toEqual([])
  })

  it('resolves an org-owned llm_provider key by metadata.provider', () => {
    const entry = identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: null,
      secret: 'sk-ant-real-key',
      label: 'org anthropic',
      metadata: { provider: 'anthropic' },
    })
    const got = pool.resolveLlmKey('anthropic')
    expect(got).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-ant-real-key',
      entryId: entry.id,
      label: 'org anthropic',
    })
  })

  it('honours metadata.provider — same vault row, different tag → no match', () => {
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-ant-1',
      metadata: { provider: 'anthropic' },
    })
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-openai-1',
      metadata: { provider: 'openai' },
    })
    expect(pool.resolveLlmKey('anthropic')?.apiKey).toBe('sk-ant-1')
    expect(pool.resolveLlmKey('openai')?.apiKey).toBe('sk-openai-1')
    expect(pool.resolveLlmKey('deepseek')).toBeNull()
  })

  it('returns the newest entry when multiple active rows share a provider', async () => {
    const _old = identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-old',
      metadata: { provider: 'anthropic' },
    })
    // Vault stores createdAt in ms; force a strictly-later timestamp so
    // newest-first ordering is unambiguous.
    await new Promise((r) => setTimeout(r, 5))
    const newer = identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-new',
      metadata: { provider: 'anthropic' },
    })
    expect(pool.resolveLlmKey('anthropic')?.entryId).toBe(newer.id)
    expect(pool.resolveLlmKey('anthropic')?.apiKey).toBe('sk-new')
  })

  it('caches resolved keys until invalidate() — revoke alone is not enough', () => {
    const e1 = identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-one',
      metadata: { provider: 'anthropic' },
    })
    expect(pool.resolveLlmKey('anthropic')?.entryId).toBe(e1.id)

    // Revoke the cached entry + add a replacement. Without invalidate,
    // the pool keeps handing out the cached `e1` row. This is the
    // documented contract — admin UI MUST call invalidate after edits.
    identity.revokeVaultEntry(e1.id)
    const e2 = identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-two',
      metadata: { provider: 'anthropic' },
    })
    expect(pool.resolveLlmKey('anthropic')?.entryId).toBe(e1.id)

    pool.invalidate()
    expect(pool.resolveLlmKey('anthropic')?.entryId).toBe(e2.id)
    expect(pool.resolveLlmKey('anthropic')?.apiKey).toBe('sk-two')
  })

  it('caches misses too — invalidate clears the negative cache', () => {
    expect(pool.resolveLlmKey('anthropic')).toBeNull()
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-late',
      metadata: { provider: 'anthropic' },
    })
    // The miss is sticky until we invalidate. Important so a hot-path
    // "is there a key" check stays free even when the answer is "no".
    expect(pool.resolveLlmKey('anthropic')).toBeNull()
    pool.invalidate()
    expect(pool.resolveLlmKey('anthropic')?.apiKey).toBe('sk-late')
  })

  it('listProviders returns unique sorted provider tags', () => {
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-1',
      metadata: { provider: 'openai' },
    })
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-2',
      metadata: { provider: 'anthropic' },
    })
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-3',
      // duplicate provider — must dedupe so admin UI shows each tag once
      metadata: { provider: 'anthropic' },
    })
    expect(pool.listProviders()).toEqual(['anthropic', 'openai'])
  })

  it('ignores non-org owners (user / peer scoped rows must not leak)', () => {
    // Critical isolation: a user-scoped row with the same provider tag
    // MUST NOT be resolved through the org pool. Otherwise alice's
    // personal anthropic key silently becomes the org default.
    const userId = randomBytes(8).toString('hex')
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'user',
      ownerId: userId,
      secret: 'sk-user-private',
      metadata: { provider: 'anthropic' },
    })
    expect(pool.resolveLlmKey('anthropic')).toBeNull()
    expect(pool.listProviders()).toEqual([])
  })

  it('ignores other vault kinds (mcp_server / peer_token / third_party_api)', () => {
    // Same defense — a non-llm secret with a spoofed provider tag must
    // not show up. The kind filter at the SQL level guards this.
    identity.createVaultEntry({
      kind: 'mcp_server',
      ownerKind: 'org',
      secret: 'mcp-token',
      metadata: { provider: 'fake-mcp-as-llm' },
    })
    identity.createVaultEntry({
      kind: 'third_party_api',
      ownerKind: 'org',
      secret: '3p-token',
      metadata: { provider: 'anthropic' },
    })
    expect(pool.resolveLlmKey('fake-mcp-as-llm')).toBeNull()
    expect(pool.resolveLlmKey('anthropic')).toBeNull()
  })

  it('handles entries with no metadata gracefully', () => {
    // The vault accepts metadata=null/omitted. An llm row without a
    // provider tag is unusable to the pool but mustn't crash queries
    // for OTHER providers (the filter just skips it).
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-no-meta',
    })
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-ok',
      metadata: { provider: 'anthropic' },
    })
    expect(pool.resolveLlmKey('anthropic')?.apiKey).toBe('sk-ok')
    expect(pool.listProviders()).toEqual(['anthropic'])
  })

  it('handles entries with non-object / non-string-provider metadata defensively', () => {
    // Belt-and-braces: metadata is typed as `Record<string, unknown>`
    // but the pool can't trust the shape. Provider tag that's a number
    // or an array → ignored, not crashed.
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-bad-meta-1',
      metadata: { provider: 42 } as unknown as Record<string, unknown>,
    })
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-bad-meta-2',
      metadata: { provider: '' },
    })
    expect(pool.listProviders()).toEqual([])
    expect(pool.resolveLlmKey('42')).toBeNull()
  })

  it('rejects bad provider input at the type boundary', () => {
    expect(() => pool.resolveLlmKey('')).toThrow(/non-empty/)
    expect(() => pool.resolveLlmKey(undefined as unknown as string)).toThrow(
      /non-empty/,
    )
    expect(() => pool.resolveLlmKey(123 as unknown as string)).toThrow(
      /non-empty/,
    )
  })

  it('constructor rejects missing identity dependency', () => {
    expect(
      () => new OrgApiPool({} as unknown as { identity: IdentityStore }),
    ).toThrow(/identity/)
  })
})
