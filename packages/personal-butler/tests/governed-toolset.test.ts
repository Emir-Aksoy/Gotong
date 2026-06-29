import { describe, expect, it } from 'vitest'

import { ButlerError, GovernedActionToolset, type GovernedToolSpec } from '../src/index.js'

const DELETE_SPEC: GovernedToolSpec = {
  name: 'delete_agent',
  description: 'Permanently delete a managed agent.',
  inputSchema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] },
}

describe('GovernedActionToolset — construction', () => {
  it('throws no_governed_tools when built with an empty tool list', () => {
    expect(() => new GovernedActionToolset({ tools: [], execute: async () => ({ text: 'x' }) })).toThrow(
      ButlerError,
    )
    try {
      new GovernedActionToolset({ tools: [], execute: async () => ({ text: 'x' }) })
    } catch (e) {
      expect((e as ButlerError).code).toBe('no_governed_tools')
    }
  })

  it('throws duplicate_governed_tool when two specs share a name', () => {
    try {
      new GovernedActionToolset({ tools: [DELETE_SPEC, { ...DELETE_SPEC }], execute: async () => ({ text: 'x' }) })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ButlerError)
      expect((e as ButlerError).code).toBe('duplicate_governed_tool')
    }
  })
})

describe('GovernedActionToolset — listTools / governs', () => {
  it('lists the declared tools and reports membership', () => {
    const ts = new GovernedActionToolset({ tools: [DELETE_SPEC], execute: async () => ({ text: 'ok' }) })
    const defs = ts.listTools()
    expect(defs).toHaveLength(1)
    expect(defs[0]!.name).toBe('delete_agent')
    expect(defs[0]!.description).toBe('Permanently delete a managed agent.')
    expect(ts.governs('delete_agent')).toBe(true)
    expect(ts.governs('echo')).toBe(false)
  })
})

describe('GovernedActionToolset — classify', () => {
  it('defaults a governed tool with no policy to approve (conservative)', async () => {
    const ts = new GovernedActionToolset({ tools: [DELETE_SPEC], execute: async () => ({ text: 'ok' }) })
    const v = await ts.classify('delete_agent', { handle: 'mailer' })
    expect(v.decision).toBe('approve')
  })

  it("uses a spec's defaultVerdict when no classifier is injected", async () => {
    const ts = new GovernedActionToolset({
      tools: [{ ...DELETE_SPEC, defaultVerdict: { decision: 'refuse', reason: 'never delete' } }],
      execute: async () => ({ text: 'ok' }),
    })
    const v = await ts.classify('delete_agent', { handle: 'mailer' })
    expect(v).toEqual({ decision: 'refuse', reason: 'never delete' })
  })

  it('prefers an injected classifier over the spec default', async () => {
    const ts = new GovernedActionToolset({
      tools: [{ ...DELETE_SPEC, defaultVerdict: { decision: 'refuse', reason: 'spec' } }],
      execute: async () => ({ text: 'ok' }),
      classify: async (name, args) =>
        args.handle === 'mailer' ? { decision: 'approve', reason: 'destructive' } : { decision: 'allow' },
    })
    expect(await ts.classify('delete_agent', { handle: 'mailer' })).toEqual({
      decision: 'approve',
      reason: 'destructive',
    })
    expect(await ts.classify('delete_agent', { handle: 'noop' })).toEqual({ decision: 'allow' })
  })
})

describe('GovernedActionToolset — describe', () => {
  it('renders a default human title from name + args', () => {
    const ts = new GovernedActionToolset({ tools: [DELETE_SPEC], execute: async () => ({ text: 'ok' }) })
    expect(ts.describe('delete_agent', { handle: 'mailer' })).toBe('delete_agent({"handle":"mailer"})')
  })

  it('truncates an over-long arg blob', () => {
    const ts = new GovernedActionToolset({ tools: [DELETE_SPEC], execute: async () => ({ text: 'ok' }) })
    const title = ts.describe('delete_agent', { handle: 'x'.repeat(400) })
    expect(title.length).toBeLessThan(140)
    expect(title.endsWith('…)')).toBe(true)
  })

  it('uses an injected describe', () => {
    const ts = new GovernedActionToolset({
      tools: [DELETE_SPEC],
      execute: async () => ({ text: 'ok' }),
      describe: (name, args) => `${name} → ${String(args.handle)}`,
    })
    expect(ts.describe('delete_agent', { handle: 'mailer' })).toBe('delete_agent → mailer')
  })
})

describe('GovernedActionToolset — callTool (execution is unconditional)', () => {
  it('runs the injected executor and shapes a text result — never re-classifies', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const ts = new GovernedActionToolset({
      tools: [DELETE_SPEC],
      // Even a refuse policy is irrelevant here — callTool runs only AFTER the
      // butler's loop cleared the gate, so it must not second-guess.
      classify: async () => ({ decision: 'refuse', reason: 'should be ignored by callTool' }),
      execute: async (name, args) => {
        calls.push({ name, args })
        return { text: `deleted ${String(args.handle)}` }
      },
    })
    const out = await ts.callTool('delete_agent', { handle: 'mailer' })
    expect(out.isError).toBeUndefined()
    expect(out.content).toEqual([{ type: 'text', text: 'deleted mailer' }])
    expect(calls).toEqual([{ name: 'delete_agent', args: { handle: 'mailer' } }])
  })

  it('propagates an executor isError flag', async () => {
    const ts = new GovernedActionToolset({
      tools: [DELETE_SPEC],
      execute: async () => ({ text: 'no such agent', isError: true }),
    })
    const out = await ts.callTool('delete_agent', { handle: 'ghost' })
    expect(out.isError).toBe(true)
    expect(out.content).toEqual([{ type: 'text', text: 'no such agent' }])
  })

  it('returns an isError result for an unknown tool (never reaches the executor)', async () => {
    let called = false
    const ts = new GovernedActionToolset({
      tools: [DELETE_SPEC],
      execute: async () => {
        called = true
        return { text: 'x' }
      },
    })
    const out = await ts.callTool('nope', {})
    expect(out.isError).toBe(true)
    expect(called).toBe(false)
  })
})
