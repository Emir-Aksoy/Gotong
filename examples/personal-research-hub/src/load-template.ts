/**
 * load-template — proof that personal-research-hub's "team" config is a LOADABLE
 * FILE, not a built-in TS literal.
 *
 * It reads the shipped `template/personal-research-hub.template.yaml` off disk,
 * parses it, and previews the architecture it declares:
 *
 *   [1] LOAD     — the config comes from a file (read + parsed here, live).
 *   [2] team     — 3 managed LLM agents (librarian / compiler / researcher), each
 *                  reaching the wiki KB via mcp-obsidian.
 *   [3] KB slot  — an addressable Obsidian wiki whose presetData is a POINTER,
 *                  never knowledge content (Stream B decision #4).
 *   [4] content  — the actual knowledge is YOUR Obsidian wiki; it does NOT ship in
 *                  the template. The runnable demo (src/index.ts) seeds two tiny
 *                  raw fixtures at runtime just to show the loop end to end.
 *
 * This is a config-preview (same approach as examples/obsidian-kb): it does NOT
 * spawn the mcp-obsidian server (that needs a running Obsidian + the Local REST
 * API plugin). The rigorous "passes the real schema + imports end-to-end" proof
 * is the web anti-corruption test
 * (packages/web/tests/personal-research-hub-template.test.ts), which runs this
 * exact file through the real parseTemplate + import route.
 *
 * Run:  pnpm demo:personal-research-hub:template
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

const TEMPLATE = fileURLToPath(
  new URL('../template/personal-research-hub.template.yaml', import.meta.url),
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
  console.log('\n=== AipeHub case: personal-research-hub — load the template ===\n')

  // --- [1] LOAD: the config is a FILE, parsed live (not a built-in literal) ---
  section('[1] load the config from a FILE')
  console.log(`  file: ${TEMPLATE}`)
  const doc = parseYaml(readFileSync(TEMPLATE, 'utf8')) as LoadedTemplate
  const t = doc.template ?? {}
  console.log(`  schema: ${doc.schema}`)
  console.log(`  name:   ${t.name}`)
  console.log(`  apiKey: prompt once for ${t.defaults?.apiKeyPrompt?.label ?? '(none)'}`)

  // --- [2] the research team — 3 managed LLM agents --------------------------
  section('[2] the research team (librarian routes; compiler + researcher work)')
  const agents = t.agents ?? []
  for (const a of agents) {
    console.log(`  agent  ${a.id}  [${(a.capabilities ?? []).join(', ')}]`)
    console.log(`         reaches the wiki via mcpServer: ${(a.mcpServers ?? []).map((s) => s.name).join(', ')}`)
  }

  // --- [3] the addressable KB slot: wiring + a POINTER, never content ---------
  section('[3] knowledge-base slot — wiring + presetData POINTER (never content)')
  const kbs = t.knowledgeBases ?? []
  for (const k of kbs) {
    console.log(`  KB slot  ${k.name}  (transport: mcp '${k.mcpServer?.name}')`)
    console.log(`           presetData: ${k.presetData?.kind} → ${k.presetData?.ref}`)
  }

  // --- [4] the actual knowledge CONTENT lives OUTSIDE the template ------------
  section('[4] the wiki content — YOUR Obsidian vault, not the template')
  console.log('  The template carries structure + a pointer only (decision #4). The')
  console.log('  knowledge content is your own Obsidian wiki behind mcp-obsidian.')
  console.log('  The runnable demo seeds two tiny raw fixtures at runtime to show the')
  console.log('  raw → compiled-wiki → ask-your-wiki loop end to end:')
  console.log('    pnpm demo:personal-research-hub')

  // --- [5] load it into a real host ------------------------------------------
  section('[5] load it into a real host')
  console.log('  curl -X POST -H "Authorization: Bearer <admin-token>" \\')
  console.log("    -H 'content-type: application/json' \\")
  console.log("    -d \"$(jq -Rs '{template: .}' \\")
  console.log('      examples/personal-research-hub/template/personal-research-hub.template.yaml)\" \\')
  console.log('    http://127.0.0.1:8745/api/admin/templates/import')

  // Self-assert (this doubles as a smoke test): the loaded FILE really declares
  // the whole team + the wiki KB slot with a presetData POINTER (no content).
  const ids = new Set(agents.map((a) => a.id))
  const kb = kbs.find((k) => k.name === 'research_wiki')
  if (doc.schema !== 'aipehub.template/v1') throw new Error('expected schema aipehub.template/v1')
  for (const want of ['librarian', 'compiler', 'researcher']) {
    if (!ids.has(want)) throw new Error(`expected a ${want} agent in the loaded template`)
  }
  if (!kb?.presetData?.ref) throw new Error('expected the KB slot to carry a presetData POINTER')

  section('done')
  console.log('  Loaded from a FILE — the research team + wiki KB slot (pointer); content is your vault.\n')
  process.exit(0)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main()
