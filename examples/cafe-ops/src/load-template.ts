/**
 * load-template — proof that cafe-ops's org config is a LOADABLE FILE, not a
 * built-in TS literal. And, since cafe-ops is the first ORGANIZATION template,
 * it previews the piece the personal hubs never carried: declarative workflows.
 *
 * It reads the shipped `template/cafe-ops.template.yaml` off disk, parses it,
 * and previews the architecture it declares:
 *
 *   [1] LOAD      — the config comes from a file (read + parsed here, live).
 *   [2] agents    — 2 managed LLM agents (岗位培训师 + 运营助手) covering the
 *                   capabilities the workflows dispatch.
 *   [3] workflows — 3 DECLARATIVE workflows (the new bit): member self-service
 *                   via surface.me + manager approval via human: HITL.
 *   [4] KB slot   — an addressable store-ops-manual whose presetData is a
 *                   POINTER, never the manual content (Stream B decision #4).
 *
 * This is a config-preview (same approach as examples/obsidian-kb): it does NOT
 * spawn mcp-obsidian. The rigorous "passes the real schema + each workflow
 * round-trips + imports end-to-end" proof is the web anti-corruption test
 * (packages/web/tests/cafe-ops-template.test.ts).
 *
 * Run:  pnpm demo:cafe-ops:template
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

const TEMPLATE = fileURLToPath(new URL('../template/cafe-ops.template.yaml', import.meta.url))

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
    defaults?: { apiKeyPrompt?: { label?: string } }
  }
}

function main(): void {
  console.log('\n=== AipeHub case: cafe-ops — load the org template ===\n')

  // --- [1] LOAD: the config is a FILE, parsed live (not a built-in literal) ---
  section('[1] load the config from a FILE')
  console.log(`  file: ${TEMPLATE}`)
  const doc = parseYaml(readFileSync(TEMPLATE, 'utf8')) as LoadedTemplate
  const t = doc.template ?? {}
  console.log(`  schema: ${doc.schema}`)
  console.log(`  name:   ${t.name}`)
  console.log(`  apiKey: prompt once for ${t.defaults?.apiKeyPrompt?.label ?? '(none)'}`)

  // --- [2] the agents — 2 managed LLM agents ---------------------------------
  section('[2] agents (岗位培训师 + 运营助手)')
  const agents = t.agents ?? []
  for (const a of agents) {
    console.log(`  agent  ${a.id}  [${(a.capabilities ?? []).join(', ')}]`)
    console.log(`         reaches the manual via mcpServer: ${(a.mcpServers ?? []).map((s) => s.name).join(', ')}`)
  }

  // --- [3] the DECLARATIVE workflows — the new bit for an org template -------
  section('[3] workflows (surface.me self-service + human: manager approval)')
  const workflows = t.workflows ?? []
  for (const w of workflows) {
    const selfService = w.surface?.me?.enabled ? `成员自助 (/me, scope=${w.surface?.me?.user_scope_field})` : '—'
    const humanSteps = (w.steps ?? []).filter((s) => s.human).map((s) => `${s.id}:${s.human?.kind}`)
    const gate = humanSteps.length ? `店长审批 [${humanSteps.join(', ')}]` : '无审批'
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

  // --- [5] the actual manual CONTENT lives OUTSIDE the template ---------------
  section('[5] the manual content — YOUR Obsidian vault, not the template')
  console.log('  The template carries structure + a pointer only (decision #4). The store')
  console.log('  operations manual (岗位 SOP / 规范 / 加班政策) is your own Obsidian vault')
  console.log('  behind mcp-obsidian. The runnable demo uses deterministic stand-ins to show')
  console.log('  the onboarding + overtime-approval (HITL) flows end to end:')
  console.log('    pnpm demo:cafe-ops')

  // --- [6] load it into a real host ------------------------------------------
  section('[6] load it into a real host')
  console.log('  curl -X POST -H "Authorization: Bearer <admin-token>" \\')
  console.log("    -H 'content-type: application/json' \\")
  console.log("    -d \"$(jq -Rs '{template: .}' \\")
  console.log('      examples/cafe-ops/template/cafe-ops.template.yaml)\" \\')
  console.log('    http://127.0.0.1:8745/api/admin/templates/import')

  // Self-assert (this doubles as a smoke test): the loaded FILE declares both
  // agents, all three workflows (two of them HITL), and a KB POINTER (no content).
  const ids = new Set(agents.map((a) => a.id))
  const wfIds = new Set(workflows.map((w) => w.id))
  const kb = kbs.find((k) => k.name === 'store_ops_manual')
  if (doc.schema !== 'aipehub.template/v1') throw new Error('expected schema aipehub.template/v1')
  for (const want of ['onboarding-trainer', 'ops-assistant']) {
    if (!ids.has(want)) throw new Error(`expected a ${want} agent in the loaded template`)
  }
  for (const want of ['cafe-staff-onboarding', 'cafe-shift-availability', 'cafe-overtime-claim']) {
    if (!wfIds.has(want)) throw new Error(`expected workflow ${want} in the loaded template`)
  }
  const hitl = workflows.filter((w) => (w.steps ?? []).some((s) => s.human))
  if (hitl.length !== 2) throw new Error(`expected 2 HITL workflows, found ${hitl.length}`)
  if (!kb?.presetData?.ref) throw new Error('expected the KB slot to carry a presetData POINTER')

  section('done')
  console.log('  Loaded from a FILE — 2 agents + 3 declarative workflows + a KB pointer.\n')
  process.exit(0)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main()
