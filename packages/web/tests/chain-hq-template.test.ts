/**
 * Anti-rot acceptance gate for the tea-chain-hq loadable template (HQ2).
 *
 * chain-hq is the SECOND cross-ORG template — the MIRROR of tea-shop one tier up
 * (HQ → shop, the reverse of shop → supplier). It pins down the SAME teaching
 * point: the cross-org LINK is NOT in the template, and the cross-org approval is
 * NOT a workflow `human:` step.
 *   - The `rollout` step dispatches a capability (`shop.apply-directive`) that no
 *     template agent serves — it resolves to a franchise-shop PEER at runtime. The
 *     template carries only the HQ-side skeleton; WHICH / HOW MANY shops is runtime
 *     peer config.
 *   - Unlike cafe-ops (whose workflows desugar `human:` to `gotong.human/v1`),
 *     this workflow has NO human step: the cross-org approval is the runtime
 *     outbound gate (Stream G), so the embedded block must NOT mention
 *     `gotong.human/v1`.
 *
 * It reads the SHIPPED
 * `examples/tea-chain-hq/template/chain-hq.template.yaml` off disk → real
 * parseTemplate → real parseWorkflow on the embedded block → real import route,
 * so the example can never silently drift out of sync with either schema.
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
  new URL('../../../examples/tea-chain-hq/template/chain-hq.template.yaml', import.meta.url),
)

const WORKFLOW_IDS = ['chain-directive-rollout']

let templateText: string

beforeEach(async () => {
  templateText = await readFile(EXAMPLE_PATH, 'utf8')
})

describe('examples/tea-chain-hq/template (HQ2)', () => {
  it('parses as a valid gotong.template/v1 manifest', () => {
    const t = parseTemplate(templateText)
    expect(t.name).toBe('连锁奶茶店总部(跨组织指令下发)')
    expect(t.version).toBe(1)
    // One HQ-side agent serving HQ's two LOCAL capabilities.
    expect(t.agents.map((a) => a.id)).toEqual(['rollout-coordinator'])
    expect(t.workflows.map((w) => w.id)).toEqual(WORKFLOW_IDS)
    expect(t.knowledgeBases.map((k) => k.name)).toEqual(['chain_playbook'])
  })

  it('the agent serves the HQ-LOCAL capabilities + reaches the playbook via mcp-obsidian', () => {
    const agent = parseTemplate(templateText).agents[0]!
    expect(agent.capabilities).toEqual(['chainhq.draft-directive', 'chainhq.record-rollout'])
    // NOTE: `shop.apply-directive` is deliberately NOT here — it lives on the
    // franchise-shop peer, reached over a runtime federation link, not a template agent.
    expect(agent.capabilities).not.toContain('shop.apply-directive')
    // Credentials ride as ${ENV} placeholders — never literal secrets.
    const obsidian = (agent.managed.mcpServers ?? []).find((s) => s.name === 'obsidian')
    expect(obsidian, 'agent must wire obsidian').toBeDefined()
    expect((obsidian as { env?: Record<string, string> }).env?.OBSIDIAN_API_KEY).toBe(
      '${OBSIDIAN_API_KEY}',
    )
  })

  it('the embedded workflow round-trips through parseWorkflow — cross-org DOWNWARD, NO human step', () => {
    const t = parseTemplate(templateText)
    const rollout = parseWorkflow(t.workflows[0]!.yaml)

    expect(rollout.id).toBe('chain-directive-rollout')
    expect(rollout.trigger.capability).toBe('chainhq.rollout-directive')
    // surface.me survives the template→workflow re-serialization (snake→camel).
    expect(rollout.surface?.me?.enabled).toBe(true)
    expect(rollout.surface?.me?.userScopeField).toBe('initiated_by')

    // The `rollout` step orchestrates a CROSS-ORG capability that names no peer —
    // cross-hub dispatch is capability dispatch where the capability lives on a peer.
    const step = rollout.steps.find((s) => s.id === 'rollout')!
    expect(step.dispatch?.strategy).toMatchObject({
      kind: 'capability',
      capabilities: ['shop.apply-directive'],
    })
    // The EXECUTABLE steps name only capabilities — no step targets a peer. (The
    // governance note below may name the franchise-shop peer in prose; that's an
    // honest human-facing risk summary, not part of the executable dispatch.)
    expect(JSON.stringify(rollout.steps)).not.toContain('peer')
    for (const s of rollout.steps) expect(s.dispatch?.strategy.kind).toBe('capability')

    // ★ The teaching invariant: the cross-org approval is the RUNTIME outbound
    // gate, NOT a workflow human step. So unlike cafe-ops, this block must carry
    // NO `gotong.human/v1` capability anywhere.
    expect(JSON.stringify(rollout)).not.toContain('gotong.human/v1')

    // Governance is a declarative risk summary (not a gate).
    expect(rollout.governance?.dataSensitivity).toBe('internal')
  })

  it('declares the chain-playbook KB as MCP wiring + a presetData POINTER (never content)', () => {
    const kb = parseTemplate(templateText).knowledgeBases[0]!
    expect(kb.mcpServer?.name).toBe('obsidian')
    expect(kb.presetData?.kind).toBe('url')
    expect(kb.presetData?.ref).toMatch(/^https:\/\//)
  })

  it('carries a one-click apiKeyPrompt', () => {
    const t = parseTemplate(templateText)
    expect(t.apiKeyPrompt).toMatchObject({ provider: 'openai-compatible', label: 'DeepSeek' })
  })

  it('imports end-to-end: 1 agent lands, 1 workflow imports (re-validated), KB reported inline', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-chain-hq-'))
    const { space } = await Space.init(tmp, { name: 'chain-hq-test' })
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

      // The HQ-side agent landed; the franchise shop's worker is NOT here (it's on
      // the peer hub) — the template only carries the orchestrating side.
      const landed = (await space.agents()).map((a) => a.id)
      expect(landed).toContain('rollout-coordinator')
      expect(json.team.created.map((a: any) => a.id)).toEqual(['rollout-coordinator'])

      // The workflow imported, having passed parseWorkflow.
      expect(json.workflows).toEqual(WORKFLOW_IDS.map((id) => ({ id, ok: true })))
      expect(importedIds).toEqual(WORKFLOW_IDS)

      // The KB slot is reported (inline wiring), never auto-wired (decision #4).
      expect(json.knowledgeBases).toEqual([
        {
          name: 'chain_playbook',
          description:
            '连锁运营手册(调价规范 / 加盟商政策 / 区域沟通口径 / SOP, via mcp-obsidian)',
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
