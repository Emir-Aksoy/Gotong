/**
 * load-template — proof that the smart-home hub's config is a LOADABLE FILE, not
 * a built-in TS literal. It reads the shipped
 * `template/smart-home-hub.template.yaml` off disk, parses it, and previews the
 * architecture it declares:
 *
 *   [1] LOAD      — the config comes from a file (read + parsed here, live).
 *   [2] agent     — 1 managed LLM agent (家居管家) with a Home Assistant MCP server.
 *   [3] workflow  — 1 declarative workflow (晚安例程) with a human: 安防确认 step.
 *   [4] runtime   — which Home Assistant + which token is RUNTIME config (the
 *                   ${HA_MCP_SSE_URL} / ${HA_TOKEN} placeholders), not in the
 *                   template and not named in the workflow.
 *
 * This is a config-preview (same approach as examples/obsidian-kb): it does NOT
 * spawn mcp-proxy or talk to a real Home Assistant. The rigorous "passes the real
 * schema + the workflow round-trips + imports end-to-end" proof is the web
 * anti-corruption test (packages/web/tests/smart-home-hub-template.test.ts).
 *
 * Run:  pnpm demo:smart-home-hub:template
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

const TEMPLATE = fileURLToPath(new URL('../template/smart-home-hub.template.yaml', import.meta.url))

interface LoadedWorkflow {
  id?: string
  trigger?: { capability?: string }
  surface?: { me?: { enabled?: boolean; user_scope_field?: string } }
  steps?: Array<{ id?: string; human?: { kind?: string }; when?: string }>
}

interface LoadedTemplate {
  schema?: string
  template?: {
    name?: string
    agents?: Array<{ id?: string; capabilities?: string[]; mcpServers?: Array<{ name?: string; env?: Record<string, string> }> }>
    workflows?: LoadedWorkflow[]
    knowledgeBases?: Array<{ name?: string }>
    defaults?: { apiKeyPrompt?: { label?: string } }
  }
}

function main(): void {
  console.log('\n=== AipeHub case: smart-home-hub — load the template ===\n')

  // --- [1] LOAD: the config is a FILE, parsed live (not a built-in literal) ---
  section('[1] load the config from a FILE')
  console.log(`  file: ${TEMPLATE}`)
  const doc = parseYaml(readFileSync(TEMPLATE, 'utf8')) as LoadedTemplate
  const t = doc.template ?? {}
  console.log(`  schema: ${doc.schema}`)
  console.log(`  name:   ${t.name}`)
  console.log(`  apiKey: prompt once for ${t.defaults?.apiKeyPrompt?.label ?? '(none)'}`)

  // --- [2] the agent — 1 managed LLM agent with a Home Assistant MCP server ---
  section('[2] agent (家居管家 → Home Assistant MCP server)')
  const agents = t.agents ?? []
  for (const a of agents) {
    console.log(`  agent  ${a.id}  [${(a.capabilities ?? []).join(', ')}]`)
    for (const s of a.mcpServers ?? []) {
      console.log(`         reaches devices via mcpServer: ${s.name}  (env: ${Object.keys(s.env ?? {}).join(', ')})`)
    }
  }

  // --- [3] the declarative workflow — reversible direct + human: secure gate --
  section('[3] workflow (晚安例程 — 可逆直接做 + human: 安防确认)')
  const workflows = t.workflows ?? []
  for (const w of workflows) {
    const selfService = w.surface?.me?.enabled ? `成员自助 (/me, scope=${w.surface?.me?.user_scope_field})` : '—'
    const humanSteps = (w.steps ?? []).filter((s) => s.human).map((s) => `${s.id}:${s.human?.kind}`)
    const gatedSteps = (w.steps ?? []).filter((s) => s.when).map((s) => s.id)
    console.log(`  workflow  ${w.id}  (trigger: ${w.trigger?.capability})`)
    console.log(`            ${selfService}`)
    console.log(`            human 闸: [${humanSteps.join(', ') || '无'}]  ·  when 闸: [${gatedSteps.join(', ') || '无'}]`)
  }

  // --- [4] which Home Assistant is RUNTIME config, not in the template --------
  section('[4] 接哪个 Home Assistant 是运行时配置, 不在模板里')
  console.log('  模板里设备的 MCP 接线是 ${HA_MCP_SSE_URL} / ${HA_TOKEN} 占位符 —— 你接')
  console.log('  哪个 Home Assistant、用哪个长期令牌, 是导入后填的运行时配置。工作流的步骤')
  console.log('  只点名 capability (home.apply-scene / home.secure), 从不点名某一个设备或')
  console.log('  某一台 HA。换一套设备、换一个家, 工作流一个字不用改 (模版/框架分离)。')
  console.log('  凡是能进 Home Assistant 的设备 (小米 / 特斯拉 / 美的 …) 都能接到这个 hub。')

  // --- [5] load it into a real host ------------------------------------------
  section('[5] load it into a real host')
  console.log('  curl -X POST -H "Authorization: Bearer <admin-token>" \\')
  console.log("    -H 'content-type: application/json' \\")
  console.log("    -d \"$(jq -Rs '{template: .}' \\")
  console.log('      examples/smart-home-hub/template/smart-home-hub.template.yaml)\" \\')
  console.log('    http://127.0.0.1:8745/api/admin/templates/import')

  // Self-assert (this doubles as a smoke test): the loaded FILE declares the
  // home-steward agent wired to a Home Assistant MCP server, the 晚安例程 workflow
  // with a human: step + a when-gated secure step, and intentionally NO KB slot.
  const ids = new Set(agents.map((a) => a.id))
  const wf = workflows.find((w) => w.id === 'home-goodnight')
  if (doc.schema !== 'aipehub.template/v1') throw new Error('expected schema aipehub.template/v1')
  if (!ids.has('home-steward')) throw new Error('expected a home-steward agent in the loaded template')
  const steward = agents.find((a) => a.id === 'home-steward')!
  if (!(steward.mcpServers ?? []).some((s) => s.name === 'homeassistant')) {
    throw new Error('expected home-steward to wire the homeassistant MCP server')
  }
  if (!wf) throw new Error('expected the home-goodnight workflow in the loaded template')
  if (!(wf.steps ?? []).some((s) => s.human?.kind === 'approval')) {
    throw new Error('expected a human: approval step (the security gate)')
  }
  if (!(wf.steps ?? []).some((s) => s.id === 'secure' && s.when)) {
    throw new Error('expected the secure step to be when-gated on approval')
  }
  if ((t.knowledgeBases ?? []).length !== 0) {
    throw new Error('this template intentionally carries no KB slot (devices are the live HA state)')
  }

  section('done')
  console.log('  Loaded from a FILE — 1 agent (+ HA MCP) + 1 workflow (human: 安防闸), no KB.\n')
  process.exit(0)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main()
