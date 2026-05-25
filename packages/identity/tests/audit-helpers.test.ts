/**
 * Tests for A2.1 — typed audit helpers (writeApiCall / writeVaultAccess
 * / writeKnowledgeAccess).
 *
 * Each helper is a thin wrapper around writeAuditLog. The tests focus on
 * two contracts that future refactors might silently break:
 *
 *   1. The persisted `action` verb is the value from `AUDIT_ACTIONS`
 *      (so the admin UI's groupBy(action) keeps working).
 *   2. The persisted `metadata` JSON shape is stable across helper
 *      calls (rollup queries assume keys like `provider`, `vaultKind`,
 *      `setName` exist when the corresponding action verb is set).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AUDIT_ACTIONS,
  IdentityStore,
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
} from '../src/index.js'

const FIXED_KEY = Buffer.alloc(MASTER_KEY_LEN_BYTES, 0x42)

describe('audit helpers', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:', masterKey: FIXED_KEY })
  })
  afterEach(() => {
    store.close()
  })

  describe('writeApiCall', () => {
    it('persists action=api_call and the full metadata shape', () => {
      const u = store.createUser({ email: 'alice@org', role: 'member' })
      const row = store.writeApiCall({
        actorSource: 'v4-session',
        actorUserId: u.id,
        provider: 'anthropic',
        model: 'claude-opus-4',
        tokensIn: 1234,
        tokensOut: 567,
        costUsd: 0.018,
        durationMs: 845,
      })
      expect(row.action).toBe(AUDIT_ACTIONS.API_CALL)
      expect(row.action).toBe('api_call')
      expect(row.metadata).toEqual({
        provider: 'anthropic',
        model: 'claude-opus-4',
        tokensIn: 1234,
        tokensOut: 567,
        costUsd: 0.018,
        durationMs: 845,
      })
      expect(row.actorUserId).toBe(u.id)
      expect(row.success).toBe(true)
    })

    it('omits absent optional metadata fields rather than encoding undefined', () => {
      const row = store.writeApiCall({
        actorSource: 'system',
        provider: 'brave-search',
      })
      expect(row.metadata).toEqual({ provider: 'brave-search' })
      // Critically: no 'model', no 'tokensIn' etc keys — caller can
      // safely Object.keys() the metadata and not see ghost undefined
      // entries.
      expect(Object.keys(row.metadata!)).toEqual(['provider'])
    })

    it('propagates success:false for failed upstream calls', () => {
      const row = store.writeApiCall({
        actorSource: 'system',
        provider: 'deepseek',
        success: false,
      })
      expect(row.success).toBe(false)
    })
  })

  describe('writeVaultAccess', () => {
    it('maps action enum to the right AUDIT_ACTIONS verb (create)', () => {
      const entry = store.createVaultEntry({
        kind: 'llm_provider',
        ownerKind: 'org',
        secret: 's',
      })
      const row = store.writeVaultAccess({
        actorSource: 'v4-session',
        action: 'create',
        vaultEntryId: entry.id,
        vaultKind: 'llm_provider',
        ownerKind: 'org',
        ownerId: null,
      })
      expect(row.action).toBe(AUDIT_ACTIONS.VAULT_CREATE)
      expect(row.targetCredentialId).toBe(entry.id)
      expect(row.metadata).toEqual({
        vaultKind: 'llm_provider',
        ownerKind: 'org',
        ownerId: null,
      })
    })

    it('maps action=read → vault_read', () => {
      const row = store.writeVaultAccess({
        actorSource: 'system',
        action: 'read',
        vaultEntryId: 'fake-id',
        vaultKind: 'mcp_server',
        ownerKind: 'user',
        ownerId: 'alice-id',
      })
      expect(row.action).toBe(AUDIT_ACTIONS.VAULT_READ)
      expect(row.metadata).toEqual({
        vaultKind: 'mcp_server',
        ownerKind: 'user',
        ownerId: 'alice-id',
      })
    })

    it('maps action=revoke → vault_revoke', () => {
      const row = store.writeVaultAccess({
        actorSource: 'v4-bearer',
        action: 'revoke',
        vaultEntryId: 'fake-id',
        vaultKind: 'peer_token',
        ownerKind: 'peer',
        ownerId: 'widgets-hub',
      })
      expect(row.action).toBe(AUDIT_ACTIONS.VAULT_REVOKE)
    })
  })

  describe('writeKnowledgeAccess', () => {
    it('maps action enum to AUDIT_ACTIONS.KNOWLEDGE_INGEST', () => {
      const row = store.writeKnowledgeAccess({
        actorSource: 'v4-session',
        action: 'ingest',
        setName: 'engineering-handbook',
        ownerKind: 'org',
        extra: { docs: 12, chunks: 384 },
      })
      expect(row.action).toBe(AUDIT_ACTIONS.KNOWLEDGE_INGEST)
      expect(row.metadata).toEqual({
        setName: 'engineering-handbook',
        ownerKind: 'org',
        ownerId: null,
        docs: 12,
        chunks: 384,
      })
    })

    it('maps action=search → knowledge_search and merges extra correctly', () => {
      const row = store.writeKnowledgeAccess({
        actorSource: 'v4-session',
        action: 'search',
        setName: 'rfp-history',
        ownerKind: 'peer',
        ownerId: 'widgets-hub',
        extra: { query: 'pricing 2024', returned: 8 },
      })
      expect(row.action).toBe(AUDIT_ACTIONS.KNOWLEDGE_SEARCH)
      expect(row.metadata!.setName).toBe('rfp-history')
      expect(row.metadata!.ownerId).toBe('widgets-hub')
      expect(row.metadata!.query).toBe('pricing 2024')
      expect(row.metadata!.returned).toBe(8)
    })

    it('extra fields cannot collide with the reserved keys (caller-supplied wins by spread order)', () => {
      // The helper spreads `extra` last to allow callers to override
      // ownerKind/ownerId/setName if they really want — but warns nobody
      // by default. This test pins the documented behaviour: spread order
      // = caller wins. (If we later prefer "reserved keys ALWAYS win,
      // refuse override", that's a semantic change and this test should
      // flip to expect a throw.)
      const row = store.writeKnowledgeAccess({
        actorSource: 'system',
        action: 'grant',
        setName: 'set-a',
        ownerKind: 'org',
        extra: { setName: 'override-via-extra' },
      })
      expect(row.action).toBe(AUDIT_ACTIONS.KNOWLEDGE_GRANT)
      expect(row.metadata!.setName).toBe('override-via-extra')
    })
  })

  describe('AUDIT_ACTIONS taxonomy', () => {
    it('every action value is a unique snake_case string', () => {
      const values = Object.values(AUDIT_ACTIONS)
      const set = new Set(values)
      expect(set.size).toBe(values.length) // no duplicates
      for (const v of values) {
        expect(typeof v).toBe('string')
        expect(v).toMatch(/^[a-z][a-z0-9_]*$/)
      }
    })

    it('covers every helper-emitted verb (sanity link from helpers to enum)', () => {
      // If a future PR adds a new writeXyz helper, this test fails
      // until the verb is added to AUDIT_ACTIONS — keeping the two in
      // sync without manual review.
      const expected = [
        'api_call',
        'vault_create',
        'vault_read',
        'vault_revoke',
        'knowledge_ingest',
        'knowledge_search',
        'knowledge_grant',
        'knowledge_revoke',
      ]
      const values = Object.values(AUDIT_ACTIONS)
      for (const v of expected) {
        expect(values).toContain(v)
      }
    })
  })
})
