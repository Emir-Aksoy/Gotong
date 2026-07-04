/**
 * a2a-long-running-step — runnable demo of a LONG-RUNNING external A2A agent as
 * a workflow step.
 *
 * The sibling of examples/a2a-workflow-step. Both put an external A2A agent in
 * the middle of a declarative workflow, but the remote's TIMING differs:
 *
 *   - a2a-workflow-step (BLOCKING): the external agent answers `message/send` in
 *     one round-trip. The run never parks — it completes in one shot.
 *   - THIS demo (LONG-RUNNING): the external agent SUSPENDS — it answers
 *     `message/send` with a `working` Task (long compute, or its own HITL). The
 *     workflow run PARKS, polls `tasks/get` until the remote settles, then feeds
 *     the verdict into the next step.
 *
 * The whole point of Stream H2: this is AUTOMATIC, with NO host/runner/YAML
 * change. The lifecycle `A2aRemoteParticipant` (opt-in `lifecycle`) parks the
 * review sub-task with a FINITE `resumeAt` — so the run inherits a sweep-eligible
 * resumeAt and the ordinary suspend/resume sweep drives it to convergence. (That
 * finite resumeAt is the contrast with an outbound APPROVAL gate, which parks
 * with NEVER_RESUME_AT and waits for a human in the inbox.) A workflow step
 * `{kind: capability, capabilities: [external.review]}` routes to it like any
 * other — "long-running external agent" is invisible to the workflow author.
 *
 * What this demo proves end to end (deterministic, no API key, no socket):
 *
 *   [A] the run dispatches `external.review`; the remote SUSPENDS → the step
 *       parks → the whole run parks. TWO rows park (the lifecycle child AND the
 *       run), BOTH with a finite resumeAt (sweep-eligible, not NEVER).
 *   [B] an inlined sweep loop (mirroring the host's resume sweep) wakes the
 *       parked rows: the child polls `tasks/get` — still `working` → it re-parks;
 *       the run re-polls the child → re-parks. No premature downstream run.
 *   [C] the remote settles (`completed`); the next sweep folds the verdict into
 *       the run, which runs the local `archive` step; the run finishes ok.
 *
 * The "external long-running A2A agent" is modelled by an injected `fetchImpl`
 * (the same trick the @gotong/a2a unit tests use): `message/send` → a `working`
 * Task; each `tasks/get` advances an internal poll counter and only returns
 * `completed` once it crosses a threshold — modelling remote compute that takes
 * time. The real host reaches a real endpoint over `global fetch`; the
 * acceptance gate host/tests/a2a-long-running-step-e2e.test.ts runs the same
 * flow against a real loopback A2A server + a real suspend/resume sweep.
 *
 * Run:  pnpm demo:a2a-long-running-step
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Hub,
  InMemoryStorage,
  type ParticipantId,
  type Task,
  type TaskResult,
} from '@gotong/core'
import {
  A2A_ERROR,
  A2A_METHOD_MESSAGE_SEND,
  A2A_METHOD_TASKS_GET,
  A2aRemoteParticipant,
  completedTask,
  workingTask,
  type A2ARequest,
  type A2AResponse,
  type A2ATasksGetRequest,
} from '@gotong/a2a'
import { parseWorkflow, workflowParticipantId, WorkflowRunner } from '@gotong/workflow'

const WORKFLOWS_DIR = fileURLToPath(new URL('../workflows', import.meta.url))

// The external A2A agent's endpoint + bearer. In production these live in the
// host's a2a_outbound_agents config (url + token-from-env); here they're
// constants the injected fetch checks so the demo is a real auth round-trip.
const EXTERNAL_URL = 'https://review-svc.example/a2a'
const EXTERNAL_TOKEN = 'ext-review-bearer'
const TARGET_SKILL = 'external.review'

// How many `tasks/get` polls the remote needs before it settles — i.e. how long
// the remote "compute / HITL" takes. >1 so the demo actually exercises a re-park.
const POLLS_UNTIL_DONE = 2

/** The external review service's deterministic verdict — its "brain". */
function reviewVerdict(text: string): string {
  const t = text.toLowerCase()
  if (t.includes('urgent') || t.includes('breach')) return 'PRIORITY'
  if (t.includes('refund')) return 'ESCALATE'
  return 'ROUTINE'
}

const JSON_HEADERS = { 'content-type': 'application/json' }

// --- the simulated external LONG-RUNNING A2A agent ---------------------------
// Tracks per-task poll counts so it can return `working` for a while, then
// `completed` — modelling remote compute that doesn't finish in one round-trip.
const remoteTasks = new Map<string, { text: string; polls: number }>()
let nextRemoteTaskId = 1
let externalSends = 0
let externalPolls = 0
/** What the external agent received on `message/send` — for assertions. */
const externalSeen: Array<{ text: string; skill: unknown; bearer: string | undefined }> = []

/**
 * Injected fetch standing in for the external A2A review agent. On `message/send`
 * it SUSPENDS (returns a `working` Task with an opaque id). On each `tasks/get`
 * it advances that task's poll counter and only returns `completed` once it
 * crosses POLLS_UNTIL_DONE. No socket: deterministic and offline.
 */
const externalLongReviewAgent: typeof fetch = async (_url, init) => {
  const req = JSON.parse(String(init?.body)) as A2ARequest | A2ATasksGetRequest
  const reqId = req.id // captured before the method narrowing exhausts the union
  const headers = (init?.headers ?? {}) as Record<string, string>
  const bearer = headers.authorization

  // Auth: a generic external A2A agent only needs the bearer.
  if (bearer !== `Bearer ${EXTERNAL_TOKEN}`) {
    return new Response('unauthorized', { status: 401 })
  }

  if (req.method === A2A_METHOD_MESSAGE_SEND) {
    externalSends++
    const send = req as A2ARequest
    const text = send.params.message.parts.map((p) => p.text).join('')
    const skill = send.params.message.metadata?.skill
    externalSeen.push({ text, skill, bearer })
    const id = `ext-review-${nextRemoteTaskId++}`
    remoteTasks.set(id, { text, polls: 0 })
    // The remote SUSPENDS: a `working` Task, not an immediate Message.
    return jsonRpc(send.id, { result: workingTask(id) })
  }

  if (req.method === A2A_METHOD_TASKS_GET) {
    externalPolls++
    const get = req as A2ATasksGetRequest
    const entry = remoteTasks.get(get.params.id)
    if (!entry) {
      return jsonRpc(get.id, { error: { code: A2A_ERROR.TASK_NOT_FOUND, message: 'unknown task' } })
    }
    entry.polls++
    if (entry.polls >= POLLS_UNTIL_DONE) {
      return jsonRpc(get.id, {
        result: completedTask(get.params.id, `reviewed → ${reviewVerdict(entry.text)}`, 'ext-reply-1'),
      })
    }
    return jsonRpc(get.id, { result: workingTask(get.params.id) }) // still computing
  }

  return jsonRpc(reqId, { error: { code: A2A_ERROR.METHOD_NOT_FOUND, message: 'method not found' } })
}

function jsonRpc(id: string | number, body: Partial<A2AResponse>): Response {
  const envelope: A2AResponse = { jsonrpc: '2.0', id, ...body }
  return new Response(JSON.stringify(envelope), { status: 200, headers: JSON_HEADERS })
}

/** Local worker on this hub — files the verdict the external agent returned. */
class ArchiveAgent {
  readonly kind = 'agent' as const
  readonly id = 'doc-archive' as ParticipantId
  readonly capabilities = ['docs.archive']
  readonly seen: Task[] = []
  async onTask(task: Task): Promise<TaskResult> {
    this.seen.push(task)
    const p = task.payload as { original?: string; verdict?: string }
    return { kind: 'ok', taskId: task.id, by: this.id, ts: 1, output: { filed: p.original, verdict: p.verdict } }
  }
}

/** A parked row, captured exactly as the host's SQLite suspendNotifier captures it. */
interface Parked {
  taskId: string
  task: Task
  by: ParticipantId
  state: unknown
  resumeAt: number
}

const NEVER = 9_999_999_999_000

async function main(): Promise<void> {
  console.log('\n=== Gotong case: a2a-long-running-step — 长任务外部 A2A agent 当工作流步 (Stream H2) ===\n')

  // Latest park per task id (run + lifecycle child), survives re-parks — exactly
  // how the host's SQLite-backed suspendNotifier captures parked tasks.
  const parked = new Map<string, Parked>()
  const hub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, by, s) => {
      parked.set(task.id, { taskId: task.id, task, by, state: s.state, resumeAt: s.resumeAt })
    },
  })
  await hub.start()

  section('[0] 注册参与者 + 载入工作流')
  // The outbound A2A edge with `lifecycle` opted IN: when the remote suspends,
  // THIS participant parks + polls `tasks/get` instead of failing. Without
  // `lifecycle` a returned Task would be a hard failure (the blocking sibling).
  const reviewer = new A2aRemoteParticipant({
    id: 'ext-reviewer' as ParticipantId,
    capabilities: [TARGET_SKILL],
    url: EXTERNAL_URL,
    token: EXTERNAL_TOKEN,
    targetSkill: TARGET_SKILL,
    lifecycle: { pollIntervalMs: 500, maxAttempts: 10 },
    now: () => 1_000_000, // deterministic resumeAt; the sweep below is driven manually
    fetchImpl: externalLongReviewAgent,
  })
  hub.register(reviewer)
  const archive = new ArchiveAgent()
  hub.register(archive)
  console.log(`  ext-reviewer  → 外部长任务 A2A agent @ ${EXTERNAL_URL} (cap ${TARGET_SKILL}, lifecycle 轮询)`)
  console.log(`  doc-archive   → 本地归档 (cap docs.archive)`)

  // Parsed by the REAL parseWorkflow — a broken workflow YAML fails the demo.
  const def = parseWorkflow(readFileSync(join(WORKFLOWS_DIR, 'review-and-file.yaml'), 'utf8'))
  hub.register(new WorkflowRunner({ definition: def, hub }))
  const runPid = workflowParticipantId(def.id)
  console.log(`  ${def.id}  (trigger: ${def.trigger.capability}, ${def.steps.length} 步: ${def.steps.map((s) => s.id).join(' → ')})`)

  /**
   * One sweep tick over the parked rows: resume each; drop those that settle.
   * Returns the RUN's terminal result if it finished this tick (so `main`'s own
   * flow holds it — closure-mutated state would narrow to `never` under CFA).
   */
  async function sweepOnce(): Promise<TaskResult | null> {
    let runDone: TaskResult | null = null
    for (const row of [...parked.values()]) {
      const result = await hub.resumeTask(row.by, row.task, row.state)
      // A re-park already overwrote this id via the notifier; only terminal
      // outcomes are removed. Mirrors the host sweep's INSERT-OR-REPLACE rule.
      if (result.kind !== 'suspended') parked.delete(row.taskId)
      if (row.by === runPid && result.kind !== 'suspended') runDone = result
    }
    return runDone
  }
  let runResult: TaskResult | null = null

  // --- [A] fire the trigger → the remote suspends → the whole run parks --------
  section('[A] 跑到 `review` 步 → 外部 agent 挂起 (working Task) → 整个 run 挂起')
  const fired = await hub.dispatch({
    from: 'doc-intake' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [def.trigger.capability] },
    payload: { text: 'please review the urgent breach clause' },
    title: '审阅一段需要时间的外文条款',
  })
  if (fired.kind !== 'suspended') {
    throw new Error(`expected the run to PARK (remote suspended), got '${fired.kind}'`)
  }
  const childPark = [...parked.values()].find((p) => p.by === 'ext-reviewer')
  const runPark = [...parked.values()].find((p) => p.by === runPid)
  console.log(`  运行已挂起 (run.kind=${fired.kind}); 挂起行 ${parked.size} 个: 子任务(轮询) + run`)
  console.log(`  子任务 resumeAt=${childPark?.resumeAt} (有限值, 可被 sweep 唤醒, 非 NEVER=${NEVER})`)
  console.log(`  run     resumeAt=${runPark?.resumeAt} (继承子任务的有限值 → 整个 run 可被 sweep)`)

  // --- [B] sweep while the remote is still computing → re-park, no progress ----
  section('[B] sweep 唤醒 → 子任务轮询 `tasks/get` (仍 working) → 再挂起; run 再挂起')
  runResult = (await sweepOnce()) ?? runResult
  console.log(`  第 1 拍后: 外部被轮询 ${externalPolls} 次; 仍有 ${parked.size} 个挂起行; 归档 ${archive.seen.length} 次 (未跑)`)

  // --- [C] keep sweeping → remote settles → verdict folds in → archive runs ----
  section('[C] 继续 sweep → 外部 settle (completed) → 裁决回流 → 本地 `archive` 跑')
  for (let i = 0; i < 10 && parked.size > 0; i++) {
    runResult = (await sweepOnce()) ?? runResult
  }
  const out =
    runResult?.kind === 'ok'
      ? ((runResult as { output: unknown }).output as { filed?: string; verdict?: string })
      : null
  console.log(`  外部共被轮询 ${externalPolls} 次后 settle; run 完成 (kind=${runResult?.kind})`)
  console.log(`  外部 A2A 裁决 (回流到本地步): verdict=${out?.verdict}`)
  console.log(`  本地归档: filed=${out?.filed}`)

  // --- self-assertions (this demo doubles as a smoke test) ---------------------
  section('[verify]')
  assert(fired.kind === 'suspended', 'a suspending remote PARKS the whole run (not a one-shot complete)')
  assert(childPark !== undefined && runPark !== undefined, 'TWO rows parked: the lifecycle child sub-task AND the run')
  assert(
    (childPark?.resumeAt ?? NEVER) < NEVER && (runPark?.resumeAt ?? NEVER) < NEVER,
    'BOTH parked rows carry a FINITE resumeAt — sweep-eligible (the H2 enabler), not NEVER_RESUME_AT',
  )
  assert(externalSends === 1, 'the external agent was reached once over the message/send wire')
  assert(externalSeen[0]!.text === 'please review the urgent breach clause', 'the workflow payload reached the external agent intact')
  assert(externalSeen[0]!.skill === TARGET_SKILL, 'the outbound carried metadata.skill = the target capability')
  assert(externalPolls >= POLLS_UNTIL_DONE, 'the remote was POLLED via tasks/get until it settled (the lifecycle loop ran)')
  assert(runResult?.kind === 'ok', 'the run completed once the remote settled')
  assert(out?.verdict === 'reviewed → PRIORITY', "the external agent's async verdict flowed back into the local archive step")
  assert(archive.seen.length === 1, 'the downstream local step ran exactly once — only AFTER the remote settled')
  assert(parked.size === 0, 'both parked rows drained — the run and its child reached terminal outcomes')
  console.log('  all checks passed.')

  await hub.stop()

  section('done')
  console.log('  工作流的一步可以调一个会挂起的外部 A2A agent — runner/YAML 零改: 子任务挂起带有限 resumeAt,')
  console.log('  整个 run 继承它被 sweep 唤醒, 轮询 tasks/get 直到 settle, 再把结果喂给下一步.\n')
  process.exit(0)
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
