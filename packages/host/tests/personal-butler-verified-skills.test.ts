import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { LlmAgentOptions, LlmProvider, LlmRequest } from '@gotong/llm'
import { MASTER_KEY_LEN_BYTES, openIdentityStore } from '@gotong/identity'
import { createLogger, SuspendTaskError, Space, Hub, AgentParticipant, type Task } from '@gotong/core'
import { PersonalButlerAgent, readButlerGateState } from '@gotong/personal-butler'
import { MemoryToolset, VerifiedSkills, publishedProcedure } from '@gotong/personal-memory'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import * as host from '../src/personal-butler-verified-skills.js'
import { openButlerRecallIndex } from '../src/butler-recall-index.js'
import { LocalAgentPool } from '../src/local-agent-pool.js'
import { butlerApprovalItemFor } from '../src/personal-butler-escalation.js'
import { OrgApiPool } from '../src/org-api-pool.js'

const cases = [{ input: 'Return the three-letter greeting', expected: 'HEY' }]
const requests: LlmRequest[] = []
const logger = createLogger({ level: 'fatal' })
function provider(mode = 'ok'): LlmProvider {
  return { name: 'test', async *stream(req) {
    requests.push(req)
    yield { type: 'text', text: mode === 'empty' ? '' : 'HEY' }
    if (mode !== 'incomplete') yield { type: 'end', stopReason: mode === 'truncated' ? 'max_tokens' : 'end_turn' }
  } }
}

describe('personal skill production path', () => {
  it('uses the actual pool budget gate and identity usage ledger for both evaluation arms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gotong-skill-real-ledger-'))
    const { space } = await Space.init(root, { name: 'skill-ledger' })
    const hub = new Hub({ space })
    await hub.start()
    const identity = openIdentityStore({ dbPath: join(root, 'identity.sqlite'), masterKey: randomBytes(MASTER_KEY_LEN_BYTES) })
    const user = identity.createUser({ email: 'skill@test.local', displayName: 'Skill owner', role: 'member' })
    identity.setQuota({ userId: user.id, metric: 'llm_requests', period: 'daily', quota: 2 })
    let base: LlmAgentOptions | undefined
    let calls = 0
    class Butler extends AgentParticipant { protected async handleTask() { return 'unused' } }
    const pool = new LocalAgentPool({ hub, space, identity, orgApiPool: new OrgApiPool({ identity }), butlerDefaultOn: true,
      butlerFactory: (opts) => { base = opts; return new Butler({ id: opts.id, capabilities: opts.capabilities }) },
      providerFactory: () => ({ name: 'anthropic', async *stream() {
        calls++
        yield { type: 'text', text: 'HEY' }
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 5 } }
        yield { type: 'end', stopReason: 'end_turn' }
      } }),
    })
    try {
      await space.upsertAgent({ id: 'skill-butler', allowedCapabilities: ['chat'], createdAt: new Date().toISOString(),
        managed: { kind: 'llm', provider: 'anthropic', model: 'claude-opus-4', apiKeyEnv: 'SKILL_TEST_NO_CREDENTIAL' } })
      await pool.start()
      expect(base?.preCallHook).toBeTypeOf('function')
      expect(base?.usageSink).toBeTypeOf('function')
      const memory = openButlerMemory({ rootDir: root, userId: user.id, logger })
      const source = await memory.remember({ kind: 'episodic', text: 'source' })
      const runner = host.buildSkillSandboxRunner({ buildProvider: async () => base!.provider, hooks: base!,
        task: () => host.skillEvaluationTask(base!.id, user.id) })
      const skills = new VerifiedSkills({ memory, userId: user.id, runner })
      const c = await skills.create({ name: 'greet', steps: ['Greet'], sources: [source.id], conditions: ['greetings'], counterexamples: ['other'] })
      await skills.approveTests(c.id, cases)
      expect((await skills.verify(c.id)).status).toBe('passed')
      expect((await skills.verify(c.id)).status).toBe('failed')
      expect(calls).toBe(2)
      expect(identity.listUsage({ userId: user.id, metric: 'llm_tokens', period: 'daily' })[0]?.used).toBe(18)
      expect(identity.listUsage({ userId: user.id, metric: 'llm_requests', period: 'daily' })[0]?.used).toBe(2)
      const ledger = identity.queryLedger({ userId: user.id })
      expect(ledger).toHaveLength(2)
      expect(ledger.every((r) => r.orgId === 'local' && r.model === 'claude-opus-4' && r.taskId?.startsWith('skill-eval-'))).toBe(true)
    } finally { await pool.stop(); await hub.stop(); identity.close() }
  })

  it.each(['max_tokens', 'end_turn'])('records consumed usage even when %s output is rejected', async (stopReason) => {
    const charges: unknown[] = []
    const p: LlmProvider = { name: 'test', async *stream() {
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } }
      yield { type: 'end', stopReason: stopReason as 'max_tokens' | 'end_turn' }
    } }
    const run = host.buildSkillSandboxRunner({ buildProvider: async () => host.withSkillEvaluation(p, () => ({ provider: p, model: 'test@1' })),
      task: () => host.skillEvaluationTask('butler', 'alice'), hooks: { usageSink: (_t, u) => { charges.push(u) } } })
    await expect(run({ input: 'x', steps: [], conditions: [], counterexamples: [] })).rejects.toThrow()
    expect(charges).toEqual([{ inputTokens: 3, outputTokens: 1 }])
  })

  it('does not certify otherwise complete output without reported usage when accounting is enabled', async () => {
    const p = provider()
    const run = host.buildSkillSandboxRunner({ buildProvider: async () => host.withSkillEvaluation(p, () => ({ provider: p, model: 'test@1' })),
      task: () => host.skillEvaluationTask('butler', 'alice'), hooks: { usageSink: () => {} } })
    await expect(run({ input: 'x', steps: [], conditions: [], counterexamples: [] })).rejects.toThrow(/usage/)
  })
  it('refuses suites whose full approval cannot fit, including invisible expected characters', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gotong-skill-approval-size-'))
    const memory = openButlerMemory({ rootDir, userId: 'alice', logger })
    const source = await memory.remember({ kind: 'episodic', text: 'source' })
    const skills = new VerifiedSkills({ memory, userId: 'alice' })
    const c = await skills.create({ name: 'greet', steps: ['Greet'], sources: [source.id], conditions: ['greetings'], counterexamples: ['other'] })
    const gov = host.buildSkillTestApproval({ skills, userId: 'alice' })
    for (const test of [{ input: 'x'.repeat(1500), expected: 'HIDDEN EXPECTED' }, { input: 'x', expected: 'H\u200bEY' }]) {
      expect((await gov.classify('approve_procedure_tests', { id: c.id, cases: [test] })).decision).toBe('refuse')
    }
  })
  it('gates and records every paid arm with trusted user/org attribution, stopping at quota', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gotong-skill-quota-'))
    const memory = openButlerMemory({ rootDir, userId: 'alice', logger })
    const source = await memory.remember({ kind: 'episodic', text: 'source' })
    const events: string[] = []
    const charges: Task[] = []
    const p: LlmProvider = { name: 'metered', async *stream() {
      events.push('stream')
      yield { type: 'text', text: 'HEY' }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } }
      yield { type: 'end', stopReason: 'end_turn' }
    } }
    const runner = host.buildSkillSandboxRunner({ buildProvider: async () => host.withSkillEvaluation(p, () => ({ provider: p, model: 'model' })),
      task: () => host.skillEvaluationTask('butler', 'alice', 'local'),
      hooks: {
        preCallHook: (t) => { events.push('gate'); expect(t.origin).toEqual({ userId: 'alice', orgId: 'local' }); if (charges.length >= 2) throw new Error('quota_exceeded') },
        usageSink: (t, usage, meta) => { events.push('charge'); charges.push(t); expect(usage).toEqual({ inputTokens: 3, outputTokens: 1 }); expect(meta).toMatchObject({ provider: 'metered', model: 'model' }) },
      },
    })
    const skills = new VerifiedSkills({ memory, userId: 'alice', runner })
    const c = await skills.create({ name: 'greet', steps: ['Greet'], sources: [source.id], conditions: ['greetings'], counterexamples: ['other'] })
    await skills.approveTests(c.id, [...cases, { input: 'Another greeting', expected: 'HEY' }])
    expect((await skills.verify(c.id)).status).toBe('failed')
    expect(events).toEqual(['gate', 'stream', 'charge', 'gate', 'stream', 'charge', 'gate'])
    expect(charges).toHaveLength(2)
    expect(charges[0]!.id).not.toBe(charges[1]!.id)
  })

  it.each([true, false])('real governed park/resume approval=%s saves only the approved cases', async (approved) => {
    const approvalCases = [{ input: 'x'.repeat(580), expected: 'EXPECTED AT THE END ' + 'y'.repeat(190) }]
    const rootDir = await mkdtemp(join(tmpdir(), 'gotong-skill-gate-'))
    const memory = openButlerMemory({ rootDir, userId: 'alice', logger })
    const source = await memory.remember({ kind: 'episodic', text: 'Example' })
    const service = new VerifiedSkills({ memory, userId: 'alice' })
    const candidate = await service.create({ name: 'greet', steps: ['Greet'], sources: [source.id], conditions: ['Greetings'], counterexamples: ['Other tasks'] })
    let n = 0
    const agent = new PersonalButlerAgent({ id: 'butler', memory, verifiedSkills: service, captureTurns: false,
      governed: host.buildSkillTestApproval({ skills: service, userId: 'alice' }),
      provider: { name: 'script', async *stream() {
        if (n++ === 0) {
          yield { type: 'tool_use', toolUse: { type: 'tool_use', id: 'approve', name: 'approve_procedure_tests', input: { id: candidate.id, cases: approvalCases } } }
          yield { type: 'end', stopReason: 'tool_use' }
        } else { yield { type: 'text', text: 'done' }; yield { type: 'end', stopReason: 'end_turn' } }
      } },
    })
    const task: Task = { id: 'test', from: 'user:alice', strategy: { kind: 'explicit', to: 'butler' }, payload: 'Approve the tests I supplied' }
    let suspended: SuspendTaskError | undefined
    try { await agent.onTask(task) } catch (e) { if (e instanceof SuspendTaskError) suspended = e; else throw e }
    expect(suspended).toBeInstanceOf(SuspendTaskError)
    const gate = readButlerGateState(suspended!.state)
    expect(gate!.pending!.approval.title).toContain(approvalCases[0]!.expected)
    const item = butlerApprovalItemFor(task, 'butler', suspended!.state, { approver: 'alice' })
    expect(item!.prompt).toContain(JSON.stringify(approvalCases))
    expect(item!.title).toContain(JSON.stringify(approvalCases))
    expect(item!.prompt).not.toContain('已截断')
    expect((await service.get(candidate.id)).meta!.skill).toMatchObject({ suites: [] })
    await agent.onResume(task, { ...suspended!.state as object, answer: { approved } })
    expect(((await service.get(candidate.id)).meta!.skill as any).suites).toHaveLength(approved ? 1 : 0)
  })

  it('resolves old personal skills beyond the backend 500-entry list cap through the existing index', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gotong-skill-index-'))
    let clock = 1
    const memory = openButlerMemory({ rootDir, userId: 'alice', logger, now: () => clock++ })
    const source = await memory.remember({ kind: 'episodic', text: 'source' })
    const index = openButlerRecallIndex({ rootDir, userId: 'alice', logger })
    const service = new VerifiedSkills({ memory, userId: 'alice', lookup: (ids) => index.lookupByIds(ids) })
    const c = await service.create({ name: 'old skill', steps: ['do'], sources: [source.id], conditions: ['matching'], counterexamples: ['other'] })
    for (let i = 0; i < 501; i++) await memory.remember({ kind: 'semantic', text: `new ${i}` })
    await expect(new VerifiedSkills({ memory }).get(c.id)).rejects.toThrow(/not found/)
    expect((await service.get(c.id)).id).toBe(c.id)
    await service.approveTests(c.id, cases)
    expect((await service.get(c.id)).meta!.skill).toMatchObject({ suites: [{ approvedBy: 'alice' }] })
    expect((await new MemoryToolset({ memory, skills: service }).callTool('refine_procedure', { id: c.id, appendSteps: ['check'] })).isError).not.toBe(true)
  })

  it('the production pool supplies a single-model evaluator, not the fallback router', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gotong-skill-pool-'))
    const { space } = await Space.init(root, { name: 'skill-test' })
    const hub = new Hub({ space })
    await hub.start()
    const built: Array<{ model?: string; resolver: unknown }> = []
    class Butler extends AgentParticipant { protected async handleTask() { return 'unused' } }
    const pool = new LocalAgentPool({ hub, space, butlerDefaultOn: true,
      butlerFactory: (base) => new Butler({ id: base.id, capabilities: base.capabilities }),
      providerFactory: (spec, _key, resolver) => { built.push({ model: spec.model, resolver }); return provider() },
    })
    try {
      await space.upsertAgent({ id: 'assistant', allowedCapabilities: ['chat'], createdAt: new Date().toISOString(),
        managed: { kind: 'llm', provider: 'mock', model: 'primary', fallbacks: [{ provider: 'mock', model: 'fallback' }] } })
      const run = host.buildSkillSandboxRunner({ buildProvider: () => pool.buildButlerProvider() })
      const result = await run({ input: 'greet', steps: ['Greet'], conditions: [], counterexamples: [] })
      expect(result.model).toBe('test:primary')
      expect(built.at(-1)).toEqual({ model: 'primary', resolver: undefined })
      expect(requests.at(-1)!.model).toBe('primary')
    } finally { await pool.stop(); await hub.stop() }
  })

  it('requires human approval, runs the real stream path without tools/expected, survives reopen', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gotong-verified-skills-'))
    const memory = openButlerMemory({ rootDir, userId: 'alice', logger })
    const source = await memory.remember({ kind: 'episodic', text: 'A greeting task succeeded.' })
    const p = provider()
    const runner = host.buildSkillSandboxRunner({ buildProvider: async () => host.withSkillEvaluation(p, () => ({ provider: p, model: 'test@1' })) })
    const service = new VerifiedSkills({ memory, runner, userId: 'alice' })
    const tools = new MemoryToolset({ memory, skills: service })
    const c = await service.create({ name: 'greet', steps: ['Return a three-letter greeting'], sources: [source.id], conditions: ['Greeting tasks'], counterexamples: ['Not salutations in letters'] })
    const gov = host.buildSkillTestApproval({ skills: service, userId: 'alice' })
    const args = { id: c.id, cases }
    expect((await gov.classify('approve_procedure_tests', args)).decision).toBe('approve')
    expect(gov.describe('approve_procedure_tests', args)).toContain('HEY')
    expect((await tools.callTool('verify_procedure', { id: c.id })).isError).toBe(true)
    // Exactly the existing governed executor boundary: only the approved resume calls this.
    expect((await gov.callTool('approve_procedure_tests', args)).isError).not.toBe(true)
    requests.length = 0
    expect((await tools.callTool('verify_procedure', { id: c.id })).isError).not.toBe(true)
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests)).not.toContain('HEY')
    expect(requests.every((r) => r.tools?.length === 0)).toBe(true)
    await service.publish(c.id)
    await service.revise(c.id, ['Reply with a brief greeting'])
    await service.verify(c.id)
    await service.publish(c.id)
    const reopened = new VerifiedSkills({ memory: openButlerMemory({ rootDir, userId: 'alice', logger }), runner })
    await reopened.rollback(c.id)
    expect(publishedProcedure(await reopened.get(c.id))?.meta?.steps).toEqual(['Return a three-letter greeting'])
    const bob = new VerifiedSkills({ memory: openButlerMemory({ rootDir, userId: 'bob', logger }), runner })
    await expect(bob.get(c.id)).rejects.toThrow(/not found/)
  })

  it.each(['empty', 'incomplete', 'truncated'])('rejects %s stream output', async (mode) => {
    const p = provider(mode)
    const run = host.buildSkillSandboxRunner({ buildProvider: async () => host.withSkillEvaluation(p, () => ({ provider: p, model: 'test@1' })) })
    await expect(run({ input: 'x', steps: [], conditions: [], counterexamples: [] })).rejects.toThrow()
  })

  it('refuses missing provider/model identity instead of inventing evidence', async () => {
    for (const p of [null, provider()]) {
      const run = host.buildSkillSandboxRunner({ buildProvider: async () => p })
      await expect(run({ input: 'x', steps: [], conditions: [], counterexamples: [] })).rejects.toThrow()
    }
  })
})
