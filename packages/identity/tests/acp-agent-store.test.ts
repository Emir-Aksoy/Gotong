/**
 * ACP-OUT-M1 — outbound ACP agent config store.
 *
 * The vault-free twin of a2a-agent-store.test.ts, one step purer: an outbound
 * ACP agent carries NO confidential field and not even an env-var pointer — ACP
 * bridges authenticate with the underlying agent's own login. So every column
 * round-trips through the projection, the store opens WITHOUT a master key, and
 * there is nothing to revoke on remove. The participant id is the PK; a reused
 * id is rejected. Capabilities and args round-trip as JSON-backed string[].
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { openIdentityStore, IdentityStore, IdentityError } from '../src/index.js'

describe('AcpAgentStore (ACP-OUT-M1)', () => {
  let store: IdentityStore

  beforeEach(() => {
    // No masterKey on purpose: an outbound ACP agent has no secret in the DB
    // (it rides the agent's own login), so registering one must NOT require a vault.
    store = openIdentityStore({ dbPath: ':memory:' })
  })

  it('round-trips the full config; no credential is ever stored', () => {
    const a = store.addAcpAgent({
      id: 'claude-code',
      capabilities: ['code', 'review'],
      command: 'npx',
      args: ['@zed-industries/claude-code-acp'],
      cwd: '/repos/app',
      label: 'My Claude Code',
    })
    expect(a.id).toBe('claude-code')
    expect(a.capabilities).toEqual(['code', 'review'])
    expect(a.command).toBe('npx')
    expect(a.args).toEqual(['@zed-industries/claude-code-acp'])
    expect(a.cwd).toBe('/repos/app')
    expect(a.enabled).toBe(true)
    expect(a.label).toBe('My Claude Code')
    // Nothing credential-shaped anywhere — ACP rides the agent's own login.
    expect(JSON.stringify(a)).not.toContain('token')
    expect(JSON.stringify(a)).not.toContain('secret')
  })

  it('optional fields default; args default to []; enabled defaults true', () => {
    const a = store.addAcpAgent({
      id: 'minimal',
      capabilities: ['code'],
      command: 'codex-acp',
    })
    expect(a.args).toEqual([]) // a bare binary may take no args
    expect(a.cwd).toBeNull()
    expect(a.label).toBeNull()
    expect(a.enabled).toBe(true)
  })

  it('persists across a list() and survives a reopen on the same db', () => {
    store.addAcpAgent({ id: 'one', capabilities: ['a'], command: 'npx', args: ['x'] })
    store.addAcpAgent({ id: 'two', capabilities: ['b'], command: 'codex-acp', enabled: false })
    const list = store.listAcpAgents()
    expect(list.map((a) => a.id)).toEqual(['one', 'two']) // created_at ASC
    expect(store.getAcpAgent('two')?.enabled).toBe(false)
    expect(store.getAcpAgent('one')?.args).toEqual(['x'])
  })

  it('rejects a reused id (the participant identity is the PK)', () => {
    store.addAcpAgent({ id: 'dup', capabilities: ['a'], command: 'npx' })
    expect(() => store.addAcpAgent({ id: 'dup', capabilities: ['b'], command: 'npx' })).toThrow(
      IdentityError,
    )
    try {
      store.addAcpAgent({ id: 'dup', capabilities: ['b'], command: 'npx' })
    } catch (e) {
      expect((e as IdentityError).code).toBe('acp_agent_exists')
    }
  })

  it('rejects empty id / command, empty capabilities, and non-array args', () => {
    const ok = { id: 'x', capabilities: ['a'], command: 'npx' }
    expect(() => store.addAcpAgent({ ...ok, id: '  ' })).toThrow(/id/)
    expect(() => store.addAcpAgent({ ...ok, command: '' })).toThrow(/command/)
    expect(() => store.addAcpAgent({ ...ok, capabilities: [] })).toThrow(/capabilities/)
    // whitespace-only capabilities collapse to empty → rejected
    expect(() => store.addAcpAgent({ ...ok, capabilities: ['   '] })).toThrow(/capabilities/)
    // args must be an array if present
    expect(() => store.addAcpAgent({ ...ok, args: 'oops' as unknown as string[] })).toThrow(/args/)
  })

  it('targeted update keeps untouched fields; id is immutable', () => {
    store.addAcpAgent({
      id: 'edit-me',
      capabilities: ['code'],
      command: 'npx',
      args: ['@zed-industries/claude-code-acp'],
      cwd: '/repos/a',
      label: 'before',
    })
    // Change only command + enabled; capabilities / args / cwd / label preserved.
    const u = store.updateAcpAgent('edit-me', { command: 'codex-acp', enabled: false })
    expect(u.command).toBe('codex-acp')
    expect(u.enabled).toBe(false)
    expect(u.capabilities).toEqual(['code'])
    expect(u.args).toEqual(['@zed-industries/claude-code-acp'])
    expect(u.cwd).toBe('/repos/a')
    expect(u.label).toBe('before')
  })

  it('update can replace args and clear optional fields with empty / null', () => {
    store.addAcpAgent({
      id: 'clearable',
      capabilities: ['a'],
      command: 'npx',
      args: ['old'],
      cwd: '/repos/x',
      label: 'lbl',
    })
    const u = store.updateAcpAgent('clearable', { args: [], cwd: '', label: null })
    expect(u.args).toEqual([])
    expect(u.cwd).toBeNull()
    expect(u.label).toBeNull()
  })

  it('update on an unknown id throws acp_agent_not_found', () => {
    try {
      store.updateAcpAgent('ghost', { enabled: false })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as IdentityError).code).toBe('acp_agent_not_found')
    }
  })

  it('remove deletes and reports; a second remove is false', () => {
    store.addAcpAgent({ id: 'gone', capabilities: ['a'], command: 'npx' })
    expect(store.removeAcpAgent('gone')).toBe(true)
    expect(store.getAcpAgent('gone')).toBeNull()
    expect(store.removeAcpAgent('gone')).toBe(false)
  })

  // --- Item 2: outbound gate policy (v34 data-class / quota columns; ACP has no approval) ---

  it('the gate columns default off — no contract, no quota (legacy)', () => {
    const a = store.addAcpAgent({ id: 'plain', capabilities: ['code'], command: 'npx' })
    expect(a.allowedDataClasses).toBeNull() // null = no contract (governance off)
    expect(a.outboundQuotaBudget).toBeNull()
    const re = store.getAcpAgent('plain')!
    expect(re.allowedDataClasses).toBeNull()
    expect(re.outboundQuotaBudget).toBeNull()
    // ACP carries no approval field at all (D5/D6 — it escalates per-tool).
    expect('requireApprovalOutbound' in re).toBe(false)
  })

  it('a data-class allowlist round-trips; [] = lockdown (distinct from null)', () => {
    const a = store.addAcpAgent({
      id: 'classed',
      capabilities: ['code'],
      command: 'npx',
      allowedDataClasses: ['public', 'pii'],
    })
    expect(a.allowedDataClasses).toEqual(['public', 'pii'])
    expect(store.getAcpAgent('classed')?.allowedDataClasses).toEqual(['public', 'pii'])
    const locked = store.addAcpAgent({ id: 'locked', capabilities: ['code'], command: 'npx', allowedDataClasses: [] })
    expect(locked.allowedDataClasses).toEqual([])
    expect(locked.allowedDataClasses).not.toBeNull()
  })

  it('allowlist trims + drops empties; a non-array value is rejected', () => {
    const a = store.addAcpAgent({
      id: 'trim',
      capabilities: ['code'],
      command: 'npx',
      allowedDataClasses: ['  pii  ', '', 'public'],
    })
    expect(a.allowedDataClasses).toEqual(['pii', 'public'])
    expect(() =>
      store.addAcpAgent({ id: 'bad', capabilities: ['code'], command: 'npx', allowedDataClasses: 'pii' as never }),
    ).toThrow(/allowedDataClasses/)
  })

  it('a quota budget round-trips; 0 persists (off) and negative is rejected', () => {
    const a = store.addAcpAgent({ id: 'quota', capabilities: ['code'], command: 'npx', outboundQuotaBudget: 30 })
    expect(a.outboundQuotaBudget).toBe(30)
    expect(store.getAcpAgent('quota')?.outboundQuotaBudget).toBe(30)
    const z = store.addAcpAgent({ id: 'zero', capabilities: ['code'], command: 'npx', outboundQuotaBudget: 0 })
    expect(z.outboundQuotaBudget).toBe(0)
    expect(() =>
      store.addAcpAgent({ id: 'neg', capabilities: ['code'], command: 'npx', outboundQuotaBudget: -3 }),
    ).toThrow(/outboundQuotaBudget/)
  })

  it('update sets the gate fields; omitting keeps them; null/null clears', () => {
    store.addAcpAgent({
      id: 'evolve',
      capabilities: ['code'],
      command: 'npx',
      allowedDataClasses: ['public'],
      outboundQuotaBudget: 12,
    })
    const kept = store.updateAcpAgent('evolve', { label: 'renamed' })
    expect(kept.allowedDataClasses).toEqual(['public'])
    expect(kept.outboundQuotaBudget).toBe(12)
    const cleared = store.updateAcpAgent('evolve', { allowedDataClasses: null, outboundQuotaBudget: null })
    expect(cleared.allowedDataClasses).toBeNull()
    expect(cleared.outboundQuotaBudget).toBeNull()
  })
})
