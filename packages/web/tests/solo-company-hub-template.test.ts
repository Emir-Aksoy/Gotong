/**
 * Anti-rot acceptance gate for the solo-company-hub loadable template (OPC-M1).
 *
 * solo-company-hub is the SOLO-COMPANY-HUB.md story made installable: one
 * person + three professional stand-ins runs a small team's output. The
 * gallery gate (builtin-templates.test.ts) only re-parses the manifest — it
 * treats each workflow as an opaque blob. This gate is the LOAD-BEARING one:
 * it drives real parseWorkflow per block and pins the two semantics a Codex
 * cross-review caught the first draft getting WRONG, so they can't regress:
 *
 *   1. The outreach approval flow's `finalize` step is GATED on the approval
 *      (`when: $approve.output.approved == true`). A human `approval` step
 *      that is REJECTED returns a normal `{approved:false}` output — it does
 *      NOT halt the run — so without the gate the "拒绝就不发" promise is a
 *      lie: finalize would run and emit the final copy anyway.
 *   2. The `smoke-new-client-workup` acceptance trigger declares EXACTLY one
 *      field `brief` carrying the whole prompt. A bare (unquoted) value in a
 *      YAML flow mapping `{ brief: …,… }` splits on the ASCII commas into
 *      stray null keys and silently truncates the brief — so the value must
 *      survive intact.
 *
 * Plus the family-hub-gate invariants: real parseTemplate, agents cover the
 * dispatched capabilities, no secrets inline, optional connector slots,
 * person-less schedule suggestion, real POST import lands everything.
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
  new URL(
    '../../../examples/solo-company-hub/template/solo-company-hub.template.yaml',
    import.meta.url,
  ),
)

const AGENT_IDS = ['client-comms', 'ops-brief-writer', 'research-aide']
const WORKFLOW_IDS = ['client-outreach-approval', 'daily-ops-brief', 'new-client-workup']

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/solo-company-hub/template (OPC-M1)', () => {
  it('parses as a valid gotong.template/v1 manifest', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('一人公司 hub(一个人顶一个团队)')
    expect(t.version).toBe(1)
    expect(t.agents.map((a) => a.id)).toEqual(AGENT_IDS)
    expect(t.workflows.map((w) => w.id)).toEqual(WORKFLOW_IDS)
    // One-click key prompt, mirroring family-hub / morning-brief.
    expect(t.apiKeyPrompt).toMatchObject({ provider: 'openai-compatible', label: 'DeepSeek' })
  })

  it('three stand-ins cover exactly the three dispatched capabilities, no secrets inline', () => {
    const agents = parseTemplate(templateText).agents
    expect(agents.find((a) => a.id === 'client-comms')!.capabilities).toEqual(['solo.comms'])
    expect(agents.find((a) => a.id === 'ops-brief-writer')!.capabilities).toEqual([
      'solo.brief.compose',
    ])
    expect(agents.find((a) => a.id === 'research-aide')!.capabilities).toEqual(['solo.research'])
    // The manifest ships structure only — never a literal key.
    expect(templateText).not.toMatch(/sk-[A-Za-z0-9]{8}/)
  })

  it('outreach flow GATES finalize on approval — reject produces no final copy', () => {
    const t = parseTemplate(templateText)
    const outreach = parseWorkflow(t.workflows.find((w) => w.id === 'client-outreach-approval')!.yaml)

    // Any member starts it from /me; the requester is pinned by the /me gate,
    // never trusted from the form.
    expect(outreach.trigger.capability).toBe('solo.outreach.request')
    expect(outreach.surface?.me?.userScopeField).toBe('requester_id')

    const steps = new Map(outreach.steps.map((s) => [s.id, s]))
    expect([...steps.keys()]).toEqual(['draft', 'approve', 'finalize'])

    // THE load-bearing assertion: finalize is gated on the approval decision.
    // Without this `when`, a rejected approval (which returns {approved:false}
    // as a normal ok output, NOT a halt) would still run finalize and emit the
    // final copy — breaking "不签发就不发".
    const finalize = steps.get('finalize')! as { when?: string }
    expect(finalize.when).toBe('$approve.output.approved == true')

    // One-person company: the approver is the requester (server-pinned), so the
    // card always lands in your own inbox and there's no userId to mistype.
    const serialized = JSON.stringify(outreach)
    expect(serialized).toContain('gotong.human/v1')
    expect(serialized).toContain('$trigger.payload.requester_id')
    // The draft is inlined into the approval prompt so it's visible ON the card
    // (the /me inbox projection shows the prompt, not prior step outputs).
    expect(serialized).toContain('$draft.output.text')
  })

  it('golden-runs cover ONLY the two unattended flows; the approval flow is human-verified', () => {
    const t = parseTemplate(templateText)
    expect(t.acceptanceCases.map((c) => c.id)).toEqual([
      'smoke-ops-brief',
      'smoke-new-client-workup',
    ])
    // The approval flow deliberately is NOT a golden-run — it suspends on the
    // human step by design; "你真签发一次" is what it exists to have a human verify.
    expect(t.acceptanceCases.map((c) => c.workflowId)).not.toContain('client-outreach-approval')

    const brief = t.acceptanceCases.find((c) => c.id === 'smoke-ops-brief')!
    expect(brief.assert.contains).toEqual(['今日优先级', '待跟进', '现金流提醒', '今日一问'])

    // #4 regression guard: the workup trigger must carry EXACTLY `brief` with the
    // whole prompt intact — an unquoted flow-mapping value would split on the
    // ASCII commas into stray null keys and truncate the brief.
    const workup = t.acceptanceCases.find((c) => c.id === 'smoke-new-client-workup')!
    expect(Object.keys(workup.trigger)).toEqual(['brief'])
    expect(workup.trigger.brief).toBe('一个电商客户想做一个促销落地页,两周内上线,预算不明。')
    expect(workup.assert.contains).toEqual(['这单的背景', '关键要点', '报价参考', '风险与注意'])
  })

  it('declares four OPTIONAL connector slots and a person-less schedule suggestion', () => {
    const t = parseTemplate(templateText)
    expect(t.connectorSlots.map((s) => s.id)).toEqual(['knowledge', 'calendar', 'tasks', 'crm'])
    for (const slot of t.connectorSlots) {
      expect(slot.optional, `${slot.id} must stay optional (honest mode)`).toBe(true)
    }
    // Cadence only — the suggestion targets the brief workflow, no userId.
    expect(t.scheduleSuggestions).toEqual([
      expect.objectContaining({ workflowId: 'daily-ops-brief' }),
    ])
  })

  it('imports end-to-end: 3 agents land, all three workflows import (each re-validated)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-solo-'))
    const { space } = await Space.init(tmp, { name: 'solo-test' })
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
      for (const id of AGENT_IDS) expect(landed).toContain(id)

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
