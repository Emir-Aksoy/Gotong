/**
 * load-template — proof that the 家长 side of the family-learning hub is a LOADABLE
 * FILE, not a built-in TS literal. It previews the architecture the file declares,
 * and the two things that make this case the MIRROR of tea-supply-link:
 *   - tea-supply-link's template is the INITIATOR side (the shop); this one is the
 *     SERVING side (the 家长 hub that holds the subscription + tutor + governance).
 *   - tea-supply-link's workflow has NO human step (its cross-org approval is the
 *     runtime outbound gate); THIS workflow HAS a `human:` step — the topic-whitelist
 *     approval — because the approver (the 家长) is a LOCAL user of this hub, and a
 *     local human step can only assign to a same-hub user. That's the design's key
 *     correctness constraint, and it's why the approval lives in the 家长 workflow.
 *
 * It reads the shipped `template/family-tutor.template.yaml` off disk, parses it,
 * and previews:
 *
 *   [1] LOAD      — the config comes from a file (read + parsed here, live).
 *   [2] agent     — 1 /teach tutor covering the 家长 hub's LOCAL caps.
 *   [3] workflow  — 1 DECLARATIVE workflow: screen → guardian-approval (human:,
 *                   conditional on off-whitelist) → teach (tagged child-learning).
 *   [4] KB slot   — an addressable learning_records whose presetData is a POINTER,
 *                   never the records content (Stream B decision #4).
 *   [5] the LINK  — which 孩子 peer, outbound allowlist, data-class contract:
 *                   RUNTIME config, in NEITHER the template nor the workflow.
 *                   (模版和框架是分离关系 — the teaching point.)
 *
 * This is a config-preview (same approach as examples/obsidian-kb / tea-supply-link):
 * it does NOT spawn mcp-obsidian and does NOT open a peer link. The rigorous "passes
 * the real schema + the workflow round-trips + imports end-to-end" proof is the web
 * anti-corruption test (packages/web/tests/family-tutor-template.test.ts); the
 * runnable cross-hub orchestration (with the whitelist approval gate + data-class
 * confinement) is the deterministic demo (pnpm demo:family-learning-hub).
 *
 * Run:  pnpm demo:family-learning-hub:template
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

const TEMPLATE = fileURLToPath(new URL('../template/family-tutor.template.yaml', import.meta.url))

interface LoadedStep {
  id?: string
  when?: string
  human?: { kind?: string; assignee?: string }
  dispatch?: { strategy?: { capabilities?: string[] }; dataClasses?: string[] }
}

interface LoadedWorkflow {
  id?: string
  name?: string
  trigger?: { capability?: string }
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

/** The capability the child reaches cross-hub — it's the WORKFLOW trigger, not an agent cap. */
const TUTOR_CAP = 'tutor.teach'
/** The data class tagging the child's learning content as it flows. */
const CHILD_LEARNING = 'child-learning'

function main(): void {
  console.log('\n=== AipeHub case: family-learning-hub — load the 家长 (cross-org) template ===\n')

  // --- [1] LOAD: the config is a FILE, parsed live (not a built-in literal) ---
  section('[1] load the config from a FILE')
  console.log(`  file: ${TEMPLATE}`)
  const doc = parseYaml(readFileSync(TEMPLATE, 'utf8')) as LoadedTemplate
  const t = doc.template ?? {}
  console.log(`  schema: ${doc.schema}`)
  console.log(`  name:   ${t.name}`)
  console.log(`  apiKey: prompt once for ${t.defaults?.apiKeyPrompt?.label ?? '(none)'}`)

  // --- [2] the agent — 1 managed LLM tutor (家长-LOCAL caps only) --------------
  section('[2] agent (AI 导师) — serves the 家长 hub LOCAL capabilities')
  const agents = t.agents ?? []
  for (const a of agents) {
    console.log(`  agent  ${a.id}  [${(a.capabilities ?? []).join(', ')}]`)
    console.log(`         reaches learning_records via mcpServer: ${(a.mcpServers ?? []).map((s) => s.name).join(', ')}`)
  }
  console.log(`  note:  '${TUTOR_CAP}' is NOT an agent cap — it's the workflow trigger the child`)
  console.log('         reaches cross-hub; the workflow dispatches the inner teach.lesson here.')

  // --- [3] the DECLARATIVE workflow with the whitelist approval ----------------
  section('[3] workflow (screen → 家长 审批 human: → teach)')
  const workflows = t.workflows ?? []
  for (const w of workflows) {
    const steps = w.steps ?? []
    const humanSteps = steps.filter((s) => s.human)
    const taggedSteps = steps.filter((s) => (s.dispatch?.dataClasses ?? []).includes(CHILD_LEARNING))
    console.log(`  workflow  ${w.id}  (trigger: ${w.trigger?.capability} ← 孩子 hub 跨组织调用)`)
    console.log(`            steps: ${steps.map((s) => s.id).join(' → ')}`)
    console.log(
      `            human: 步: ${
        humanSteps.length
          ? humanSteps.map((s) => `${s.id} (assignee=${s.human?.assignee}${s.when ? `, when ${s.when}` : ''})`).join(', ')
          : '无'
      }`,
    )
    console.log(`            标 ${CHILD_LEARNING} 的步: ${taggedSteps.map((s) => s.id).join(', ') || '—'}`)
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
  console.log('  模版和框架是分离关系: this file carries only the 家长-SIDE skeleton (the tutor +')
  console.log('  the whitelist-approval workflow). The link to the 孩子 hub — which peer, which')
  console.log('  outbound capabilities are allowed, the child-learning data-class contract — is')
  console.log('  RUNTIME peer config (host installPeerLink / admin「联邦」tab), in neither the')
  console.log(`  template nor the workflow. The workflow trigger names only '${TUTOR_CAP}', never a`)
  console.log('  peer. The 孩子 hub keeps the learning-records MASTER copy; this 家长 side gets a')
  console.log('  fork (oversight). Credentials / data / billing stay each-its-own. See it wired')
  console.log('  live in:  pnpm demo:family-learning-hub')

  // --- [6] load it into a real host ------------------------------------------
  section('[6] load it into a real host')
  console.log('  curl -X POST -H "Authorization: Bearer <admin-token>" \\')
  console.log("    -H 'content-type: application/json' \\")
  console.log("    -d \"$(jq -Rs '{template: .}' \\")
  console.log('      examples/family-learning-hub/template/family-tutor.template.yaml)\" \\')
  console.log('    http://127.0.0.1:8745/api/admin/templates/import')

  // Self-assert (this doubles as a smoke test): the loaded FILE declares the tutor
  // agent + the cross-org workflow (a `guardian-approval` HUMAN step gated on the
  // whitelist — opposite of tea-shop — and a `teach` step tagged child-learning),
  // and a KB POINTER (no content).
  const ids = new Set(agents.map((a) => a.id))
  if (doc.schema !== 'aipehub.template/v1') throw new Error('expected schema aipehub.template/v1')
  if (!ids.has('family-tutor')) throw new Error('expected a family-tutor agent')
  // The cross-hub trigger capability must NOT be served by a template agent.
  for (const a of agents) {
    if ((a.capabilities ?? []).includes(TUTOR_CAP)) {
      throw new Error(`${a.id} must NOT serve ${TUTOR_CAP} — it's the cross-hub workflow trigger`)
    }
  }
  const wf = workflows.find((w) => w.id === 'tutor-teach')
  if (!wf) throw new Error('expected the tutor-teach workflow in the loaded template')
  // ★ Inversion vs tea-shop: this workflow MUST carry a human approval step.
  const approval = (wf.steps ?? []).find((s) => s.human)
  if (!approval) throw new Error('expected a `human:` whitelist-approval step (家长 hub side)')
  if (approval.when !== '$screen.output.allowed == false') {
    throw new Error('the approval must be conditional on the whitelist (when off-whitelist)')
  }
  // ★ The teach step must tag the lesson content with the child-learning data class.
  const teach = (wf.steps ?? []).find((s) => s.id === 'teach')
  if (!(teach?.dispatch?.dataClasses ?? []).includes(CHILD_LEARNING)) {
    throw new Error(`expected the teach step to tag ${CHILD_LEARNING}`)
  }
  const kb = kbs.find((k) => k.name === 'learning_records')
  if (!kb?.presetData?.ref) throw new Error('expected the KB slot to carry a presetData POINTER')

  section('done')
  console.log('  Loaded from a FILE — 1 tutor + 1 workflow (家长 审批 human: 步 + child-learning 标), KB pointer; the LINK is runtime.\n')
  process.exit(0)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main()
