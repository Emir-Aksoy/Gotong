/**
 * Unit tests for `buildButlerGovernedToolset` (BF-M7-M1) — the resident butler's
 * SENSITIVE-action toolset built on the hub-steward action set.
 *
 * These pin the pure shaping in ISOLATION: the toolset exposes exactly the four
 * member-scoped kinds, gates all of them to `approve` (the resident IM butler has
 * no plan/apply preview, so the /me inbox IS the review step), validates every
 * call, and routes execution through `performStewardAction` + fake member
 * services. The production park → /me-approval → resume path is exercised
 * end-to-end by personal-butler-e2e.test.ts (mechanism) and the BF-M7-M3 E2E
 * (real HostMeAgentService).
 */

import { describe, expect, it } from 'vitest'

import { buildButlerGovernedToolset } from '../src/personal-butler-governed.js'
import type {
  StewardAgentDirectory,
  StewardOwnedAgent,
  StewardWorkflowEditor,
} from '../src/hub-steward-service.js'
import type { MeWorkflowEditResult } from '../src/me-workflow-edit-service.js'

const USER = 'u1'

/** A recording fake agent directory — captures the delegated call + returns a stub. */
function fakeAgents(overrides: Partial<StewardAgentDirectory> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const stubAgent: StewardOwnedAgent = {
    id: 'me.u1.helper',
    label: '小助手',
    capabilities: ['chat'],
    provider: 'mock',
  }
  const dir: StewardAgentDirectory = {
    listOwned: async () => [],
    availableProviders: async () => ['mock'],
    create: async (userId, input) => {
      calls.push({ method: 'create', args: [userId, input] })
      return stubAgent
    },
    update: async (userId, agentId, input) => {
      calls.push({ method: 'update', args: [userId, agentId, input] })
      return { ...stubAgent, id: agentId }
    },
    remove: async (userId, agentId) => {
      calls.push({ method: 'remove', args: [userId, agentId] })
      return true
    },
    ...overrides,
  }
  return { dir, calls }
}

/** A recording fake workflow editor. */
function fakeWorkflowEditor(result: MeWorkflowEditResult) {
  const calls: Array<Record<string, unknown>> = []
  const editor: StewardWorkflowEditor = {
    edit: async (req) => {
      calls.push(req as Record<string, unknown>)
      return result
    },
  }
  return { editor, calls }
}

/** The single text payload of an `LlmToolCallResult`. */
function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  const block = res.content.find((c) => c.type === 'text')
  return block?.text ?? ''
}

// The butler renderer only reads `.ok` on success, so a minimal stub is the
// honest fixture (the full MeWorkflowEditOk shape is exercised by the edit tests).
const okEdit: MeWorkflowEditResult = { ok: true } as unknown as MeWorkflowEditResult

describe('buildButlerGovernedToolset — exposed tools', () => {
  it('exposes exactly the four member-scoped governed tools', () => {
    const { dir } = fakeAgents()
    const { editor } = fakeWorkflowEditor(okEdit)
    const toolset = buildButlerGovernedToolset({ userId: USER, agents: dir, workflowEditor: editor })
    const names = toolset.listTools().map((t) => t.name).sort()
    expect(names).toEqual(['create_agent', 'delete_agent', 'edit_agent', 'edit_workflow'])
    // Every tool advertises an input schema.
    for (const t of toolset.listTools()) expect(t.inputSchema).toBeTruthy()
  })

  it('omits edit_workflow when no workflow editor is wired (agents still work)', () => {
    const { dir } = fakeAgents()
    // No workflowEditor — a hub with identity but no workflowAssist.
    const toolset = buildButlerGovernedToolset({ userId: USER, agents: dir })
    const names = toolset.listTools().map((t) => t.name).sort()
    expect(names).toEqual(['create_agent', 'delete_agent', 'edit_agent'])
    expect(toolset.governs('edit_workflow')).toBe(false)
  })

  it('does NOT expose the operator-only sensitive writes', () => {
    const { dir } = fakeAgents()
    const { editor } = fakeWorkflowEditor(okEdit)
    const toolset = buildButlerGovernedToolset({ userId: USER, agents: dir, workflowEditor: editor })
    // A member butler is never handed the sensitive executors, so these tools
    // simply do not exist on it (defense: structural, not just tiered forbidden).
    expect(toolset.governs('set_credential_ref')).toBe(false)
    expect(toolset.governs('revoke_credential')).toBe(false)
    expect(toolset.governs('set_peer_policy')).toBe(false)
    expect(toolset.governs('set_security_quota')).toBe(false)
    expect(toolset.governs('create_agent')).toBe(true)
  })
})

describe('buildButlerGovernedToolset — always asks a human (approve)', () => {
  it('classifies all four kinds as approve (no inline safe path on IM)', async () => {
    const { dir } = fakeAgents()
    const { editor } = fakeWorkflowEditor(okEdit)
    const toolset = buildButlerGovernedToolset({ userId: USER, agents: dir, workflowEditor: editor })
    for (const name of ['create_agent', 'edit_agent', 'delete_agent', 'edit_workflow']) {
      const verdict = await toolset.classify(name, {})
      expect(verdict.decision).toBe('approve')
    }
  })
})

describe('buildButlerGovernedToolset — describe (inbox title)', () => {
  it('reuses the steward zh summary for a valid action', () => {
    const { dir } = fakeAgents()
    const { editor } = fakeWorkflowEditor(okEdit)
    const toolset = buildButlerGovernedToolset({ userId: USER, agents: dir, workflowEditor: editor })
    expect(
      toolset.describe('create_agent', {
        handle: 'helper',
        label: '小助手',
        provider: 'mock',
        system: '你是助手',
        capabilities: ['chat'],
      }),
    ).toBe('建一个新助手「小助手」(mock)')
    expect(toolset.describe('delete_agent', { agentId: 'me.u1.helper' })).toBe('删掉助手 me.u1.helper')
  })

  it('falls back to name(json) when the args are not a valid action', () => {
    const { dir } = fakeAgents()
    const { editor } = fakeWorkflowEditor(okEdit)
    const toolset = buildButlerGovernedToolset({ userId: USER, agents: dir, workflowEditor: editor })
    // Missing agentId → not a valid delete_agent → fallback rendering.
    expect(toolset.describe('delete_agent', {})).toBe('delete_agent({})')
  })
})

describe('buildButlerGovernedToolset — callTool executes a cleared action', () => {
  it('delete_agent delegates to agents.remove and renders removed', async () => {
    const { dir, calls } = fakeAgents()
    const { editor } = fakeWorkflowEditor(okEdit)
    const toolset = buildButlerGovernedToolset({ userId: USER, agents: dir, workflowEditor: editor })
    const res = await toolset.callTool('delete_agent', { agentId: 'me.u1.helper' })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toBe('已删除该助手。')
    expect(calls).toEqual([{ method: 'remove', args: [USER, 'me.u1.helper'] }])
  })

  it('delete_agent renders "not found" when the service returns false', async () => {
    const { dir } = fakeAgents({ remove: async () => false })
    const { editor } = fakeWorkflowEditor(okEdit)
    const toolset = buildButlerGovernedToolset({ userId: USER, agents: dir, workflowEditor: editor })
    const res = await toolset.callTool('delete_agent', { agentId: 'nope' })
    expect(textOf(res)).toContain('没找到这个助手')
  })

  it('create_agent delegates to agents.create with the composed input', async () => {
    const { dir, calls } = fakeAgents()
    const { editor } = fakeWorkflowEditor(okEdit)
    const toolset = buildButlerGovernedToolset({ userId: USER, agents: dir, workflowEditor: editor })
    const res = await toolset.callTool('create_agent', {
      handle: 'helper',
      label: '小助手',
      provider: 'mock',
      system: '你是助手',
      capabilities: ['chat'],
    })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toBe('已创建助手「小助手」(me.u1.helper)。')
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('create')
    const [uid, input] = calls[0].args as [string, Record<string, unknown>]
    expect(uid).toBe(USER)
    // performStewardAction maps handle → the member service's `id`.
    expect(input).toMatchObject({
      id: 'helper',
      label: '小助手',
      provider: 'mock',
      system: '你是助手',
      capabilities: ['chat'],
    })
  })

  it('edit_agent delegates to agents.update', async () => {
    const { dir, calls } = fakeAgents()
    const { editor } = fakeWorkflowEditor(okEdit)
    const toolset = buildButlerGovernedToolset({ userId: USER, agents: dir, workflowEditor: editor })
    const res = await toolset.callTool('edit_agent', {
      agentId: 'me.u1.helper',
      changes: { label: '新名字' },
    })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toBe('已更新助手 me.u1.helper。')
    expect(calls[0]?.method).toBe('update')
  })

  it('edit_workflow delegates to the workflow editor and reports success', async () => {
    const { dir } = fakeAgents()
    const { editor, calls } = fakeWorkflowEditor(okEdit)
    const toolset = buildButlerGovernedToolset({ userId: USER, agents: dir, workflowEditor: editor })
    const res = await toolset.callTool('edit_workflow', {
      workflowId: 'wf1',
      instruction: '更礼貌一点',
    })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('工作流已按你的说法更新')
    // The member's userId is forced server-side into the edit request.
    expect(calls[0]).toMatchObject({ workflowId: 'wf1', instruction: '更礼貌一点', userId: USER })
  })

  it('edit_workflow surfaces a denial (locally-safe edit can still come back ok=false)', async () => {
    const denied: MeWorkflowEditResult = {
      ok: false,
      reason: 'boundary_locked',
      message: '这一步是跨 hub 出口，锁住了',
    } as unknown as MeWorkflowEditResult
    const { dir } = fakeAgents()
    const { editor } = fakeWorkflowEditor(denied)
    const toolset = buildButlerGovernedToolset({ userId: USER, agents: dir, workflowEditor: editor })
    const res = await toolset.callTool('edit_workflow', { workflowId: 'wf1', instruction: '把出口改掉' })
    expect(textOf(res)).toContain('这一步是跨 hub 出口')
  })

  it('rejects a malformed action shape without executing anything', async () => {
    const { dir, calls } = fakeAgents()
    const { editor } = fakeWorkflowEditor(okEdit)
    const toolset = buildButlerGovernedToolset({ userId: USER, agents: dir, workflowEditor: editor })
    // delete_agent with no agentId → validateStewardAction returns null.
    const res = await toolset.callTool('delete_agent', {})
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('动作格式不对')
    expect(calls).toHaveLength(0) // never reached the member service
  })
})
