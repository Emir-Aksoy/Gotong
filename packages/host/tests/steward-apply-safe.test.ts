/**
 * SW-M4 — `HostStewardService.apply()` safe-path executor + the tier dispatch.
 *
 * `apply` is the execute half of the steward. It RE-CLASSIFIES the action
 * server-side (never the client's tier) and then forks on the tier:
 *
 *   - SAFE       → executes inline via `performStewardAction` (delegating to the
 *                  member services), returning `{ status: 'done', result }`;
 *   - FORBIDDEN  → `{ status: 'refused' }`, nothing executed;
 *   - DANGEROUS  → `{ status: 'needs_approval', tier: 'dangerous' }`  ┐ the two
 *   - CROSS_HUB  → `{ status: 'needs_approval', tier: 'cross_hub' }`  ┘ hard
 *                  constraints — NOT executed in M4 (M5 wires the inbox).
 *
 * The whole point of this test: prove the gate is on the SERVER, so the two hard
 * constraints (delete + cross-hub workflow edit) can NEVER execute on a single
 * confirmation, and a forbidden action never touches an executor. The member
 * services are light fakes that RECORD their calls — so "executed" vs
 * "not executed" is asserted on the recorder, not just the return value.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space, createLogger } from '@gotong/core'
import { MockLlmProvider } from '@gotong/llm'

import {
  createHubStewardService,
  type HubStewardSurface,
  type StewardAgentDirectory,
  type StewardWorkflowDirectory,
  type StewardWorkflowEditor,
} from '../src/hub-steward-service.js'

const USER = 'u1'

/** Records every write verb so the test can assert executed-vs-not. */
interface AgentCalls {
  created: Array<{ userId: string; id: string; provider: string; capabilities: string[] }>
  updated: Array<{ userId: string; agentId: string; label?: string }>
  removed: Array<{ userId: string; agentId: string }>
}

function fakeAgentDir(calls: AgentCalls): StewardAgentDirectory {
  return {
    async listOwned() {
      return []
    },
    async availableProviders() {
      return ['anthropic', 'mock']
    },
    async create(userId, input) {
      calls.created.push({
        userId,
        id: input.id,
        provider: input.provider,
        capabilities: [...input.capabilities],
      })
      // The member service composes the namespaced id; the fake mirrors that.
      return {
        id: `me.${userId}.${input.id}`,
        label: input.label,
        capabilities: [...input.capabilities],
        provider: input.provider,
        ...(input.model ? { model: input.model } : {}),
      }
    },
    async update(userId, agentId, input) {
      calls.updated.push({ userId, agentId, ...(input.label ? { label: input.label } : {}) })
      return {
        id: agentId,
        label: input.label ?? '(unchanged)',
        capabilities: input.capabilities ? [...input.capabilities] : [],
        provider: input.provider ?? 'anthropic',
      }
    },
    async remove(userId, agentId) {
      calls.removed.push({ userId, agentId })
      return true
    },
  }
}

/** One purely-local workflow + one cross-hub workflow (drives the tier split). */
function fakeWorkflowDir(): StewardWorkflowDirectory {
  return {
    async listForUser() {
      return [
        { id: 'local-wf', name: '本地工作流', crossHub: false },
        { id: 'xhub-wf', name: '跨 hub 工作流', crossHub: true },
      ]
    },
  }
}

function fakeWorkflowEditor(calls: { edited: Array<{ workflowId: string; instruction: string }> }): StewardWorkflowEditor {
  return {
    async edit(req) {
      calls.edited.push({ workflowId: req.workflowId, instruction: req.instruction })
      return {
        ok: true,
        state: 'published',
        applied: 'published',
        yaml: 'schema: gotong.workflow/v1\nid: local-wf\n',
        explanation: '语气改礼貌了。',
        boundary: { trigger: 'chat', egress: [] },
        diff: [{ kind: 'add', text: '  # politer' }],
      }
    },
  }
}

interface Bench {
  root: string
  hub: Hub
  surface: HubStewardSurface
  agentCalls: AgentCalls
  editCalls: { edited: Array<{ workflowId: string; instruction: string }> }
}

async function boot(): Promise<Bench> {
  const root = await mkdtemp(join(tmpdir(), 'gotong-steward-apply-'))
  const { space } = await Space.init(root, { name: 'steward-apply-test' })
  const hub = new Hub({ space })
  await hub.start()

  const agentCalls: AgentCalls = { created: [], updated: [], removed: [] }
  const editCalls = { edited: [] as Array<{ workflowId: string; instruction: string }> }

  const surface = createHubStewardService({
    hub,
    config: { provider: 'mock' },
    agents: fakeAgentDir(agentCalls),
    workflows: fakeWorkflowDir(),
    workflowEditor: fakeWorkflowEditor(editCalls),
    logger: createLogger('test-steward-apply'),
    // apply never calls the LLM — a bare mock satisfies registration.
    provider: new MockLlmProvider({ reply: '{}' }),
  })
  if (!surface) throw new Error('createHubStewardService returned null (expected a surface)')

  return { root, hub, surface, agentCalls, editCalls }
}

describe('SW-M4 — hub steward apply()', () => {
  let b: Bench
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await b.hub.stop()
    await rm(b.root, { recursive: true, force: true })
  })

  it('executes a SAFE create_agent inline (member service called, done)', async () => {
    const res = await b.surface.apply({
      userId: USER,
      action: {
        kind: 'create_agent',
        handle: 'mailer',
        label: '邮件助手',
        provider: 'anthropic',
        system: '你负责把邮件总结成要点。',
        capabilities: ['summarize'],
      },
    })
    expect(res.status).toBe('done')
    if (res.status !== 'done') throw new Error('unreachable')
    expect(res.tier).toBe('safe')
    expect(res.result.kind).toBe('create_agent')
    if (res.result.kind !== 'create_agent') throw new Error('unreachable')
    expect(res.result.agent.id).toBe(`me.${USER}.mailer`)
    // The member service ACTUALLY ran (the handle maps to the composed id).
    expect(b.agentCalls.created).toEqual([
      { userId: USER, id: 'mailer', provider: 'anthropic', capabilities: ['summarize'] },
    ])
  })

  it('executes a SAFE edit_agent inline (handle dropped from the update input)', async () => {
    const res = await b.surface.apply({
      userId: USER,
      action: {
        kind: 'edit_agent',
        agentId: `me.${USER}.mailer`,
        changes: { label: '新名字', handle: 'ignored' },
      },
    })
    expect(res.status).toBe('done')
    if (res.status !== 'done') throw new Error('unreachable')
    expect(res.result.kind).toBe('edit_agent')
    expect(b.agentCalls.updated).toEqual([
      { userId: USER, agentId: `me.${USER}.mailer`, label: '新名字' },
    ])
  })

  it('executes a SAFE local edit_workflow inline (delegates to the editor)', async () => {
    const res = await b.surface.apply({
      userId: USER,
      action: { kind: 'edit_workflow', workflowId: 'local-wf', instruction: '语气更礼貌些' },
    })
    expect(res.status).toBe('done')
    if (res.status !== 'done') throw new Error('unreachable')
    expect(res.tier).toBe('safe')
    expect(res.result.kind).toBe('edit_workflow')
    if (res.result.kind !== 'edit_workflow') throw new Error('unreachable')
    expect(res.result.edit.ok).toBe(true)
    expect(b.editCalls.edited).toEqual([{ workflowId: 'local-wf', instruction: '语气更礼貌些' }])
  })

  it('answers a SAFE inspect with no side effects', async () => {
    const res = await b.surface.apply({
      userId: USER,
      action: { kind: 'inspect', answer: '你现在有 0 个助手。' },
    })
    expect(res.status).toBe('done')
    if (res.status !== 'done') throw new Error('unreachable')
    expect(res.result).toEqual({ kind: 'inspect', answer: '你现在有 0 个助手。' })
    // Nothing was executed.
    expect(b.agentCalls.created).toEqual([])
    expect(b.agentCalls.updated).toEqual([])
    expect(b.editCalls.edited).toEqual([])
  })

  it('REFUSES a forbidden action without executing anything', async () => {
    const res = await b.surface.apply({
      userId: USER,
      action: { kind: 'refuse', reason: '改 peer 信任策略要去设置面板。' },
    })
    expect(res.status).toBe('refused')
    if (res.status !== 'refused') throw new Error('unreachable')
    expect(res.reason).toContain('peer')
    expect(b.agentCalls).toEqual({ created: [], updated: [], removed: [] })
  })

  it('★ a DANGEROUS delete_agent needs approval — it does NOT delete in M4', async () => {
    const res = await b.surface.apply({
      userId: USER,
      action: { kind: 'delete_agent', agentId: `me.${USER}.mailer` },
    })
    expect(res).toEqual({ status: 'needs_approval', tier: 'dangerous' })
    // The hard constraint: the member service's remove was NEVER called.
    expect(b.agentCalls.removed).toEqual([])
  })

  it('★ a CROSS_HUB workflow edit needs approval — it does NOT edit in M4', async () => {
    const res = await b.surface.apply({
      userId: USER,
      action: { kind: 'edit_workflow', workflowId: 'xhub-wf', instruction: '改触发条件' },
    })
    expect(res).toEqual({ status: 'needs_approval', tier: 'cross_hub' })
    // The editor was never invoked — the second confirmation gates it.
    expect(b.editCalls.edited).toEqual([])
  })

  it('re-classifies on the SERVER — a client cannot relabel delete as safe', async () => {
    // Even though the caller "thinks" it's applying an accepted action, the tier
    // is recomputed from the action kind, so a forged-safe delete still parks.
    const res = await b.surface.apply({
      userId: USER,
      action: { kind: 'delete_agent', agentId: `me.${USER}.whatever` },
    })
    expect(res.status).toBe('needs_approval')
    expect(b.agentCalls.removed).toEqual([])
  })
})
