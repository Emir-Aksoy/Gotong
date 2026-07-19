/**
 * load-template — proof that bar-ops's org config is a LOADABLE FILE, not a
 * built-in TS literal. The bar-flavored sibling of cafe-ops's load-template.
 *
 * It reads the shipped `template/bar-ops.template.yaml` off disk, parses it,
 * and previews the architecture it declares:
 *
 *   [1] LOAD      — the config comes from a file (read + parsed here, live).
 *   [2] agents    — 3 managed LLM agents (岗位培训师 / 运营助手 / 合规助手)
 *                   covering every capability the six workflows dispatch.
 *   [3] workflows — 6 DECLARATIVE workflows: member self-service via surface.me +
 *                   manager approval via human: HITL (排班 / 深夜薪 / 年龄事件).
 *   [4] KB slot   — an addressable bar_ops_manual whose presetData is a
 *                   POINTER, never the manual content (Stream B decision #4).
 *
 * This is a config-preview (same approach as examples/cafe-ops): it does NOT
 * spawn mcp-obsidian. The rigorous "passes the real schema + each workflow
 * round-trips + imports end-to-end" proof is the web anti-corruption test
 * (packages/web/tests/bar-ops-template.test.ts).
 *
 * Run:  pnpm demo:bar-ops:template
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

const TEMPLATE = fileURLToPath(new URL('../template/bar-ops.template.yaml', import.meta.url))

interface LoadedWorkflow {
  id?: string
  name?: string
  trigger?: { capability?: string }
  surface?: { me?: { enabled?: boolean; user_scope_field?: string } }
  steps?: Array<{ id?: string; human?: { kind?: string; assignee?: string } }>
}

interface LoadedTemplate {
  schema?: string
  template?: {
    name?: string
    agents?: Array<{ id?: string; capabilities?: string[]; mcpServers?: Array<{ name?: string }> }>
    workflows?: LoadedWorkflow[]
    knowledgeBases?: Array<{
      name?: string
      mcpServer?: { name?: string }
      presetData?: { kind?: string; ref?: string }
    }>
    requires?: { connectors?: Array<{ id?: string; optional?: boolean; capability?: string }> }
    defaults?: { apiKeyPrompt?: { label?: string } }
  }
}

function main(): void {
  console.log('\n=== Gotong case: bar-ops — load the org template ===\n')

  // --- [1] LOAD: the config is a FILE, parsed live (not a built-in literal) ---
  section('[1] load the config from a FILE')
  console.log(`  file: ${TEMPLATE}`)
  const doc = parseYaml(readFileSync(TEMPLATE, 'utf8')) as LoadedTemplate
  const t = doc.template ?? {}
  console.log(`  schema: ${doc.schema}`)
  console.log(`  name:   ${t.name}`)
  console.log(`  apiKey: prompt once for ${t.defaults?.apiKeyPrompt?.label ?? '(none)'}`)

  // --- [2] the agents — 3 managed LLM agents ---------------------------------
  section('[2] agents (岗位培训师 + 运营助手 + 合规助手)')
  const agents = t.agents ?? []
  for (const a of agents) {
    console.log(`  agent  ${a.id}  [${(a.capabilities ?? []).join(', ')}]`)
    console.log(`         reaches the manual via mcpServer: ${(a.mcpServers ?? []).map((s) => s.name).join(', ')}`)
  }

  // --- [3] the DECLARATIVE workflows — the org story --------------------------
  section('[3] workflows (surface.me self-service + human: manager approval)')
  const workflows = t.workflows ?? []
  for (const w of workflows) {
    const selfService = w.surface?.me?.enabled ? `成员自助 (/me, scope=${w.surface?.me?.user_scope_field})` : '—'
    const humanSteps = (w.steps ?? []).filter((s) => s.human).map((s) => `${s.id}:${s.human?.kind}`)
    const gate = humanSteps.length ? `审批 [${humanSteps.join(', ')}]` : '无人值守'
    console.log(`  workflow  ${w.id}  (trigger: ${w.trigger?.capability})`)
    console.log(`            ${selfService}  |  ${gate}`)
  }

  // --- [4] the addressable KB slot: wiring + a POINTER, never content ---------
  section('[4] knowledge-base slot — wiring + presetData POINTER (never content)')
  const kbs = t.knowledgeBases ?? []
  for (const k of kbs) {
    console.log(`  KB slot  ${k.name}  (transport: mcp '${k.mcpServer?.name}')`)
    console.log(`           presetData: ${k.presetData?.kind} → ${k.presetData?.ref}`)
  }

  // --- [5] optional read-only connector slots — abstract needs, not pre-wired -
  section('[5] optional connector slots (酒水库存 / 考勤 — 只读, 可选)')
  const connectors = t.requires?.connectors ?? []
  for (const c of connectors) {
    console.log(`  connector  ${c.id}  (capability: ${c.capability}, optional: ${c.optional})`)
  }
  console.log('  不挂进诚实模式照样跑 —— 有状态经营数据的主副本走 MCP, 框架不当主数据源。')

  // --- [6] the actual manual CONTENT lives OUTSIDE the template ---------------
  section('[6] the manual content — YOUR Obsidian vault, not the template')
  console.log('  The template carries structure + a pointer only (decision #4). The bar')
  console.log('  operations manual (岗位 SOP / 年龄核查与酒牌规范 / 深夜薪政策) is your own')
  console.log('  Obsidian vault behind mcp-obsidian. The runnable demo uses deterministic')
  console.log('  stand-ins to show the onboarding + age-incident (HITL) flows end to end:')
  console.log('    pnpm demo:bar-ops')

  // --- [7] load it into a real host ------------------------------------------
  section('[7] load it into a real host')
  console.log('  curl -X POST -H "Authorization: Bearer <admin-token>" \\')
  console.log("    -H 'content-type: application/json' \\")
  console.log("    -d \"$(jq -Rs '{template: .}' \\")
  console.log('      examples/bar-ops/template/bar-ops.template.yaml)\" \\')
  console.log('    http://127.0.0.1:8745/api/admin/templates/import')

  // Self-assert (this doubles as a smoke test): the loaded FILE declares all
  // three agents, all six workflows (three of them HITL), a KB POINTER (no
  // content), and the two optional connector slots.
  const ids = new Set(agents.map((a) => a.id))
  const wfIds = new Set(workflows.map((w) => w.id))
  const kb = kbs.find((k) => k.name === 'bar_ops_manual')
  if (doc.schema !== 'gotong.template/v1') throw new Error('expected schema gotong.template/v1')
  for (const want of ['bar-onboarding-trainer', 'bar-ops-assistant', 'bar-compliance-aide']) {
    if (!ids.has(want)) throw new Error(`expected a ${want} agent in the loaded template`)
  }
  for (const want of [
    'bar-staff-onboarding',
    'bar-shift-availability',
    'bar-late-night-wage',
    'bar-age-incident',
    'bar-liquor-inventory',
    'bar-compliance-check',
  ]) {
    if (!wfIds.has(want)) throw new Error(`expected workflow ${want} in the loaded template`)
  }
  const hitl = workflows.filter((w) => (w.steps ?? []).some((s) => s.human))
  if (hitl.length !== 3) throw new Error(`expected 3 HITL workflows, found ${hitl.length}`)
  if (!kb?.presetData?.ref) throw new Error('expected the KB slot to carry a presetData POINTER')
  if (!connectors.every((c) => c.optional)) throw new Error('all connector slots must be optional')

  section('done')
  console.log('  Loaded from a FILE — 3 agents + 6 declarative workflows + a KB pointer.\n')
  process.exit(0)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main()
