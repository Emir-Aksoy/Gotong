/**
 * WIZ-M5 — end-to-end acceptance for the 六段建流向导 (workflow wizard).
 *
 * The WIZ-M3 unit test drives `WorkflowWizardService` with a scripted fake
 * assist; wizard-wiring.test.ts proves the five-source projection with light
 * fakes. This gate closes the seam neither can: the REAL stack, end to end —
 *
 *   a real `WorkflowAssistantAgent` dispatched through a real `Hub` (a
 *   DETERMINISTIC mock LLM keyed off markers, so the assertion is stable, not
 *   the network) + the REAL `createWorkflowWizard` wiring (five live sources →
 *   catalog → prompt) + the real gap analysis over preset template cards + the
 *   real `MeWorkflowCreateService.createFromYaml` persist gate (controller +
 *   versioning + identity owner grant).
 *
 * Exactly the user's six-phase spec ("先和用户确定任务…查看已有组件和预置组件…
 * 衡量任务、资源…给用户建议后由用户调整或同意…校验无错误才算完成"):
 *
 *   1. ①确认+②盘点 are ZERO-LLM — prepare returns the confirm card + a catalog
 *      text carrying BOTH sections (installed hub components AND preset
 *      templates), without a single model call.
 *   2. ③组装→⑥校验 green path: compose lands a valid YAML in one shot
 *      (repairRounds 0), ④ gap analysis says every step has a doer, and ⑤ the
 *      member's approval persists it AS A DRAFT they own via the SAME gate as
 *      /create (zero LLM on approve).
 *   3. ⑥ R1 repair loop: a first draft with a machine-level error (forward_ref)
 *      is fed back as a numbered instruction ("没通过校验") and the SECOND model
 *      call fixes it — repairRounds 1, green result.
 *   4. ④ a capability nobody installed serves but a PRESET template provides is
 *      a GAP, not an error — the proposal names the template (installTemplateRefs)
 *      and ★ the gapped draft still persists (advisory unknown_capability never
 *      blocks a draft; the gap closes before publish).
 *   5. ⑥ a stubborn assistant (hard-broken YAML every round) exhausts the
 *      bounded repair budget → ok:false `exhausted` with the error rendering,
 *      and NOTHING is persisted.
 *   6. ① a model that asks back instead of emitting YAML → ok:false `needs_user`
 *      relaying its question — one LLM call, no repair loop.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, HumanParticipant, InMemoryStorage } from '@aipehub/core'
import { MockLlmProvider, type LlmRequest } from '@aipehub/llm'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'
import {
  WorkflowAssistantAgent,
  WORKFLOW_ASSISTANT_CAPABILITY,
  type WorkflowAssistantOutput,
} from '@aipehub/workflow-assistant'

import { WorkflowController } from '../src/workflow-controller.js'
import { MeWorkflowCreateService } from '../src/me-workflow-create-service.js'
import { createWorkflowWizard } from '../src/wizard-wiring.js'
import type { WorkflowWizardService } from '../src/workflow-wizard.js'
import type { WizardAssistView } from '../src/workflow-wizard.js'

// --- scenario YAMLs (real text → real parseWorkflow downstream) --------------

const GREEN_YAML = [
  'schema: aipehub.workflow/v1',
  'workflow:',
  '  id: morning-digest',
  '  trigger:',
  '    capability: run-morning',
  '  steps:',
  '    - id: gather',
  '      dispatch:',
  '        strategy: { kind: capability, capabilities: [collect-notes] }',
  '        payload: {}',
  '    - id: summarize',
  '      dispatch:',
  '        strategy: { kind: capability, capabilities: [summarize] }',
  '        payload: { source: $gather.output }',
].join('\n')

// gather references the LATER step's output → forward_ref (a HARD violation the
// machine must fix; the repair loop's instruction tells it to).
const REPAIR_BROKEN = [
  'schema: aipehub.workflow/v1',
  'workflow:',
  '  id: repair-flow',
  '  trigger:',
  '    capability: run-repair',
  '  steps:',
  '    - id: gather',
  '      dispatch:',
  '        strategy: { kind: capability, capabilities: [collect-notes] }',
  '        payload: { source: $summarize.output }',
  '    - id: summarize',
  '      dispatch:',
  '        strategy: { kind: capability, capabilities: [summarize] }',
  '        payload: {}',
].join('\n')

const REPAIR_FIXED = [
  'schema: aipehub.workflow/v1',
  'workflow:',
  '  id: repair-flow',
  '  trigger:',
  '    capability: run-repair',
  '  steps:',
  '    - id: gather',
  '      dispatch:',
  '        strategy: { kind: capability, capabilities: [collect-notes] }',
  '        payload: {}',
  '    - id: summarize',
  '      dispatch:',
  '        strategy: { kind: capability, capabilities: [summarize] }',
  '        payload: { source: $gather.output }',
].join('\n')

// `legal-review` is served by NO installed participant, but the preset template
// card `legal-pack` provides an agent covering it — a GAP with an install
// proposal, not a repairable error.
const GAP_YAML = [
  'schema: aipehub.workflow/v1',
  'workflow:',
  '  id: contract-review',
  '  trigger:',
  '    capability: run-contract',
  '  steps:',
  '    - id: review',
  '      dispatch:',
  '        strategy: { kind: capability, capabilities: [legal-review] }',
  '        payload: {}',
  '    - id: summarize',
  '      dispatch:',
  '        strategy: { kind: capability, capabilities: [summarize] }',
  '        payload: { source: $review.output }',
].join('\n')

// --- deterministic assistant LLM ---------------------------------------------

function fence(yaml: string): string {
  return ['好的，方案如下：', '', '```yaml', yaml.trimEnd(), '```'].join('\n')
}

/**
 * Replies keyed off a marker the test embeds in the TASK (which the wizard folds
 * into the prompt). Repair calls are recognized by the wizard's own repair
 * banner text riding in the description — the mock "fixes" the draft exactly
 * when the loop asked it to (except the stubborn one, which never does).
 */
const MARK = {
  green: 'MARK_GREEN',
  repair: 'MARK_REPAIR',
  stubborn: 'MARK_STUBBORN',
  gap: 'MARK_GAP',
  chat: 'MARK_CHAT',
}

function wizardReply(req: LlmRequest): string {
  const seen = JSON.stringify(req)
  const isRepairRound = seen.includes('没通过校验')
  if (seen.includes(MARK.green)) return fence(GREEN_YAML)
  if (seen.includes(MARK.repair)) return isRepairRound ? fence(REPAIR_FIXED) : fence(REPAIR_BROKEN)
  if (seen.includes(MARK.stubborn)) return fence(REPAIR_BROKEN)
  if (seen.includes(MARK.gap)) return fence(GAP_YAML)
  if (seen.includes(MARK.chat)) return '我需要先问一下:这个流程谁来审批,你自己还是同事?'
  return fence(GREEN_YAML)
}

// --- rig ----------------------------------------------------------------------

const MEMBER = 'alice'
const LOCAL_CAPS = ['collect-notes', 'summarize']

interface Rig {
  tmp: string
  hub: Hub
  identity: IdentityStore
  controller: WorkflowController
  wizard: WorkflowWizardService
  create: MeWorkflowCreateService
  /** Every request the mock LLM saw — llmCalls.length is the model-call count. */
  llmCalls: LlmRequest[]
}

async function boot(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipe-wizard-e2e-'))
  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()

  // The installed hub components the catalog's "已有组件" section lists: a human
  // worker serving the local caps (人也是组件).
  hub.register(new HumanParticipant({ id: 'worker', capabilities: LOCAL_CAPS }))

  const llmCalls: LlmRequest[] = []
  hub.register(
    new WorkflowAssistantAgent({
      provider: new MockLlmProvider({
        reply: (req) => {
          llmCalls.push(req)
          return wizardReply(req)
        },
      }),
      maxTokens: 2048,
    }),
  )

  // The host's assist adapter — the same dispatch shape main.ts wires.
  const assist: WizardAssistView = {
    async assist(input) {
      const result = await hub.dispatch({
        from: input.by,
        strategy: { kind: 'capability', capabilities: [WORKFLOW_ASSISTANT_CAPABILITY] },
        payload: {
          description: input.description,
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.detail ? { detail: input.detail } : {}),
          ...(input.contextHints ? { contextHints: input.contextHints } : {}),
        },
        title: 'workflow:assist',
      })
      if (result.kind !== 'ok') throw new Error(`assist dispatch failed: ${result.kind}`)
      return result.output as WorkflowAssistantOutput
    },
  }

  const controller = new WorkflowController({
    hub,
    definitionsDir: join(tmp, 'workflows', 'definitions'),
    spaceRoot: tmp,
  })
  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })

  // ★ the REAL wiring under test: five live sources → catalog → wizard.
  const wizard = createWorkflowWizard({
    assist,
    sources: {
      participants: () => hub.participants().map((p) => ({
        id: p.id,
        kind: p.kind,
        capabilities: p.capabilities,
      })),
      mcpServers: async () => [{ spec: { name: 'filesystem', description: '读写本地文件' } }],
      inventory: async () => ({
        llmKeys: [{ provider: 'deepseek', envSet: true, vaultConfigured: false }],
        localEndpoints: [],
        cliAgents: [],
      }),
      templateCards: () => [
        {
          id: 'legal-pack',
          name: '法务包',
          description: '合同初审一条龙',
          agents: [{ id: 'lawyer', displayName: '法务审查官', capabilities: ['legal-review'] }],
        },
      ],
      connectors: () => [],
    },
    existingWorkflowIds: async () => (await controller.list()).map((w) => w.id),
  })

  // ⑤同意 lands through the SAME member gate as /create.
  const create = new MeWorkflowCreateService({
    grants: identity,
    workflows: controller,
    assist,
    participants: () =>
      hub.participants().map((p) => ({ id: p.id, capabilities: p.capabilities })),
  })

  return { tmp, hub, identity, controller, wizard, create, llmCalls }
}

async function teardown(r: Rig): Promise<void> {
  await r.hub.stop()
  r.identity.close()
  await rm(r.tmp, { recursive: true, force: true })
}

// --- tests ----------------------------------------------------------------------

describe('workflow-wizard WIZ-M5 — six phases, real stack', () => {
  let r: Rig
  beforeEach(async () => {
    r = await boot()
  })
  afterEach(() => teardown(r))

  it('1. ①确认+②盘点 are zero-LLM: confirm card + both catalog sections, no model call', async () => {
    const prep = await r.wizard.prepare({ task: '每天早上收集笔记再总结发我', by: MEMBER })
    expect(prep.confirmText).toContain('每天早上收集笔记再总结发我')
    // ② the SAME catalog text compose will feed the model: installed + preset.
    expect(prep.catalogText).toContain('本 hub 已有组件')
    expect(prep.catalogText).toContain('worker')
    expect(prep.catalogText).toContain('filesystem')
    expect(prep.catalogText).toContain('预置组件')
    expect(prep.catalogText).toContain('法务包')
    expect(prep.catalogText).toContain('legal-review')
    // ★ inventorying burned zero model calls.
    expect(r.llmCalls).toHaveLength(0)
  })

  it('2. ③→⑥ green path: one-shot valid YAML, all needs covered, approval persists a member-owned draft', async () => {
    const res = await r.wizard.compose({ task: `每天早上收集笔记再总结发我 ${MARK.green}`, by: MEMBER })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.repairRounds).toBe(0)
    // ④ every step has a doer — the installed human covers both caps.
    expect(res.gapAnalysis.ok).toBe(true)
    expect(res.gapText).toContain('✓')
    expect(res.installTemplateRefs).toEqual([])
    expect(r.llmCalls).toHaveLength(1)

    // ⑤ the member approves → zero-LLM persist through the SAME gate as /create.
    const before = r.llmCalls.length
    const saved = await r.create.createFromYaml({ yaml: res.yaml, userId: MEMBER })
    expect(saved.ok).toBe(true)
    expect(r.llmCalls).toHaveLength(before) // approve burned no model call
    expect(await r.controller.versioning.has('morning-digest')).toBe(true)
    expect((await r.controller.getState('morning-digest')).state).toBe('draft')
    expect(r.identity.hasWorkflowGrant('morning-digest', MEMBER, 'owner')).toBe(true)
  })

  it('3. ⑥ R1 repair loop: a forward_ref draft is fed back as instructions and fixed in round 1', async () => {
    const res = await r.wizard.compose({ task: `整理再收集 ${MARK.repair}`, by: MEMBER })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.repairRounds).toBe(1)
    expect(res.yaml).toContain('$gather.output') // the FIXED version landed
    // Two model calls; the second carried the wizard's error→instruction rendering.
    expect(r.llmCalls).toHaveLength(2)
    const second = JSON.stringify(r.llmCalls[1])
    expect(second).toContain('没通过校验')
    expect(second).toContain('repair-flow') // the broken draft rode along for context
  })

  it('4. ④ a preset-only capability is a GAP with an install proposal — and the gapped draft still persists', async () => {
    const res = await r.wizard.compose({ task: `合同初审 ${MARK.gap}`, by: MEMBER })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // legal-review isn't an error — it's a gap the legal-pack template can fill.
    expect(res.repairRounds).toBe(0)
    expect(res.gapAnalysis.ok).toBe(false)
    const missing = res.gapAnalysis.needs.find((n) => !n.satisfied)
    expect(missing).toBeDefined()
    expect(missing!.need.capabilities).toContain('legal-review')
    expect(missing!.proposals?.some((p) => p.kind === 'install_template')).toBe(true)
    expect(res.installTemplateRefs).toEqual(['legal-pack'])
    expect(res.gapText).toContain('✗')

    // ★ advisory unknown_capability never blocks a DRAFT: the member can save
    // now and close the gap (install legal-pack) before publish.
    const saved = await r.create.createFromYaml({ yaml: res.yaml, userId: MEMBER })
    expect(saved.ok).toBe(true)
    expect((await r.controller.getState('contract-review')).state).toBe('draft')
  })

  it('5. ⑥ a stubborn assistant exhausts the bounded repair budget; nothing persists', async () => {
    const res = await r.wizard.compose({ task: `坏流程 ${MARK.stubborn}`, by: MEMBER })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('exhausted')
    expect(res.repairRounds).toBe(2) // the default bound
    expect(res.errorsText).toBeTruthy()
    expect(res.lastYaml).toContain('repair-flow')
    expect(r.llmCalls).toHaveLength(3) // initial + 2 bounded repair rounds
    // The wizard proposes; only the member's approval persists — so nothing landed.
    expect(await r.controller.versioning.has('repair-flow')).toBe(false)
  })

  it('6. ① a model that asks back → needs_user relaying its question, no repair loop', async () => {
    const res = await r.wizard.compose({ task: `建个流程 ${MARK.chat}`, by: MEMBER })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('needs_user')
    expect(res.explanation).toContain('谁来审批')
    expect(r.llmCalls).toHaveLength(1)
  })
})
