/**
 * Anti-rot acceptance gate for the family-learning-hub CHILD-side loadable template
 * (family-learning prod A-M4).
 *
 * child-desk is the OTHER HALF of family-tutor: family-tutor ships the 家长 (guardian)
 * hub side (the subscription + the AI tutor + the topic-whitelist + the approvals);
 * child-desk ships the 孩子 (child) hub side — the child BORROWS the 家长's
 * subscription to learn.
 *
 * Three teaching invariants this test pins down — the child side's structural truths:
 *   1. ZERO LLM agents. The subscription (LLM key) lives ONLY on the 家长 hub
 *      (管辖权 = the 家长 holds the economic chokepoint). So every "use AI" goes
 *      cross-org to the 家长's tutor; the child hub carries no key-bearing managed
 *      agent. This is the SHARP inversion vs every other template (which ship ≥1 agent).
 *   2. NO `human:` step (the OPPOSITE of family-tutor). The off-whitelist approver is
 *      the 家长 — a LOCAL user of the 家长 hub, NOT the child hub. A local human step
 *      can only assign to a same-hub user, so the child workflows can't hold the
 *      approval; it's enforced by the runtime OUTBOUND approval gate on the 家长 link.
 *      So the child workflows must NOT contain `aipehub.human/v1`.
 *   3. The cross-org steps tag `dataClasses: [child-learning]` — the data-class tag
 *      survives the template→workflow opaque re-serialization (same vocabulary as the
 *      per-link OUTBOUND data-class contract that confines the child's data to the 家长).
 *
 * It reads the SHIPPED
 * `examples/family-learning-hub/template/child-desk.template.yaml` off disk → real
 * parseTemplate → real parseWorkflow on each embedded block → real import route, so
 * the example can never silently drift out of sync with either schema.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hub, Space } from '@aipehub/core'
import { parseWorkflow } from '@aipehub/workflow'

import { serveWeb, type WebServerHandle, type WorkflowSurface } from '../src/server.js'
import { parseTemplate } from '../src/template-manifest.js'

const EXAMPLE_PATH = fileURLToPath(
  new URL(
    '../../../examples/family-learning-hub/template/child-desk.template.yaml',
    import.meta.url,
  ),
)

const WORKFLOW_IDS = ['child-guided-lesson', 'child-autonomous-explore']

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/family-learning-hub/template (child-desk, A-M4)', () => {
  it('parses as a valid aipehub.template/v1 manifest with ZERO agents (child has no subscription)', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('孩子学习桌(家庭学习 hub · 孩子侧)')
    expect(t.version).toBe(1)
    // ★ The sharp inversion: the child hub has NO LLM subscription, so the template
    // carries NO managed agents (every "use AI" goes cross-org to the 家长's tutor).
    expect(t.agents).toEqual([])
    // Two declarative orchestration workflows + the learning-records MASTER KB slot.
    expect(t.workflows.map((w) => w.id)).toEqual(WORKFLOW_IDS)
    expect(t.knowledgeBases.map((k) => k.name)).toEqual(['learning_records'])
    // No LLM agent ⇒ no apiKeyPrompt (nothing to key).
    expect(t.apiKeyPrompt).toBeUndefined()
  })

  it('the guided-lesson workflow round-trips — cross-org via tutor.teach, NO human step (approval is the 家长 link gate)', () => {
    const t = parseTemplate(templateText)
    const wf = parseWorkflow(t.workflows.find((w) => w.id === 'child-guided-lesson')!.yaml)

    expect(wf.id).toBe('child-guided-lesson')
    // The child self-serves from /me (scoped to their own userId).
    expect(wf.trigger.capability).toBe('learn.request')
    expect(wf.surface?.me?.enabled).toBe(true)
    expect(wf.surface?.me?.userScopeField).toBe('learner_id')

    // tutor → record → report.
    expect(wf.steps.map((s) => s.id)).toEqual(['tutor', 'record', 'report'])

    // The tutor step reaches the 家长's tutor cross-org (capability, names no peer) and
    // tags the request child-learning (the per-link outbound data-class contract).
    const tutor = wf.steps.find((s) => s.id === 'tutor')!
    expect(tutor.dispatch?.strategy).toMatchObject({
      kind: 'capability',
      capabilities: ['tutor.teach'],
    })
    expect(tutor.dispatch?.dataClasses).toEqual(['child-learning'])

    // record stays local (the learning-records MASTER copy on the child hub).
    const record = wf.steps.find((s) => s.id === 'record')!
    expect(record.dispatch?.strategy).toMatchObject({
      kind: 'capability',
      capabilities: ['records.append'],
    })

    // report forks an oversight copy to the 家长 — also tagged child-learning.
    const report = wf.steps.find((s) => s.id === 'report')!
    expect(report.dispatch?.strategy).toMatchObject({
      kind: 'capability',
      capabilities: ['report.to-guardian'],
    })
    expect(report.dispatch?.dataClasses).toEqual(['child-learning'])

    // ★ Inversion vs family-tutor: the child workflow has NO human step. The
    // off-whitelist approval is the runtime OUTBOUND gate on the 家长 link, not a
    // local `human:` step (the approver isn't a user of THIS hub).
    expect(JSON.stringify(wf)).not.toContain('aipehub.human/v1')
    // No step names a peer; every step is a capability dispatch.
    expect(JSON.stringify(wf.steps)).not.toContain('peer')
    for (const s of wf.steps) expect(s.dispatch?.strategy.kind).toBe('capability')
    expect(wf.governance?.dataSensitivity).toBe('confidential')
  })

  it('the autonomous-explore workflow round-trips — purely LOCAL (no tutor, no subscription), still forks to the 家长', () => {
    const t = parseTemplate(templateText)
    const wf = parseWorkflow(t.workflows.find((w) => w.id === 'child-autonomous-explore')!.yaml)

    expect(wf.id).toBe('child-autonomous-explore')
    expect(wf.trigger.capability).toBe('explore.request')
    expect(wf.surface?.me?.enabled).toBe(true)

    // explore → record → report — and NOTABLY no `tutor` step (uses no subscription).
    expect(wf.steps.map((s) => s.id)).toEqual(['explore', 'record', 'report'])
    expect(wf.steps.find((s) => s.id === 'tutor')).toBeUndefined()

    // The explore step is a LOCAL deterministic browse (explore.local), not cross-org,
    // not the tutor — so it carries no child-learning outbound tag (it never leaves).
    const explore = wf.steps.find((s) => s.id === 'explore')!
    expect(explore.dispatch?.strategy).toMatchObject({
      kind: 'capability',
      capabilities: ['explore.local'],
    })
    expect(explore.dispatch?.dataClasses).toBeUndefined()

    // The only step that leaves the child hub is the oversight fork to the 家长.
    const report = wf.steps.find((s) => s.id === 'report')!
    expect(report.dispatch?.strategy).toMatchObject({
      kind: 'capability',
      capabilities: ['report.to-guardian'],
    })
    expect(report.dispatch?.dataClasses).toEqual(['child-learning'])

    // Still no human step, still names no peer.
    expect(JSON.stringify(wf)).not.toContain('aipehub.human/v1')
    expect(JSON.stringify(wf.steps)).not.toContain('peer')
  })

  it('declares the learning_records MASTER KB as MCP wiring + a presetData POINTER (never content)', () => {
    const kb = parseTemplate(templateText).knowledgeBases[0]!
    expect(kb.mcpServer?.name).toBe('obsidian')
    expect(kb.presetData?.kind).toBe('url')
    expect(kb.presetData?.ref).toMatch(/^https:\/\//)
  })

  it('imports end-to-end: ZERO agents land, 2 workflows import (re-validated), KB reported inline', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'aipehub-child-desk-'))
    const { space } = await Space.init(tmp, { name: 'child-desk-test' })
    const hub = new Hub({ space })
    await hub.start()
    const { token } = await space.createAdmin('TestAdmin')

    // The mock workflow surface re-parses each yaml with the REAL parseWorkflow, so the
    // route-level path validates each embedded block exactly as a real host would.
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

      // ★ ZERO agents land — the child hub has no subscription. The tutor lives on the
      // 家长 hub (a runtime federation link), the local participants (records.append /
      // report.to-guardian / explore.local) are runtime-wired, not in the template.
      expect(json.team.created).toEqual([])

      // Both workflows imported, having passed parseWorkflow.
      expect(json.workflows).toEqual(WORKFLOW_IDS.map((id) => ({ id, ok: true })))
      expect(importedIds).toEqual(WORKFLOW_IDS)

      // The KB slot is reported (inline wiring), never auto-wired (decision #4).
      expect(json.knowledgeBases).toEqual([
        {
          name: 'learning_records',
          description:
            '学习档案主副本(每个学习者上到第几课 / 学过什么, via mcp-obsidian)。住在孩子 hub;家长侧是 fork 副本。',
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
