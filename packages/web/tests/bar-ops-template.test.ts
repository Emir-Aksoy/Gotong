/**
 * Anti-rot acceptance gate for the bar-ops loadable template (STORE-M2).
 *
 * bar-ops is the SECOND storefront pack (cafe-ops is the first). Same org
 * mechanisms — 3 agents + 6 declarative workflows + surface.me + human: gates +
 * optional read-only connector slots — tuned to a bar: the signature flow is an
 * age-check incident review, where the `human:` gate that guards MONEY in
 * cafe-ops here guards a COMPLIANCE decision.
 *
 * The gallery gate (builtin-templates.test.ts) only re-parses the manifest — it
 * treats each workflow as an opaque blob. This is the LOAD-BEARING gate: it
 * drives real `parseWorkflow` per block and pins the semantics that are easy to
 * get subtly wrong, so they can't regress:
 *
 *   1. TWO when-gated record steps. Both the wage flow (建结算单) and the
 *      age-incident flow (写正式拒售条目) gate their `record` step on the approval
 *      (`when: $approve.output.approved == true`). A REJECTED human `approval`
 *      returns a normal `{approved:false}` output — it does NOT halt the run
 *      (packages/inbox/src/types.ts) — so without the gate "不批就不出" is a lie:
 *      record would run and emit a settlement / log entry on refusal anyway.
 *   2. The SCHEDULED compliance flow must keep `member` in allowed_roles, or the
 *      schedule sweeper (fixed least-privilege `member`) judges it unrunnable and
 *      the weekly self-check silently never fires.
 *   3. Unattended vs HITL split: golden-run acceptance covers ONLY the two
 *      unattended flows (inventory / compliance); the three `human:` flows suspend
 *      by design and are human-verified, never auto-run.
 *
 * It reads the SHIPPED
 * `examples/bar-ops/template/bar-ops.template.yaml` off disk → real
 * parseTemplate → real parseWorkflow per block → real import route, so the
 * example can never silently drift out of sync with either schema.
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
  new URL('../../../examples/bar-ops/template/bar-ops.template.yaml', import.meta.url),
)

const AGENT_IDS = ['bar-onboarding-trainer', 'bar-ops-assistant', 'bar-compliance-aide']

// Workflow ids in declaration order — the importer reports them in that order.
const WORKFLOW_IDS = [
  'bar-staff-onboarding',
  'bar-shift-availability',
  'bar-late-night-wage',
  'bar-age-incident',
  'bar-liquor-inventory',
  'bar-compliance-check',
]

// The two unattended flows — the only ones that enter golden-run acceptance.
const UNATTENDED_IDS = ['bar-liquor-inventory', 'bar-compliance-check']

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/bar-ops/template (STORE-M2)', () => {
  it('parses as a valid gotong.template/v1 manifest', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('酒吧运营(bar / pub)')
    expect(t.version).toBe(1)
    // Three agents covering every capability the six workflows dispatch.
    expect(t.agents.map((a) => a.id)).toEqual(AGENT_IDS)
    // Six declarative workflows.
    expect(t.workflows.map((w) => w.id)).toEqual(WORKFLOW_IDS)
    expect(t.knowledgeBases.map((k) => k.name)).toEqual(['bar_ops_manual'])
  })

  it('each agent covers its workflow capabilities + reaches the manual via mcp-obsidian', () => {
    const agents = parseTemplate(templateText).agents
    const trainer = agents.find((a) => a.id === 'bar-onboarding-trainer')!
    const ops = agents.find((a) => a.id === 'bar-ops-assistant')!
    const compliance = agents.find((a) => a.id === 'bar-compliance-aide')!
    expect(trainer.capabilities).toEqual(['bar.train-position'])
    // ops-assistant serves scheduling + late-night wage.
    expect(ops.capabilities).toEqual(['bar.shift-draft', 'bar.late-night-wage'])
    // compliance-aide serves liquor inventory + license/compliance check + age-incident review.
    expect(compliance.capabilities).toEqual([
      'bar.liquor-inventory',
      'bar.license-check',
      'bar.age-incident-review',
    ])
    // Credentials ride as ${ENV} placeholders — never literal secrets.
    for (const a of agents) {
      const obsidian = (a.managed.mcpServers ?? []).find((s) => s.name === 'obsidian')
      expect(obsidian, `${a.id} must wire obsidian`).toBeDefined()
      expect((obsidian as { env?: Record<string, string> }).env?.OBSIDIAN_API_KEY).toBe(
        '${OBSIDIAN_API_KEY}',
      )
    }
    // No literal API key anywhere in the shipped manifest.
    expect(templateText).not.toMatch(/sk-[A-Za-z0-9]{8}/)
  })

  it('every embedded workflow block round-trips through the real parseWorkflow', () => {
    const t = parseTemplate(templateText)
    // The opaque-blob trick is only sound if each re-serialized block is in fact
    // a valid gotong.workflow/v1 — assert it against the SAME parser the host
    // would run on import, not parseTemplate (which never inspects steps).
    const byId = new Map(t.workflows.map((w) => [w.id, parseWorkflow(w.yaml)]))
    expect([...byId.keys()]).toEqual(WORKFLOW_IDS)

    const onboarding = byId.get('bar-staff-onboarding')!
    expect(onboarding.trigger.capability).toBe('bar.onboard-staff')
    expect(onboarding.surface?.me?.enabled).toBe(true)
    // snake_case user_scope_field survives the template→workflow re-serialization.
    expect(onboarding.surface?.me?.userScopeField).toBe('trainee_id')

    const shift = byId.get('bar-shift-availability')!
    expect(shift.trigger.capability).toBe('bar.submit-availability')
    // The `human:` step sugar desugared to the inbox capability.
    expect(JSON.stringify(shift)).toContain('gotong.human/v1')
    // The confirm step ROUTES to the owner-supplied manager_id (领班) — pin it so
    // the shift routing can't drift (wage/age pin their approver in the red-line
    // tests; shift is the third HITL flow and needs its own routing pin).
    const manConfirm = shift.steps.find((s) => s.id === 'manager-confirm') as {
      dispatch?: { payload?: Record<string, unknown> }
    }
    expect(manConfirm.dispatch?.payload?.assignee).toBe('$trigger.payload.manager_id')

    const wage = byId.get('bar-late-night-wage')!
    expect(wage.trigger.capability).toBe('bar.settle-late-wage')
    expect(JSON.stringify(wage)).toContain('gotong.human/v1')
    // Wage data is flagged confidential in governance (declarative, not a gate).
    expect(wage.governance?.dataSensitivity).toBe('confidential')

    const incident = byId.get('bar-age-incident')!
    expect(incident.trigger.capability).toBe('bar.report-age-incident')
    expect(JSON.stringify(incident)).toContain('gotong.human/v1')
    // Age-incident detail (顾客样貌 / 证件) is confidential.
    expect(incident.governance?.dataSensitivity).toBe('confidential')
  })

  it('WAGE RED LINE: late-night-wage gates its record step on the approval decision', () => {
    // What this gate pins is the STRUCTURAL red line the template actually
    // enforces — human decides + record is when-gated + no auto-settlement — NOT
    // "who computes the figure". In the loadable template the compute step is an
    // LLM (DeepSeek) producing a SUGGESTION per policy; deterministic arithmetic
    // (a payroll MCP, or the demo stand-in) is an optional upgrade, out of scope
    // for a structural gate. So we assert the gate, the routing, and the inlined
    // figure — never a "deterministic compute" claim the template doesn't make.
    //
    // The load-bearing assertion. The record step (建结算单) must be `when`-gated
    // on approval; a rejected approval returns a normal {approved:false} ok output
    // (NOT a halt — see packages/inbox/src/types.ts), so without the gate record
    // would run and emit a settlement even on refusal, breaking "不批就不出结算单".
    // Pinned at the STEP (not a whole-flow .toContain that a stray ref elsewhere
    // could false-green).
    const t = parseTemplate(templateText)
    const wage = parseWorkflow(t.workflows.find((w) => w.id === 'bar-late-night-wage')!.yaml)
    expect(wage.trigger.capability).toBe('bar.settle-late-wage')
    expect(wage.governance?.dataSensitivity).toBe('confidential')

    const steps = new Map(wage.steps.map((s) => [s.id, s]))
    expect([...steps.keys()]).toEqual(['compute', 'approve', 'record'])

    const record = steps.get('record')! as {
      when?: string
      dispatch?: { payload?: Record<string, unknown> }
    }
    expect(record.when).toBe('$approve.output.approved == true')

    // A `human:` block desugars to a dispatch to gotong.human/v1; the approval is
    // ROUTED to the supplied approver_id (owner-picked), distinct from the /me
    // server-pinned initiator scope. And the computed suggestion is inlined INTO
    // the approval prompt so the owner sees the numbers ON the card.
    const approve = steps.get('approve') as {
      dispatch?: {
        strategy?: { capabilities?: string[] }
        payload?: Record<string, unknown>
      }
    }
    expect(approve.dispatch?.strategy?.capabilities).toEqual(['gotong.human/v1'])
    expect(approve.dispatch?.payload?.assignee).toBe('$trigger.payload.approver_id')
    expect(String(approve.dispatch?.payload?.prompt)).toContain('$compute.output.text')

    // The compute step tells the agent which branch to run (step=compute → 算建议
    // 金额). Pinned alongside record.step so the two-branch (compute / record) shape
    // the wage agent's system prompt depends on can't silently drift.
    const compute = steps.get('compute') as { dispatch?: { payload?: Record<string, unknown> } }
    expect(compute.dispatch?.payload?.step).toBe('compute')

    // The record step carries the APPROVED math forward (not a re-computation) —
    // pin the exact ref so a mistype can't silently break the "record ≠ recompute"
    // contract the agent's step=record branch depends on.
    expect(record.dispatch?.payload?.step).toBe('record')
    expect(record.dispatch?.payload?.approved_math).toBe('$compute.output.text')

    // Field-name honesty: `approved_math` is a RECORD-STEP-only field (it only
    // exists on the when-gated path, so it's accurate — a figure that survived
    // approval). The workflow OUTPUT block resolves unconditionally (even on
    // reject), so its figure is a SUGGESTION not an approval — it's named
    // `suggested_math`, and must NOT reuse `approved_math` (which would mislabel a
    // rejected suggestion as approved). Pin both so a rename can't conflate them.
    const output = wage.output as Record<string, unknown>
    expect(output.suggested_math).toBe('$compute.output.text')
    expect(output.approved_math, 'output must not carry approved_math (that is record-step only)').toBeUndefined()

    // /me: settling someone's wages is a management action — owner/admin only.
    expect((wage.surface?.me as { allowedRoles?: string[] })?.allowedRoles).toEqual([
      'owner',
      'admin',
    ])
    expect(wage.surface?.me?.userScopeField).toBe('settled_by')
  })

  it('COMPLIANCE RED LINE: age-incident gates its record step on the manager review', () => {
    // The bar's signature: the SAME when-gate pattern applied to a COMPLIANCE
    // decision rather than money. The record step (写正式拒售条目) must be when-gated
    // on the duty manager's review — a rejected review (judged a non-incident)
    // returns {approved:false} and must NOT write a formal refusal-of-service entry
    // (the run itself is still recorded, its record step skipped). This is what makes
    // "不确认就不写正式拒售条目" true rather than aspirational.
    const t = parseTemplate(templateText)
    const inc = parseWorkflow(t.workflows.find((w) => w.id === 'bar-age-incident')!.yaml)

    const steps = new Map(inc.steps.map((s) => [s.id, s]))
    expect([...steps.keys()]).toEqual(['review', 'approve', 'record'])

    const record = steps.get('record')! as {
      when?: string
      dispatch?: { payload?: Record<string, unknown> }
    }
    expect(record.when).toBe('$approve.output.approved == true')
    // record carries the reviewed summary forward, and runs the review agent's
    // step=record branch. Pin the EXACT ref (the age-incident mirror of wage's
    // approved_math pin) so a mistype can't silently break "record ≠ re-review".
    expect(record.dispatch?.payload?.step).toBe('record')
    expect(record.dispatch?.payload?.reviewed_summary).toBe('$review.output.text')

    // The review is ROUTED to the supplied reviewer_id (duty manager), and the
    // review sheet is inlined into the approval prompt.
    const approve = steps.get('approve') as {
      dispatch?: { payload?: Record<string, unknown> }
    }
    expect(approve.dispatch?.payload?.assignee).toBe('$trigger.payload.reviewer_id')
    expect(String(approve.dispatch?.payload?.prompt)).toContain('$review.output.text')

    // Any member (bartender / security) can report; the review routes to a manager.
    expect((inc.surface?.me as { allowedRoles?: string[] })?.allowedRoles).toContain('member')
    expect(inc.surface?.me?.userScopeField).toBe('reporter_id')
  })

  it('the two unattended flows carry NO human step (so they can enter acceptance)', () => {
    const t = parseTemplate(templateText)
    for (const id of UNATTENDED_IDS) {
      const flow = parseWorkflow(t.workflows.find((w) => w.id === id)!.yaml)
      expect(JSON.stringify(flow), `${id} must be unattended`).not.toContain('gotong.human/v1')
    }
    const inv = parseWorkflow(t.workflows.find((w) => w.id === 'bar-liquor-inventory')!.yaml)
    expect(inv.trigger.capability).toBe('bar.count-liquor')
    const comp = parseWorkflow(t.workflows.find((w) => w.id === 'bar-compliance-check')!.yaml)
    expect(comp.trigger.capability).toBe('bar.compliance-check')
  })

  it('the SCHEDULED compliance flow keeps member — or the sweeper never fires it', () => {
    // Load-bearing invariant, the exact trap a separate allowed_roles + weekday
    // pair CANNOT catch: bar-compliance-check is auto-scheduled (Monday), and the
    // schedule sweeper evaluates runnability at a FIXED least-privilege `member`
    // role (workflow-schedule-sweeper.ts DEFAULT_SCHEDULE_ROLE → evaluateRunnable
    // returns null when allowedRoles excludes it → judged unrunnable, never fires).
    // Drop member and the weekly self-check SILENTLY stops firing while every
    // other assertion stays green.
    const t = parseTemplate(templateText)
    const comp = parseWorkflow(t.workflows.find((w) => w.id === 'bar-compliance-check')!.yaml)
    expect(
      (comp.surface?.me as { allowedRoles?: string[] })?.allowedRoles,
      'the scheduled compliance flow must keep member (see comment)',
    ).toContain('member')
  })

  it('the HITL approval cards inline the prior step output as .output.text + applicant identity', () => {
    // A `human:` approval prompt DOES interpolate $refs (unlike a dispatch title,
    // which does NOT). Reference the string field `$X.output.text` — NOT the whole
    // `$X.output` object (that renders as [object Object] on the card). And each
    // card must inline the initiator's scoped userId so the approver sees WHO is
    // asking (each of the three HITL flows scopes on a DIFFERENT field).
    const t = parseTemplate(templateText)
    const promptOf = (wfId: string, stepId: string): string => {
      const wf = parseWorkflow(t.workflows.find((w) => w.id === wfId)!.yaml)
      const step = wf.steps.find((s) => s.id === stepId) as {
        dispatch?: { payload?: { prompt?: unknown } }
      }
      return String(step.dispatch?.payload?.prompt ?? '')
    }
    // [wfId, stepId, outputRef, applicantRef] — each flow's own scope field.
    const cards: [string, string, string, string][] = [
      ['bar-shift-availability', 'manager-confirm', '$draft.output.text', '$trigger.payload.staff_id'],
      ['bar-late-night-wage', 'approve', '$compute.output.text', '$trigger.payload.settled_by'],
      ['bar-age-incident', 'approve', '$review.output.text', '$trigger.payload.reporter_id'],
    ]
    for (const [wfId, stepId, ref, applicant] of cards) {
      const prompt = promptOf(wfId, stepId)
      expect(prompt, `${wfId}/${stepId} inlines ${ref}`).toContain(ref)
      // The object form (ref without `.text`) must NOT appear as a bare token.
      const objForm = ref.replace(/\.text$/, '')
      expect(
        new RegExp(`\\${objForm}(?!\\.text)(?![\\w.])`).test(prompt),
        `${wfId}/${stepId} must not inline the bare object ${objForm}`,
      ).toBe(false)
      // Applicant identity on the card: an approver must see WHO is asking.
      expect(prompt, `${wfId}/${stepId} shows the applicant userId`).toContain(applicant)
    }
  })

  it('declares the bar-ops-manual KB as MCP wiring + a presetData POINTER (never content)', () => {
    const kb = parseTemplate(templateText).knowledgeBases[0]!
    expect(kb.mcpServer?.name).toBe('obsidian')
    expect(kb.presetData?.kind).toBe('url')
    expect(kb.presetData?.ref).toMatch(/^https:\/\//)
  })

  it('declares two OPTIONAL read-only connector slots (inventory / timesheet)', () => {
    const t = parseTemplate(templateText)
    expect(t.connectorSlots.map((s) => s.id)).toEqual(['inventory', 'timesheet'])
    for (const slot of t.connectorSlots) {
      expect(slot.optional, `${slot.id} must stay optional (honest mode)`).toBe(true)
      // `capability` is a DOC-ONLY tag — it pins the sample's STATED read-only
      // intent, not a runtime guarantee. Pin it so the manifest can't silently
      // ship a write-shaped slot.
      expect(slot.capability, `${slot.id} declares read-only intent`).toMatch(/\.read$/)
    }
  })

  it('golden-runs cover ONLY the two unattended flows; the HITL flows are human-verified', () => {
    const t = parseTemplate(templateText)
    expect(t.acceptanceCases.map((c) => c.id)).toEqual([
      'smoke-liquor-inventory',
      'smoke-compliance-check',
    ])
    // No `human:` flow is a golden-run — they suspend on the approval step by
    // design; "领班 / 老板 / 值班经理真的批一次" is what they exist to have verified.
    for (const c of t.acceptanceCases) {
      expect(UNATTENDED_IDS, `${c.id} must target an unattended flow`).toContain(c.workflowId)
    }

    // #4 regression guard: each trigger must carry its whole value intact — a bare
    // (unquoted) value in a YAML flow mapping `{ x: …,… }` splits on the ASCII
    // commas into stray null keys and silently truncates.
    const inv = t.acceptanceCases.find((c) => c.id === 'smoke-liquor-inventory')!
    expect(inv.trigger.category).toBe('all')
    expect(inv.trigger.focus).toBe('临期精酿与周末备货')
    expect(inv.assert.contains).toEqual(['盘点', '清单'])

    const comp = t.acceptanceCases.find((c) => c.id === 'smoke-compliance-check')!
    expect(comp.trigger.scope).toBe('weekly')
    expect(comp.assert.contains).toEqual(['酒牌', '营业时间'])
  })

  it('carries a person-less weekly schedule for the compliance flow', () => {
    const t = parseTemplate(templateText)
    expect(t.scheduleSuggestions).toHaveLength(1)
    const sched = t.scheduleSuggestions[0] as {
      workflowId: string
      cadence: { kind: string; weekday?: number; hour?: number }
    }
    expect(sched.workflowId).toBe('bar-compliance-check')
    expect(sched.cadence.kind).toBe('weekly')
    expect(sched.cadence.weekday).toBe(1)
    expect(sched.cadence.hour).toBe(16)
    // No person is carried — a schedule never names a userId.
    expect(JSON.stringify(sched)).not.toContain('userId')
  })

  it('carries a one-click apiKeyPrompt', () => {
    const t = parseTemplate(templateText)
    expect(t.apiKeyPrompt).toMatchObject({ provider: 'openai-compatible', label: 'DeepSeek' })
  })

  it('imports end-to-end: 3 agents land, 6 workflows import (each re-validated)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-bar-'))
    const { space } = await Space.init(tmp, { name: 'bar-test' })
    const hub = new Hub({ space })
    await hub.start()
    const { token } = await space.createAdmin('TestAdmin')

    // The mock workflow surface re-parses each yaml with the REAL parseWorkflow,
    // so the route-level path validates every embedded block exactly as a real
    // host would before registering it.
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

      // All three agents landed in the Space.
      const landed = (await space.agents()).map((a) => a.id)
      for (const id of AGENT_IDS) expect(landed).toContain(id)
      expect(json.team.created.map((a: any) => a.id)).toEqual(AGENT_IDS)

      // All six workflows imported, in order, each having passed parseWorkflow.
      expect(json.workflows).toEqual(WORKFLOW_IDS.map((id) => ({ id, ok: true })))
      expect(importedIds).toEqual(WORKFLOW_IDS)

      // The KB slot is reported (inline wiring), never auto-wired (decision #4).
      expect(json.knowledgeBases).toEqual([
        {
          name: 'bar_ops_manual',
          description:
            '酒吧运营手册(岗位 SOP / 年龄核查与酒牌规范 / 深夜薪政策 / 排班规则,via mcp-obsidian)',
          wiring: 'inline',
          useMcpServer: undefined,
        },
      ])

      // A structure-only import carries no secrets and omits nothing sensitive.
      expect(json.secretsApplied).toBe(0)
      expect(json.encryptedSkipped).toBe(false)
      expect(json.personnelOmitted).toBe(false)
    } finally {
      await server?.close()
      await hub.stop?.()
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
