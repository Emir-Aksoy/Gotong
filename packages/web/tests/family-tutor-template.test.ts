/**
 * Anti-rot acceptance gate for the family-learning-hub loadable template (FL-M2).
 *
 * family-tutor is the SECOND cross-ORG template, and it is the MIRROR of tea-shop:
 * where tea-shop ships the INITIATOR side (the shop that drafts an order and
 * dispatches a cross-org capability), family-tutor ships the SERVING side (the
 * 家长 hub that holds the subscription + the AI tutor + the governance). The
 * value of the whole setup lives on the 家长 side, so that's what the template is.
 *
 * Two teaching invariants this test pins down — both OPPOSITE to tea-shop:
 *   1. This workflow HAS `human:` steps (TWO of them: the topic-whitelist approval
 *      AND the content-moderation approval), because the approver (the 家长) is a
 *      LOCAL user of the 家长 hub — a local human step can only assign to a same-hub
 *      user, which is exactly why these approvals must live in the 家长 hub workflow
 *      (the design's key correctness constraint). So unlike tea-shop, the embedded
 *      block MUST contain `gotong.human/v1`.
 *   2. The `teach` step carries `dataClasses: [child-learning]` — the data-class
 *      tag survives the template→workflow opaque re-serialization (same vocabulary
 *      as the per-link OUTBOUND data-class contract).
 *
 * And the key A-M3 safety invariant: the two GATE capabilities (topic.screen +
 * content.moderate) are served by RUNTIME deterministic participants, NOT the LLM
 * tutor — so the agent's ONLY capability is `teach.lesson`. A deterministic
 * topic.screen returning a real boolean is what makes `guardian-approval.when:
 * $screen.output.allowed == false` actually fire (an LLM returning free text would
 * make `allowed` undefined → the gate silently skips → fail-OPEN).
 *
 * It reads the SHIPPED
 * `examples/family-learning-hub/template/family-tutor.template.yaml` off disk →
 * real parseTemplate → real parseWorkflow on the embedded block → real import
 * route, so the example can never silently drift out of sync with either schema.
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
    '../../../examples/family-learning-hub/template/family-tutor.template.yaml',
    import.meta.url,
  ),
)

const WORKFLOW_IDS = ['tutor-teach']

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/family-learning-hub/template (FL-M2)', () => {
  it('parses as a valid gotong.template/v1 manifest', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('家长 AI 导师(家庭学习 hub · 家长侧)')
    expect(t.version).toBe(1)
    // One 家长-side tutor agent serving its one 家长-LOCAL capability (teach.lesson).
    expect(t.agents.map((a) => a.id)).toEqual(['family-tutor'])
    expect(t.workflows.map((w) => w.id)).toEqual(WORKFLOW_IDS)
    expect(t.knowledgeBases.map((k) => k.name)).toEqual(['learning_records'])
  })

  it('the tutor serves ONLY teach.lesson (the two gates are runtime participants) + reaches learning_records via mcp-obsidian', () => {
    const agent = parseTemplate(templateText).agents[0]!
    // ★ A-M3: the tutor serves ONLY teach.lesson. The two gate capabilities
    // (topic.screen / content.moderate) are RUNTIME deterministic participants —
    // a deterministic boolean gate is what keeps the whitelist闸 from fail-OPEN
    // (an LLM topic.screen returns free text with no `allowed` field → the
    // `guardian-approval.when` evaluates undefined == false → false → silent skip).
    expect(agent.capabilities).toEqual(['teach.lesson'])
    expect(agent.capabilities).not.toContain('topic.screen')
    expect(agent.capabilities).not.toContain('content.moderate')
    // NOTE: `tutor.teach` is the WORKFLOW trigger (wraps screen+approval+teach+
    // moderate), not an agent capability; the child reaches `tutor.teach` cross-hub
    // and the 家长 workflow dispatches the inner `teach.lesson` to this agent.
    expect(agent.capabilities).not.toContain('tutor.teach')
    // Credentials ride as ${ENV} placeholders — never literal secrets.
    const obsidian = (agent.managed.mcpServers ?? []).find((s) => s.name === 'obsidian')
    expect(obsidian, 'tutor must wire obsidian').toBeDefined()
    expect((obsidian as { env?: Record<string, string> }).env?.OBSIDIAN_API_KEY).toBe(
      '${OBSIDIAN_API_KEY}',
    )
  })

  it('the embedded workflow round-trips through parseWorkflow — cross-org, WITH two human approval steps + a rule-engine moderation layer', () => {
    const t = parseTemplate(templateText)
    const wf = parseWorkflow(t.workflows[0]!.yaml)

    expect(wf.id).toBe('tutor-teach')
    // Triggered cross-hub by the child's `tutor.teach` dispatch (names no peer).
    expect(wf.trigger.capability).toBe('tutor.teach')

    // ★ A-M3: the full 5-step sequence — screen → 家长批白名单外 → 上课 → 规则筛 → 家长审内容.
    expect(wf.steps.map((s) => s.id)).toEqual([
      'screen',
      'guardian-approval',
      'teach',
      'moderate',
      'mod-approval',
    ])
    // The topic screen is dispatched to a runtime deterministic participant (topic.screen).
    const screen = wf.steps.find((s) => s.id === 'screen')!
    expect(screen.dispatch?.strategy).toMatchObject({
      kind: 'capability',
      capabilities: ['topic.screen'],
    })

    // ★ Inversion vs tea-shop #1: the whitelist approval IS a workflow human step,
    // because the approver (家长) is a LOCAL user of this hub. The `human:` sugar
    // desugars to a dispatch to `gotong.human/v1`.
    const approval = wf.steps.find((s) => s.id === 'guardian-approval')!
    expect(approval.dispatch?.strategy).toMatchObject({
      kind: 'capability',
      capabilities: ['gotong.human/v1'],
    })
    // The approval is conditional: only off-whitelist topics park for the parent.
    expect(approval.when).toBe('$screen.output.allowed == false')
    // The assignee rides as a portable $ref (same pattern as cafe-ops' manager_id).
    expect(JSON.stringify(approval.dispatch?.payload)).toContain('$trigger.payload.guardian_id')
    // So the whole block DOES mention the human inbox capability (opposite of tea-shop).
    expect(JSON.stringify(wf)).toContain('gotong.human/v1')

    // ★ Inversion vs tea-shop #2: the teach step tags the lesson content with the
    // `child-learning` data class — the field survives the template re-serialization.
    const teach = wf.steps.find((s) => s.id === 'teach')!
    expect(teach.dispatch?.strategy).toMatchObject({
      kind: 'capability',
      capabilities: ['teach.lesson'],
    })
    expect(teach.dispatch?.dataClasses).toEqual(['child-learning'])
    // The lesson only runs on-whitelist OR after the 家长 approved the off-whitelist
    // exception — so a 家长 REJECTING the whitelist approval actually STOPS the lesson
    // (the workflow-level fail-open fix; verified through the real predicate in A-M2).
    expect(teach.when).toContain('$guardian-approval.output.approved == true')

    // ★ A-M3: the optional rule-engine layer — a `moderate` step dispatching
    // content.moderate (a runtime deterministic participant, not an agent cap).
    const moderate = wf.steps.find((s) => s.id === 'moderate')!
    expect(moderate.dispatch?.strategy).toMatchObject({
      kind: 'capability',
      capabilities: ['content.moderate'],
    })

    // ★ A-M3: a SECOND human approval — content review — gated on EITHER the tutor's
    // self-flag (decision 1.a) OR the rule engine. Layered defense, both retained.
    const modApproval = wf.steps.find((s) => s.id === 'mod-approval')!
    expect(modApproval.dispatch?.strategy).toMatchObject({
      kind: 'capability',
      capabilities: ['gotong.human/v1'],
    })
    expect(modApproval.when).toContain('flagged')
    // So there are exactly TWO human (gotong.human/v1) steps in this workflow now.
    const humanStepIds = wf.steps
      .filter((s) =>
        (s.dispatch?.strategy as { capabilities?: string[] } | undefined)?.capabilities?.includes(
          'gotong.human/v1',
        ),
      )
      .map((s) => s.id)
    expect(humanStepIds).toEqual(['guardian-approval', 'mod-approval'])

    // The EXECUTABLE steps name only capabilities — no step targets a peer. (The
    // governance note below may name the child peer in prose; that's an honest
    // human-facing risk summary, not part of the executable dispatch.)
    expect(JSON.stringify(wf.steps)).not.toContain('peer')
    for (const s of wf.steps) expect(s.dispatch?.strategy.kind).toBe('capability')

    // Governance is a declarative risk summary (not a gate) — child data is confidential.
    expect(wf.governance?.dataSensitivity).toBe('confidential')
  })

  it('declares the learning_records KB as MCP wiring + a presetData POINTER (never content)', () => {
    const kb = parseTemplate(templateText).knowledgeBases[0]!
    expect(kb.mcpServer?.name).toBe('obsidian')
    expect(kb.presetData?.kind).toBe('url')
    expect(kb.presetData?.ref).toMatch(/^https:\/\//)
  })

  it('carries a one-click apiKeyPrompt', () => {
    const t = parseTemplate(templateText)
    expect(t.apiKeyPrompt).toMatchObject({ provider: 'openai-compatible', label: 'DeepSeek' })
  })

  it('imports end-to-end: 1 tutor lands, 1 workflow imports (re-validated), KB reported inline', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-family-tutor-'))
    const { space } = await Space.init(tmp, { name: 'family-tutor-test' })
    const hub = new Hub({ space })
    await hub.start()
    const { token } = await space.createAdmin('TestAdmin')

    // The mock workflow surface re-parses each yaml with the REAL parseWorkflow,
    // so the route-level path validates the embedded block exactly as a real host
    // would before registering it.
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

      // The 家长-side tutor landed; the 孩子 hub's explore agent + the federation
      // link are NOT here (they're runtime config) — the template carries only the
      // 家长-serving side.
      const landed = (await space.agents()).map((a) => a.id)
      expect(landed).toContain('family-tutor')
      expect(json.team.created.map((a: any) => a.id)).toEqual(['family-tutor'])

      // The workflow imported, having passed parseWorkflow.
      expect(json.workflows).toEqual(WORKFLOW_IDS.map((id) => ({ id, ok: true })))
      expect(importedIds).toEqual(WORKFLOW_IDS)

      // The KB slot is reported (inline wiring), never auto-wired (decision #4).
      expect(json.knowledgeBases).toEqual([
        {
          name: 'learning_records',
          description:
            '学习档案(每个学习者上到第几课 / 学过什么 / 主题白名单,via mcp-obsidian)。主副本在孩子 hub, 此为家长侧教学日志 / fork 副本。',
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
