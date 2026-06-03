/**
 * load-template — proof that battle-monk-training's "order" config is a LOADABLE
 * FILE, not a built-in TS literal.
 *
 * It reads the shipped `template/battle-monk-training.template.yaml` off disk,
 * parses it, and previews the architecture it declares:
 *
 *   [1] LOAD     — the config comes from a file (read + parsed here, live).
 *   [2] order    — 4 managed LLM agents (preceptor + body / mind / lore drills),
 *                  each reaching the Codex via mcp-obsidian.
 *   [3] KB slot  — an addressable Codex whose presetData is a POINTER, never the
 *                  trainee's state content (Stream B decision #4).
 *   [4] content  — the actual state is YOUR Obsidian Codex; it does NOT ship in
 *                  the template. The runnable demo (src/index.ts) seeds a tiny
 *                  baseline at runtime just to show the loop end to end.
 *
 * This is a config-preview (same approach as examples/obsidian-kb): it does NOT
 * spawn the mcp-obsidian server. The rigorous "passes the real schema + imports
 * end-to-end" proof is the web anti-corruption test
 * (packages/web/tests/battle-monk-training-template.test.ts), which runs this
 * exact file through the real parseTemplate + import route.
 *
 * Run:  pnpm demo:battle-monk-training:template
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

const TEMPLATE = fileURLToPath(
  new URL('../template/battle-monk-training.template.yaml', import.meta.url),
)

interface LoadedTemplate {
  schema?: string
  template?: {
    name?: string
    agents?: Array<{ id?: string; capabilities?: string[]; mcpServers?: Array<{ name?: string }> }>
    knowledgeBases?: Array<{
      name?: string
      mcpServer?: { name?: string }
      presetData?: { kind?: string; ref?: string }
    }>
    defaults?: { apiKeyPrompt?: { label?: string } }
  }
}

function main(): void {
  console.log('\n=== AipeHub case: battle-monk-training — load the template ===\n')

  // --- [1] LOAD: the config is a FILE, parsed live (not a built-in literal) ---
  section('[1] load the config from a FILE')
  console.log(`  file: ${TEMPLATE}`)
  const doc = parseYaml(readFileSync(TEMPLATE, 'utf8')) as LoadedTemplate
  const t = doc.template ?? {}
  console.log(`  schema: ${doc.schema}`)
  console.log(`  name:   ${t.name}`)
  console.log(`  apiKey: prompt once for ${t.defaults?.apiKeyPrompt?.label ?? '(none)'}`)

  // --- [2] the order — 4 managed LLM agents ----------------------------------
  section('[2] the order (督修 routes; 三柱 drill body / mind / lore)')
  const agents = t.agents ?? []
  for (const a of agents) {
    console.log(`  agent  ${a.id}  [${(a.capabilities ?? []).join(', ')}]`)
    console.log(`         reaches the Codex via mcpServer: ${(a.mcpServers ?? []).map((s) => s.name).join(', ')}`)
  }

  // --- [3] the addressable KB slot: wiring + a POINTER, never content ---------
  section('[3] knowledge-base slot — wiring + presetData POINTER (never content)')
  const kbs = t.knowledgeBases ?? []
  for (const k of kbs) {
    console.log(`  KB slot  ${k.name}  (transport: mcp '${k.mcpServer?.name}')`)
    console.log(`           presetData: ${k.presetData?.kind} → ${k.presetData?.ref}`)
  }

  // --- [4] the actual state CONTENT lives OUTSIDE the template ----------------
  section('[4] the Codex content — YOUR Obsidian vault, not the template')
  console.log('  The template carries structure + a pointer only (decision #4). The')
  console.log("  trainee's state (三柱档案) is your own Obsidian Codex behind mcp-obsidian.")
  console.log('  The runnable demo seeds a tiny baseline at runtime to show the')
  console.log('  assess → drill → log-state loop end to end:')
  console.log('    pnpm demo:battle-monk-training')

  // --- [5] load it into a real host ------------------------------------------
  section('[5] load it into a real host')
  console.log('  curl -X POST -H "Authorization: Bearer <admin-token>" \\')
  console.log("    -H 'content-type: application/json' \\")
  console.log("    -d \"$(jq -Rs '{template: .}' \\")
  console.log('      examples/battle-monk-training/template/battle-monk-training.template.yaml)\" \\')
  console.log('    http://127.0.0.1:8745/api/admin/templates/import')

  // Self-assert (this doubles as a smoke test): the loaded FILE really declares
  // the whole order + the Codex KB slot with a presetData POINTER (no content).
  const ids = new Set(agents.map((a) => a.id))
  const kb = kbs.find((k) => k.name === 'acolyte_codex')
  if (doc.schema !== 'aipehub.template/v1') throw new Error('expected schema aipehub.template/v1')
  for (const want of ['preceptor', 'body-drill', 'mind-forge', 'lore-scribe']) {
    if (!ids.has(want)) throw new Error(`expected a ${want} agent in the loaded template`)
  }
  if (!kb?.presetData?.ref) throw new Error('expected the KB slot to carry a presetData POINTER')

  section('done')
  console.log('  Loaded from a FILE — the order + Codex KB slot (pointer); state is your vault.\n')
  process.exit(0)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main()
