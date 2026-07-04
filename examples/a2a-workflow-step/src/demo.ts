/**
 * a2a-workflow-step — runnable demo of an EXTERNAL A2A agent as a workflow step.
 *
 * The sibling of examples/cross-hub-workflow. Both put an off-hub destination in
 * the middle of a declarative workflow, but the destination differs:
 *
 *   - cross-hub-workflow: the step routes to a mesh PEER hub (Gotong↔Gotong
 *     over a federation link). A peer that set `requireApprovalOutbound` makes
 *     the step PARK in the owner's inbox until they approve — the task can wait
 *     on a human before it crosses the org boundary.
 *   - THIS demo: the step routes to an EXTERNAL A2A agent (a third-party service
 *     reached over the A2A `message/send` wire). There is NO approval gate — the
 *     step FIRES IMMEDIATELY, calls out, and the reply flows into the next step.
 *
 * The mechanism is the SAME capability dispatch in both. An `A2aRemoteParticipant`
 * is just a LOCAL participant registered under a capability; when dispatched it
 * forwards the task to the agent's HTTP endpoint and turns the reply into the
 * task's `ok` output. So a workflow step `{kind: capability, capabilities:
 * [external.translate]}` routes to it with NO new runner code, NO new YAML
 * keyword — calling an external A2A agent is capability dispatch where the
 * capability is served by an outbound A2A edge.
 *
 * What this demo proves end to end (deterministic, no API key, no socket):
 *
 *   [A] happy — the workflow dispatches `translate` to the external A2A agent.
 *       The run COMPLETES IN ONE SHOT (no suspension — there is no gate): the
 *       agent translates over the A2A wire, the reply flows back into the local
 *       `archive` step, which files it; the run finishes `ok`.
 *   [B] failure — the external agent returns a JSON-RPC error (input it can't
 *       handle). `a2aSend` throws, the `translate` step FAILS, the workflow
 *       halts before `archive`, and the run fails closed.
 *
 * The "external A2A agent" is modelled by an injected `fetchImpl` rather than a
 * real socket — the same trick the @gotong/a2a unit tests use. It parses the
 * outbound JSON-RPC body and asserts the wire shape (method `message/send`,
 * bearer auth, `metadata.skill`), so this demo doubles as an A2A wire-contract
 * smoke. The real host reaches a real endpoint over `global fetch`; the
 * acceptance gate host/tests/a2a-workflow-step-e2e.test.ts runs the same flow
 * against a real loopback A2A server.
 *
 * Run:  pnpm demo:a2a-workflow-step
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hub, InMemoryStorage, type ParticipantId, type Task, type TaskResult } from '@gotong/core'
import {
  A2A_METHOD_MESSAGE_SEND,
  A2aRemoteParticipant,
  agentMessage,
  type A2ARequest,
  type A2AResponse,
} from '@gotong/a2a'
import { parseWorkflow, WorkflowRunner } from '@gotong/workflow'

const WORKFLOWS_DIR = fileURLToPath(new URL('../workflows', import.meta.url))

// The external A2A agent's endpoint + bearer. In production these live in the
// host's a2a_outbound_agents config (url + token-from-env); here they're
// constants the injected fetch checks so the demo is a real auth round-trip.
const EXTERNAL_URL = 'https://translator.example/a2a'
const EXTERNAL_TOKEN = 'ext-translate-bearer'
const TARGET_SKILL = 'external.translate'

/** A tiny deterministic glossary — the "external translation agent's" brain. */
const GLOSSARY: Record<string, string> = {
  hello: '你好',
  world: '世界',
  urgent: '紧急',
  contract: '合同',
  invoice: '发票',
  please: '请',
  review: '审阅',
}

/** Translate word-by-word; return null for any word the glossary can't handle. */
function translate(text: string): string | null {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  const out = words.map((w) => GLOSSARY[w.toLowerCase().replace(/[^a-z]/gi, '')])
  if (out.some((x) => x === undefined)) return null
  return out.join('')
}

/** What the simulated external agent actually received — for assertions. */
const externalSeen: Array<{ text: string; skill: unknown; bearer: string | undefined }> = []

const JSON_HEADERS = { 'content-type': 'application/json' }

/**
 * Injected fetch that stands in for the external A2A translation agent. Parses
 * the outbound `message/send`, asserts the wire shape, checks the bearer, and
 * replies with a translated A2A agent Message — or a JSON-RPC error it can't
 * translate. No socket: deterministic and offline.
 */
const externalA2aAgent: typeof fetch = async (_url, init) => {
  const req = JSON.parse(String(init?.body)) as A2ARequest
  const headers = (init?.headers ?? {}) as Record<string, string>
  const bearer = headers.authorization

  // Wire-contract smoke: the outbound must be a `message/send` JSON-RPC call.
  if (req.method !== A2A_METHOD_MESSAGE_SEND) {
    return jsonRpc(req.id, { error: { code: -32601, message: 'method not found' } })
  }
  // Auth: a generic A2A agent only needs the bearer (no X-Gotong-Peer-Id).
  if (bearer !== `Bearer ${EXTERNAL_TOKEN}`) {
    return new Response('unauthorized', { status: 401 })
  }

  const text = req.params.message.parts.map((p) => p.text).join('')
  const skill = req.params.message.metadata?.skill
  externalSeen.push({ text, skill, bearer })

  const translated = translate(text)
  if (translated === null) {
    // The external agent legitimately can't handle this input → JSON-RPC error.
    return jsonRpc(req.id, { error: { code: -32000, message: `unsupported input: ${text}` } })
  }
  return jsonRpc(req.id, { result: agentMessage(translated, 'ext-reply-1') })
}

function jsonRpc(id: string | number, body: Partial<A2AResponse>): Response {
  const envelope: A2AResponse = { jsonrpc: '2.0', id, ...body }
  return new Response(JSON.stringify(envelope), { status: 200, headers: JSON_HEADERS })
}

/** Local worker on this hub — files the translation the external agent returned. */
class ArchiveAgent {
  readonly kind = 'agent' as const
  readonly id = 'doc-archive' as ParticipantId
  readonly capabilities = ['docs.archive']
  readonly seen: Task[] = []
  async onTask(task: Task): Promise<TaskResult> {
    this.seen.push(task)
    const p = task.payload as { original?: string; translation?: string }
    return {
      kind: 'ok',
      taskId: task.id,
      by: this.id,
      ts: 1,
      output: { filed: p.original, translation: p.translation },
    }
  }
}

async function main(): Promise<void> {
  console.log('\n=== Gotong case: a2a-workflow-step — 外部 A2A agent 当工作流步 (Stream H) ===\n')

  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()

  section('[0] 注册参与者 + 载入工作流')
  // The outbound A2A edge: a LOCAL participant advertising `external.translate`.
  // Dispatching that capability routes here; it forwards over the A2A wire. The
  // injected fetch is the only thing standing in for a real external endpoint.
  const translator = new A2aRemoteParticipant({
    id: 'ext-translator' as ParticipantId,
    capabilities: [TARGET_SKILL],
    url: EXTERNAL_URL,
    token: EXTERNAL_TOKEN,
    targetSkill: TARGET_SKILL,
    fetchImpl: externalA2aAgent,
  })
  hub.register(translator)
  const archive = new ArchiveAgent()
  hub.register(archive) // local `archive` worker
  console.log(`  ext-translator  → 外部 A2A agent @ ${EXTERNAL_URL} (cap ${TARGET_SKILL}, 无审批闸)`)
  console.log(`  doc-archive     → 本地归档 (cap docs.archive)`)

  // Parsed by the REAL parseWorkflow (same one the template importer runs) — a
  // broken workflow YAML fails the demo loudly.
  const def = parseWorkflow(readFileSync(join(WORKFLOWS_DIR, 'translate-and-file.yaml'), 'utf8'))
  hub.register(new WorkflowRunner({ definition: def, hub }))
  console.log(`  ${def.id}  (trigger: ${def.trigger.capability}, ${def.steps.length} 步: ${def.steps.map((s) => s.id).join(' → ')})`)

  // --- [A] happy — the headline: external A2A step fires immediately -----------
  section('[A] 工作流跑到 `translate` 步 → 立即调外部 A2A agent → 回流 → 本地 `archive`')
  const fired = await hub.dispatch({
    from: 'doc-intake' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    payload: { text: 'hello world' },
    title: '翻译外文片段并归档',
  })
  // No approval gate ⇒ the run does NOT suspend; it completes in one shot.
  if (fired.kind !== 'ok') {
    throw new Error(`expected the run to COMPLETE immediately (no gate), got '${fired.kind}'`)
  }
  const out = okOutput(fired, 'happy run') as { filed?: string; translation?: string }
  console.log('  运行未挂起 (外部 A2A 步无审批闸, 一步到底)')
  console.log(`  外部 A2A agent 译文 (回流到本地步): translation=${out.translation}`)
  console.log(`  本地归档: filed=${out.filed}`)

  // --- [B] failure — external agent errors → step fails → run fails closed -----
  section('[B] 外部 A2A agent 报错 (无法处理的输入) → 步骤失败 → 工作流 fail-closed')
  const archivedBeforeFailure: number = archive.seen.length
  const fired2 = await hub.dispatch({
    from: 'doc-intake' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    payload: { text: '<<garbled>>' }, // no glossary words → external returns JSON-RPC error
    title: '外部 agent 无法翻译的输入',
  })
  console.log(`  外部 A2A agent 返回 JSON-RPC error → \`translate\` 步失败 → run.kind=${fired2.kind}`)

  // --- self-assertions (this demo doubles as a smoke test) ---------------------
  section('[verify]')
  assert(fired.kind === 'ok', 'external A2A step ran WITHOUT suspending (no approval gate — fires immediately)')
  assert(externalSeen.length === 2, 'the external A2A agent was reached over the wire (both runs called out)')
  assert(externalSeen[0]!.text === 'hello world', 'the workflow payload reached the external agent intact')
  assert(externalSeen[0]!.skill === TARGET_SKILL, 'the outbound carried metadata.skill = the target capability')
  assert(externalSeen[0]!.bearer === `Bearer ${EXTERNAL_TOKEN}`, 'the outbound presented the bearer token')
  assert(out.translation === '你好世界', "the external agent's reply flowed back into the local archive step")
  assert(archivedBeforeFailure === 1 && archive.seen.length === 1, 'archive ran once (happy) and NOT for the failed run')
  assert(fired2.kind === 'failed', 'a failed external A2A step fails the run closed (halt before archive)')
  console.log('  all checks passed.')

  await hub.stop()

  section('done')
  console.log('  工作流的一步可以调一个外部 A2A agent — 跟调本地能力同一套派发, 只是无审批闸、立即外发.\n')
  process.exit(0)
}

function okOutput(r: TaskResult, label: string): unknown {
  if (r.kind !== 'ok') throw new Error(`${label}: expected an 'ok' result, got '${r.kind}'`)
  return (r as { output: unknown }).output
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`)
  console.log(`  ✓ ${label}`)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
