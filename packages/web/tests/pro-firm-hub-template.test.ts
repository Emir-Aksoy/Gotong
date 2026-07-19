/**
 * Anti-rot acceptance gate for the pro-firm-hub loadable template (ENT-M1).
 *
 * pro-firm-hub is the enterprise upward-compatibility case: solo-company-hub
 * grown into a small team. It is the same kernel proving that "一个人顶一个团队"
 * scales to "一个小团队协作交付" — multi-person (role-gated + cross-role
 * approval), multi-agent (a three-stand-in pipeline in one workflow), and an
 * enterprise DB + knowledge base plugged in as read-only MCP slots.
 *
 * The gallery gate (builtin-templates.test.ts) only re-parses the manifest —
 * it treats each workflow as an opaque blob. This gate is the LOAD-BEARING
 * one: it drives real parseWorkflow per block and pins the semantics that are
 * easy to get subtly wrong (the OPC Codex cross-review caught these on the
 * sibling template's first draft), so they can't regress:
 *
 *   1. The flagship `client-proposal` flow's `finalize` step is GATED on the
 *      approval (`when: $approve.output.approved == true`). A human `approval`
 *      step that is REJECTED returns a normal `{approved:false}` output — it
 *      does NOT halt the run — so without the gate the "不签发就不出正式方案"
 *      promise is a lie: finalize would run and emit the proposal anyway.
 *   2. Cross-role approval is the multi-person differentiator: the initiator is
 *      scoped by the server-pinned `requester_id` while the sign-off is ROUTED
 *      to a SEPARATE supplied `approver_id`. These are two distinct fields, so
 *      the flow structurally sends the card to a designated approver — but the
 *      framework does NOT enforce that the approver is a different person or an
 *      owner/admin (that's deployment discipline, same as cafe-ops's manager_id).
 *      This gate pins the STRUCTURE (distinct fields + the draft chained into the
 *      card), not a role guarantee.
 *   3. The pipeline dispatches three DISTINCT capabilities in order
 *      (firm.intake → firm.knowledge → firm.proposal) before the human step and
 *      CHAINS their text outputs forward: draft's payload carries
 *      `background: $research.output.text` + `references: $reference.output.text`.
 *      Pinning these exact refs is the point of a dedicated gate — the gallery
 *      gate would stay green if a ref were mistyped to `.output.content`.
 *   4. The two golden-run acceptance triggers each declare EXACTLY one field
 *      carrying the whole prompt. A bare (unquoted) value in a YAML flow
 *      mapping `{ x: …,… }` splits on the ASCII commas into stray null keys
 *      and silently truncates — so the value must survive intact.
 *
 * Plus the family-hub / solo gate invariants: real parseTemplate, agents cover
 * the dispatched capabilities, no secrets inline, optional connector slots,
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
    '../../../examples/pro-firm-hub/template/pro-firm-hub.template.yaml',
    import.meta.url,
  ),
)

const AGENT_IDS = ['intake-analyst', 'knowledge-aide', 'proposal-drafter']
const WORKFLOW_IDS = ['client-proposal', 'weekly-portfolio-brief', 'new-matter-workup']

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/pro-firm-hub/template (ENT-M1)', () => {
  it('parses as a valid gotong.template/v1 manifest', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('专业服务公司 hub(小团队协作交付)')
    expect(t.version).toBe(1)
    expect(t.agents.map((a) => a.id)).toEqual(AGENT_IDS)
    expect(t.workflows.map((w) => w.id)).toEqual(WORKFLOW_IDS)
    // One-click key prompt, mirroring solo-company-hub / family-hub.
    expect(t.apiKeyPrompt).toMatchObject({ provider: 'openai-compatible', label: 'DeepSeek' })
  })

  it('three stand-ins cover exactly the three dispatched capabilities, no secrets inline', () => {
    const agents = parseTemplate(templateText).agents
    expect(agents.find((a) => a.id === 'intake-analyst')!.capabilities).toEqual(['firm.intake'])
    expect(agents.find((a) => a.id === 'knowledge-aide')!.capabilities).toEqual(['firm.knowledge'])
    expect(agents.find((a) => a.id === 'proposal-drafter')!.capabilities).toEqual(['firm.proposal'])
    // The manifest ships structure only — never a literal key.
    expect(templateText).not.toMatch(/sk-[A-Za-z0-9]{8}/)
  })

  it('flagship GATES finalize on approval, routes cross-role, and relays a 3-agent pipeline', () => {
    const t = parseTemplate(templateText)
    const flow = parseWorkflow(t.workflows.find((w) => w.id === 'client-proposal')!.yaml)

    // Any member starts it from /me; the requester is pinned by the /me gate.
    expect(flow.trigger.capability).toBe('firm.proposal.request')
    expect(flow.surface?.me?.userScopeField).toBe('requester_id')

    const steps = new Map(flow.steps.map((s) => [s.id, s]))
    expect([...steps.keys()]).toEqual(['research', 'reference', 'draft', 'approve', 'finalize'])

    // (1) THE load-bearing assertion: finalize is gated on the approval decision.
    // Without this `when`, a rejected approval (which returns {approved:false} as
    // a normal ok output, NOT a halt) would still run finalize and emit the
    // proposal — breaking "不签发就不出正式方案".
    const finalize = steps.get('finalize')! as {
      when?: string
      dispatch?: { payload?: Record<string, unknown> }
    }
    expect(finalize.when).toBe('$approve.output.approved == true')

    // Typed accessor for a step's post-parse dispatch (a `human:` block desugars
    // to a dispatch to gotong.human/v1 — see schema.ts humanToDispatch — so both
    // agent steps and the approval step expose `.dispatch.{strategy,payload}`).
    const dispatchOf = (id: string) =>
      (
        steps.get(id) as {
          dispatch?: {
            strategy?: { capabilities?: string[] }
            payload?: Record<string, unknown>
          }
        }
      ).dispatch

    // (2) Cross-role approval — the multi-person differentiator, pinned at the
    // approval STEP (not the whole-flow serialization — a stray `approver_id`
    // anywhere else would false-green a whole-flow `.toContain`). The approval
    // desugars to gotong.human/v1 and routes the card to the SEPARATE supplied
    // `approver_id`, distinct from the server-pinned `requester_id` /me scope.
    const approve = dispatchOf('approve')
    expect(approve?.strategy?.capabilities).toEqual(['gotong.human/v1'])
    expect(approve?.payload?.assignee).toBe('$trigger.payload.approver_id')
    // The draft is inlined INTO the approval prompt so it's visible ON the card
    // (the /me inbox projection shows the prompt, not prior step outputs).
    expect(String(approve?.payload?.prompt)).toContain('$draft.output.text')

    const triggerFields = (flow.trigger as { payloadSchema?: Array<{ id: string }> }).payloadSchema
    expect(triggerFields?.map((f) => f.id)).toEqual(['client', 'brief', 'approver_id'])

    // (3) 多 agent 接力 — pin the exact output-ref CHAIN, not just the capability
    // set. The gallery gate would stay green if `$research.output.text` were
    // mistyped to `.output.content`; this is the load-bearing bit a dedicated
    // gate exists for. draft consumes BOTH upstream agents; finalize consumes
    // the draft.
    expect(dispatchOf('research')?.strategy?.capabilities).toEqual(['firm.intake'])
    expect(dispatchOf('reference')?.strategy?.capabilities).toEqual(['firm.knowledge'])
    const draft = dispatchOf('draft')
    expect(draft?.strategy?.capabilities).toEqual(['firm.proposal'])
    expect(draft?.payload?.background).toBe('$research.output.text')
    expect(draft?.payload?.references).toBe('$reference.output.text')
    expect(finalize.dispatch?.payload?.drafted).toBe('$draft.output.text')
    // finalize dispatches the proposal capability (same stand-in, finalize step).
    expect(
      (steps.get('finalize') as { dispatch?: { strategy?: { capabilities?: string[] } } }).dispatch
        ?.strategy?.capabilities,
    ).toEqual(['firm.proposal'])
  })

  it('keeps every /me flow open to member — the SCHEDULED brief must, or the sweeper never fires it', () => {
    // Load-bearing invariant, and the exact trap a separate allowed_roles +
    // weekday assertion pair CANNOT catch: the weekly brief is auto-scheduled
    // (Monday), and the production schedule sweeper evaluates runnability at a
    // FIXED least-privilege `member` role (workflow-schedule-sweeper.ts
    // DEFAULT_SCHEDULE_ROLE → evaluateRunnable returns null when allowedRoles
    // excludes that role → the row is judged `unrunnable` and never fires). So a
    // scheduled flow that dropped `member` from allowed_roles would SILENTLY stop
    // firing while every other assertion here stayed green. Pin member on all
    // three /me flows; the scheduled one is the one that would actually break.
    const t = parseTemplate(templateText)
    for (const id of WORKFLOW_IDS) {
      const flow = parseWorkflow(t.workflows.find((w) => w.id === id)!.yaml)
      expect(
        (flow.surface?.me as { allowedRoles?: string[] })?.allowedRoles,
        `${id} must keep member (a scheduled flow runs as member; see comment)`,
      ).toContain('member')
    }
  })

  it('golden-runs cover ONLY the two unattended flows; the approval flow is human-verified', () => {
    const t = parseTemplate(templateText)
    expect(t.acceptanceCases.map((c) => c.id)).toEqual([
      'smoke-portfolio-brief',
      'smoke-new-matter-workup',
    ])
    // The approval flow deliberately is NOT a golden-run — it suspends on the
    // human step by design; "负责人真的签发一次" is what it exists to have verified.
    expect(t.acceptanceCases.map((c) => c.workflowId)).not.toContain('client-proposal')

    const brief = t.acceptanceCases.find((c) => c.id === 'smoke-portfolio-brief')!
    expect(brief.assert.contains).toEqual(['在办项目', '本周待跟进', '风险与阻塞', '负责人一问'])

    // #4 regression guard: the workup trigger must carry EXACTLY `matter` with the
    // whole prompt intact — an unquoted flow-mapping value would split on the
    // ASCII commas into stray null keys and truncate it.
    const workup = t.acceptanceCases.find((c) => c.id === 'smoke-new-matter-workup')!
    expect(Object.keys(workup.trigger)).toEqual(['matter'])
    expect(workup.trigger.matter).toBe('一个制造业客户想上一套内部知识库,预算和范围都还没定。')
    expect(workup.assert.contains).toEqual(['背景', '相关先例', '可行性与要点', '风险与注意'])
  })

  it('declares three OPTIONAL read-only connector slots and a person-less weekly schedule', () => {
    const t = parseTemplate(templateText)
    expect(t.connectorSlots.map((s) => s.id)).toEqual(['db', 'kb', 'tasks'])
    for (const slot of t.connectorSlots) {
      expect(slot.optional, `${slot.id} must stay optional (honest mode)`).toBe(true)
      // `capability` is a DOC-ONLY tag (template-manifest.ts: "no structural
      // meaning") — it pins the sample's STATED read-only intent, not a runtime
      // guarantee. Runtime read-only depends on the read-only creds/server the
      // deployer actually plugs in. Pin the declared intent so the manifest can't
      // silently ship a write-shaped slot.
      expect(slot.capability, `${slot.id} declares read-only intent`).toMatch(/\.read$/)
    }
    // Cadence only — the suggestion targets the brief workflow, no userId. Pin
    // Monday 08:00 (JS weekday 1) so the "每周一早 8 点" doc promise can't drift.
    expect(t.scheduleSuggestions).toHaveLength(1)
    const sched = t.scheduleSuggestions[0] as {
      workflowId: string
      cadence: { kind: string; weekday?: number; hour?: number }
    }
    expect(sched.workflowId).toBe('weekly-portfolio-brief')
    expect(sched.cadence.kind).toBe('weekly')
    expect(sched.cadence.weekday).toBe(1)
    expect(sched.cadence.hour).toBe(8)
    // No person is carried — a schedule never names a userId.
    expect(JSON.stringify(sched)).not.toContain('userId')
  })

  it('imports end-to-end: 3 agents land, all three workflows import (each re-validated)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-firm-'))
    const { space } = await Space.init(tmp, { name: 'firm-test' })
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
