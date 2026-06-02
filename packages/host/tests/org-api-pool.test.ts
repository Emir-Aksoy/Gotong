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

import { OrgApiPool, QuotaExceededError } from '../src/org-api-pool.js'

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

  // Audit #145 — vault mutations now auto-invalidate the cache via
  // the IdentityStore.onVaultMutation hook. The OLD contract said
  // "admin UI MUST call pool.invalidate() after vault edits"; that
  // contract was easy to forget and the 401 auto-revoke path was the
  // only thing keeping the cache honest in practice. Now revoke +
  // createVaultEntry both fire the subscriber automatically.
  it('vault revoke auto-invalidates cache (Audit #145)', () => {
    const e1 = identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-one',
      metadata: { provider: 'anthropic' },
    })
    expect(pool.resolveLlmKey('anthropic')?.entryId).toBe(e1.id)

    identity.revokeVaultEntry(e1.id)
    const e2 = identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-two',
      metadata: { provider: 'anthropic' },
    })
    // Cache was flushed by revoke (and again by the create) — pool
    // now sees the fresh row without anyone calling invalidate().
    expect(pool.resolveLlmKey('anthropic')?.entryId).toBe(e2.id)
    expect(pool.resolveLlmKey('anthropic')?.apiKey).toBe('sk-two')
  })

  // Audit #145 — negative cache (we resolved + got null) used to stay
  // sticky until invalidate() — now the create event flips it.
  it('vault create auto-invalidates the negative cache (Audit #145)', () => {
    expect(pool.resolveLlmKey('anthropic')).toBeNull()
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-late',
      metadata: { provider: 'anthropic' },
    })
    // No manual pool.invalidate() — the create event auto-fired it.
    expect(pool.resolveLlmKey('anthropic')?.apiKey).toBe('sk-late')
  })

  // Audit #145 — defensive: the cache is still flushable explicitly,
  // even though autop-invalidate covers the common path. Some tests
  // / future hot-path consumers may want to flush without writing.
  it('manual invalidate() still works (orthogonal to auto-invalidate)', () => {
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-manual',
      metadata: { provider: 'anthropic' },
    })
    expect(pool.resolveLlmKey('anthropic')?.apiKey).toBe('sk-manual')
    pool.invalidate()
    // A re-resolve hits sqlite again; result is the same active row.
    expect(pool.resolveLlmKey('anthropic')?.apiKey).toBe('sk-manual')
  })

  // Audit #145 — dispose() detaches the subscriber so the pool stops
  // reacting to vault writes (important for tests that recreate pools
  // and for hosts that swap orgId-scoped pools at runtime).
  it('dispose() detaches the vault-mutation subscriber', () => {
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-pre',
      metadata: { provider: 'anthropic' },
    })
    expect(pool.resolveLlmKey('anthropic')?.apiKey).toBe('sk-pre')
    pool.dispose()
    // After dispose, vault writes no longer auto-invalidate. To prove
    // it: revoke + create should leave the old apiKey cached. But
    // dispose ALSO clears the cache once on its way out, so re-resolve
    // returns the NEW key — proving sqlite was hit, not the cache.
    identity.revokeVaultEntry(identity.listVaultEntries({ kind: 'llm_provider', activeOnly: true })[0]!.id)
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-post-dispose',
      metadata: { provider: 'anthropic' },
    })
    // The post-dispose write does NOT trigger our (now-detached) sub,
    // but the cache was cleared by dispose, so the next resolve hits
    // sqlite and sees the new row. Re-cache the new row, then verify
    // a SECOND post-dispose mutation does NOT flip the cache.
    expect(pool.resolveLlmKey('anthropic')?.apiKey).toBe('sk-post-dispose')
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-after-cache',
      metadata: { provider: 'anthropic' },
    })
    // Subscriber detached — second mutation does NOT flush. Cache still
    // serves the earlier row.
    expect(pool.resolveLlmKey('anthropic')?.apiKey).toBe('sk-post-dispose')
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

// =========================================================================
// Phase 6 #3 — per-org pool scoping. The default pool (no orgId) sees
// vault rows with ownerId IS NULL (primary org). A pool constructed
// with an orgId sees ONLY rows tagged with that orgId. Cross-org
// isolation is the whole point — orgA's pool must never leak into
// orgB's resolve path.
// =========================================================================

describe('OrgApiPool — multi-org scoping (Phase 6 #3)', () => {
  let dir: string
  let identity: IdentityStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipehub-orgpool-multiorg-'))
    identity = openIdentityStore({
      dbPath: join(dir, 'id.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
  })
  afterEach(() => {
    identity.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('constructor accepts orgId; scopedOrgId reflects it', () => {
    const primary = new OrgApiPool({ identity })
    expect(primary.scopedOrgId).toBeNull()

    const primaryExplicit = new OrgApiPool({ identity, orgId: null })
    expect(primaryExplicit.scopedOrgId).toBeNull()

    const orgA = new OrgApiPool({ identity, orgId: 'hub_a' })
    expect(orgA.scopedOrgId).toBe('hub_a')
  })

  it('rejects empty-string orgId at construction', () => {
    expect(() => new OrgApiPool({ identity, orgId: '' })).toThrow(/non-empty/)
  })

  it('primary pool (no orgId) only sees rows with ownerId IS NULL', () => {
    // One row in the primary org bucket, one in a peer org bucket.
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: null,
      secret: 'sk-primary',
      metadata: { provider: 'anthropic' },
    })
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: 'hub_peer',
      secret: 'sk-peer',
      metadata: { provider: 'anthropic' },
    })

    const primary = new OrgApiPool({ identity })
    const resolved = primary.resolveLlmKey('anthropic')
    expect(resolved?.apiKey).toBe('sk-primary')
  })

  it('orgId-scoped pool only sees rows tagged with that orgId', () => {
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: null,
      secret: 'sk-primary',
      metadata: { provider: 'anthropic' },
    })
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: 'hub_peer_a',
      secret: 'sk-a',
      metadata: { provider: 'anthropic' },
    })
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: 'hub_peer_b',
      secret: 'sk-b',
      metadata: { provider: 'anthropic' },
    })

    const a = new OrgApiPool({ identity, orgId: 'hub_peer_a' })
    const b = new OrgApiPool({ identity, orgId: 'hub_peer_b' })
    expect(a.resolveLlmKey('anthropic')?.apiKey).toBe('sk-a')
    expect(b.resolveLlmKey('anthropic')?.apiKey).toBe('sk-b')
  })

  it('orgId-scoped pool returns null when no row exists for that org', () => {
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: null, // primary only
      secret: 'sk-primary',
      metadata: { provider: 'anthropic' },
    })
    const orgX = new OrgApiPool({ identity, orgId: 'hub_x_no_rows' })
    expect(orgX.resolveLlmKey('anthropic')).toBeNull()
    expect(orgX.listProviders()).toEqual([])
  })

  // Audit #145 — both pools now subscribe to the same IdentityStore's
  // vault-mutation events, so every revoke / create flushes every
  // pool's cache. The org-scoping contract still holds: each pool
  // sees only its own scope when it re-resolves. The OLD assertion
  // "b's cache untouched while a's was stale" no longer makes sense
  // because they're flushed together — but the SCOPING isolation
  // (the actual safety property) remains and is what we test here.
  it('per-pool scoping persists across cross-pool vault rotations (Audit #145)', () => {
    const e1 = identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: 'hub_a',
      secret: 'sk-a-v1',
      metadata: { provider: 'anthropic' },
    })
    const a = new OrgApiPool({ identity, orgId: 'hub_a' })
    const b = new OrgApiPool({ identity, orgId: 'hub_b' })
    expect(a.resolveLlmKey('anthropic')?.apiKey).toBe('sk-a-v1')
    expect(b.resolveLlmKey('anthropic')).toBeNull()
    // Mutate underlying vault: revoke a's key. Now BOTH pools' caches
    // are flushed by the vault-mutation hook.
    identity.revokeVaultEntry(e1.id)
    // Re-resolve: a no longer has any active anthropic row.
    expect(a.resolveLlmKey('anthropic')).toBeNull()
    // b still has no rows scoped to hub_b — scoping protected b from
    // accidentally seeing hub_a's revoked-then-replaced rows.
    expect(b.resolveLlmKey('anthropic')).toBeNull()
    // Adding a new row to hub_b: only b sees it. a stays null.
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: 'hub_b',
      secret: 'sk-b-v1',
      metadata: { provider: 'anthropic' },
    })
    expect(b.resolveLlmKey('anthropic')?.apiKey).toBe('sk-b-v1')
    expect(a.resolveLlmKey('anthropic')).toBeNull()
  })

  it('cross-org isolation: user-scoped row in one org does not leak to another', () => {
    // Defense in depth: even non-org rows with the same provider tag
    // must not cross the org-scoped pool boundary.
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'user',
      ownerId: 'user-in-a',
      secret: 'sk-user-leak',
      metadata: { provider: 'anthropic' },
    })
    const a = new OrgApiPool({ identity, orgId: 'hub_a' })
    expect(a.resolveLlmKey('anthropic')).toBeNull()
  })

  it('vault createVaultEntry accepts ownerKind=org + non-null ownerId now', () => {
    // The validation relaxation is the schema-level enabler. Make sure
    // the underlying store no longer rejects it.
    const entry = identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: 'hub_specific',
      secret: 'sk-x',
      metadata: { provider: 'openai' },
    })
    expect(entry.ownerKind).toBe('org')
    expect(entry.ownerId).toBe('hub_specific')
  })
})

// =========================================================================
// B2.2 — makeLlmQuotaGate factory: pre-call hook that debits a counter
// from `subject.userId` and throws QuotaExceededError on overrun.
// =========================================================================

describe('OrgApiPool.makeLlmQuotaGate (B2.2)', () => {
  let dir: string
  let identity: IdentityStore
  let pool: OrgApiPool
  let userId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipehub-orgpool-gate-'))
    identity = openIdentityStore({
      dbPath: join(dir, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    pool = new OrgApiPool({ identity })
    const u = identity.createUser({
      email: 'gate-target@test.local',
      displayName: 'Gate Target',
      role: 'member',
    })
    userId = u.id
  })

  afterEach(() => {
    identity.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns a hook that no-ops when subject is undefined', () => {
    const gate = pool.makeLlmQuotaGate({
      metric: 'llm_requests',
      period: 'daily',
    })
    expect(() => gate(undefined)).not.toThrow()
    expect(identity.listUsage({ userId })).toEqual([]) // nothing debited
  })

  it('no-ops when subject.userId is absent', () => {
    const gate = pool.makeLlmQuotaGate({
      metric: 'llm_requests',
      period: 'daily',
    })
    expect(() => gate({})).not.toThrow()
    expect(identity.listUsage({ userId })).toEqual([])
  })

  it('debits 1 per call against the configured (metric, period) by default', () => {
    const gate = pool.makeLlmQuotaGate({
      metric: 'llm_requests',
      period: 'daily',
    })
    gate({ userId })
    gate({ userId })
    gate({ userId })
    const [row] = identity.listUsage({
      userId,
      metric: 'llm_requests',
      period: 'daily',
    })
    expect(row?.used).toBe(3)
  })

  it('honours a custom `amount` (batched debit)', () => {
    const gate = pool.makeLlmQuotaGate({
      metric: 'llm_tokens_in',
      period: 'monthly',
      amount: 500,
    })
    gate({ userId })
    gate({ userId })
    const [row] = identity.listUsage({
      userId,
      metric: 'llm_tokens_in',
      period: 'monthly',
    })
    expect(row?.used).toBe(1000)
  })

  it('throws QuotaExceededError when the cap is breached; does NOT commit', () => {
    identity.setQuota({
      userId,
      metric: 'llm_requests',
      period: 'daily',
      quota: 3,
    })
    const gate = pool.makeLlmQuotaGate({
      metric: 'llm_requests',
      period: 'daily',
    })
    gate({ userId }) // used=1
    gate({ userId }) // used=2
    gate({ userId }) // used=3 (at cap)
    let caught: unknown
    try {
      gate({ userId }) // would be 4
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(QuotaExceededError)
    const e = caught as QuotaExceededError
    expect(e.code).toBe('quota_exceeded')
    expect(e.userId).toBe(userId)
    expect(e.metric).toBe('llm_requests')
    expect(e.period).toBe('daily')
    expect(e.used).toBe(3) // un-committed
    expect(e.quota).toBe(3)
    expect(e.exceededBy).toBe(1)
    // Counter on disk is unchanged.
    const [row] = identity.listUsage({
      userId,
      metric: 'llm_requests',
      period: 'daily',
    })
    expect(row?.used).toBe(3)
  })

  it('writes api_quota_denied audit row on cap breach (Audit #151)', () => {
    // Operators need a time-series of denied calls (sized per user /
    // per period) to know when to raise a quota. Until #151, the
    // QuotaExceededError throw was silent — only the counter on disk
    // changed (it didn't even increment in the breach case). Now the
    // gate writes an audit row alongside the throw, so the standard
    // audit-log query surface picks it up without any new wiring.
    identity.setQuota({
      userId,
      metric: 'llm_requests',
      period: 'daily',
      quota: 2,
    })
    const gate = pool.makeLlmQuotaGate({
      metric: 'llm_requests',
      period: 'daily',
    })
    gate({ userId }) // used=1
    gate({ userId }) // used=2 (at cap)
    expect(() => gate({ userId })).toThrow(QuotaExceededError)
    const rows = identity.listAuditLog({ targetUserId: userId, limit: 50 })
    const denied = rows.filter((r) => r.action === 'api_quota_denied')
    expect(denied).toHaveLength(1)
    const row = denied[0]!
    expect(row.success).toBe(false)
    expect(row.actorSource).toBe('system')
    expect(row.actorUserId).toBe(userId)
    expect(row.targetUserId).toBe(userId)
    const meta = row.metadata as Record<string, unknown>
    expect(meta.metric).toBe('llm_requests')
    expect(meta.period).toBe('daily')
    expect(meta.used).toBe(2)
    expect(meta.quota).toBe(2)
    expect(meta.exceededBy).toBe(1)
  })

  it('null quota = unlimited (no throw even after huge debits)', () => {
    const gate = pool.makeLlmQuotaGate({
      metric: 'llm_tokens_in',
      period: 'monthly',
      amount: 10_000,
    })
    for (let i = 0; i < 100; i++) gate({ userId })
    const [row] = identity.listUsage({
      userId,
      metric: 'llm_tokens_in',
      period: 'monthly',
    })
    expect(row?.used).toBe(1_000_000)
    expect(row?.quota).toBeNull()
  })

  it('rejects bad opts at factory time (fail fast, not on first call)', () => {
    expect(() =>
      pool.makeLlmQuotaGate({} as unknown as { metric: string; period: 'daily' }),
    ).toThrow(/metric/)
    expect(() =>
      pool.makeLlmQuotaGate({ metric: '', period: 'daily' }),
    ).toThrow(/non-empty/)
    expect(() =>
      pool.makeLlmQuotaGate({
        metric: 'm',
        period: 'daily',
        amount: -1,
      }),
    ).toThrow(/non-negative/)
    expect(() =>
      pool.makeLlmQuotaGate({
        metric: 'm',
        period: 'daily',
        amount: 1.5,
      }),
    ).toThrow(/non-negative integer/)
  })

  // -- v5 A-M3: per-user "bring your own key" resolution -------------------

  it('resolveUserLlmKey returns null when the member has no key', () => {
    expect(pool.resolveUserLlmKey('anthropic', 'u-alice')).toBeNull()
  })

  it('resolveUserLlmKey resolves a user-owned llm_provider key', () => {
    const entry = identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'user',
      ownerId: 'u-alice',
      secret: 'sk-alice-byo',
      label: 'alice anthropic',
      metadata: { provider: 'anthropic' },
    })
    expect(pool.resolveUserLlmKey('anthropic', 'u-alice')).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-alice-byo',
      entryId: entry.id,
      label: 'alice anthropic',
    })
  })

  it('resolveUserLlmKey is isolated per user — alice never sees bob’s key', () => {
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'user',
      ownerId: 'u-bob',
      secret: 'sk-bob-byo',
      metadata: { provider: 'anthropic' },
    })
    expect(pool.resolveUserLlmKey('anthropic', 'u-bob')?.apiKey).toBe('sk-bob-byo')
    expect(pool.resolveUserLlmKey('anthropic', 'u-alice')).toBeNull()
  })

  it('a user key does NOT leak into the org resolution (and vice versa)', () => {
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'user',
      ownerId: 'u-alice',
      secret: 'sk-alice-only',
      metadata: { provider: 'anthropic' },
    })
    // The org pool sees no org-scope row → still null.
    expect(pool.resolveLlmKey('anthropic')).toBeNull()
    // And the user resolution does not surface an org row when only an
    // org key exists.
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      secret: 'sk-org-only',
      metadata: { provider: 'openai' },
    })
    expect(pool.resolveUserLlmKey('openai', 'u-alice')).toBeNull()
  })

  it('user-key create auto-invalidates the per-user negative cache', () => {
    expect(pool.resolveUserLlmKey('anthropic', 'u-alice')).toBeNull() // caches null
    identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'user',
      ownerId: 'u-alice',
      secret: 'sk-alice-late',
      metadata: { provider: 'anthropic' },
    })
    // No manual invalidate — the vault-mutation listener flushed the user cache.
    expect(pool.resolveUserLlmKey('anthropic', 'u-alice')?.apiKey).toBe('sk-alice-late')
  })

  it('resolveUserLlmKey rejects an empty provider / userId', () => {
    expect(() => pool.resolveUserLlmKey('', 'u-alice')).toThrow(/provider/)
    expect(() => pool.resolveUserLlmKey('anthropic', '')).toThrow(/userId/)
  })
})
