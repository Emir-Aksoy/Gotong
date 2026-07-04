/**
 * load-template — proof that the 总部 side of the chain link is a LOADABLE FILE,
 * not a built-in TS literal. It also previews the thing that makes this case
 * (like tea-supply-link) different from cafe-ops / warband-club: the orchestration
 * crosses an ORGANIZATION boundary, and the cross-org LINK is deliberately NOT in
 * the file. This is the MIRROR of tea-supply-link, one tier UP and pointing DOWN:
 * the HQ rolls a directive DOWN to a franchise shop, instead of a shop ordering UP
 * from a supplier.
 *
 * It reads the shipped `template/chain-hq.template.yaml` off disk, parses it, and
 * previews the architecture it declares:
 *
 *   [1] LOAD      — the config comes from a file (read + parsed here, live).
 *   [2] agent     — 1 rollout coordinator covering HQ's LOCAL caps.
 *   [3] workflow  — 1 DECLARATIVE cross-org workflow: surface.me self-service +
 *                   a `rollout` step that dispatches a capability living on the
 *                   franchise-SHOP peer (named by capability, never by peer). No
 *                   human: step — the cross-org approval is the runtime outbound gate.
 *   [4] KB slot   — an addressable chain_playbook whose presetData is a POINTER,
 *                   never the playbook content (Stream B decision #4).
 *   [5] the LINK  — which / how many franchise shops, outbound allowlist, approval
 *                   policy: RUNTIME config, in NEITHER the template nor the workflow.
 *                   (模版和框架是分离关系 — the teaching point.)
 *
 * This is a config-preview (same approach as examples/obsidian-kb / tea-supply-link):
 * it does NOT spawn mcp-obsidian and does NOT open a peer link. The rigorous "passes
 * the real schema + the workflow round-trips + imports end-to-end" proof is the web
 * anti-corruption test (packages/web/tests/chain-hq-template.test.ts); the runnable
 * cross-hub orchestration (with the outbound approval gate) is the deterministic
 * demo (pnpm demo:tea-chain-hq).
 *
 * Run:  pnpm demo:tea-chain-hq:template
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

const TEMPLATE = fileURLToPath(new URL('../template/chain-hq.template.yaml', import.meta.url))

interface LoadedStep {
  id?: string
  human?: { kind?: string }
  dispatch?: { strategy?: { capabilities?: string[] } }
}

interface LoadedWorkflow {
  id?: string
  name?: string
  trigger?: { capability?: string }
  surface?: { me?: { enabled?: boolean; user_scope_field?: string } }
  steps?: LoadedStep[]
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

/** The one capability NOT served by the template — it lives on the franchise-shop peer. */
const SHOP_CAP = 'shop.apply-directive'

function main(): void {
  console.log('\n=== Gotong case: tea-chain-hq — load the 连锁总部 (cross-org) template ===\n')

  // --- [1] LOAD: the config is a FILE, parsed live (not a built-in literal) ---
  section('[1] load the config from a FILE')
  console.log(`  file: ${TEMPLATE}`)
  const doc = parseYaml(readFileSync(TEMPLATE, 'utf8')) as LoadedTemplate
  const t = doc.template ?? {}
  console.log(`  schema: ${doc.schema}`)
  console.log(`  name:   ${t.name}`)
  console.log(`  apiKey: prompt once for ${t.defaults?.apiKeyPrompt?.label ?? '(none)'}`)

  // --- [2] the agent — 1 managed LLM agent (HQ-LOCAL caps only) ---------------
  section('[2] agent (下发协调员) — serves the HQ-LOCAL capabilities')
  const agents = t.agents ?? []
  for (const a of agents) {
    console.log(`  agent  ${a.id}  [${(a.capabilities ?? []).join(', ')}]`)
    console.log(`         reaches the playbook via mcpServer: ${(a.mcpServers ?? []).map((s) => s.name).join(', ')}`)
  }
  console.log(`  note:  '${SHOP_CAP}' is NOT served here — it lives on the franchise-shop peer.`)

  // --- [3] the DECLARATIVE cross-org workflow --------------------------------
  section('[3] workflow (surface.me self-service + a CROSS-ORG `rollout` step)')
  const workflows = t.workflows ?? []
  for (const w of workflows) {
    const selfService = w.surface?.me?.enabled ? `成员自助 (/me, scope=${w.surface?.me?.user_scope_field})` : '—'
    const steps = w.steps ?? []
    const crossOrg = steps.filter((s) => (s.dispatch?.strategy?.capabilities ?? []).includes(SHOP_CAP))
    const humanSteps = steps.filter((s) => s.human)
    console.log(`  workflow  ${w.id}  (trigger: ${w.trigger?.capability})`)
    console.log(`            ${selfService}`)
    console.log(`            steps: ${steps.map((s) => s.id).join(' → ')}`)
    console.log(`            跨组织步: ${crossOrg.map((s) => `${s.id}→[${SHOP_CAP}]`).join(', ') || '—'}`)
    console.log(`            human: 步: ${humanSteps.length ? humanSteps.map((s) => s.id).join(', ') : '无 (跨组织审批是运行时出站闸, 不是工作流步)'}`)
  }

  // --- [4] the addressable KB slot: wiring + a POINTER, never content ---------
  section('[4] knowledge-base slot — wiring + presetData POINTER (never content)')
  const kbs = t.knowledgeBases ?? []
  for (const k of kbs) {
    console.log(`  KB slot  ${k.name}  (transport: mcp '${k.mcpServer?.name}')`)
    console.log(`           presetData: ${k.presetData?.kind} → ${k.presetData?.ref}`)
  }

  // --- [5] the cross-org LINK lives OUTSIDE the template (the teaching point) --
  section('[5] the cross-org LINK — RUNTIME peer config, NOT in this template')
  console.log('  模版和框架是分离关系: this file carries only the HQ-SIDE skeleton, and it')
  console.log('  orchestrates DOWNWARD. The link to your franchise shops — WHICH / HOW MANY')
  console.log('  shops, which outbound capabilities are allowed, and whether the 区域经理 must')
  console.log('  approve before a directive leaves HQ — is RUNTIME peer config (host')
  console.log('  installPeerLink / admin「联邦」tab), in neither the template nor the workflow.')
  console.log(`  The 'rollout' step names only the capability '${SHOP_CAP}', never a peer:`)
  console.log('    · 单店: the capability resolves to the one linked franchise shop;')
  console.log('    · 多店: link more franchise shops (or a broadcast strategy) — the workflow')
  console.log('            is UNCHANGED. credentials / data / billing stay each-its-own.')
  console.log('  See the link wired live (with the outbound approval gate) in:')
  console.log('    pnpm demo:tea-chain-hq')

  // --- [6] load it into a real host ------------------------------------------
  section('[6] load it into a real host')
  console.log('  curl -X POST -H "Authorization: Bearer <admin-token>" \\')
  console.log("    -H 'content-type: application/json' \\")
  console.log("    -d \"$(jq -Rs '{template: .}' \\")
  console.log('      examples/tea-chain-hq/template/chain-hq.template.yaml)\" \\')
  console.log('    http://127.0.0.1:8745/api/admin/templates/import')

  // Self-assert (this doubles as a smoke test): the loaded FILE declares the HQ
  // agent + the cross-org workflow (a `rollout` step targeting the shop cap, and
  // NO human step), and a KB POINTER (no content).
  const ids = new Set(agents.map((a) => a.id))
  if (doc.schema !== 'gotong.template/v1') throw new Error('expected schema gotong.template/v1')
  if (!ids.has('rollout-coordinator')) throw new Error('expected a rollout-coordinator agent')
  // The shop capability must NOT be served by a template agent (it's on the peer).
  for (const a of agents) {
    if ((a.capabilities ?? []).includes(SHOP_CAP)) {
      throw new Error(`${a.id} must NOT serve ${SHOP_CAP} — it lives on the franchise-shop peer`)
    }
  }
  const rollout = workflows.find((w) => w.id === 'chain-directive-rollout')
  if (!rollout) throw new Error('expected the chain-directive-rollout workflow in the loaded template')
  const rolloutStep = (rollout.steps ?? []).find((s) =>
    (s.dispatch?.strategy?.capabilities ?? []).includes(SHOP_CAP),
  )
  if (!rolloutStep) throw new Error(`expected a step dispatching the cross-org ${SHOP_CAP}`)
  const anyHuman = (rollout.steps ?? []).some((s) => s.human)
  if (anyHuman) throw new Error('the cross-org approval is the runtime outbound gate — expected NO human: step')
  const kb = kbs.find((k) => k.name === 'chain_playbook')
  if (!kb?.presetData?.ref) throw new Error('expected the KB slot to carry a presetData POINTER')

  section('done')
  console.log('  Loaded from a FILE — 1 agent + 1 cross-org workflow + a KB pointer; the LINK is runtime.\n')
  process.exit(0)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main()
