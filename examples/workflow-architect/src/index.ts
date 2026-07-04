/**
 * examples/workflow-architect — 工作流架构师 (ARCH-M8) deterministic demo.
 *
 * The user asked for a built-in agent that (1) authors a workflow YAML from
 * plain language, (2) explains it at an adjustable depth, and (3) shows a
 * picture of the workflow (工作流图片介绍). ARCH-M1..M7 grew the existing Phase 13
 * `WorkflowAssistantAgent` (capability `workflow:assist`) to do all three. This
 * demo proves the AGENT behaviors end-to-end, host-free and deterministically —
 * a mock LLM keyed off markers, so every claim is a self-assertion with no key
 * and no network. (The REAL host pipeline — member create lands a draft, a
 * cross-hub workflow is refused, a fabricated capability is caught — is proven
 * in the host acceptance gate `packages/host/tests/workflow-architect-e2e.test.ts`.)
 *
 * What this demo pins:
 *
 *   A. AUTHOR + depth-into-prompt.  The same description is authored at three
 *      depths (oneliner / brief / detailed). The mock LLM does NOT vary its
 *      reply by depth — that end-to-end text-length change is an opt-in real-LLM
 *      smoke. What's hermetic is that the depth INSTRUCTION reaches the prompt:
 *      we capture the request the agent built and assert it carries exactly
 *      `detailInstruction(detail)`. (The YAML + graph are identical at every
 *      depth, by design.)
 *
 *   B. GRAPH attached + correct.  Every valid result carries `graph` — the pure
 *      `projectWorkflowGraph` projection, the inline/downloadable SVG flowchart
 *      the frontend renders. We assert it deep-equals an independent projection
 *      of the produced YAML (node/edge counts match — it's the real picture of
 *      THIS workflow, not a stale or fabricated one).
 *
 *   C. EXPLAIN echoes verbatim, never regenerates.  In explain mode the subject
 *      YAML is authoritative: even when the mock LLM returns a DECOY yaml fence,
 *      the output's `yaml` is byte-for-byte the subject (the LLM only wrote
 *      prose) and the graph is the subject's projection.
 *
 *   D. Member create is local-only.  A member-authored workflow with an off-hub
 *      hop is refused. The host's `workflowBoundary` is the authoritative
 *      detector (exercised for real in the gate); here we inline its essence for
 *      a host-free demo — same discipline as cross-hub-workflow's inlined gate.
 *
 * Run:  pnpm demo:workflow-architect   (exits 0 iff every assertion holds)
 */

import { Hub } from '@gotong/core'
import { MockLlmProvider, type LlmRequest } from '@gotong/llm'
import {
  parseWorkflow,
  projectWorkflowGraph,
  type WorkflowDefinition,
  type WorkflowGraphView,
} from '@gotong/workflow'
import {
  detailInstruction,
  WorkflowAssistantAgent,
  WORKFLOW_ASSISTANT_CAPABILITY,
  type WorkflowAssistantOutput,
  type WorkflowAssistantPayload,
  type WorkflowDetailLevel,
} from '@gotong/workflow-assistant'

// ── tiny self-assert harness (examples have no vitest) ──────────────────────

let checks = 0
function assert(cond: unknown, msg: string): void {
  checks++
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  console.log(`  ✓ ${msg}`)
}
function assertEqual<T>(actual: T, expected: T, msg: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} (got ${JSON.stringify(actual)})`,
  )
}

// ── deterministic workflow YAMLs (real text → real parseWorkflow) ───────────

/** What the architect "authors" — a 2-step local workflow (4 nodes, 4 edges). */
const AUTHOR_YAML = `schema: gotong.workflow/v1
workflow:
  id: morning-digest
  name: 晨间摘要
  trigger:
    capability: run-morning
  steps:
    - id: gather
      dispatch:
        strategy: { kind: capability, capabilities: [collect-notes] }
        payload: {}
    - id: summarize
      dispatch:
        strategy: { kind: capability, capabilities: [summarize] }
        payload:
          source: $gather.output
`

/** The EXISTING workflow we ask the architect to EXPLAIN (the subject). */
const EXISTING_YAML = `schema: gotong.workflow/v1
workflow:
  id: existing-review
  trigger:
    capability: run-review
  steps:
    - id: draft
      dispatch:
        strategy: { kind: capability, capabilities: [draft] }
        payload: {}
    - id: review
      dispatch:
        strategy: { kind: capability, capabilities: [review] }
        payload:
          doc: $draft.output
`

/**
 * A DECOY the mock LLM returns in explain mode — a DIFFERENT workflow. If the
 * agent (wrongly) trusted the LLM echo, `out.yaml` would become this. It must
 * NOT: explain mode keeps `subjectYaml` authoritative.
 */
const DECOY_YAML = `schema: gotong.workflow/v1
workflow:
  id: decoy-flow
  trigger:
    capability: decoy:run
  steps:
    - id: x
      dispatch:
        strategy: { kind: capability, capabilities: [decoy-cap] }
        payload: {}
`

/** A member-authored workflow whose second step leaves the hub (an off-hub hop). */
const CROSS_HUB_YAML = `schema: gotong.workflow/v1
workflow:
  id: member-cross
  trigger:
    capability: run-cross
  steps:
    - id: local-draft
      dispatch:
        strategy: { kind: capability, capabilities: [draft] }
        payload: {}
    - id: place-order
      dispatch:
        strategy: { kind: capability, capabilities: [supplier.confirm-order] }
        payload: {}
`

// ── deterministic mock LLM ──────────────────────────────────────────────────

/** Wrap a YAML body in the ```yaml fence the agent extracts. */
function fence(yaml: string): string {
  return ['好的，这是工作流：', '', '```yaml', yaml.trimEnd(), '```'].join('\n')
}

/**
 * Captures the LAST request the agent built, so the demo can assert what depth
 * instruction reached the prompt. The reply is mode-aware — keyed off a marker
 * that ONLY appears in the explain USER message ("Explain the workflow below"),
 * NOT the system prompt. (The phrase "prose explanation ONLY" also lives in the
 * system prompt that documents the explain branch, so keying off it would match
 * EVERY request — author included — and the decoy would leak into author mode.)
 *   - explain mode → return a DECOY yaml fence, to PROVE the agent ignores the
 *     echo and keeps subjectYaml authoritative.
 *   - author mode → return the canonical authored workflow.
 */
let lastRequestJson = ''
function architectReply(req: LlmRequest): string {
  lastRequestJson = JSON.stringify(req)
  if (lastRequestJson.includes('Explain the workflow below')) {
    // Explain mode — hand back a decoy so non-regeneration is observable.
    return fence(DECOY_YAML)
  }
  return fence(AUTHOR_YAML)
}

// ── host-free cross-hub detector (essence of host's workflowBoundary) ───────

/**
 * The host's `workflowBoundary` (packages/host/src/workflow-edit-guard.ts) is
 * the AUTHORITATIVE detector the real `MeWorkflowCreateService` uses and the
 * host gate exercises. Here we inline its essence for a host-free demo (same
 * discipline as cross-hub-workflow's inlined approval gate): a step is an
 * off-hub egress iff its capability isn't served locally but IS advertised by a
 * peer. A member-authored workflow with any such hop is refused — members build
 * workflows that stay on their own hub.
 */
function offHubEgressSteps(
  def: WorkflowDefinition,
  localCaps: Set<string>,
  peerCaps: Set<string>,
): string[] {
  const egress: string[] = []
  for (const step of def.steps) {
    if (step.kind === 'parallel') continue // demo uses simple steps only
    const strat = step.dispatch.strategy
    if (strat.kind !== 'capability') continue
    for (const cap of strat.capabilities) {
      if (!localCaps.has(cap) && peerCaps.has(cap)) {
        egress.push(step.id)
        break
      }
    }
  }
  return egress
}

// ── dispatch helper ─────────────────────────────────────────────────────────

async function assist(
  hub: Hub,
  payload: WorkflowAssistantPayload,
): Promise<WorkflowAssistantOutput> {
  const result = await hub.dispatch({
    from: 'demo-member',
    strategy: { kind: 'capability', capabilities: [WORKFLOW_ASSISTANT_CAPABILITY] },
    payload,
    title: `workflow:assist (${payload.mode ?? 'author'})`,
  })
  if (result.kind !== 'ok') throw new Error(`assist dispatch failed: ${result.kind}`)
  return result.output as WorkflowAssistantOutput
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== 工作流架构师 (ARCH-M8) — deterministic demo ===\n')

  const hub = Hub.inMemory()
  await hub.start()
  hub.register(
    new WorkflowAssistantAgent({
      provider: new MockLlmProvider({ reply: architectReply }),
      maxTokens: 2048,
    }),
  )

  // The independent projection every graph assertion compares against — the
  // "correct picture of THIS workflow" oracle.
  const authorGraph = projectWorkflowGraph(parseWorkflow(AUTHOR_YAML))
  const existingGraph = projectWorkflowGraph(parseWorkflow(EXISTING_YAML))

  // ── A + B: author at three depths; depth reaches the prompt; graph attached + correct.
  console.log('▶ A/B — author at three depths + graph')
  const description = '每天早上把我的笔记收集起来，然后总结一下发给我。'
  const depths: WorkflowDetailLevel[] = ['oneliner', 'brief', 'detailed']
  for (const detail of depths) {
    const out = await assist(hub, { description, detail })
    // (A) the depth INSTRUCTION reached the prompt the agent built.
    assert(
      lastRequestJson.includes(detailInstruction(detail)),
      `author[${detail}] — prompt carries the ${detail} depth instruction`,
    )
    // (B) valid + graph attached + graph is the true projection of the produced YAML.
    assertEqual(out.draftStatus, 'valid', `author[${detail}] — draftStatus valid`)
    assert(out.graph !== undefined, `author[${detail}] — graph attached`)
    assertEqual(out.graph, authorGraph, `author[${detail}] — graph == projection of YAML`)
  }
  // Spell out the picture once: 4 nodes (trigger + 2 steps + output), 4 edges
  // (3 sequence backbone + 1 data edge gather→summarize).
  assertEqual(authorGraph.nodes.length, 4, 'author graph — 4 nodes (trigger+gather+summarize+output)')
  assertEqual(authorGraph.edges.length, 4, 'author graph — 4 edges (3 sequence + 1 data)')
  assertEqual(
    authorGraph.edges.filter((e) => e.kind === 'data').length,
    1,
    'author graph — exactly one $ref data edge (gather → summarize)',
  )

  // ── C: explain mode echoes the subject verbatim and never regenerates.
  console.log('\n▶ C — explain echoes verbatim (mock returns a DECOY; output must ignore it)')
  const explained = await assist(hub, {
    description: '这个工作流是干嘛的？',
    mode: 'explain',
    detail: 'detailed',
    subjectYaml: EXISTING_YAML,
  })
  assertEqual(explained.draftStatus, 'valid', 'explain — draftStatus valid')
  assertEqual(explained.yaml, EXISTING_YAML, 'explain — yaml is the subject, byte-for-byte')
  assert(!explained.yaml.includes('decoy-flow'), 'explain — did NOT adopt the LLM decoy')
  assertEqual(explained.graph, existingGraph, 'explain — graph is the subject projection')
  assertEqual(explained.graph?.workflowId, 'existing-review', 'explain — graph workflowId is the subject')

  // ── D: a member-authored cross-hub workflow is refused (host-free mirror).
  console.log('\n▶ D — member create is local-only (off-hub hop refused)')
  const localCaps = new Set(['draft', 'review', 'collect-notes', 'summarize'])
  const peerCaps = new Set(['supplier.confirm-order']) // advertised by a peer hub
  const crossDef = parseWorkflow(CROSS_HUB_YAML)
  const egress = offHubEgressSteps(crossDef, localCaps, peerCaps)
  assertEqual(egress, ['place-order'], 'member create — off-hub egress detected on place-order')
  assert(egress.length > 0, 'member create — refused (a member builds LOCAL workflows only)')
  // A purely-local workflow is NOT refused.
  const localOnly = offHubEgressSteps(parseWorkflow(AUTHOR_YAML), localCaps, peerCaps)
  assertEqual(localOnly, [], 'member create — a purely-local workflow has no egress (allowed)')

  console.log(`\n✅ all ${checks} assertions passed — transcript has ${hub.transcript.size()} entries (every assist auditable)`)
  await hub.stop()
}

main().catch((err) => {
  console.error(`\n❌ ${(err as Error).message}`)
  process.exit(1)
})
