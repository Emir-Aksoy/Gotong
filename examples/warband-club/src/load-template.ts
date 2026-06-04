/**
 * load-template — proof that warband-club's org config is a LOADABLE FILE, not a
 * built-in TS literal. Like cafe-ops it previews declarative workflows; unlike
 * cafe-ops (top-down approvals) it previews COLLABORATION over a shared resource.
 *
 * It reads the shipped `template/warband-club.template.yaml` off disk, parses it,
 * and previews the architecture it declares:
 *
 *   [1] LOAD      — the config comes from a file (read + parsed here, live).
 *   [2] agents    — 2 managed LLM agents (司库 + 传令官) covering the capabilities
 *                   the workflows dispatch.
 *   [3] workflows — 3 DECLARATIVE workflows: contribute / consult (member
 *                   self-service via surface.me, no approval) + muster (a human:
 *                   leader-confirm HITL gate).
 *   [4] KB slot   — an addressable warband_archive whose presetData is a POINTER,
 *                   never the archive content (Stream B decision #4).
 *
 * This is a config-preview (same approach as examples/obsidian-kb): it does NOT
 * spawn mcp-obsidian. The rigorous "passes the real schema + each workflow
 * round-trips + imports end-to-end" proof is the web anti-corruption test
 * (packages/web/tests/warband-club-template.test.ts).
 *
 * Run:  pnpm demo:warband-club:template
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

const TEMPLATE = fileURLToPath(new URL('../template/warband-club.template.yaml', import.meta.url))

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
  console.log('\n=== AipeHub case: warband-club — load the org template ===\n')

  // --- [1] LOAD: the config is a FILE, parsed live (not a built-in literal) ---
  section('[1] load the config from a FILE')
  console.log(`  file: ${TEMPLATE}`)
  const doc = parseYaml(readFileSync(TEMPLATE, 'utf8')) as LoadedTemplate
  const t = doc.template ?? {}
  console.log(`  schema: ${doc.schema}`)
  console.log(`  name:   ${t.name}`)
  console.log(`  apiKey: prompt once for ${t.defaults?.apiKeyPrompt?.label ?? '(none)'}`)

  // --- [2] the agents — 2 managed LLM agents ---------------------------------
  section('[2] agents (司库 + 传令官)')
  const agents = t.agents ?? []
  for (const a of agents) {
    console.log(`  agent  ${a.id}  [${(a.capabilities ?? []).join(', ')}]`)
    console.log(`         reaches the shared archive via mcpServer: ${(a.mcpServers ?? []).map((s) => s.name).join(', ')}`)
  }

  // --- [3] the DECLARATIVE workflows — write / read (collaboration) / decide --
  section('[3] workflows (surface.me self-service + human: leader confirm)')
  const workflows = t.workflows ?? []
  for (const w of workflows) {
    const selfService = w.surface?.me?.enabled ? `成员自助 (/me, scope=${w.surface?.me?.user_scope_field})` : '—'
    const humanSteps = (w.steps ?? []).filter((s) => s.human).map((s) => `${s.id}:${s.human?.kind}`)
    const gate = humanSteps.length ? `战团长确认 [${humanSteps.join(', ')}]` : '无审批'
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

  // --- [5] the actual archive CONTENT lives OUTSIDE the template --------------
  section('[5] the archive content — the warband\'s SHARED Obsidian vault, not the template')
  console.log('  The template carries structure + a pointer only (decision #4). The shared')
  console.log('  archive (涂装方案 / 战报 / 典籍 / 集结章程) is the warband\'s own Obsidian')
  console.log('  vault behind mcp-obsidian — one library the whole warband reads and writes.')
  console.log('  The runnable demo uses deterministic stand-ins + a real on-disk shared dir to')
  console.log('  show the collaboration (one member\'s contribution answers another\'s query)')
  console.log('  and the muster (HITL) flow end to end:')
  console.log('    pnpm demo:warband-club')

  // --- [6] load it into a real host ------------------------------------------
  section('[6] load it into a real host')
  console.log('  curl -X POST -H "Authorization: Bearer <admin-token>" \\')
  console.log("    -H 'content-type: application/json' \\")
  console.log("    -d \"$(jq -Rs '{template: .}' \\")
  console.log('      examples/warband-club/template/warband-club.template.yaml)\" \\')
  console.log('    http://127.0.0.1:8745/api/admin/templates/import')

  // Self-assert (this doubles as a smoke test): the loaded FILE declares both
  // agents, all three workflows (one of them HITL), and a KB POINTER (no content).
  const ids = new Set(agents.map((a) => a.id))
  const wfIds = new Set(workflows.map((w) => w.id))
  const kb = kbs.find((k) => k.name === 'warband_archive')
  if (doc.schema !== 'aipehub.template/v1') throw new Error('expected schema aipehub.template/v1')
  for (const want of ['archivist', 'herald']) {
    if (!ids.has(want)) throw new Error(`expected a ${want} agent in the loaded template`)
  }
  for (const want of ['warband-contribute', 'warband-consult', 'warband-muster']) {
    if (!wfIds.has(want)) throw new Error(`expected workflow ${want} in the loaded template`)
  }
  const hitl = workflows.filter((w) => (w.steps ?? []).some((s) => s.human))
  if (hitl.length !== 1) throw new Error(`expected 1 HITL workflow (muster), found ${hitl.length}`)
  if (!kb?.presetData?.ref) throw new Error('expected the KB slot to carry a presetData POINTER')

  section('done')
  console.log('  Loaded from a FILE — 2 agents + 3 declarative workflows + a shared-archive KB pointer.\n')
  process.exit(0)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main()
