/**
 * Phase 6 #2 — LocalAgentPool wires an onAuthFailure hook for LLM
 * agents whose key came from the vault. A 401 from the provider must:
 *   1. revoke the vault entry (soft-delete)
 *   2. flush the OrgApiPool cache so next call re-resolves
 *   3. write a VAULT_REVOKE audit row
 *
 * The full path (provider 401 → LlmAgent → host hook) is hard to drive
 * from a unit test without a stub provider override at spawn time, so
 * we exercise the closure factory `buildAuthFailureHook` directly:
 * the spawn pipeline assembles it and hands it to LlmAgent, which
 * calls it on detected 401. Testing the factory + the LlmAgent's call
 * site separately covers the full contract (the LlmAgent-side calling
 * convention is verified in @aipehub/llm's agent-auth-failure.test.ts).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { Hub, Space, type AgentRecord } from '@aipehub/core'
import {
  IdentityStore,
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
} from '@aipehub/identity'

import { LocalAgentPool } from '../src/local-agent-pool.js'
import { OrgApiPool } from '../src/org-api-pool.js'

interface Fixture {
  root: string
  space: Space
  hub: Hub
  identity: IdentityStore
  orgApiPool: OrgApiPool
  pool: LocalAgentPool
  /** vault entry id for the seeded 'anthropic' key. */
  entryId: string
}

async function boot(opts: { withIdentity?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'aipe-lap-auth-'))
  const opened = await Space.init(root, { name: 'test' })
  const space = opened.space
  const hub = new Hub({ space })
  await hub.start()
  const identity = openIdentityStore({
    dbPath: join(root, 'identity.sqlite'),
    masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
  })
  const orgApiPool = new OrgApiPool({ identity })
  // Seed one org-scoped 'anthropic' key in the vault. ownerId must be
  // null for ownerKind='org' per the contract.
  const entry = identity.createVaultEntry({
    kind: 'llm_provider',
    ownerKind: 'org',
    ownerId: null,
    secret: 'sk-ant-fake-test-key',
    label: 'phase6 test',
    metadata: { provider: 'anthropic' },
  })
  const pool = new LocalAgentPool({
    hub,
    space,
    orgApiPool,
    ...(opts.withIdentity === false ? {} : { identity }),
  })
  return { root, space, hub, identity, orgApiPool, pool, entryId: entry.id }
}

async function teardown(f: Fixture): Promise<void> {
  f.identity.close()
  await f.hub.stop()
  await rm(f.root, { recursive: true, force: true })
}

/** Build a minimal AgentRecord with `managed.provider`. */
function rec(provider: string, id = 'agent-1'): AgentRecord {
  return {
    id,
    allowedCapabilities: ['draft'],
    createdAt: new Date().toISOString(),
    managed: { kind: 'llm', provider: provider as 'anthropic', system: 'sys' },
  } satisfies AgentRecord
}

describe('LocalAgentPool.buildAuthFailureHook — gating', () => {
  let f: Fixture
  beforeEach(async () => { f = await boot() })
  afterEach(async () => { await teardown(f) })

  it('returns a closure when key came from org-pool + identity wired', () => {
    const resolution = {
      apiKey: 'sk-ant-fake-test-key',
      source: { kind: 'org-pool' as const, vaultEntryId: f.entryId },
    }
    const hook = f.pool.buildAuthFailureHook(rec('anthropic'), resolution)
    expect(typeof hook).toBe('function')
  })

  it('returns undefined for per-agent source', () => {
    const hook = f.pool.buildAuthFailureHook(rec('anthropic'), {
      apiKey: 'sk-from-per-agent',
      source: { kind: 'per-agent' },
    })
    expect(hook).toBeUndefined()
  })

  it('returns undefined for workspace source', () => {
    const hook = f.pool.buildAuthFailureHook(rec('anthropic'), {
      apiKey: 'sk-workspace',
      source: { kind: 'workspace' },
    })
    expect(hook).toBeUndefined()
  })

  it('returns undefined for env source', () => {
    const hook = f.pool.buildAuthFailureHook(rec('anthropic'), {
      apiKey: 'sk-env',
      source: { kind: 'env' },
    })
    expect(hook).toBeUndefined()
  })

  it('returns undefined for mock provider even with org-pool source', () => {
    const hook = f.pool.buildAuthFailureHook(rec('mock'), {
      apiKey: 'unused',
      source: { kind: 'org-pool', vaultEntryId: f.entryId },
    })
    expect(hook).toBeUndefined()
  })

  it('returns undefined when resolution is undefined', () => {
    const hook = f.pool.buildAuthFailureHook(rec('anthropic'), undefined)
    expect(hook).toBeUndefined()
  })
})

describe('LocalAgentPool.buildAuthFailureHook — identity absent', () => {
  let f: Fixture
  beforeEach(async () => { f = await boot({ withIdentity: false }) })
  afterEach(async () => { await teardown(f) })

  it('returns undefined when identity is not wired on the pool', () => {
    const hook = f.pool.buildAuthFailureHook(rec('anthropic'), {
      apiKey: 'sk-ant-fake-test-key',
      source: { kind: 'org-pool', vaultEntryId: f.entryId },
    })
    // No identity → can't revoke / audit. Return undefined so the
    // upstream LlmAgent simply re-throws the 401 like any other error.
    expect(hook).toBeUndefined()
  })
})

describe('LocalAgentPool.buildAuthFailureHook — side effects', () => {
  let f: Fixture
  beforeEach(async () => { f = await boot() })
  afterEach(async () => { await teardown(f) })

  it('revokes vault entry + writes audit + flushes pool cache', () => {
    // Sanity: vault entry exists active, pool resolves it.
    expect(f.identity.getVaultEntry(f.entryId)?.revokedAt).toBeNull()
    const before = f.orgApiPool.resolveLlmKey('anthropic')
    expect(before?.entryId).toBe(f.entryId)
    expect(before?.apiKey).toBe('sk-ant-fake-test-key')

    const hook = f.pool.buildAuthFailureHook(rec('anthropic', 'spawned-agent'), {
      apiKey: before!.apiKey,
      source: { kind: 'org-pool', vaultEntryId: f.entryId },
    })!
    // Simulate the LlmAgent calling us with a 401-shaped error.
    const err401 = Object.assign(new Error('401 Unauthorized'), { status: 401 })
    hook(err401, { from: 'system', strategy: { kind: 'capability', capabilities: ['draft'] }, payload: 'hi' } as never)

    // 1. Vault entry now revoked.
    const after = f.identity.getVaultEntry(f.entryId)
    expect(after?.revokedAt).toBeTruthy()
    expect(typeof after?.revokedAt).toBe('number')

    // 2. OrgApiPool re-resolve returns null (cache flushed + activeOnly
    //    filter skips the revoked row, and no other anthropic entry
    //    exists in this fixture).
    const reResolved = f.orgApiPool.resolveLlmKey('anthropic')
    expect(reResolved).toBeNull()

    // 3. Audit log contains a VAULT_REVOKE row tagged with our metadata.
    const audits = f.identity.listAuditLog!({ action: 'vault_revoke' })
    expect(audits.length).toBeGreaterThanOrEqual(1)
    const ours = audits.find((a) => {
      const md = a.metadata as { vaultEntryId?: string } | null
      return md?.vaultEntryId === f.entryId
    })
    expect(ours).toBeTruthy()
    expect(ours!.actorSource).toBe('system')
    // Audit #147 — metadata stores a structural fingerprint instead of
    // err.message (which routinely carries `Bearer sk-...` from provider
    // SDKs). errorClass = constructor name; errorStatus = numeric HTTP
    // status when present. Neither is caller-supplied; both safe to
    // surface in the audit UI.
    const md = ours!.metadata as {
      reason?: string
      provider?: string
      agent?: string
      errorClass?: string
      errorStatus?: number
      errorMessage?: string
    }
    expect(md.reason).toBe('llm_auth_failure')
    expect(md.provider).toBe('anthropic')
    expect(md.agent).toBe('spawned-agent')
    expect(md.errorClass).toBe('Error') // synth'd via `new Error()` above
    expect(md.errorStatus).toBe(401)
    // Defense-in-depth: explicitly assert the raw message was NOT
    // serialised — guards against a future revert that re-adds it.
    expect(md.errorMessage).toBeUndefined()
  })

  it('hook is idempotent + dedups audit on concurrent 401s (Audit #157)', () => {
    // Audit #157 — N concurrent in-flight LLM calls can all 401 on
    // the same dead vault entry, firing the hook N times. The revoke
    // itself is idempotent; the AUDIT must be too. Previously each
    // call wrote a separate VAULT_REVOKE row → log noise + misleading
    // counters ("10 keys revoked!" when really 1 key got 10 401s).
    //
    // After #157, revokeVaultEntry returns a boolean and the hook
    // only writes audit when revoke actually flipped revoked_at.
    const hook = f.pool.buildAuthFailureHook(rec('anthropic'), {
      apiKey: 'sk-ant-fake-test-key',
      source: { kind: 'org-pool', vaultEntryId: f.entryId },
    })!
    const err = Object.assign(new Error('401'), { status: 401 })
    const auditsBefore = f.identity.listAuditLog!({ action: 'vault_revoke' }).length

    // Fire 5 in quick succession — simulates 5 concurrent in-flight
    // workflow calls all hitting 401 before the first revoke fully
    // propagates to the cache.
    for (let i = 0; i < 5; i++) {
      expect(() =>
        hook(err, {
          from: 'sys',
          strategy: { kind: 'capability', capabilities: [] },
          payload: null,
        } as never),
      ).not.toThrow()
    }
    const auditsAfter = f.identity.listAuditLog!({ action: 'vault_revoke' })
    // Exactly ONE new audit row (the first call's revoke flipped
    // revoked_at; calls 2-5 saw the row already revoked and skipped
    // the audit).
    expect(auditsAfter.length - auditsBefore).toBe(1)
  })

  // Audit #147 — provider SDKs leak credentials in err.message
  // (e.g. "401 Unauthorized: Authorization: Bearer sk-ant-abc123 ...").
  // The hook must NEVER serialise err.message into audit metadata;
  // owners reading audit shouldn't be able to recover the very key
  // that just got revoked.
  it('audit metadata never contains raw err.message (PII / token scrub)', () => {
    const hook = f.pool.buildAuthFailureHook(rec('anthropic'), {
      apiKey: 'sk-ant-fake-test-key',
      source: { kind: 'org-pool', vaultEntryId: f.entryId },
    })!
    // Construct an err.message that LOOKS like a leaked-key provider
    // error. If the hook ever serialises it, this string will show up
    // in the audit row.
    const leaky = '401 unauthorized: Authorization: Bearer sk-ant-LEAKED-SECRET-DO-NOT-LOG'
    const err = Object.assign(new Error(leaky), { status: 401 })
    hook(err, { from: 'sys', strategy: { kind: 'capability', capabilities: [] }, payload: null } as never)
    const audits = f.identity.listAuditLog!({ action: 'vault_revoke' })
    const last = audits[audits.length - 1]!
    const mdJson = JSON.stringify(last.metadata)
    expect(mdJson).not.toContain('sk-ant-LEAKED-SECRET')
    expect(mdJson).not.toContain('Bearer ')
    expect(mdJson).not.toContain('LEAKED')
    // What we DO want: structural fingerprint + status code.
    const md = last.metadata as { errorClass?: string; errorStatus?: number }
    expect(md.errorClass).toBe('Error')
    expect(md.errorStatus).toBe(401)
  })

  // Audit #146 — revoke failure must NOT write success:true audit, and
  // must NOT invalidate the cache (so the next request hits the same
  // vault row and retries the revoke — the only way out of a transient
  // SQLite BUSY is to actually re-attempt, not to falsely claim it worked).
  it('revoke failure: no audit row, no cache flush, no death-loop signal', () => {
    // Wrap identity.revokeVaultEntry to throw once.
    const realRevoke = f.identity.revokeVaultEntry.bind(f.identity)
    let calls = 0
    ;(f.identity as unknown as { revokeVaultEntry: (id: string) => boolean }).revokeVaultEntry = (id: string) => {
      calls++
      if (calls === 1) throw new Error('SQLITE_BUSY: simulated')
      return realRevoke(id)
    }

    const hook = f.pool.buildAuthFailureHook(rec('anthropic'), {
      apiKey: 'sk-ant-fake-test-key',
      source: { kind: 'org-pool', vaultEntryId: f.entryId },
    })!
    const err = Object.assign(new Error('401'), { status: 401 })

    const auditsBefore = f.identity.listAuditLog!({ action: 'vault_revoke' }).length

    // 1st call: revoke throws — must NOT write audit, must NOT touch cache.
    hook(err, { from: 'sys', strategy: { kind: 'capability', capabilities: [] }, payload: null } as never)
    const auditsAfter1 = f.identity.listAuditLog!({ action: 'vault_revoke' }).length
    expect(auditsAfter1).toBe(auditsBefore)
    // Vault row is still active — the broken first attempt didn't lie.
    const stillActive = f.identity.getVaultEntry(f.entryId)
    expect(stillActive?.revokedAt).toBeNull()
    // Cache wasn't flushed: re-resolve still returns the same key.
    const reResolved = f.orgApiPool.resolveLlmKey('anthropic')
    expect(reResolved?.apiKey).toBe('sk-ant-fake-test-key')

    // 2nd call (after the transient busy resolves): real revoke runs,
    // audit DOES write, cache DOES flush. This is the recovery path.
    hook(err, { from: 'sys', strategy: { kind: 'capability', capabilities: [] }, payload: null } as never)
    const auditsAfter2 = f.identity.listAuditLog!({ action: 'vault_revoke' }).length
    expect(auditsAfter2).toBe(auditsBefore + 1)
    const nowRevoked = f.identity.getVaultEntry(f.entryId)
    expect(nowRevoked?.revokedAt).toBeTruthy()
  })

  it('next agent spawn after revoke gets undefined apiKey + no hook', async () => {
    // Trigger revoke.
    const before = f.orgApiPool.resolveLlmKey('anthropic')!
    const hook = f.pool.buildAuthFailureHook(rec('anthropic'), {
      apiKey: before.apiKey,
      source: { kind: 'org-pool', vaultEntryId: f.entryId },
    })!
    hook(Object.assign(new Error('401'), { status: 401 }), { from: 'sys', strategy: { kind: 'capability', capabilities: [] }, payload: null } as never)
    // Now a fresh resolve through the orgApiPool finds nothing — the
    // pool's cache was flushed AND the underlying vault row is filtered
    // by activeOnly.
    expect(f.orgApiPool.resolveLlmKey('anthropic')).toBeNull()
  })
})
