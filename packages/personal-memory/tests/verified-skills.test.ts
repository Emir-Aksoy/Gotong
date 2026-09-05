import { describe, expect, it } from 'vitest'
import * as api from '../src/index.js'
import { makeFakeMemory, entry } from './fake-memory.js'

const draft = { name: 'normalize', steps: ['Return uppercase'], sources: ['episode'],
  conditions: ['Text input'], counterexamples: ['Do not change numbers'] }
const cases = [{ input: 'hello', expected: 'HELLO' }, { input: '123', expected: '123' }]

async function setup() {
  const memory = makeFakeMemory([entry('episode', 'episodic', 'normalized a word', 1)])
  const service = new api.VerifiedSkills({ memory, userId: 'alice', runner: async ({ input, steps }) => ({
    output: steps.length ? input.toUpperCase() : input, model: 'test-model@1',
  }) })
  const candidate = await service.create(draft)
  return { memory, service, candidate }
}

describe('verified personal skills', () => {
  it('keeps published applicability boundaries in every prompt mode, or omits the whole skill', async () => {
    const { service, candidate } = await setup()
    await service.approveTests(candidate.id, cases)
    await service.verify(candidate.id)
    await service.publish(candidate.id)
    await service.revise(candidate.id, ['Different draft'], { ...draft, conditions: ['DRAFT ONLY'] })
    const e = await service.get(candidate.id)
    expect(api.publishedProcedure(e)?.meta).toMatchObject({ conditions: draft.conditions, counterexamples: draft.counterexamples })
    for (const render of [api.renderFrozenBlock, api.renderClusteredFrozenBlock]) {
      for (const showProcedures of [true, false]) {
        const text = render([e], { showProcedures })
        expect(text).toContain('Text input')
        expect(text).toContain('Do not change numbers')
        expect(text).not.toContain('DRAFT ONLY')
        expect(render([e], { showProcedures, maxChars: 20 })).not.toContain('Return uppercase')
      }
    }
  })

  it('stores an untested candidate, not a published skill', async () => {
    const { candidate } = await setup()
    expect(api.skillStatus(candidate)).toBe('untested')
    expect(api.publishedProcedure(candidate)).toBeNull()
    expect(api.renderFrozenBlock([candidate], { showProcedures: true })).not.toContain('normalize')
  })

  it('requires trusted approved tests; deterministically compares both arms', async () => {
    const { service, candidate } = await setup()
    await expect(service.verify(candidate.id)).rejects.toThrow(/approved/i)
    await service.approveTests(candidate.id, cases)
    const evidence = await service.verify(candidate.id)
    expect(evidence.status).toBe('passed')
    expect(evidence.results.map((r) => [r.baselinePassed, r.candidatePassed])).toEqual([[false, true], [true, true]])
    expect(evidence.model).toBe('test-model@1')
    expect(api.publishedProcedure(await service.get(candidate.id))).toBeNull()
    await service.publish(candidate.id)
    expect(api.publishedProcedure(await service.get(candidate.id))?.meta?.steps).toEqual(draft.steps)
  })

  it('preserves immutable versions, invalidates new steps, and rolls back', async () => {
    const { service, candidate } = await setup()
    await service.approveTests(candidate.id, cases)
    await service.verify(candidate.id)
    await service.publish(candidate.id)
    const before = (await service.get(candidate.id)).meta!.skill
    await service.revise(candidate.id, ['Return uppercase, leave digits unchanged'])
    const revised = await service.get(candidate.id)
    expect(api.skillStatus(revised)).toBe('untested')
    expect((revised.meta!.skill as any).versions[0]).toEqual((before as any).versions[0])
    await expect(service.publish(candidate.id)).rejects.toThrow(/passed/i)
    expect(api.publishedProcedure(revised)?.meta?.steps).toEqual(draft.steps)
    await service.verify(candidate.id)
    await service.publish(candidate.id)
    await service.rollback(candidate.id)
    expect(api.publishedProcedure(await service.get(candidate.id))?.meta?.steps).toEqual(draft.steps)
  })

  it('does not accept self-reported passed or a forged expected in tool calls', async () => {
    const { memory, service, candidate } = await setup()
    const tools = new api.MemoryToolset({ memory, skills: service })
    for (const name of ['verify_procedure', 'publish_procedure']) {
      const result = await tools.callTool(name, { id: candidate.id, passed: true, expected: 'anything' })
      expect(result.isError).toBe(true)
    }
    expect(tools.listTools().some((t) => t.name === 'approve_procedure_tests')).toBe(false)
    expect(api.skillStatus(await service.get(candidate.id))).toBe('untested')
  })

  it('failure, model identity drift, and stored-step tampering fail closed', async () => {
    const { service, memory, candidate } = await setup()
    await service.approveTests(candidate.id, [{ input: 'hello', expected: 'not HELLO' }])
    expect((await service.verify(candidate.id)).status).toBe('failed')
    await expect(service.publish(candidate.id)).rejects.toThrow(/passed/i)
    await service.approveTests(candidate.id, cases)
    await service.verify(candidate.id)
    await memory.patchMeta!(candidate.id, { steps: ['Forged steps'] })
    await expect(service.publish(candidate.id)).rejects.toThrow(/fingerprint/i)
    expect(api.publishedProcedure(await service.get(candidate.id))).toBeNull()
  })

  it('cannot resolve another user source, candidate, or approval', async () => {
    const { candidate } = await setup()
    const other = new api.VerifiedSkills({ memory: makeFakeMemory(), userId: 'bob' })
    await expect(other.create(draft)).rejects.toThrow(/source/i)
    await expect(other.get(candidate.id)).rejects.toThrow(/not found/i)
    await expect(other.approveTests(candidate.id, cases)).rejects.toThrow(/not found/i)
  })

  it('labels old skills unverified without inventing evidence', () => {
    const old = entry('old', 'semantic', 'legacy', 1, { form: 'procedure', steps: ['run'] })
    expect(api.skillStatus(old)).toBe('unverified')
    expect(api.publishedProcedure(old)).toBeNull()
  })

  it('auto-author and umbrella produce untested versions with sources, never retire a publication', async () => {
    const { service, memory, candidate } = await setup()
    await service.approveTests(candidate.id, cases)
    await service.verify(candidate.id)
    await service.publish(candidate.id)
    await service.create({ ...draft, name: 'normalize variant' })
    const ctx = { memory, now: 5000, episodic: [], semantic: [] } as any
    await api.umbrellaReviewer({ merge: async () => ({ ...draft, name: 'master normalize', steps: ['uppercase'] }), minSimilarity: 0 })(ctx)
    const umbrella = memory.entries.find((e) => e.meta?.umbrella)!
    expect(api.skillStatus(umbrella)).toBe('untested')
    expect((api.skillState(umbrella)!.versions[0]!.sources)).toContain(candidate.id)
    expect(api.isActive(await service.get(candidate.id), 6000)).toBe(true)
    expect(api.publishedProcedure(await service.get(candidate.id))).not.toBeNull()
    const episodes = ['e1', 'e2', 'e3'].map((id) => entry(id, 'episodic', 'repeat same task', 10))
    const authoredMemory = makeFakeMemory(episodes)
    const authorCtx = { ...ctx, memory: authoredMemory, episodic: episodes }
    await api.procedureAuthoringReviewer({ draft: async () => ({ name: 'incomplete', steps: ['do task'] }) })(authorCtx)
    expect((await authoredMemory.list()).some((e) => e.text === 'incomplete')).toBe(false)
    await api.procedureAuthoringReviewer({ draft: async () => ({ ...draft, name: 'authored', steps: ['do task'] }) })(authorCtx)
    const authored = authoredMemory.entries.find((e) => e.meta?.authored)!
    expect(api.skillStatus(authored)).toBe('untested')
    expect(api.skillState(authored)!.versions[0]!.sources).toEqual(['e1', 'e2', 'e3'])
  })

  it.each([undefined, {}, { output: '', model: 'test' }, { output: 'HELLO', model: '' }])('fails closed for invalid runner output %j', async (output) => {
    const { service, memory, candidate } = await setup()
    await service.approveTests(candidate.id, [{ input: 'hello', expected: 'HELLO' }])
    let n = 0
    const broken = new api.VerifiedSkills({ memory, runner: async () => ++n === 1 ? output as any : { output: 'HELLO', model: 'test' } })
    expect((await broken.verify(candidate.id)).status).toBe('failed')
    await expect(broken.publish(candidate.id)).rejects.toThrow(/passed/i)
  })

  it('serializes separate services on the same skill; in-flight proof cannot publish revised steps', async () => {
    const { service, memory, candidate } = await setup()
    await service.approveTests(candidate.id, cases)
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>((r) => { started = r })
    const gate = new Promise<void>((r) => { release = r })
    const slow = new api.VerifiedSkills({ memory, runner: async ({ input }) => {
      started(); await gate; return { output: input.toUpperCase(), model: 'test' }
    } })
    const verifying = slow.verify(candidate.id)
    await ready
    const revising = service.revise(candidate.id, ['Different steps'])
    const publishing = expect(service.publish(candidate.id)).rejects.toThrow(/passed/i)
    release()
    expect((await verifying).status).toBe('passed')
    await revising
    await publishing
    expect(api.skillStatus(await service.get(candidate.id))).toBe('untested')
  })

  it('candidate failure cannot replace or weaken the last published baseline', async () => {
    const { service, memory, candidate } = await setup()
    await service.approveTests(candidate.id, cases)
    await service.verify(candidate.id); await service.publish(candidate.id)
    await service.revise(candidate.id, ['Return lowercase'])
    const worse = new api.VerifiedSkills({ memory, runner: async ({ input, steps }) => ({
      output: steps[0] === 'Return lowercase' ? input.toLowerCase() : input.toUpperCase(), model: 'test',
    }) })
    const evidence = await worse.verify(candidate.id)
    expect(evidence.baseline).not.toBeNull()
    expect(evidence.results[0]).toMatchObject({ baselinePassed: true, candidatePassed: false })
    await expect(worse.publish(candidate.id)).rejects.toThrow(/passed/)
    expect(api.publishedProcedure(await service.get(candidate.id))?.meta?.steps).toEqual(draft.steps)
  })

  it('new approval cannot re-publish an old proof; existing publication pins its original suite', async () => {
    const { service, candidate } = await setup()
    await service.approveTests(candidate.id, cases)
    await service.verify(candidate.id); await service.publish(candidate.id)
    await service.approveTests(candidate.id, [{ input: 'new task', expected: 'new expected' }])
    expect(api.skillState(await service.get(candidate.id))!.suites.at(-1)!.approvedBy).toBe('alice')
    expect(api.skillStatus(await service.get(candidate.id))).toBe('untested')
    await expect(service.publish(candidate.id)).rejects.toThrow(/passed/)
    expect(api.publishedProcedure(await service.get(candidate.id))).not.toBeNull()
    expect((await service.verify(candidate.id)).status).toBe('failed')
    // A failed retest must not rewrite the evidence attached to an existing release.
    expect(api.publishedProcedure(await service.get(candidate.id))).not.toBeNull()
  })

  it.each(['versions', 'suites', 'evidence'] as const)('caps %s without discarding history', async (key) => {
    const { service, candidate } = await setup()
    const limit = api.SKILL_LIMITS[key]
    if (key === 'evidence') await service.approveTests(candidate.id, cases)
    const add = () => key === 'versions' ? service.revise(candidate.id, ['Uppercase'])
      : key === 'suites' ? service.approveTests(candidate.id, cases) : service.verify(candidate.id)
    const initial = key === 'versions' ? 1 : 0
    for (let i = initial; i < limit; i++) await add()
    const before = api.skillState(await service.get(candidate.id))
    await expect(add()).rejects.toThrow(/limit/i)
    expect(api.skillState(await service.get(candidate.id))).toEqual(before)
  })

  it('rejects oversized content before storing a candidate', async () => {
    const { service, memory } = await setup()
    const before = memory.entries.length
    await expect(service.create({ ...draft, steps: ['x'.repeat(600_000)] })).rejects.toThrow(/limit/)
    expect(memory.entries).toHaveLength(before)
  })

  it('fails closed on malformed persisted evidence and a missing baseline version', async () => {
    const { service, memory, candidate } = await setup()
    await service.approveTests(candidate.id, cases)
    await service.verify(candidate.id); await service.publish(candidate.id)
    const s = api.skillState(await service.get(candidate.id))!
    await memory.patchMeta!(candidate.id, { skill: { ...s, evidence: [null] } })
    expect(api.publishedProcedure(await service.get(candidate.id))).toBeNull()
    await memory.patchMeta!(candidate.id, { skill: { ...s, publications: [{ version: 'missing', evidence: s.evidence[0]!.id }] } })
    await expect(service.verify(candidate.id)).rejects.toThrow(/baseline/)
  })

  it('concurrent append tools retain both additions in immutable versions', async () => {
    const { service, memory, candidate } = await setup()
    const tools = new api.MemoryToolset({ memory, skills: service })
    await Promise.all(['A', 'B'].map((s) => tools.callTool('refine_procedure', { id: candidate.id, appendSteps: [s] })))
    expect(api.stepsOf(await service.get(candidate.id))).toEqual([...draft.steps, 'A', 'B'])
  })
})
