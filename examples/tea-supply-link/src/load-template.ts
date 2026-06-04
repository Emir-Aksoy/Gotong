/**
 * load-template — proof that the 奶茶店 side of the supplier link is a LOADABLE
 * FILE, not a built-in TS literal. It also previews the thing that makes this
 * case different from cafe-ops / warband-club: the orchestration crosses an
 * ORGANIZATION boundary, and the cross-org LINK is deliberately NOT in the file.
 *
 * It reads the shipped `template/tea-shop.template.yaml` off disk, parses it,
 * and previews the architecture it declares:
 *
 *   [1] LOAD      — the config comes from a file (read + parsed here, live).
 *   [2] agent     — 1 procurement assistant covering the shop's LOCAL caps.
 *   [3] workflow  — 1 DECLARATIVE cross-org workflow: surface.me self-service +
 *                   a `place` step that dispatches a capability living on the
 *                   SUPPLIER peer (named by capability, never by peer). No human:
 *                   step — the cross-org approval is the runtime outbound gate.
 *   [4] KB slot   — an addressable supplier_catalog whose presetData is a
 *                   POINTER, never the catalog content (Stream B decision #4).
 *   [5] the LINK  — which supplier peer, outbound allowlist, approval policy:
 *                   RUNTIME config, in NEITHER the template nor the workflow.
 *                   (模版和框架是分离关系 — the teaching point.)
 *
 * This is a config-preview (same approach as examples/obsidian-kb / cafe-ops): it
 * does NOT spawn mcp-obsidian and does NOT open a peer link. The rigorous "passes
 * the real schema + the workflow round-trips + imports end-to-end" proof is the
 * web anti-corruption test (packages/web/tests/tea-shop-template.test.ts); the
 * runnable cross-hub orchestration (with the outbound approval gate) is the
 * deterministic demo (pnpm demo:tea-supply-link).
 *
 * Run:  pnpm demo:tea-supply-link:template
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

const TEMPLATE = fileURLToPath(new URL('../template/tea-shop.template.yaml', import.meta.url))

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

/** The one local capability NOT served by the template — it lives on the supplier peer. */
const SUPPLIER_CAP = 'supplier.confirm-order'

function main(): void {
  console.log('\n=== AipeHub case: tea-supply-link — load the 奶茶店 (cross-org) template ===\n')

  // --- [1] LOAD: the config is a FILE, parsed live (not a built-in literal) ---
  section('[1] load the config from a FILE')
  console.log(`  file: ${TEMPLATE}`)
  const doc = parseYaml(readFileSync(TEMPLATE, 'utf8')) as LoadedTemplate
  const t = doc.template ?? {}
  console.log(`  schema: ${doc.schema}`)
  console.log(`  name:   ${t.name}`)
  console.log(`  apiKey: prompt once for ${t.defaults?.apiKeyPrompt?.label ?? '(none)'}`)

  // --- [2] the agent — 1 managed LLM agent (shop-LOCAL caps only) -------------
  section('[2] agent (采购助手) — serves the shop-LOCAL capabilities')
  const agents = t.agents ?? []
  for (const a of agents) {
    console.log(`  agent  ${a.id}  [${(a.capabilities ?? []).join(', ')}]`)
    console.log(`         reaches the catalog via mcpServer: ${(a.mcpServers ?? []).map((s) => s.name).join(', ')}`)
  }
  console.log(`  note:  '${SUPPLIER_CAP}' is NOT served here — it lives on the supplier peer.`)

  // --- [3] the DECLARATIVE cross-org workflow --------------------------------
  section('[3] workflow (surface.me self-service + a CROSS-ORG `place` step)')
  const workflows = t.workflows ?? []
  for (const w of workflows) {
    const selfService = w.surface?.me?.enabled ? `成员自助 (/me, scope=${w.surface?.me?.user_scope_field})` : '—'
    const steps = w.steps ?? []
    const crossOrg = steps.filter((s) => (s.dispatch?.strategy?.capabilities ?? []).includes(SUPPLIER_CAP))
    const humanSteps = steps.filter((s) => s.human)
    console.log(`  workflow  ${w.id}  (trigger: ${w.trigger?.capability})`)
    console.log(`            ${selfService}`)
    console.log(`            steps: ${steps.map((s) => s.id).join(' → ')}`)
    console.log(`            跨组织步: ${crossOrg.map((s) => `${s.id}→[${SUPPLIER_CAP}]`).join(', ') || '—'}`)
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
  console.log('  模版和框架是分离关系: this file carries only the SHOP-SIDE skeleton. The link')
  console.log('  to your supplier — which peer, which outbound capabilities are allowed, and')
  console.log('  whether the 店长 must approve before an order leaves — is RUNTIME peer config')
  console.log('  (host installPeerLink / admin「联邦」tab), in neither the template nor the')
  console.log(`  workflow. The 'place' step names only the capability '${SUPPLIER_CAP}', never a`)
  console.log('  peer. Two shops import this same template and each connect their own supplier;')
  console.log('  credentials / data / billing stay each-its-own. See the link wired live in:')
  console.log('    pnpm demo:tea-supply-link')

  // --- [6] load it into a real host ------------------------------------------
  section('[6] load it into a real host')
  console.log('  curl -X POST -H "Authorization: Bearer <admin-token>" \\')
  console.log("    -H 'content-type: application/json' \\")
  console.log("    -d \"$(jq -Rs '{template: .}' \\")
  console.log('      examples/tea-supply-link/template/tea-shop.template.yaml)\" \\')
  console.log('    http://127.0.0.1:8745/api/admin/templates/import')

  // Self-assert (this doubles as a smoke test): the loaded FILE declares the shop
  // agent + the cross-org workflow (a `place` step targeting the supplier cap, and
  // NO human step), and a KB POINTER (no content).
  const ids = new Set(agents.map((a) => a.id))
  if (doc.schema !== 'aipehub.template/v1') throw new Error('expected schema aipehub.template/v1')
  if (!ids.has('procurement-assistant')) throw new Error('expected a procurement-assistant agent')
  // The supplier capability must NOT be served by a template agent (it's on the peer).
  for (const a of agents) {
    if ((a.capabilities ?? []).includes(SUPPLIER_CAP)) {
      throw new Error(`${a.id} must NOT serve ${SUPPLIER_CAP} — it lives on the supplier peer`)
    }
  }
  const restock = workflows.find((w) => w.id === 'tea-shop-restock')
  if (!restock) throw new Error('expected the tea-shop-restock workflow in the loaded template')
  const placeStep = (restock.steps ?? []).find((s) =>
    (s.dispatch?.strategy?.capabilities ?? []).includes(SUPPLIER_CAP),
  )
  if (!placeStep) throw new Error(`expected a step dispatching the cross-org ${SUPPLIER_CAP}`)
  const anyHuman = (restock.steps ?? []).some((s) => s.human)
  if (anyHuman) throw new Error('the cross-org approval is the runtime outbound gate — expected NO human: step')
  const kb = kbs.find((k) => k.name === 'supplier_catalog')
  if (!kb?.presetData?.ref) throw new Error('expected the KB slot to carry a presetData POINTER')

  section('done')
  console.log('  Loaded from a FILE — 1 agent + 1 cross-org workflow + a KB pointer; the LINK is runtime.\n')
  process.exit(0)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main()
