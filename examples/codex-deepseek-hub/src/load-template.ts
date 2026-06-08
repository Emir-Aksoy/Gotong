/**
 * load-template — proof that codex-deepseek-hub's "brain" config is a LOADABLE
 * FILE, not a built-in TS literal.
 *
 * It reads the shipped `template/codex-deepseek-hub.template.yaml` off disk,
 * parses it, and previews the architecture it declares:
 *
 *   [1] LOAD     — the config comes from a file (read + parsed here, live).
 *   [2] mentor   — a methodology-aware pairing-mentor agent that reaches a KB.
 *   [3] KB slot  — an addressable Obsidian KB whose presetData is a POINTER,
 *                  never knowledge content (Stream B decision #4).
 *   [4] vault    — the actual CONTENT the pointer points at ships SEPARATELY,
 *                  under methodology-vault/ (import into your own Obsidian vault).
 *
 * This is a config-preview (same approach as examples/obsidian-kb): it does NOT
 * spawn the mcp-obsidian server (that needs a running Obsidian + the Local REST
 * API plugin). The rigorous "passes the real schema + imports end-to-end" proof
 * is the web anti-corruption test
 * (packages/web/tests/codex-deepseek-hub-template.test.ts), which runs this exact
 * file through the real parseTemplate + import route.
 *
 * Run:  pnpm demo:codex-deepseek-hub:template
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

const TEMPLATE = fileURLToPath(
  new URL('../template/codex-deepseek-hub.template.yaml', import.meta.url),
)
const VAULT_DIR = fileURLToPath(new URL('../methodology-vault', import.meta.url))

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
  console.log('\n=== AipeHub case: codex-deepseek-hub — load the template ===\n')

  // --- [1] LOAD: the config is a FILE, parsed live (not a built-in literal) ---
  section('[1] load the config from a FILE')
  console.log(`  file: ${TEMPLATE}`)
  const doc = parseYaml(readFileSync(TEMPLATE, 'utf8')) as LoadedTemplate
  const t = doc.template ?? {}
  console.log(`  schema: ${doc.schema}`)
  console.log(`  name:   ${t.name}`)
  console.log(`  apiKey: prompt once for ${t.defaults?.apiKeyPrompt?.label ?? '(none)'}`)

  // --- [2] the methodology-aware pairing mentor agent ------------------------
  section('[2] the methodology-aware pairing mentor agent')
  const agents = t.agents ?? []
  for (const a of agents) {
    console.log(`  agent  ${a.id}  [${(a.capabilities ?? []).join(', ')}]`)
    console.log(`         consults the KB via mcpServer: ${(a.mcpServers ?? []).map((s) => s.name).join(', ')}`)
  }
  console.log('  (the two coders — codex + deepseek-tui — are NOT in the template:')
  console.log('   they are CliParticipants, wired at runtime by src/real-agents.ts)')

  // --- [3] the addressable KB slot: wiring + a POINTER, never content ---------
  section('[3] knowledge-base slot — wiring + presetData POINTER (never content)')
  const kbs = t.knowledgeBases ?? []
  for (const k of kbs) {
    console.log(`  KB slot  ${k.name}  (transport: mcp '${k.mcpServer?.name}')`)
    console.log(`           presetData: ${k.presetData?.kind} → ${k.presetData?.ref}`)
  }

  // --- [4] the actual knowledge CONTENT ships OUTSIDE the template ------------
  section('[4] the methodology vault — the CONTENT the pointer points at')
  const notes = listMarkdown(VAULT_DIR)
  console.log(`  ${notes.length} markdown notes under methodology-vault/ (copy into your Obsidian vault):`)
  for (const n of notes) console.log(`    • ${n}`)

  // --- [5] load it into a real host ------------------------------------------
  section('[5] load it into a real host')
  console.log('  curl -X POST -H "Authorization: Bearer <admin-token>" \\')
  console.log("    -H 'content-type: application/json' \\")
  console.log("    -d \"$(jq -Rs '{template: .}' \\")
  console.log('      examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml)\" \\')
  console.log('    http://127.0.0.1:8745/api/admin/templates/import')

  // Self-assert (this doubles as a smoke test): the loaded FILE really declares
  // the mentor + the methodology KB slot with a presetData POINTER, and the
  // content ships separately as the vault.
  const mentor = agents.find((a) => a.id === 'pairing-mentor')
  const kb = kbs.find((k) => k.name === 'coder_pairing_methodology')
  if (doc.schema !== 'aipehub.template/v1') throw new Error('expected schema aipehub.template/v1')
  if (!mentor) throw new Error('expected a pairing-mentor agent in the loaded template')
  if (!kb?.presetData?.ref) throw new Error('expected the KB slot to carry a presetData POINTER')
  if (notes.length === 0) throw new Error('expected the methodology vault to ship content')

  section('done')
  console.log('  Loaded from a FILE — mentor + pairing-methodology KB slot (pointer); content is the vault.\n')
  process.exit(0)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

/** Recursively list `.md` files under `dir`, as paths relative to it (sorted). */
function listMarkdown(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listMarkdown(full))
    else if (entry.name.endsWith('.md')) out.push(relative(VAULT_DIR, full))
  }
  return out.sort()
}

main()
