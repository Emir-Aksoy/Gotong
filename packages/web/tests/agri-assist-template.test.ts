/**
 * Anti-rot acceptance gate for the agri-assist loadable template (AGRI-M1).
 *
 * agri-assist is the gallery's FIRST combined pack — one install lands an
 * agent + two workflows + a panel shape. This gate protects the load-bearing
 * shape of that story:
 *   - the advisor deliberately has NO `chat` capability (the panel chat card's
 *     contract is chat.butler only; a chat-capable advisor would get butler
 *     treatment — session window / memory / toolface — which a specialist
 *     must not);
 *   - both workflows dispatch by the ONE capability the advisor ships
 *     (garden.advise), each /me-visible to member (scheduled flows must stay
 *     member-runnable — the sweeper judges runnability as `member`);
 *   - the golden-run covers ONLY the weekly-plan flow, whose three section
 *     headers are pinned verbatim in the advisor's system prompt;
 *   - the pesticide red line lives in the system prompt (no dosage, ever);
 *   - the weekly schedule suggestion carries sample `inputs.crops` — a
 *     required trigger field, so a person-armed schedule without inputs
 *     would fire a form-invalid payload;
 *   - a real POST /api/admin/templates/import lands the agent + both
 *     workflows AND declares the panel preset, with zero secrets inline.
 *
 * Panel config validation happens in HOST tests (web must not import
 * personal-butler): packages/host/tests/agri-assist-template.test.ts.
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
  new URL('../../../examples/agri-assist/template/agri-assist.template.yaml', import.meta.url),
)

const WORKFLOW_IDS = ['garden-weekly-plan', 'garden-diagnose']

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/agri-assist/template (AGRI-M1)', () => {
  it('parses as a combined pack: 1 agent + 2 workflows + 1 panel', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('农业辅助(家庭菜园/果园)')
    expect(t.version).toBe(1)
    expect(t.agents.map((a) => a.id)).toEqual(['garden-advisor'])
    expect(t.workflows.map((w) => w.id)).toEqual(WORKFLOW_IDS)
    expect(t.panels.map((p) => p.id)).toEqual(['garden-care'])
    expect(t.apiKeyPrompt).toMatchObject({ provider: 'openai-compatible', label: 'DeepSeek' })
  })

  it('the advisor is a specialist, NOT a second butler, and ships no secrets', () => {
    const t = parseTemplate(templateText)
    const advisor = t.agents[0]!
    // Load-bearing: `chat` here would make the pool treat the advisor as a
    // butler (SESS window + memory + full toolface). The panel chat card
    // talks to 阿同 by contract; the advisor is reached via workflows and
    // ask_my_agent only.
    expect(advisor.capabilities).toEqual(['garden.advise'])
    expect(advisor.capabilities).not.toContain('chat')
    expect(templateText).not.toMatch(/sk-[A-Za-z0-9]{8}/)
  })

  it('pins the pesticide red line and the fixed section headers in the system prompt', () => {
    const t = parseTemplate(templateText)
    // ParsedAgent keeps the spawnable spec under `.managed` (manifest.ts).
    const system = (t.agents[0] as { managed?: { system?: string } }).managed?.system ?? ''
    // The red line — dosage is never given, packaging + local station instead.
    expect(system).toContain('绝不给具体剂量')
    expect(system).toContain('农技站')
    expect(system).toContain('立即就医')
    // Golden-run asserts these verbatim, so the prompt must pin them verbatim.
    for (const h of ['本周要做', '浇水施肥', '病虫害提防']) expect(system).toContain(h)
    for (const h of ['可能是什么', '怎么处理', '什么时候要找人']) expect(system).toContain(h)
  })

  it('both workflows dispatch by garden.advise and stay member-runnable from /me', () => {
    const t = parseTemplate(templateText)
    const byId = new Map(t.workflows.map((w) => [w.id, parseWorkflow(w.yaml)]))

    const plan = byId.get('garden-weekly-plan')!
    expect(plan.trigger.capability).toBe('garden.plan.request')
    expect(plan.surface?.me?.enabled).toBe(true)
    expect(plan.surface?.me?.userScopeField).toBe('reader_id')

    const diagnose = byId.get('garden-diagnose')!
    expect(diagnose.trigger.capability).toBe('garden.diagnose.request')
    expect(diagnose.surface?.me?.userScopeField).toBe('requester_id')

    for (const [id, def] of byId) {
      // Scheduled flows must stay member-open: the schedule sweeper judges
      // runnability as the LOWEST role (pro-firm lesson — dropping member
      // silently kills the weekly fire).
      expect(def.surface?.me?.allowedRoles, id).toContain('member')
      const serialized = JSON.stringify(def)
      expect(serialized, id).toContain('garden.advise')
    }
  })

  it('golden-run covers ONLY the weekly plan, honest mode is the baseline', () => {
    const t = parseTemplate(templateText)
    expect(t.acceptanceCases.map((c) => c.workflowId)).toEqual(['garden-weekly-plan'])
    const smoke = t.acceptanceCases[0]!
    expect(smoke.assert.contains).toEqual(['本周要做', '浇水施肥', '病虫害提防'])
    expect(smoke.assert.forbid).toEqual(['作为一个AI', '我无法访问'])
  })

  it('declares one OPTIONAL weather slot and a weekly suggestion with sample crops inputs', () => {
    const t = parseTemplate(templateText)
    expect(t.connectorSlots.map((s) => s.id)).toEqual(['weather'])
    expect(t.connectorSlots[0]!.optional).toBe(true)

    expect(t.scheduleSuggestions).toHaveLength(1)
    const s = t.scheduleSuggestions[0]!
    expect(s.workflowId).toBe('garden-weekly-plan')
    expect(s.cadence).toMatchObject({ kind: 'weekly', weekday: 6, hour: 7 })
    // `crops` is a REQUIRED trigger field — a person-armed schedule without
    // inputs would fire a payload the form itself would reject. The sample
    // value also tells the arming admin what to replace.
    expect((s.inputs as { crops?: string })?.crops).toBeTruthy()
  })

  it('imports end-to-end: agent + both workflows land, panel preset declared', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-agri-'))
    const { space } = await Space.init(tmp, { name: 'agri-test' })
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
      expect(landed).toContain('garden-advisor')

      expect(json.workflows).toEqual(WORKFLOW_IDS.map((id) => ({ id, ok: true })))
      expect(importedIds).toEqual(WORKFLOW_IDS)
      // The pack DECLARES its panel preset even when no library sink is wired
      // (the host wires the sink; declaration rides the post-install checklist).
      expect(json.postInstallChecklist.panels).toEqual([
        { id: 'garden-care', title: '菜园照看面' },
      ])

      expect(json.secretsApplied).toBe(0)
      expect(json.encryptedSkipped).toBe(false)
    } finally {
      await server?.close()
      await hub.stop?.()
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
