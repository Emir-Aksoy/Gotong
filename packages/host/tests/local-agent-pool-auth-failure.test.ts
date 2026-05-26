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
    const md = ours!.metadata as {
      reason?: string
      provider?: string
      agent?: string
      errorMessage?: string
    }
    expect(md.reason).toBe('llm_auth_failure')
    expect(md.provider).toBe('anthropic')
    expect(md.agent).toBe('spawned-agent')
    expect(md.errorMessage).toContain('Unauthorized')
  })

  it('hook is idempotent (calling twice doesn\'t double-revoke or crash)', () => {
    const hook = f.pool.buildAuthFailureHook(rec('anthropic'), {
      apiKey: 'sk-ant-fake-test-key',
      source: { kind: 'org-pool', vaultEntryId: f.entryId },
    })!
    const err = Object.assign(new Error('401'), { status: 401 })
    expect(() => hook(err, { from: 'sys', strategy: { kind: 'capability', capabilities: [] }, payload: null } as never)).not.toThrow()
    // Second invocation: revoke is a soft-delete idempotent op; audit
    // row count grows by another 1 (each call is its own event).
    expect(() => hook(err, { from: 'sys', strategy: { kind: 'capability', capabilities: [] }, payload: null } as never)).not.toThrow()
    const audits = f.identity.listAuditLog!({ action: 'vault_revoke' })
    expect(audits.length).toBeGreaterThanOrEqual(2)
  })

  it('clamps long error messages in audit metadata', () => {
    const hook = f.pool.buildAuthFailureHook(rec('anthropic'), {
      apiKey: 'sk-ant-fake-test-key',
      source: { kind: 'org-pool', vaultEntryId: f.entryId },
    })!
    const longMsg = '401 unauthorized: ' + 'x'.repeat(1000)
    const err = Object.assign(new Error(longMsg), { status: 401 })
    hook(err, { from: 'sys', strategy: { kind: 'capability', capabilities: [] }, payload: null } as never)
    const audits = f.identity.listAuditLog!({ action: 'vault_revoke' })
    const last = audits[audits.length - 1]!
    const md = last.metadata as { errorMessage: string }
    // Clamp is 200 chars in buildAuthFailureHook.
    expect(md.errorMessage.length).toBeLessThanOrEqual(200)
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
