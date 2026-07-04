import { describe, expect, it } from 'vitest'

import { MemoryToolset } from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

function textOf(result: { content: ReadonlyArray<unknown> }): string {
  return (result.content[0] as { text: string }).text
}

describe('MemoryToolset', () => {
  it('advertises remember/remember_procedure/recall/forget with LLM-safe names', () => {
    const ts = new MemoryToolset({ memory: makeFakeMemory() })
    const names = ts.listTools().map((t) => t.name)
    expect(names).toEqual([
      'remember',
      'remember_procedure',
      'refine_procedure',
      'recall',
      'forget',
    ])
    for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('remember → recall round-trips, defaulting to semantic kind', async () => {
    const mem = makeFakeMemory()
    const ts = new MemoryToolset({ memory: mem })

    const r = await ts.callTool('remember', { text: 'user prefers morning workouts' })
    expect(r.isError).toBeFalsy()
    expect(mem.entries.some((e) => e.kind === 'semantic' && e.text.includes('morning'))).toBe(true)

    const recall = await ts.callTool('recall', { query: 'morning' })
    expect(recall.isError).toBeFalsy()
    expect(textOf(recall)).toContain('morning workouts')
  })

  it('remember accepts an explicit writable kind', async () => {
    const mem = makeFakeMemory()
    const ts = new MemoryToolset({ memory: mem })
    await ts.callTool('remember', { text: 'logged a thing', kind: 'episodic' })
    expect(mem.entries[0]!.kind).toBe('episodic')
  })

  it('rejects a non-writable kind', async () => {
    const ts = new MemoryToolset({ memory: makeFakeMemory(), writableKinds: ['semantic'] })
    const r = await ts.callTool('remember', { text: 'x', kind: 'episodic' })
    expect(r.isError).toBe(true)
  })

  it('rejects empty / whitespace-only text', async () => {
    const ts = new MemoryToolset({ memory: makeFakeMemory() })
    const r = await ts.callTool('remember', { text: '   ' })
    expect(r.isError).toBe(true)
  })

  it('recall returns a friendly message when nothing matches', async () => {
    const ts = new MemoryToolset({ memory: makeFakeMemory() })
    const r = await ts.callTool('recall', { query: 'nope' })
    expect(textOf(r)).toContain('No matching memories')
  })

  it('forget removes an entry by id; missing id is a no-op (not an error)', async () => {
    const mem = makeFakeMemory([
      entry('keep', 'semantic', 'keep me', 100),
      entry('drop', 'semantic', 'drop me', 200),
    ])
    const ts = new MemoryToolset({ memory: mem })
    await ts.callTool('forget', { id: 'drop' })
    expect(mem.entries.map((e) => e.id)).toEqual(['keep'])

    const r = await ts.callTool('forget', { id: 'ghost' })
    expect(r.isError).toBeFalsy()
  })

  it('unknown tool → isError', async () => {
    const ts = new MemoryToolset({ memory: makeFakeMemory() })
    const r = await ts.callTool('nope', {})
    expect(r.isError).toBe(true)
  })

  it('remember records importance into meta; recall shows it and filters by minImportance', async () => {
    const mem = makeFakeMemory()
    const ts = new MemoryToolset({ memory: mem })

    await ts.callTool('remember', { text: 'master key location', importance: 5 })
    await ts.callTool('remember', { text: 'idle small talk', importance: 1 })

    const stored = mem.entries.find((e) => e.text.includes('master key'))!
    expect((stored.meta as { importance?: number }).importance).toBe(5)

    // recall surfaces the importance marker (p5)
    const all = await ts.callTool('recall', { query: '' })
    expect(textOf(all)).toMatch(/p5/)

    // minImportance filters out the trivial entry
    const important = await ts.callTool('recall', { minImportance: 4 })
    expect(textOf(important)).toContain('master key location')
    expect(textOf(important)).not.toContain('idle small talk')
  })

  it('clamps an out-of-range importance into 1..5', async () => {
    const mem = makeFakeMemory()
    const ts = new MemoryToolset({ memory: mem })
    await ts.callTool('remember', { text: 'over the top', importance: 99 })
    expect((mem.entries[0]!.meta as { importance?: number }).importance).toBe(5)
  })

  it('recall filters by tier and tags the cluster in the output line', async () => {
    const mem = makeFakeMemory([
      entry('p1', 'semantic', 'works at a tea shop', 100, { tier: 'projects', importance: 4 }),
      entry('q1', 'semantic', 'allergic to peanuts', 101, { tier: 'persona', importance: 5 }),
      entry('u1', 'semantic', 'untagged note', 102),
    ])
    const ts = new MemoryToolset({ memory: mem })

    const proj = await ts.callTool('recall', { tier: 'projects' })
    const projText = textOf(proj)
    expect(projText).toContain('tea shop')
    expect(projText).toContain('semantic/projects') // cluster tag shown
    expect(projText).not.toContain('peanuts') // other cluster filtered out
    expect(projText).not.toContain('untagged note')

    // an untagged entry shows just the kind (no slash), and is excluded by a tier filter
    const all = await ts.callTool('recall', { query: 'untagged' })
    expect(textOf(all)).toMatch(/\[u1\] \(semantic, p3,/)
  })

  it('recall clamps k to the hard cap', async () => {
    const seed = Array.from({ length: 80 }, (_, i) =>
      entry(`e${i}`, 'episodic', `note ${i}`, 1000 + i),
    )
    const ts = new MemoryToolset({ memory: makeFakeMemory(seed) })
    const r = await ts.callTool('recall', { k: 999 })
    const lines = textOf(r).split('\n')
    expect(lines.length).toBeLessThanOrEqual(50)
  })

  describe('recall link expansion (E-M3) — opt-in', () => {
    // s1 matches "preferences" and links to s2/s3 (which do NOT match the query);
    // they should only appear via one-hop expansion, marked `↪`.
    function seeded() {
      return makeFakeMemory([
        entry('s1', 'semantic', 'tea preferences', 300, { links: ['s2', 's3'] }),
        entry('s2', 'semantic', 'favorite tea shop', 200),
        entry('s3', 'semantic', 'tea brewing notes', 100),
        entry('u1', 'semantic', 'basketball schedule', 50),
      ])
    }
    const lookup = (mem: ReturnType<typeof seeded>) => (ids: readonly string[]) =>
      ids.map((id) => mem.entries.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => !!e)

    it('does not expand by default (no linkLookup)', async () => {
      const mem = seeded()
      const ts = new MemoryToolset({ memory: mem })
      const out = textOf(await ts.callTool('recall', { query: 'preferences' }))
      expect(out).toContain('[s1] (semantic')
      expect(out).not.toContain('s2')
      expect(out).not.toContain('↪')
    })

    it('appends one-hop neighbors marked ↪ when linkLookup is set', async () => {
      const mem = seeded()
      const ts = new MemoryToolset({ memory: mem, linkLookup: lookup(mem) })
      const out = textOf(await ts.callTool('recall', { query: 'preferences' }))
      expect(out).toMatch(/(?<!↪ )\[s1\] \(semantic/) // seed: no marker
      expect(out).toContain('↪ [s2]')
      expect(out).toContain('↪ [s3]')
      expect(out).not.toContain('u1') // unrelated, never linked
    })

    it('caps expansion at expandK', async () => {
      const mem = seeded()
      const ts = new MemoryToolset({ memory: mem, linkLookup: lookup(mem), expandK: 1 })
      const out = textOf(await ts.callTool('recall', { query: 'preferences' }))
      const neighbors = out.split('\n').filter((l) => l.startsWith('↪ '))
      expect(neighbors).toHaveLength(1) // only the first linked neighbor
    })

    it('is best-effort: a throwing lookup yields the un-expanded seeds, not an error', async () => {
      const mem = seeded()
      const boom = () => {
        throw new Error('lookup down')
      }
      const ts = new MemoryToolset({ memory: mem, linkLookup: boom })
      const r = await ts.callTool('recall', { query: 'preferences' })
      expect(r.isError).toBeFalsy()
      expect(textOf(r)).toContain('[s1]')
      expect(textOf(r)).not.toContain('↪')
    })
  })

  describe('procedural memory (G-M1)', () => {
    it('stores form+steps as a semantic entry; recall form="procedure" shows steps inline', async () => {
      const mem = makeFakeMemory()
      const ts = new MemoryToolset({ memory: mem })

      const r = await ts.callTool('remember_procedure', {
        name: 'get an overtime claim approved',
        steps: ['draft the claim', 'check the policy', 'route to the manager'],
      })
      expect(r.isError).toBeFalsy()
      expect(textOf(r)).toMatch(/3 step/)

      const stored = mem.entries.find((e) => (e.meta as { form?: string }).form === 'procedure')!
      expect(stored.kind).toBe('semantic')
      expect((stored.meta as { steps?: string[] }).steps).toEqual([
        'draft the claim',
        'check the policy',
        'route to the manager',
      ])

      await ts.callTool('remember', { text: 'likes oat milk' }) // a plain fact

      const procs = await ts.callTool('recall', { form: 'procedure' })
      const out = textOf(procs)
      expect(out).toContain('get an overtime claim approved')
      expect(out).toContain(
        'steps: 1. draft the claim; 2. check the policy; 3. route to the manager',
      )
      expect(out).not.toContain('oat milk') // non-procedure filtered out by form
    })

    it('a procedure also surfaces in an unfiltered recall, carrying its steps', async () => {
      const mem = makeFakeMemory()
      const ts = new MemoryToolset({ memory: mem })
      await ts.callTool('remember_procedure', { name: 'brew tea', steps: ['boil', 'steep'] })
      await ts.callTool('remember', { text: 'likes oat milk' })

      const out = textOf(await ts.callTool('recall', { query: '' }))
      expect(out).toContain('brew tea — steps: 1. boil; 2. steep')
      expect(out).toContain('oat milk') // a plain fact has no steps suffix
      expect(out).not.toMatch(/oat milk[^\n]*steps:/)
    })

    it('rejects an empty name or empty/blank steps', async () => {
      const ts = new MemoryToolset({ memory: makeFakeMemory() })
      expect((await ts.callTool('remember_procedure', { name: '  ', steps: ['x'] })).isError).toBe(
        true,
      )
      expect((await ts.callTool('remember_procedure', { name: 'x', steps: [] })).isError).toBe(true)
      expect(
        (await ts.callTool('remember_procedure', { name: 'x', steps: ['', '   '] })).isError,
      ).toBe(true)
    })

    it('refuses to record a procedure when semantic is not writable', async () => {
      const ts = new MemoryToolset({ memory: makeFakeMemory(), writableKinds: ['episodic'] })
      const r = await ts.callTool('remember_procedure', { name: 'x', steps: ['a'] })
      expect(r.isError).toBe(true)
    })
  })

  describe('refine_procedure (MR3 ② self-improve)', () => {
    async function seedProcedure(): Promise<{ mem: ReturnType<typeof makeFakeMemory>; ts: MemoryToolset; id: string }> {
      const mem = makeFakeMemory()
      const ts = new MemoryToolset({ memory: mem })
      await ts.callTool('remember_procedure', { name: 'brew tea', steps: ['boil', 'steep'] })
      const id = mem.entries.find((e) => (e.meta as { form?: string }).form === 'procedure')!.id
      return { mem, ts, id }
    }

    it('replaces the steps in place, keeping the same id/name', async () => {
      const { mem, ts, id } = await seedProcedure()
      const r = await ts.callTool('refine_procedure', { id, steps: ['boil', 'warm pot', 'steep 3min'] })
      expect(r.isError).toBeFalsy()
      const after = mem.entries.find((e) => e.id === id)!
      expect(after.text).toBe('brew tea') // name unchanged
      expect((after.meta as { steps?: string[] }).steps).toEqual(['boil', 'warm pot', 'steep 3min'])
      // No new entry was minted — still exactly one procedure.
      expect(mem.entries.filter((e) => (e.meta as { form?: string }).form === 'procedure')).toHaveLength(1)
    })

    it('appends steps to the end with appendSteps', async () => {
      const { mem, ts, id } = await seedProcedure()
      const r = await ts.callTool('refine_procedure', { id, appendSteps: ['pour', 'serve'] })
      expect(r.isError).toBeFalsy()
      expect((mem.entries.find((e) => e.id === id)!.meta as { steps?: string[] }).steps).toEqual([
        'boil',
        'steep',
        'pour',
        'serve',
      ])
    })

    it('a refined procedure surfaces its new steps on recall', async () => {
      const { ts, id } = await seedProcedure()
      await ts.callTool('refine_procedure', { id, steps: ['boil', 'steep', 'enjoy'] })
      const out = textOf(await ts.callTool('recall', { form: 'procedure' }))
      expect(out).toContain('steps: 1. boil; 2. steep; 3. enjoy')
    })

    it('rejects giving both steps and appendSteps, or neither', async () => {
      const { ts, id } = await seedProcedure()
      expect((await ts.callTool('refine_procedure', { id, steps: ['a'], appendSteps: ['b'] })).isError).toBe(true)
      expect((await ts.callTool('refine_procedure', { id })).isError).toBe(true)
      expect((await ts.callTool('refine_procedure', { id, steps: [] })).isError).toBe(true)
    })

    it('rejects an unknown id or a non-procedure target', async () => {
      const mem = makeFakeMemory()
      const ts = new MemoryToolset({ memory: mem })
      // unknown id
      expect((await ts.callTool('refine_procedure', { id: 'nope', steps: ['x'] })).isError).toBe(true)
      // a plain semantic fact is not a procedure
      await ts.callTool('remember', { text: 'likes oat milk' })
      const factId = mem.entries.find((e) => e.text.includes('oat milk'))!.id
      expect((await ts.callTool('refine_procedure', { id: factId, steps: ['x'] })).isError).toBe(true)
    })

    it('errors when the backend cannot amend meta in place', async () => {
      // Strip patchMeta from an otherwise-normal handle.
      const base = makeFakeMemory()
      await base.remember({ kind: 'semantic', text: 'brew tea', meta: { form: 'procedure', steps: ['boil'] } })
      const noPatch = {
        recall: base.recall.bind(base),
        remember: base.remember.bind(base),
        list: base.list.bind(base),
        forget: base.forget.bind(base),
        clear: base.clear.bind(base),
      } as unknown as import('@gotong/services-sdk').MemoryHandle
      const ts = new MemoryToolset({ memory: noPatch })
      const r = await ts.callTool('refine_procedure', { id: 'm1', steps: ['x'] })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toMatch(/cannot revise/i)
    })
  })
})
