/**
 * ARCH-M5 — unit tests for the member NL workflow-CREATE service (the "工作流
 * 架构师" from the /me side) + the explain-at-depth path. Light fakes for every
 * dep (no Hub, no LLM, no sqlite): we drive the decision pipeline directly and
 * assert
 *   (a) a local-only authored workflow lands as a DRAFT and seeds the member's
 *       owner grant,
 *   (b) ★ a workflow with ANY cross-hub egress is rejected BEFORE persistence ★
 *       (members are local-only),
 *   (c) an id collision is refused before it can clobber an existing workflow,
 *   (d) assistant / structure failures map to typed reasons,
 *   (e) explain echoes the subject YAML + carries the depth + graph.
 *
 * The YAML is real (`parseWorkflow` runs on the authored side), so the cross-hub
 * boundary primitive sees a genuine `WorkflowDefinition` — the same path
 * production takes.
 */

import { describe, expect, it } from 'vitest'

import { parseWorkflow, projectWorkflowGraph } from '@aipehub/workflow'
import type { WorkflowAssistantOutput, WorkflowDetailLevel } from '@aipehub/workflow-assistant'

import {
  MeWorkflowCreateService,
  type MeWorkflowCreateDeps,
} from '../src/me-workflow-create-service.js'
import type { PeerCapabilityView } from '../src/workflow-controller.js'

// --- YAML builders (real text → real parseWorkflow) -------------------------

interface StepSpec {
  id: string
  cap: string
  payload?: string
  dataClasses?: string[]
}

function yamlStep(s: StepSpec): string {
  const dc = s.dataClasses ? `\n        dataClasses: [${s.dataClasses.join(', ')}]` : ''
  return [
    `    - id: ${s.id}`,
    `      dispatch:`,
    `        strategy: { kind: capability, capabilities: [${s.cap}] }`,
    `        payload: ${s.payload ?? '{}'}${dc}`,
  ].join('\n')
}

function yamlWf(opts: { id?: string; trigger?: string; steps: StepSpec[] }): string {
  return [
    'schema: aipehub.workflow/v1',
    'workflow:',
    `  id: ${opts.id ?? 'my-flow'}`,
    '  trigger:',
    `    capability: ${opts.trigger ?? 'run-flow'}`,
    '  steps:',
    ...opts.steps.map(yamlStep),
  ].join('\n')
}

const LOCAL_WF = yamlWf({ steps: [{ id: 'draft', cap: 'wf.draft', payload: '{ note: hi }' }] })

const CROSS_HUB_WF = yamlWf({
  steps: [
    { id: 'draft', cap: 'wf.draft', payload: '{ note: hi }' },
    { id: 'place', cap: 'supplier.confirm-order', dataClasses: ['public'] },
  ],
})

/** A peer serving an off-hub cap — makes `place` read as cross-hub egress. */
const PEER_VIEW: PeerCapabilityView = {
  peerCapabilities: () => [
    { peer: 'supplier-hub', label: '供货商 Hub', capabilities: ['supplier.confirm-order'] },
  ],
}

// --- assistant output fakes -------------------------------------------------

function assistOk(
  yaml: string,
  extra?: { explanation?: string; deepCheck?: WorkflowAssistantOutput['deepCheck']; graph?: boolean },
): WorkflowAssistantOutput {
  // The real agent attaches `graph = projectWorkflowGraph(parsed)` on valid YAML;
  // project a real one here so the "graph attached" assertions are meaningful.
  const graph = extra?.graph === false ? undefined : projectWorkflowGraph(parseWorkflow(yaml))
  return {
    text: yaml,
    raw: yaml,
    stopReason: 'end_turn',
    by: 'workflow-assistant',
    yaml,
    explanation: extra?.explanation ?? '建好了',
    draftStatus: 'valid',
    ...(graph ? { graph } : {}),
    ...(extra?.deepCheck ? { deepCheck: extra.deepCheck } : {}),
  } as WorkflowAssistantOutput
}

function assistInvalid(): WorkflowAssistantOutput {
  return {
    text: '',
    raw: '',
    stopReason: 'end_turn',
    by: 'workflow-assistant',
    yaml: '',
    explanation: '生成的 YAML 不合法',
    draftStatus: 'invalid',
    validationError: 'step "x" references unknown step',
  } as WorkflowAssistantOutput
}

function assistNoYaml(): WorkflowAssistantOutput {
  return {
    text: '你想做什么?',
    raw: '你想做什么?',
    stopReason: 'end_turn',
    by: 'workflow-assistant',
    yaml: '',
    explanation: '你想做什么?',
    draftStatus: 'no_yaml',
  } as WorkflowAssistantOutput
}

// --- fake-deps builder ------------------------------------------------------

interface BuildOpts {
  /** What the assistant returns (or throws). */
  assist: WorkflowAssistantOutput | Error
  /** Make `versioning.has` return true for this id (collision test). */
  existingIds?: string[]
  /** Backs explain's `exportDefinitionText`. */
  source?: string | null
  participants?: Array<{ id: string; capabilities: string[] }>
  peerCapabilities?: PeerCapabilityView
  /** Throw from the grant seed (best-effort test). */
  failGrant?: boolean
  failPersist?: Error
  perMemberDraftCap?: number
  ownedDrafts?: number
  /** MCD-M4 — installed MCP server names fed into the architect's contextHints. */
  mcpServerNames?: () => Promise<ReadonlyArray<string>> | ReadonlyArray<string>
}

function buildDeps(opts: BuildOpts) {
  const calls = {
    assist: 0,
    assistInputs: [] as Array<{
      description: string
      mode?: string
      detail?: WorkflowDetailLevel
      subjectYaml?: string
      hadOnChunk: boolean
      mcpServers?: ReadonlyArray<string>
    }>,
    saveDraft: [] as Array<{ text: string; by?: string }>,
    grants: [] as Array<{ workflowId: string; userId: string; perm: string }>,
  }
  const existing = new Set(opts.existingIds ?? [])

  const deps: MeWorkflowCreateDeps = {
    grants: {
      setWorkflowGrant: (input) => {
        if (opts.failGrant) throw new Error('grant write failed')
        calls.grants.push({ workflowId: input.workflowId, userId: input.userId, perm: input.perm })
        return undefined
      },
    },
    workflows: {
      versioning: {
        has: async (id) => existing.has(id),
      },
      saveDraft: async (text, o) => {
        if (opts.failPersist) throw opts.failPersist
        calls.saveDraft.push({ text, ...o })
        const def = parseWorkflow(text)
        return { id: def.id }
      },
      exportDefinitionText: async () => (opts.source === undefined ? null : opts.source),
    },
    assist: {
      assist: async (input) => {
        calls.assist++
        calls.assistInputs.push({
          description: input.description,
          mode: input.mode,
          detail: input.detail,
          subjectYaml: input.subjectYaml,
          hadOnChunk: typeof input.onChunk === 'function',
          mcpServers: input.contextHints?.mcpServers,
        })
        input.onChunk?.('chunk-1')
        input.onChunk?.('chunk-2')
        if (opts.assist instanceof Error) throw opts.assist
        return opts.assist
      },
    },
    participants: () => opts.participants ?? [{ id: 'local-agent', capabilities: ['wf.draft'] }],
    ...(opts.peerCapabilities ? { peerCapabilities: opts.peerCapabilities } : {}),
    ...(opts.mcpServerNames ? { mcpServerNames: opts.mcpServerNames } : {}),
    ...(typeof opts.perMemberDraftCap === 'number'
      ? { perMemberDraftCap: opts.perMemberDraftCap, countOwnedDrafts: () => opts.ownedDrafts ?? 0 }
      : {}),
  }
  return { service: new MeWorkflowCreateService(deps), calls }
}

// --- create -----------------------------------------------------------------

describe('MeWorkflowCreateService.create — happy path', () => {
  it('lands a local-only workflow as a draft + seeds the member owner grant', async () => {
    const { service, calls } = buildDeps({ assist: assistOk(LOCAL_WF, { explanation: '每天整理待办' }) })
    const r = await service.create({ instruction: '每天早上整理我的待办', userId: 'alice' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.workflowId).toBe('my-flow')
      expect(r.yaml).toBe(LOCAL_WF)
      expect(r.explanation).toBe('每天整理待办')
      // The flowchart rides the result — a trigger node is always projected.
      expect(r.graph?.nodes.some((n) => n.kind === 'trigger')).toBe(true)
      expect(r.graph?.workflowId).toBe('my-flow')
    }
    expect(calls.saveDraft).toHaveLength(1)
    expect(calls.saveDraft[0]?.by).toBe('alice')
    // owner-as-grant seeded for the creating member.
    expect(calls.grants).toEqual([{ workflowId: 'my-flow', userId: 'alice', perm: 'owner' }])
  })

  it('threads deepCheck warnings through on success', async () => {
    const deepCheck = {
      ok: false,
      violations: [{ kind: 'unknown_capability', path: 'steps[0]', message: 'no agent serves wf.draft' }],
    }
    const { service } = buildDeps({
      assist: assistOk(LOCAL_WF, { deepCheck: deepCheck as WorkflowAssistantOutput['deepCheck'] }),
    })
    const r = await service.create({ instruction: 'x', userId: 'alice' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.deepCheck).toEqual(deepCheck)
  })

  it('forwards author mode + the requested depth to the assistant', async () => {
    const { service, calls } = buildDeps({ assist: assistOk(LOCAL_WF) })
    await service.create({ instruction: 'x', userId: 'alice', detail: 'detailed' })
    expect(calls.assistInputs[0]?.mode).toBe('author')
    expect(calls.assistInputs[0]?.detail).toBe('detailed')
    expect(calls.assistInputs[0]?.subjectYaml).toBeUndefined()
  })

  it('seeds the draft even if the owner-grant write hiccups (best-effort)', async () => {
    const { service, calls } = buildDeps({ assist: assistOk(LOCAL_WF), failGrant: true })
    const r = await service.create({ instruction: 'x', userId: 'alice' })
    expect(r.ok).toBe(true) // draft is saved; grant is best-effort
    expect(calls.saveDraft).toHaveLength(1)
    expect(calls.grants).toHaveLength(0)
  })
})

describe('MeWorkflowCreateService.create — the local-only gate', () => {
  it('rejects a workflow that dispatches off-hub (and never persists or grants)', async () => {
    const { service, calls } = buildDeps({ assist: assistOk(CROSS_HUB_WF), peerCapabilities: PEER_VIEW })
    const r = await service.create({ instruction: '下单发给供货商', userId: 'alice' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('cross_hub')
      expect(r.message).toContain('supplier.confirm-order')
    }
    expect(calls.saveDraft).toHaveLength(0) // ← blocked BEFORE persistence
    expect(calls.grants).toHaveLength(0)
  })

  it('allows the same off-hub-looking cap when it is actually served LOCALLY', async () => {
    // No peer view + a local agent serving the cap → not egress → local create OK.
    const { service, calls } = buildDeps({
      assist: assistOk(CROSS_HUB_WF),
      participants: [
        { id: 'local-agent', capabilities: ['wf.draft'] },
        { id: 'in-house', capabilities: ['supplier.confirm-order'] },
      ],
      // peerCapabilities intentionally absent
    })
    const r = await service.create({ instruction: 'x', userId: 'alice' })
    expect(r.ok).toBe(true)
    expect(calls.saveDraft).toHaveLength(1)
  })
})

describe('MeWorkflowCreateService.create — collisions & failures', () => {
  it('refuses an id that collides with an existing workflow (never clobbers)', async () => {
    const { service, calls } = buildDeps({ assist: assistOk(LOCAL_WF), existingIds: ['my-flow'] })
    const r = await service.create({ instruction: 'x', userId: 'alice' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('id_exists')
    expect(calls.saveDraft).toHaveLength(0)
  })

  it('surfaces an invalid assistant draft as assistant_failed', async () => {
    const { service, calls } = buildDeps({ assist: assistInvalid() })
    const r = await service.create({ instruction: 'x', userId: 'alice' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('assistant_failed')
      expect(r.draftStatus).toBe('invalid')
    }
    expect(calls.saveDraft).toHaveLength(0)
  })

  it('surfaces a no_yaml (clarifying-question) draft as assistant_failed', async () => {
    const { service } = buildDeps({ assist: assistNoYaml() })
    const r = await service.create({ instruction: '帮我做点事', userId: 'alice' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('assistant_failed')
      expect(r.draftStatus).toBe('no_yaml')
    }
  })

  it('surfaces an assist dispatch error as assistant_unavailable', async () => {
    const { service } = buildDeps({ assist: new Error('no api key') })
    const r = await service.create({ instruction: 'x', userId: 'alice' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('assistant_unavailable')
  })

  it('maps a structure-gate rejection from saveDraft to structure_failed', async () => {
    const { service } = buildDeps({
      assist: assistOk(LOCAL_WF),
      failPersist: new Error("workflow 'my-flow' failed structural check — bad_ref @ steps[0]"),
    })
    const r = await service.create({ instruction: 'x', userId: 'alice' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('structure_failed')
      expect(r.detail).toContain('bad_ref')
    }
  })
})

describe('MeWorkflowCreateService.create — authoring conversation + streaming', () => {
  it('folds prior turns into the author prompt, before the current description', async () => {
    const { service, calls } = buildDeps({ assist: assistOk(LOCAL_WF) })
    await service.create({
      instruction: '再加一步让我确认',
      userId: 'alice',
      history: [
        { instruction: '每天整理待办发给我', outcome: '建好了草稿。' },
        { instruction: '出口指到供货商', outcome: '失败:新建工作流只能用本 hub 的能力。' },
      ],
    })
    const prompt = calls.assistInputs[0]!.description
    expect(prompt).toContain('=== 之前的对话')
    expect(prompt).toContain('1. 用户: 每天整理待办发给我')
    expect(prompt).toContain('结果: 失败:新建工作流只能用本 hub 的能力。')
    expect(prompt.indexOf('=== 之前的对话')).toBeLessThan(prompt.indexOf('=== 用户的描述 ==='))
  })

  it('omits the conversation section when there is no history', async () => {
    const { service, calls } = buildDeps({ assist: assistOk(LOCAL_WF) })
    await service.create({ instruction: '建个工作流', userId: 'alice' })
    expect(calls.assistInputs[0]!.description).not.toContain('之前的对话')
  })

  it('forwards onChunk to the assist surface (per-call streaming)', async () => {
    const { service } = buildDeps({ assist: assistOk(LOCAL_WF) })
    const got: string[] = []
    const r = await service.create({ instruction: 'x', userId: 'alice', onChunk: (c) => got.push(c) })
    expect(r.ok).toBe(true)
    expect(got).toEqual(['chunk-1', 'chunk-2'])
  })

  it('omits the onChunk field entirely when the caller did not stream', async () => {
    const { service, calls } = buildDeps({ assist: assistOk(LOCAL_WF) })
    await service.create({ instruction: 'x', userId: 'alice' })
    expect(calls.assistInputs[0]?.hadOnChunk).toBe(false)
  })
})

describe('MeWorkflowCreateService.create — optional per-member draft cap', () => {
  it('refuses when the member is at the cap (assistant never runs)', async () => {
    const { service, calls } = buildDeps({ assist: assistOk(LOCAL_WF), perMemberDraftCap: 3, ownedDrafts: 3 })
    const r = await service.create({ instruction: 'x', userId: 'alice' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('draft_cap')
    expect(calls.assist).toBe(0)
  })

  it('allows when under the cap', async () => {
    const { service } = buildDeps({ assist: assistOk(LOCAL_WF), perMemberDraftCap: 3, ownedDrafts: 2 })
    const r = await service.create({ instruction: 'x', userId: 'alice' })
    expect(r.ok).toBe(true)
  })

  it('is OFF by default — no cap dep means unlimited', async () => {
    const { service } = buildDeps({ assist: assistOk(LOCAL_WF) })
    const r = await service.create({ instruction: 'x', userId: 'alice' })
    expect(r.ok).toBe(true)
  })
})

// --- MCD-M4: installed MCP server names in the architect's contextHints ------

describe('MeWorkflowCreateService.create — MCD-M4 MCP hints', () => {
  it('feeds installed MCP server names into the assistant contextHints', async () => {
    const { service, calls } = buildDeps({
      assist: assistOk(LOCAL_WF),
      mcpServerNames: () => ['chroma-rag', 'obsidian-notes'],
    })
    const r = await service.create({ instruction: 'x', userId: 'alice' })
    expect(r.ok).toBe(true)
    // The architect is told which MCP backends are already wired, so it builds
    // around 可直接组装的组件 instead of inventing names.
    expect(calls.assistInputs[0]?.mcpServers).toEqual(['chroma-rag', 'obsidian-notes'])
  })

  it('omits the MCP hint when no servers are installed (empty list)', async () => {
    const { service, calls } = buildDeps({ assist: assistOk(LOCAL_WF), mcpServerNames: () => [] })
    const r = await service.create({ instruction: 'x', userId: 'alice' })
    expect(r.ok).toBe(true)
    expect(calls.assistInputs[0]?.mcpServers).toBeUndefined()
  })

  it('omits the MCP hint entirely when no provider is wired (the default)', async () => {
    const { service, calls } = buildDeps({ assist: assistOk(LOCAL_WF) })
    const r = await service.create({ instruction: 'x', userId: 'alice' })
    expect(r.ok).toBe(true)
    expect(calls.assistInputs[0]?.mcpServers).toBeUndefined()
  })

  it('is best-effort: a registry read failure just omits the hint (create still succeeds)', async () => {
    const { service, calls } = buildDeps({
      assist: assistOk(LOCAL_WF),
      mcpServerNames: () => {
        throw new Error('registry off')
      },
    })
    const r = await service.create({ instruction: 'x', userId: 'alice' })
    expect(r.ok).toBe(true) // the MCP hint is advisory — its failure never blocks authoring
    expect(calls.assistInputs[0]?.mcpServers).toBeUndefined()
  })
})

// --- explain -----------------------------------------------------------------

describe('MeWorkflowCreateService.explain', () => {
  it('narrates an existing workflow at the requested depth + attaches the graph', async () => {
    // explain echoes subjectYaml verbatim — the fake returns assistOk(source).
    const { service, calls } = buildDeps({ assist: assistOk(CROSS_HUB_WF), source: CROSS_HUB_WF, existingIds: ['my-flow'] })
    const r = await service.explain({ workflowId: 'my-flow', userId: 'alice', detail: 'detailed' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.detail).toBe('detailed')
      expect(r.yaml).toBe(CROSS_HUB_WF)
      expect(r.graph?.workflowId).toBe('my-flow')
    }
    // explain mode forwards subjectYaml + mode + depth.
    expect(calls.assistInputs[0]?.mode).toBe('explain')
    expect(calls.assistInputs[0]?.subjectYaml).toBe(CROSS_HUB_WF)
    expect(calls.assistInputs[0]?.detail).toBe('detailed')
  })

  it('defaults to brief depth', async () => {
    const { service, calls } = buildDeps({ assist: assistOk(LOCAL_WF), source: LOCAL_WF, existingIds: ['my-flow'] })
    const r = await service.explain({ workflowId: 'my-flow', userId: 'alice' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.detail).toBe('brief')
    expect(calls.assistInputs[0]?.detail).toBe('brief')
  })

  it('returns not_found for an unknown workflow (assistant never runs)', async () => {
    const { service, calls } = buildDeps({ assist: assistOk(LOCAL_WF), existingIds: [] })
    const r = await service.explain({ workflowId: 'nope', userId: 'alice' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
    expect(calls.assist).toBe(0)
  })

  it('returns no_source when there is no readable YAML mirror', async () => {
    const { service } = buildDeps({ assist: assistOk(LOCAL_WF), source: null, existingIds: ['my-flow'] })
    const r = await service.explain({ workflowId: 'my-flow', userId: 'alice' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no_source')
  })

  it('surfaces an assist dispatch error as assistant_unavailable', async () => {
    const { service } = buildDeps({ assist: new Error('no api key'), source: LOCAL_WF, existingIds: ['my-flow'] })
    const r = await service.explain({ workflowId: 'my-flow', userId: 'alice' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('assistant_unavailable')
  })

  it('forwards a focus question as the description', async () => {
    const { service, calls } = buildDeps({ assist: assistOk(LOCAL_WF), source: LOCAL_WF, existingIds: ['my-flow'] })
    await service.explain({ workflowId: 'my-flow', userId: 'alice', focus: '这步为什么要审批?' })
    expect(calls.assistInputs[0]?.description).toBe('这步为什么要审批?')
  })
})

// --- createFromYaml (WIZ-M4) --------------------------------------------------
// 向导「用户已同意」的 YAML 走与 create() 完全相同的成员闸落草稿——唯一差别是
// 零 LLM（组装 + 修复回路向导已经跑完）。钉死：闸一个不少 + assist 一次不调。

describe('MeWorkflowCreateService.createFromYaml', () => {
  it('persists an approved yaml as a member-owned draft WITHOUT any assist call', async () => {
    const { service, calls } = buildDeps({ assist: new Error('must not be called') })
    const r = await service.createFromYaml({ yaml: LOCAL_WF, userId: 'alice' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.workflowId).toBe('my-flow')
    expect(calls.assist).toBe(0) // 关键：不重跑 LLM，不漂离用户同意的那版
    expect(calls.saveDraft).toEqual([{ text: LOCAL_WF, by: 'alice' }])
    expect(calls.grants).toEqual([{ workflowId: 'my-flow', userId: 'alice', perm: 'owner' }])
  })

  it('★ rejects cross-hub egress BEFORE persistence (same gate as create) ★', async () => {
    const { service, calls } = buildDeps({
      assist: new Error('unused'),
      peerCapabilities: PEER_VIEW,
    })
    const r = await service.createFromYaml({ yaml: CROSS_HUB_WF, userId: 'alice' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('cross_hub')
    expect(calls.saveDraft).toHaveLength(0)
  })

  it('refuses an id collision before it can clobber an existing workflow', async () => {
    const { service } = buildDeps({ assist: new Error('unused'), existingIds: ['my-flow'] })
    const r = await service.createFromYaml({ yaml: LOCAL_WF, userId: 'alice' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('id_exists')
  })

  it('honors the opt-in per-member draft cap (it creates a draft too)', async () => {
    const { service } = buildDeps({
      assist: new Error('unused'),
      perMemberDraftCap: 1,
      ownedDrafts: 1,
    })
    const r = await service.createFromYaml({ yaml: LOCAL_WF, userId: 'alice' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('draft_cap')
  })

  it('maps garbage yaml / persist failure to the same typed reasons as create', async () => {
    const bad = await buildDeps({ assist: new Error('unused') }).service.createFromYaml({
      yaml: 'not: [valid workflow',
      userId: 'alice',
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toBe('parse_failed')

    const failing = buildDeps({ assist: new Error('unused'), failPersist: new Error('gate said no') })
    const r = await failing.service.createFromYaml({ yaml: LOCAL_WF, userId: 'alice' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('structure_failed')
  })
})
