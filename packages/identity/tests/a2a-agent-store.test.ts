/**
 * Route B P1-M11a — outbound A2A agent config store.
 *
 * The vault-free twin of saml-provider-store.test.ts: an outbound A2A agent
 * carries no confidential field — the bearer the remote demands is NOT stored,
 * only the NAME of the env var (`tokenEnv`) the host reads it from. So every
 * column round-trips through the projection, the store opens WITHOUT a master
 * key, and there is nothing to revoke on remove. The participant id is the PK;
 * a reused id is rejected. Capabilities round-trip as a JSON-backed string[].
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { openIdentityStore, IdentityStore, IdentityError } from '../src/index.js'

const URL_A = 'https://agent-a.example.com/a2a'

describe('A2aAgentStore (P1-M11a)', () => {
  let store: IdentityStore

  beforeEach(() => {
    // No masterKey on purpose: an outbound A2A agent has no secret in the DB
    // (the bearer stays in env), so registering one must NOT require a vault.
    store = openIdentityStore({ dbPath: ':memory:' })
  })

  it('round-trips the full config; the bearer itself is never stored', () => {
    const a = store.addA2aAgent({
      id: 'remote-writer',
      capabilities: ['draft', 'review'],
      url: URL_A,
      tokenEnv: 'WRITER_A2A_TOKEN',
      peerId: 'hub-a',
      targetSkill: 'compose',
      label: 'Partner writer',
    })
    expect(a.id).toBe('remote-writer')
    expect(a.capabilities).toEqual(['draft', 'review'])
    expect(a.url).toBe(URL_A)
    expect(a.tokenEnv).toBe('WRITER_A2A_TOKEN') // the env var NAME, not the secret
    expect(a.peerId).toBe('hub-a')
    expect(a.targetSkill).toBe('compose')
    expect(a.enabled).toBe(true)
    expect(a.label).toBe('Partner writer')
    // No field anywhere carries a token value — only its env var name.
    expect(JSON.stringify(a)).not.toContain('secret')
  })

  it('optional fields default to null; enabled defaults true', () => {
    const a = store.addA2aAgent({
      id: 'minimal',
      capabilities: ['chat'],
      url: URL_A,
      tokenEnv: 'TOK',
    })
    expect(a.peerId).toBeNull()
    expect(a.targetSkill).toBeNull()
    expect(a.label).toBeNull()
    expect(a.enabled).toBe(true)
  })

  it('persists across a list() and survives a reopen on the same db', () => {
    store.addA2aAgent({ id: 'one', capabilities: ['a'], url: URL_A, tokenEnv: 'T1' })
    store.addA2aAgent({ id: 'two', capabilities: ['b'], url: URL_A, tokenEnv: 'T2', enabled: false })
    const list = store.listA2aAgents()
    expect(list.map((a) => a.id)).toEqual(['one', 'two']) // created_at ASC
    expect(store.getA2aAgent('two')?.enabled).toBe(false)
  })

  it('rejects a reused id (the participant identity is the PK)', () => {
    store.addA2aAgent({ id: 'dup', capabilities: ['a'], url: URL_A, tokenEnv: 'T' })
    expect(() => store.addA2aAgent({ id: 'dup', capabilities: ['b'], url: URL_A, tokenEnv: 'T' })).toThrow(
      IdentityError,
    )
    try {
      store.addA2aAgent({ id: 'dup', capabilities: ['b'], url: URL_A, tokenEnv: 'T' })
    } catch (e) {
      expect((e as IdentityError).code).toBe('a2a_agent_exists')
    }
  })

  it('rejects empty id / url / tokenEnv and empty capabilities', () => {
    const ok = { id: 'x', capabilities: ['a'], url: URL_A, tokenEnv: 'T' }
    expect(() => store.addA2aAgent({ ...ok, id: '  ' })).toThrow(/id/)
    expect(() => store.addA2aAgent({ ...ok, url: '' })).toThrow(/url/)
    expect(() => store.addA2aAgent({ ...ok, tokenEnv: '' })).toThrow(/tokenEnv/)
    expect(() => store.addA2aAgent({ ...ok, capabilities: [] })).toThrow(/capabilities/)
    // whitespace-only capabilities collapse to empty → rejected
    expect(() => store.addA2aAgent({ ...ok, capabilities: ['   '] })).toThrow(/capabilities/)
  })

  it('targeted update keeps untouched fields; id is immutable', () => {
    store.addA2aAgent({
      id: 'edit-me',
      capabilities: ['draft'],
      url: URL_A,
      tokenEnv: 'TOK',
      peerId: 'hub-a',
      label: 'before',
    })
    // Change only url + enabled; capabilities / peerId / tokenEnv / label preserved.
    const u = store.updateA2aAgent('edit-me', { url: 'https://new.example/a2a', enabled: false })
    expect(u.url).toBe('https://new.example/a2a')
    expect(u.enabled).toBe(false)
    expect(u.capabilities).toEqual(['draft'])
    expect(u.peerId).toBe('hub-a')
    expect(u.tokenEnv).toBe('TOK')
    expect(u.label).toBe('before')
  })

  it('update can clear optional fields with empty / null', () => {
    store.addA2aAgent({
      id: 'clearable',
      capabilities: ['a'],
      url: URL_A,
      tokenEnv: 'T',
      peerId: 'hub-a',
      targetSkill: 'compose',
      label: 'lbl',
    })
    const u = store.updateA2aAgent('clearable', { peerId: '', targetSkill: null, label: '' })
    expect(u.peerId).toBeNull()
    expect(u.targetSkill).toBeNull()
    expect(u.label).toBeNull()
  })

  it('update on an unknown id throws a2a_agent_not_found', () => {
    try {
      store.updateA2aAgent('ghost', { enabled: false })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as IdentityError).code).toBe('a2a_agent_not_found')
    }
  })

  it('remove deletes and reports; a second remove is false', () => {
    store.addA2aAgent({ id: 'gone', capabilities: ['a'], url: URL_A, tokenEnv: 'T' })
    expect(store.removeA2aAgent('gone')).toBe(true)
    expect(store.getA2aAgent('gone')).toBeNull()
    expect(store.removeA2aAgent('gone')).toBe(false)
  })

  // --- Stream H2-OUT: opt-in long-running poll lifecycle (v32 `lifecycle` column) ---

  it('lifecycle defaults to null = blocking (legacy); the column is opt-in', () => {
    const a = store.addA2aAgent({ id: 'blocking', capabilities: ['chat'], url: URL_A, tokenEnv: 'T' })
    // Absent in the input → NULL column → null projection → blocking participant.
    expect(a.lifecycle).toBeNull()
    expect(store.getA2aAgent('blocking')?.lifecycle).toBeNull()
  })

  it('a tuned lifecycle object round-trips through the JSON column', () => {
    const a = store.addA2aAgent({
      id: 'long-runner',
      capabilities: ['review'],
      url: URL_A,
      tokenEnv: 'T',
      lifecycle: { pollIntervalMs: 5000, maxAttempts: 40 },
    })
    expect(a.lifecycle).toEqual({ pollIntervalMs: 5000, maxAttempts: 40 })
    // Survives a fresh read (it's persisted, not just echoed).
    expect(store.getA2aAgent('long-runner')?.lifecycle).toEqual({ pollIntervalMs: 5000, maxAttempts: 40 })
  })

  it('an empty lifecycle object = lifecycle ON with participant defaults (distinct from null = OFF)', () => {
    const a = store.addA2aAgent({
      id: 'defaults-on',
      capabilities: ['review'],
      url: URL_A,
      tokenEnv: 'T',
      lifecycle: {},
    })
    // `{}` is NOT null — it opts into the lifecycle, letting the participant floor
    // pollIntervalMs/maxAttempts. null would have meant blocking.
    expect(a.lifecycle).toEqual({})
    expect(a.lifecycle).not.toBeNull()
    expect(store.getA2aAgent('defaults-on')?.lifecycle).toEqual({})
  })

  it('a partial lifecycle keeps only the field given', () => {
    const a = store.addA2aAgent({
      id: 'partial',
      capabilities: ['review'],
      url: URL_A,
      tokenEnv: 'T',
      lifecycle: { maxAttempts: 12 },
    })
    expect(a.lifecycle).toEqual({ maxAttempts: 12 })
  })

  it('rejects a non-positive / non-number lifecycle field (fail-visible, not silently dropped)', () => {
    const base = { id: 'bad-life', capabilities: ['a'], url: URL_A, tokenEnv: 'T' }
    expect(() => store.addA2aAgent({ ...base, lifecycle: { pollIntervalMs: 0 } })).toThrow(/pollIntervalMs/)
    expect(() => store.addA2aAgent({ ...base, lifecycle: { pollIntervalMs: -1 } })).toThrow(/pollIntervalMs/)
    expect(() => store.addA2aAgent({ ...base, lifecycle: { maxAttempts: -5 } })).toThrow(/maxAttempts/)
    // a NaN is not a positive finite number → rejected
    expect(() => store.addA2aAgent({ ...base, lifecycle: { maxAttempts: Number.NaN } })).toThrow(/maxAttempts/)
    // a non-object non-null value → rejected with the object/null message
    expect(() => store.addA2aAgent({ ...base, lifecycle: 5 as never })).toThrow(/object or null/)
  })

  it('update sets a lifecycle on a previously-blocking agent', () => {
    store.addA2aAgent({ id: 'turn-on', capabilities: ['a'], url: URL_A, tokenEnv: 'T' })
    expect(store.getA2aAgent('turn-on')?.lifecycle).toBeNull()
    const u = store.updateA2aAgent('turn-on', { lifecycle: { pollIntervalMs: 2000 } })
    expect(u.lifecycle).toEqual({ pollIntervalMs: 2000 })
    expect(store.getA2aAgent('turn-on')?.lifecycle).toEqual({ pollIntervalMs: 2000 })
  })

  it('update with lifecycle: null turns it OFF (back to blocking)', () => {
    store.addA2aAgent({
      id: 'turn-off',
      capabilities: ['a'],
      url: URL_A,
      tokenEnv: 'T',
      lifecycle: { maxAttempts: 9 },
    })
    const u = store.updateA2aAgent('turn-off', { lifecycle: null })
    expect(u.lifecycle).toBeNull()
    expect(store.getA2aAgent('turn-off')?.lifecycle).toBeNull()
  })

  it('update with lifecycle omitted keeps the stored value untouched', () => {
    store.addA2aAgent({
      id: 'keep-life',
      capabilities: ['a'],
      url: URL_A,
      tokenEnv: 'T',
      lifecycle: { pollIntervalMs: 3000, maxAttempts: 20 },
    })
    // Change an unrelated field; lifecycle must be preserved (undefined = keep).
    const u = store.updateA2aAgent('keep-life', { label: 'renamed' })
    expect(u.label).toBe('renamed')
    expect(u.lifecycle).toEqual({ pollIntervalMs: 3000, maxAttempts: 20 })
  })

  // --- Item 2: outbound gate policy (v34 data-class / quota / approval columns) ---

  it('the gate columns default off — no contract, no quota, no approval (legacy)', () => {
    const a = store.addA2aAgent({ id: 'plain', capabilities: ['chat'], url: URL_A, tokenEnv: 'T' })
    expect(a.allowedDataClasses).toBeNull() // null = no contract (send anything)
    expect(a.outboundQuotaBudget).toBeNull()
    expect(a.requireApprovalOutbound).toBe(false)
    const re = store.getA2aAgent('plain')!
    expect(re.allowedDataClasses).toBeNull()
    expect(re.outboundQuotaBudget).toBeNull()
    expect(re.requireApprovalOutbound).toBe(false)
  })

  it('a data-class allowlist round-trips through the JSON column', () => {
    const a = store.addA2aAgent({
      id: 'classed',
      capabilities: ['draft'],
      url: URL_A,
      tokenEnv: 'T',
      allowedDataClasses: ['public', 'pii'],
    })
    expect(a.allowedDataClasses).toEqual(['public', 'pii'])
    expect(store.getA2aAgent('classed')?.allowedDataClasses).toEqual(['public', 'pii'])
  })

  it('an empty allowlist [] = lockdown — persisted and distinct from null = no contract', () => {
    const a = store.addA2aAgent({
      id: 'locked',
      capabilities: ['draft'],
      url: URL_A,
      tokenEnv: 'T',
      allowedDataClasses: [],
    })
    // [] round-trips to [] (the gate refuses every declared class); NOT null.
    expect(a.allowedDataClasses).toEqual([])
    expect(a.allowedDataClasses).not.toBeNull()
    expect(store.getA2aAgent('locked')?.allowedDataClasses).toEqual([])
  })

  it('allowlist trims + drops empty strings; a non-array value is rejected', () => {
    const a = store.addA2aAgent({
      id: 'trim',
      capabilities: ['draft'],
      url: URL_A,
      tokenEnv: 'T',
      allowedDataClasses: ['  pii  ', '', 'public'],
    })
    expect(a.allowedDataClasses).toEqual(['pii', 'public'])
    expect(() =>
      store.addA2aAgent({
        id: 'bad-class',
        capabilities: ['draft'],
        url: URL_A,
        tokenEnv: 'T',
        allowedDataClasses: 'pii' as never,
      }),
    ).toThrow(/allowedDataClasses/)
  })

  it('a quota budget round-trips; 0 persists (off) and negative is rejected', () => {
    const a = store.addA2aAgent({
      id: 'quota',
      capabilities: ['draft'],
      url: URL_A,
      tokenEnv: 'T',
      outboundQuotaBudget: 25,
    })
    expect(a.outboundQuotaBudget).toBe(25)
    expect(store.getA2aAgent('quota')?.outboundQuotaBudget).toBe(25)
    // 0 is a persisted "off" (distinct from null = absent), faithfully kept.
    const z = store.addA2aAgent({ id: 'zero', capabilities: ['d'], url: URL_A, tokenEnv: 'T', outboundQuotaBudget: 0 })
    expect(z.outboundQuotaBudget).toBe(0)
    // negative / non-finite → fail-visible
    expect(() =>
      store.addA2aAgent({ id: 'neg', capabilities: ['d'], url: URL_A, tokenEnv: 'T', outboundQuotaBudget: -1 }),
    ).toThrow(/outboundQuotaBudget/)
  })

  it('requireApprovalOutbound round-trips true and toggles back off', () => {
    const a = store.addA2aAgent({
      id: 'gated',
      capabilities: ['draft'],
      url: URL_A,
      tokenEnv: 'T',
      requireApprovalOutbound: true,
    })
    expect(a.requireApprovalOutbound).toBe(true)
    expect(store.getA2aAgent('gated')?.requireApprovalOutbound).toBe(true)
    const u = store.updateA2aAgent('gated', { requireApprovalOutbound: false })
    expect(u.requireApprovalOutbound).toBe(false)
  })

  it('update sets the gate fields; omitting them keeps the stored values', () => {
    store.addA2aAgent({
      id: 'evolve',
      capabilities: ['draft'],
      url: URL_A,
      tokenEnv: 'T',
      allowedDataClasses: ['public'],
      outboundQuotaBudget: 10,
      requireApprovalOutbound: true,
    })
    // Touch only the label; every gate field must be preserved (undefined = keep).
    const kept = store.updateA2aAgent('evolve', { label: 'renamed' })
    expect(kept.allowedDataClasses).toEqual(['public'])
    expect(kept.outboundQuotaBudget).toBe(10)
    expect(kept.requireApprovalOutbound).toBe(true)
    // null clears the allowlist (back to no contract); 0 clears the quota.
    const cleared = store.updateA2aAgent('evolve', { allowedDataClasses: null, outboundQuotaBudget: null })
    expect(cleared.allowedDataClasses).toBeNull()
    expect(cleared.outboundQuotaBudget).toBeNull()
  })
})
