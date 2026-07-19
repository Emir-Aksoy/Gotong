/**
 * Anti-rot acceptance gate for the family-hub loadable template (FAM-M1).
 *
 * family-hub is the FAMILY-HUB.md story made installable: the approval-demo
 * workflow is "moment C" (对外动作有人批) as a one-click, so this gate protects
 * exactly the load-bearing shape of that story:
 *   - the `human:` approval step desugars to gotong.human/v1 and its assignee
 *     rides the trigger payload (the requester picks WHICH parent approves);
 *   - carry-out is GATED on the approval (`when: $approve.output.approved ==
 *     true`) — a REJECTED approval returns a normal {approved:false} ok output,
 *     NOT a halt, so without the gate carry-out would still emit the plan and
 *     break the "批准才出方案,拒绝就不做" promise;
 *   - the brief workflow is the unattended golden-run case (the approval flow
 *     deliberately is NOT — it suspends on the human step by design);
 *   - all three life-connector slots stay optional (honest mode is the
 *     acceptance baseline, not a keyed-up happy path);
 *   - a real POST /api/admin/templates/import lands both agents + both
 *     workflows with zero secrets in the manifest.
 *
 * Mirrors the cafe-ops gate: shipped yaml off disk → real parseTemplate →
 * real parseWorkflow per block → real import route.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hub, Space } from '@gotong/core'
import { parseWorkflow } from '@gotong/workflow'

import { serveWeb, type WebServerHandle, type WorkflowSurface } from '../src/server.js'
import { parseTemplate } from '../src/template-manifest.js'

const EXAMPLE_PATH = fileURLToPath(
  new URL('../../../examples/family-hub/template/family-hub.template.yaml', import.meta.url),
)

const WORKFLOW_IDS = ['family-approval-demo', 'family-brief']

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/family-hub/template (FAM-M1)', () => {
  it('parses as a valid gotong.template/v1 manifest', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('家庭 hub(一家人的 AI 管家)')
    expect(t.version).toBe(1)
    expect(t.agents.map((a) => a.id)).toEqual(['family-helper', 'family-brief-writer'])
    expect(t.workflows.map((w) => w.id)).toEqual(WORKFLOW_IDS)
    // One-click key prompt, mirroring morning-brief.
    expect(t.apiKeyPrompt).toMatchObject({ provider: 'openai-compatible', label: 'DeepSeek' })
  })

  it('agents cover exactly the two dispatched capabilities, with no secrets inline', () => {
    const agents = parseTemplate(templateText).agents
    const helper = agents.find((a) => a.id === 'family-helper')!
    const writer = agents.find((a) => a.id === 'family-brief-writer')!
    expect(helper.capabilities).toEqual(['family.assist'])
    expect(writer.capabilities).toEqual(['family.brief.compose'])
    // The manifest ships structure only — never a literal key.
    expect(templateText).not.toMatch(/sk-[A-Za-z0-9]{8}/)
  })

  it('the approval demo desugars to a real human step whose assignee rides the trigger', () => {
    const t = parseTemplate(templateText)
    const byId = new Map(t.workflows.map((w) => [w.id, parseWorkflow(w.yaml)]))

    const demo = byId.get('family-approval-demo')!
    expect(demo.trigger.capability).toBe('family.request')
    // Any family member can start it from /me; the requester is pinned by the
    // /me gate (user_scope_field), NOT trusted from the form.
    expect(demo.surface?.me?.enabled).toBe(true)
    expect(demo.surface?.me?.userScopeField).toBe('requester_id')
    // The `human:` sugar desugared to the Phase-16 inbox capability, and the
    // approver is whoever the requester named — moment C's whole point.
    const serialized = JSON.stringify(demo)
    expect(serialized).toContain('gotong.human/v1')
    expect(serialized).toContain('$trigger.payload.approver_id')

    const brief = byId.get('family-brief')!
    expect(brief.trigger.capability).toBe('family.brief.request')
    expect(brief.surface?.me?.userScopeField).toBe('reader_id')
  })

  it('GATES carry-out on the approval — a rejected approval produces no plan', () => {
    const t = parseTemplate(templateText)
    const demo = parseWorkflow(t.workflows.find((w) => w.id === 'family-approval-demo')!.yaml)

    const steps = new Map(demo.steps.map((s) => [s.id, s]))
    expect([...steps.keys()]).toEqual(['prepare', 'approve', 'carry-out'])

    // THE load-bearing assertion: carry-out is gated on the approval decision.
    // Without this `when`, a REJECTED approval (which returns {approved:false}
    // as a normal ok output, NOT a halt) would still run carry-out and emit the
    // execution plan — breaking the template's "批准才出方案,拒绝就不做" promise.
    // On rejection the step is skipped, so `output.plan` (`$carry-out.output`)
    // resolves to its undefined output = 「不做」. Mirrors solo-company-hub's
    // finalize gate (packages/web/tests/solo-company-hub-template.test.ts).
    const carryOut = steps.get('carry-out')! as { when?: string }
    expect(carryOut.when).toBe('$approve.output.approved == true')
  })

  it('golden-run covers ONLY the unattended brief; the approval flow is human-verified by design', () => {
    const t = parseTemplate(templateText)
    expect(t.acceptanceCases.map((c) => c.workflowId)).toEqual(['family-brief'])
    const smoke = t.acceptanceCases[0]!
    // Honest mode is the baseline: the case must be green with zero connectors.
    expect(smoke.assert.contains).toEqual(['今日重点', '家庭提醒', '今日一学'])
    expect(smoke.assert.forbid).toEqual(['作为一个AI', '我无法访问'])
  })

  it('declares three OPTIONAL life-connector slots and a person-less schedule suggestion', () => {
    const t = parseTemplate(templateText)
    expect(t.connectorSlots.map((s) => s.id)).toEqual(['calendar', 'notes', 'tasks'])
    for (const slot of t.connectorSlots) {
      expect(slot.optional, `${slot.id} must stay optional (honest mode)`).toBe(true)
    }
    // Cadence only — a template carrying a userId is rejected at parse time
    // elsewhere; here we assert the suggestion targets the brief workflow.
    expect(t.scheduleSuggestions).toEqual([
      expect.objectContaining({ workflowId: 'family-brief' }),
    ])
  })

  it('imports end-to-end: 2 agents land, both workflows import (each re-validated)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-family-'))
    const { space } = await Space.init(tmp, { name: 'family-test' })
    const hub = new Hub({ space })
    await hub.start()
    const { token } = await space.createAdmin('TestAdmin')

    const importedIds: string[] = []
    const workflows = {
      importFromText: async (yaml: string) => {
        const def = parseWorkflow(yaml)
        importedIds.push(def.id)
        return { id: def.id }
      },
    } as unknown as WorkflowSurface

    let server: WebServerHandle | undefined
    try {
      server = await serveWeb(hub, { host: '127.0.0.1', port: 0, workflows })
      const res = await fetch(`${server.url}/api/admin/templates/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ template: templateText }),
      })
      expect(res.status).toBe(200)
      const json: any = await res.json()
      expect(json.ok).toBe(true)

      const landed = (await space.agents()).map((a) => a.id)
      for (const id of ['family-helper', 'family-brief-writer']) expect(landed).toContain(id)

      expect(json.workflows).toEqual(WORKFLOW_IDS.map((id) => ({ id, ok: true })))
      expect(importedIds).toEqual(WORKFLOW_IDS)

      // Structure-only import: no secrets ride the manifest.
      expect(json.secretsApplied).toBe(0)
      expect(json.encryptedSkipped).toBe(false)
    } finally {
      await server?.close()
      await hub.stop?.()
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
