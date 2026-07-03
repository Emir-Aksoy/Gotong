/**
 * butler-workflow-create — Track A BE-M3. The resident butler's governed
 * `create_workflow` verb: a member says "每天早上把我的待办整理一下发给我" and the
 * butler proposes building a workflow; on /me approval the member 工作流架构师
 * (`MeWorkflowCreateService`) authors it as a draft.
 *
 * This isolates the THIN wrapper's behaviour from the real create service (a fake
 * `ButlerWorkflowCreateSource` hands back crafted results):
 *
 *   1. Every call parks (defaultVerdict `approve`) — no create runs from a chat
 *      message without the member confirming in /me.
 *   2. On success it reports the draft id + explanation and points at /me.
 *   3. A DENIAL is surfaced as an ERROR — crucially the `cross_hub` reject (the
 *      local-only gate lives in the service; the butler must relay "couldn't",
 *      never claim success).
 *   4. NO-LEAK — it only ever passes ITS OWN member's id to the create service.
 *
 * The full park→/me→approve→real-draft loop (incl. multi-gate resume routing
 * alongside the steward gate) is proven in butler-workflow-create-e2e.test.ts.
 */

import { describe, expect, it } from 'vitest'

import {
  buildButlerWorkflowCreateToolset,
  type ButlerWorkflowCreateSource,
} from '../src/personal-butler-workflow-create.js'
import type { MeWorkflowCreateResult } from '../src/me-workflow-create-service.js'

/** A fake create service that records every request and returns a scripted result. */
function fakeCreate(result: MeWorkflowCreateResult | Error): {
  surface: ButlerWorkflowCreateSource
  reqs: Array<{ instruction: string; userId: string }>
} {
  const reqs: Array<{ instruction: string; userId: string }> = []
  return {
    reqs,
    surface: {
      async create(req) {
        reqs.push({ instruction: req.instruction, userId: req.userId })
        if (result instanceof Error) throw result
        return result
      },
    },
  }
}

const OK: MeWorkflowCreateResult = {
  ok: true,
  workflowId: 'daily-todo',
  yaml: 'schema: aipehub.workflow/v1\nworkflow:\n  id: daily-todo\n',
  explanation: '每天早上把你的待办整理成要点发给你。',
}

const CROSS_HUB_DENIED: MeWorkflowCreateResult = {
  ok: false,
  reason: 'cross_hub',
  message: '这个工作流里有派发到别的 hub 的步骤(supplier.confirm-order)。新建工作流暂时只能用本 hub 的能力。',
}

const ASSISTANT_FAILED: MeWorkflowCreateResult = {
  ok: false,
  reason: 'assistant_failed',
  message: 'AI 没能把你的描述变成工作流,把想做的事说得更具体些。',
}

describe('butler-workflow-create — shape + gating', () => {
  it('offers exactly the create_workflow tool and governs it, defaulting to approve', async () => {
    const gate = buildButlerWorkflowCreateToolset({ userId: 'alice', create: fakeCreate(OK).surface })
    expect(gate.listTools().map((t) => t.name)).toEqual(['create_workflow'])
    expect(gate.governs('create_workflow')).toBe(true)
    expect(gate.governs('edit_workflow')).toBe(false)
    // Parks for a human every time — the /me inbox is the review step.
    expect(await gate.classify('create_workflow', { instruction: 'x' })).toEqual({
      decision: 'approve',
      reason: expect.stringContaining('新建'),
    })
  })

  it('describes the inbox item with a truncated instruction', () => {
    const gate = buildButlerWorkflowCreateToolset({ userId: 'alice', create: fakeCreate(OK).surface })
    expect(gate.describe('create_workflow', { instruction: '每天早上整理待办' })).toBe(
      '新建工作流:每天早上整理待办',
    )
    const long = '一'.repeat(60)
    expect(gate.describe('create_workflow', { instruction: long }).length).toBeLessThan(50)
    expect(gate.describe('create_workflow', {})).toBe('新建工作流:(未描述)')
  })
})

describe('butler-workflow-create — execute (cleared action)', () => {
  it('on success reports the draft id + explanation and points at /me', async () => {
    const f = fakeCreate(OK)
    const gate = buildButlerWorkflowCreateToolset({ userId: 'alice', create: f.surface })
    const res = await gate.callTool('create_workflow', { instruction: '每天整理待办' })
    expect(res.isError).toBeFalsy()
    const text = res.content.map((c) => c.text ?? '').join('')
    expect(text).toContain('daily-todo')
    expect(text).toContain('每天早上把你的待办整理成要点')
    expect(text).toContain('/me')
    // Called the service with THIS member's id.
    expect(f.reqs).toEqual([{ instruction: '每天整理待办', userId: 'alice' }])
  })

  it('surfaces a cross-hub denial as an error (local-only gate relayed honestly)', async () => {
    const gate = buildButlerWorkflowCreateToolset({ userId: 'alice', create: fakeCreate(CROSS_HUB_DENIED).surface })
    const res = await gate.callTool('create_workflow', { instruction: '让供货商 hub 确认订单' })
    expect(res.isError).toBe(true)
    const text = res.content.map((c) => c.text ?? '').join('')
    expect(text).toContain('别的 hub')
    expect(text).not.toContain('已建好') // never claims success on a denial
  })

  it('surfaces an assistant failure as an error', async () => {
    const gate = buildButlerWorkflowCreateToolset({ userId: 'alice', create: fakeCreate(ASSISTANT_FAILED).surface })
    const res = await gate.callTool('create_workflow', { instruction: '呃' })
    expect(res.isError).toBe(true)
    expect(res.content.map((c) => c.text ?? '').join('')).toContain('没能新建')
  })

  it('refuses an empty instruction without calling the service', async () => {
    const f = fakeCreate(OK)
    const gate = buildButlerWorkflowCreateToolset({ userId: 'alice', create: f.surface })
    const res = await gate.callTool('create_workflow', { instruction: '   ' })
    expect(res.isError).toBe(true)
    expect(f.reqs).toHaveLength(0)
  })

  it('fails closed when the service throws (never claims a draft was made)', async () => {
    const gate = buildButlerWorkflowCreateToolset({
      userId: 'alice',
      create: fakeCreate(new Error('boom')).surface,
    })
    const res = await gate.callTool('create_workflow', { instruction: '整理待办' })
    expect(res.isError).toBe(true)
    const text = res.content.map((c) => c.text ?? '').join('')
    expect(text).toContain('出错')
    expect(text).not.toContain('已建好')
  })
})

describe('butler-workflow-create — no-leak', () => {
  it("only ever passes its OWN member's id to the create service", async () => {
    const f = fakeCreate(OK)
    const aliceGate = buildButlerWorkflowCreateToolset({ userId: 'alice', create: f.surface })
    await aliceGate.callTool('create_workflow', { instruction: 'a' })
    await aliceGate.callTool('create_workflow', { instruction: 'b' })
    expect(f.reqs.every((r) => r.userId === 'alice')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// WIZ-M4c — the plan_workflow → create_workflow hand-off: an optional `yaml`
// lands the wizard-checked definition VERBATIM via createFromYaml (zero LLM),
// never regenerating something the member didn't see.
// ---------------------------------------------------------------------------

describe('butler-workflow-create — wizard YAML hand-off (WIZ-M4c)', () => {
  const WIZ_YAML = 'schema: aipehub.workflow/v1\nworkflow:\n  id: weekly-report\n'

  function fakeWithYaml(fromYamlResult: MeWorkflowCreateResult): {
    surface: ButlerWorkflowCreateSource
    createReqs: Array<{ instruction: string; userId: string }>
    yamlReqs: Array<{ yaml: string; userId: string }>
  } {
    const createReqs: Array<{ instruction: string; userId: string }> = []
    const yamlReqs: Array<{ yaml: string; userId: string }> = []
    return {
      createReqs,
      yamlReqs,
      surface: {
        async create(req) {
          createReqs.push({ instruction: req.instruction, userId: req.userId })
          return OK
        },
        async createFromYaml(req) {
          yamlReqs.push({ yaml: req.yaml, userId: req.userId })
          return fromYamlResult
        },
      },
    }
  }

  it('yaml present → lands verbatim via createFromYaml with OWN member id; create() never runs', async () => {
    const f = fakeWithYaml({ ok: true, workflowId: 'weekly-report', yaml: WIZ_YAML, explanation: '' })
    const gate = buildButlerWorkflowCreateToolset({ userId: 'alice', create: f.surface })
    const res = await gate.callTool('create_workflow', { instruction: '每周五发周报', yaml: WIZ_YAML })
    expect(res.isError).toBeFalsy()
    expect(f.yamlReqs).toEqual([{ yaml: WIZ_YAML, userId: 'alice' }])
    expect(f.createReqs).toHaveLength(0)
    const text = res.content.map((c) => c.text ?? '').join('')
    expect(text).toContain('weekly-report')
    expect(text).toContain('/me')
    // createFromYaml returns explanation:'' — no dangling blank line in the reply.
    expect(text).not.toContain('。\n\n去')
  })

  it('blank yaml falls back to the plain-language create path', async () => {
    const f = fakeWithYaml({ ok: true, workflowId: 'x', yaml: WIZ_YAML, explanation: '' })
    const gate = buildButlerWorkflowCreateToolset({ userId: 'alice', create: f.surface })
    await gate.callTool('create_workflow', { instruction: '每周五发周报', yaml: '   ' })
    expect(f.yamlReqs).toHaveLength(0)
    expect(f.createReqs).toEqual([{ instruction: '每周五发周报', userId: 'alice' }])
  })

  it('yaml present but the surface lacks createFromYaml → honest refusal, NOTHING regenerated', async () => {
    const f = fakeCreate(OK) // the legacy surface without createFromYaml
    const gate = buildButlerWorkflowCreateToolset({ userId: 'alice', create: f.surface })
    const res = await gate.callTool('create_workflow', { instruction: '每周五发周报', yaml: WIZ_YAML })
    expect(res.isError).toBe(true)
    // Silently re-authoring via create(instruction) would land a workflow the
    // member never reviewed — the wrapper must refuse instead.
    expect(f.reqs).toHaveLength(0)
    expect(res.content.map((c) => c.text ?? '').join('')).not.toContain('已建好')
  })

  it('a denial through the yaml path is relayed as an error', async () => {
    const f = fakeWithYaml({ ok: false, reason: 'id_exists', message: '已经有一个同名工作流了。' })
    const gate = buildButlerWorkflowCreateToolset({ userId: 'alice', create: f.surface })
    const res = await gate.callTool('create_workflow', { instruction: '每周五发周报', yaml: WIZ_YAML })
    expect(res.isError).toBe(true)
    expect(res.content.map((c) => c.text ?? '').join('')).toContain('同名')
  })

  it('describe marks the wizard path so the /me approval card is honest about what lands', () => {
    const gate = buildButlerWorkflowCreateToolset({ userId: 'alice', create: fakeWithYaml(OK).surface })
    expect(gate.describe('create_workflow', { instruction: '每周五发周报', yaml: WIZ_YAML })).toBe(
      '新建工作流(按向导核对过的方案):每周五发周报',
    )
    expect(gate.describe('create_workflow', { instruction: '每周五发周报' })).toBe(
      '新建工作流:每周五发周报',
    )
  })
})
