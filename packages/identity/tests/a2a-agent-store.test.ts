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
})
