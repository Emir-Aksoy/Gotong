/**
 * bar-ops — runnable demo of an ORGANIZATION hub template (the bar-flavored
 * sibling of cafe-ops).
 *
 * Same org mechanisms as cafe-ops — declarative workflows + surface.me member
 * self-service + human: manager approval (HITL) — but tuned to what a BAR
 * actually manages. The bar's signature difference from a café: **age-check /
 * liquor-license compliance is the legal high-voltage line**. So the headline
 * flow here isn't overtime pay — it's an **age-check incident review** (a
 * bartender refuses service to a suspected-underage patron → the duty manager
 * reviews → it's logged as a refusal record).
 *
 * What this demo proves end to end (deterministic, no API key):
 *
 *   [A] staff-onboarding    — a new hire picks a position (bartender / server /
 *                             security / cashier); the trainer returns that
 *                             position's SOP + norms (incl. the age-check red
 *                             line) from the bar manual. (self-service, no approval)
 *   [B] age-check incident  — a bartender files a refused-service incident; the
 *                             assistant drafts a review sheet; the workflow
 *                             SUSPENDS at a `human:` duty-manager gate; the
 *                             manager approves from their inbox; the run RESUMES
 *                             and the `record` step (when-gated on approval)
 *                             writes the compliance-log entry. (the headline HITL)
 *   [B2] late-night wage    — the same 4 hours pay differently by shift kind
 *                             (late-night ×1.5 / weekend ×2 / holiday ×3);
 *                             deterministic money math, owner still confirms.
 *
 * The worker capabilities are served here by deterministic stand-ins
 * (src/standins.ts). In the loadable template they are KB-backed LlmAgents on
 * DeepSeek + mcp-obsidian — same hub wiring, swap and nothing else changes.
 *
 * Run:  pnpm demo:bar-ops
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hub, InMemoryStorage, type ParticipantId, type Task, type TaskResult } from '@gotong/core'
import { FileInboxStore, HumanInboxParticipant, type InboxDecision } from '@gotong/inbox'
import { parseWorkflow, RunStore, WorkflowRunner, type RunState } from '@gotong/workflow'

import { BarComplianceStandin, BarOpsAssistantStandin, TrainBarPositionStandin } from './standins.js'

const WORKFLOWS_DIR = fileURLToPath(new URL('../workflows', import.meta.url))

/** In-memory stand-in for identity.suspended_tasks — what a parked task needs to resume. */
interface ParkedRow {
  agentId: ParticipantId
  state: unknown
  taskJson: string
}

async function main(): Promise<void> {
  console.log('\n=== Gotong case: bar-ops — an organization hub (酒吧运营) ===\n')

  // Fail-safe against a silent hang: default the exit code to 1 (an unexpectedly
  // unsettled await would let Node exit 0 on an empty event loop and read as a
  // false pass), and a watchdog force-exits if we ever stall. Same guard as
  // examples/framework-only-hub. Both are cleared on the real success path below.
  process.exitCode = 1
  const watchdog = setTimeout(() => {
    console.error('bar-ops demo: watchdog timeout (30s) — something stalled')
    process.exit(1)
  }, 30_000)
  watchdog.unref?.()

  const tmp = mkdtempSync(join(tmpdir(), 'gotong-bar-ops-'))
  const parked = new Map<string, ParkedRow>()
  const inbox = new FileInboxStore(tmp)
  inbox.ensureDirs()

  // A real RunStore — the same one a production host injects. Wiring it here is
  // what makes the "每次运行都留运行记录" claim demonstrable: the runner persists
  // RunState (incl. a `record` step marked `skipped` on a rejected age-incident)
  // to <tmp>/workflows/runs/, and the [persist] check below reads it back off disk.
  const runStore = new RunStore(tmp)
  runStore.ensureDirs()

  // A real host parks suspended tasks in identity.suspended_tasks and a sweep
  // (or an inbox resolve) wakes them. The demo records them in `parked` and
  // wakes them by hand below — same mechanism, visible in ~30 lines.
  const hub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, by, s) => {
      parked.set(task.id, { agentId: by, state: s.state, taskJson: JSON.stringify(task) })
    },
  })
  await hub.start()

  // The human-inbox broker (serves `gotong.human/v1`) + the deterministic
  // worker stand-ins (serve bar.train-position / late-night-wage / age-incident-review).
  hub.register(new HumanInboxParticipant({ store: inbox }))
  hub.register(new TrainBarPositionStandin())
  hub.register(new BarOpsAssistantStandin())
  hub.register(new BarComplianceStandin())

  // Load + register the two declarative workflows the demo exercises — parsed by
  // the REAL parseWorkflow (the same one the template importer runs), so a broken
  // workflow YAML fails the demo loudly. (The template ships all six.)
  section('[0] load the declarative workflows (real parseWorkflow)')
  for (const file of ['staff-onboarding.yaml', 'age-incident.yaml']) {
    const def = parseWorkflow(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'))
    hub.register(new WorkflowRunner({ definition: def, hub, runStore }))
    console.log(`  ${def.id}  (trigger: ${def.trigger.capability}, ${def.steps.length} step(s))`)
  }

  // --- [A] staff onboarding — member self-service, no approval ----------------
  section('[A] 新员工岗位上手 (surface.me 自助, 无审批)')
  const onboard = await hub.dispatch({
    from: 'u-newhire' as ParticipantId,
    strategy: { kind: 'capability', capabilities: ['bar.onboard-staff'] },
    // /me would force payload[trainee_id]=the member's own userId; we pass it directly.
    payload: { position: 'bartender', question: '吧台第一晚最容易踩的红线是什么?', trainee_id: 'u-newhire' },
    title: '新员工岗位上手',
  })
  const onboardOut = okOutput(onboard, 'onboarding') as {
    position: string
    walkthrough: { positionTitle: string; operations: string[]; norms: string[]; answeredQuestion?: string }
  }
  console.log(`  新人选了岗位: ${onboardOut.position} → ${onboardOut.walkthrough.positionTitle}`)
  console.log(`  操作 SOP: ${onboardOut.walkthrough.operations.join(' / ')}`)
  console.log(`  必学规范: ${onboardOut.walkthrough.norms.join(' / ')}`)
  if (onboardOut.walkthrough.answeredQuestion) console.log(`  答疑: ${onboardOut.walkthrough.answeredQuestion}`)

  // --- [B] age-check incident — the HITL headline: suspend → approve → resume -
  section('[B] 年龄核查事件上报 + 值班经理复核 (human: HITL — 挂起 → 经理复核 → 写正式拒售条目)')
  const incidentFired = await hub.dispatch({
    from: 'u-bartender' as ParticipantId,
    strategy: { kind: 'capability', capabilities: ['bar.report-age-incident'] },
    payload: {
      occurred_at: '2026-06-06 23:40',
      station: 'bartender',
      detail: '一位顾客点威士忌, 看着很年轻; 要求出示证件, 出示的身份证照片与本人差异明显, 已拒售并知会安保。',
      reviewer_id: 'u-duty-manager',
      reporter_id: 'u-bartender',
    },
    title: '年龄核查事件上报',
  })
  if (incidentFired.kind !== 'suspended') {
    throw new Error(`age-incident: expected the run to SUSPEND at the manager gate, got '${incidentFired.kind}'`)
  }
  console.log('  调酒师上报拒售事件 → 工作流跑到值班经理复核步骤, 挂起等人 (不是失败, 是 parked)')

  // The duty manager opens their /me inbox and sees one pending approval.
  const pending = await inbox.listPending('u-duty-manager')
  if (pending.length !== 1 || pending[0]!.kind !== 'approval') {
    throw new Error(`age-incident: expected 1 pending approval for the duty manager, got ${pending.length}`)
  }
  const item = pending[0]!
  console.log(`  值班经理 /me 收件箱: 1 条待办 [${item.kind}] "${item.title ?? item.prompt}"`)

  // Manager confirms → two-step resume (child broker before parent workflow).
  const result = await resolveHumanStep(hub, inbox, parked, item.itemId, {
    kind: 'approval',
    approved: true,
  })
  const incOut = okOutput(result, 'age-incident resume') as {
    review: { keywordScan: { mentionsIdCheck: boolean; mentionsRefusal: boolean; mentionsEscalation: boolean } }
    approval: { approved: boolean }
    record?: { logEntry?: string; reviewedSummaryReceived?: boolean }
  }
  const scan = incOut.review.keywordScan
  console.log('  经理复核确认 → 工作流恢复, record 步 (when 门控在批准上) 写一条正式拒售条目。')
  console.log(`  关键词初筛(仅提示, 非核实): 证件=${scan.mentionsIdCheck} 拒售=${scan.mentionsRefusal} 报安保=${scan.mentionsEscalation}`)
  console.log(`  正式拒售条目: ${incOut.record?.logEntry ?? '(未记录)'}`)

  // --- [B-reject] the record is when-gated: a rejected review writes NO record -
  // The compliance red line's other half. A duty manager who judges a report a
  // NON-incident (误报) rejects it; the `record` step is `when`-gated on approval,
  // so it must be SKIPPED — no formal refusal entry is written (the run itself is
  // still recorded, the record step marked skipped). Proving "不确认就不写正式拒售
  // 条目" is what makes this a governance flow, not a rubber stamp.
  section('[B-reject] 经理判定非正式事件 → 拒绝 → record 被跳过 (不写正式拒售条目)')
  const incident2 = await hub.dispatch({
    from: 'u-bartender' as ParticipantId,
    strategy: { kind: 'capability', capabilities: ['bar.report-age-incident'] },
    payload: {
      occurred_at: '2026-06-07 21:10',
      station: 'server',
      detail: '顾客点了一杯啤酒, 同事一时觉得年轻, 核对证件后确认已成年 —— 事后觉得可能是误报, 想上报留痕。',
      reviewer_id: 'u-duty-manager',
      reporter_id: 'u-server',
    },
    title: '年龄核查事件上报 (疑似误报)',
  })
  if (incident2.kind !== 'suspended') {
    throw new Error(`age-incident(reject): expected SUSPEND at the manager gate, got '${incident2.kind}'`)
  }
  const pending2 = await inbox.listPending('u-duty-manager')
  if (pending2.length !== 1) {
    throw new Error(`age-incident(reject): expected 1 pending approval, got ${pending2.length}`)
  }
  const rejected = await resolveHumanStep(hub, inbox, parked, pending2[0]!.itemId, {
    kind: 'approval',
    approved: false,
  })
  const rejOut = okOutput(rejected, 'age-incident reject resume') as {
    approval: { approved: boolean }
    record?: { logEntry?: string }
  }
  console.log('  经理判定误报 → 拒绝 → 工作流恢复(run 不中断), record 步被 when 门控跳过。')
  console.log(`  approval.approved=${rejOut.approval.approved} · record=${rejOut.record ? '(意外存在!)' : '(未记录, 正确)'}`)

  // --- [persist] the on-disk run records prove the run-record vs formal-entry split
  // The reframe's core claim, demonstrated against the REAL RunStore (not narrated):
  // EVERY age-incident run persists a RunState to <tmp>/workflows/runs/. The APPROVED
  // run has its `record` step status='done' (a formal refusal entry was written); the
  // REJECTED run has `record` status='skipped' — the run itself is STILL recorded as
  // an audit trail, it just carries no formal refusal entry.
  section('[persist] 落盘运行记录 — 拒绝的运行也留痕, 只是 record 步记 skipped')
  const incidentRuns: RunState[] = []
  for (const runId of await runStore.listRunIds()) {
    const st = await runStore.read(runId)
    if (st?.workflowId === 'bar-age-incident') incidentRuns.push(st)
  }
  const recordStepStatus = (st: RunState): string | undefined =>
    st.steps.find((s) => s.stepId === 'record')?.status
  const approvalOf = (st: RunState): boolean | undefined =>
    (st.finalOutput as { approval?: { approved?: boolean } })?.approval?.approved
  const approvedRun = incidentRuns.find((st) => approvalOf(st) === true)
  const rejectedRun = incidentRuns.find((st) => approvalOf(st) === false)
  console.log(`  bar-age-incident 落盘运行数: ${incidentRuns.length} (批准 1 + 拒绝 1)`)
  console.log(`  批准运行 record 步: ${approvedRun ? recordStepStatus(approvedRun) : '(缺)'} (写了正式拒售条目)`)
  console.log(`  拒绝运行 record 步: ${rejectedRun ? recordStepStatus(rejectedRun) : '(缺)'} (运行仍留痕, 未写正式条目)`)

  // --- [B2] the wage multiplier adapts to the shift kind (结合班次) ------------
  // Same 4 late shift hours, three shift kinds → three recommendations. The worker
  // serves bar.late-night-wage; we probe its compute branch directly with a single
  // shift (the assertable path). Money stays deterministic; owner still confirms.
  section('[B2] 同样 4 小时, 不同班次 → 不同倍率 (深夜薪结合班次算)')
  const shiftCases = [
    { shiftKind: 'late-night', multiplier: 1.5, amount: 150 }, // 4 × ¥25 × 1.5
    { shiftKind: 'weekend', multiplier: 2.0, amount: 200 }, // 4 × ¥25 × 2
    { shiftKind: 'holiday', multiplier: 3.0, amount: 300 }, // 4 × ¥25 × 3
  ] as const
  for (const c of shiftCases) {
    const r = await hub.dispatch({
      from: 'u-owner' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['bar.late-night-wage'] },
      payload: { step: 'compute', hours: 4, shift_kind: c.shiftKind },
      title: `深夜薪核算 (${c.shiftKind})`,
    })
    const o = okOutput(r, `wage ${c.shiftKind}`) as { shiftLabel: string; multiplier: number; suggestedAmount: number }
    console.log(`  ${o.shiftLabel}: ×${o.multiplier} → 建议 ¥${o.suggestedAmount}`)
    // Pin BOTH the multiplier (situational, per shift) and the amount — so a
    // policy table edit that changes the rate can't leave a stale amount green.
    assert(o.multiplier === c.multiplier, `${c.shiftKind} multiplier ×${c.multiplier}`)
    assert(o.suggestedAmount === c.amount, `4h on ${c.shiftKind} → ¥${c.amount}`)
  }

  // --- self-assertions (this demo doubles as a smoke test) --------------------
  section('[verify]')
  assert(onboard.kind === 'ok', 'onboarding completed ok')
  assert(onboardOut.walkthrough.positionTitle === '调酒师 (吧台)', 'trainer returned the bartender SOP')
  assert(
    onboardOut.walkthrough.norms.some((n) => n.includes('年龄核查')),
    'trainer surfaced the age-check red line for the bartender',
  )
  assert(incidentFired.kind === 'suspended', 'age-incident suspended at the human gate')
  assert(result.kind === 'ok', 'age-incident resumed to completion after review')
  assert(
    incOut.review.keywordScan.mentionsRefusal === true,
    'the keyword prefilter flags a refusal mentioned in the report',
  )
  assert(incOut.approval.approved === true, "the duty manager's confirmation flowed into the output")
  assert(
    typeof incOut.record?.logEntry === 'string' && incOut.record.logEntry.includes('拒售记录'),
    'the record step wrote a refusal-of-service log entry (because approved)',
  )
  assert(
    incOut.record?.reviewedSummaryReceived === true,
    "record received the review sheet via ref ($review.output.text wired through)",
  )
  // [B-reject]: rejection is a real governance outcome, not an error — the run
  // completes ok, but the when-gated record is skipped, so NO formal refusal entry
  // is written (the run itself is still recorded, the record step marked skipped).
  assert(rejected.kind === 'ok', 'a rejected age-incident still resumes to a clean completion')
  assert(rejOut.approval.approved === false, 'the rejection is recorded as approved=false')
  assert(rejOut.record === undefined, 'the when-gated record step was SKIPPED (不确认就不写正式拒售条目)')
  const stillPending = await inbox.listPending('u-duty-manager')
  assert(stillPending.length === 0, 'both inbox items are resolved, none pending')
  assert(parked.size === 0, 'no task left parked — every suspend was resumed')
  // [persist]: both age-incident runs are on disk (a rejected run is STILL recorded
  // as an audit trail) — the approve run's `record` step is 'done' (formal refusal
  // entry written), the reject run's is 'skipped'. This is what "每次运行都留运行记录,
  // 只是拒绝的运行不写正式拒售条目" means on disk, read back off the real RunStore.
  assert(incidentRuns.length === 2, 'both age-incident runs persisted a RunState (approve + reject)')
  // Both runs reach a clean terminal `done` on disk — including the rejected one,
  // which is the whole point ("run 不中断"). Pin the run status too so a future
  // terminal-write drift can't leave the record-step asserts stale-green.
  assert(approvedRun?.status === 'done', 'approved run: reached terminal done on disk')
  assert(rejectedRun?.status === 'done', 'rejected run: still reached terminal done on disk (run not halted)')
  assert(
    recordStepStatus(approvedRun!) === 'done',
    'approved run: record step done on disk (formal refusal entry written)',
  )
  assert(
    recordStepStatus(rejectedRun!) === 'skipped',
    'rejected run: record step SKIPPED on disk, yet the run itself is still recorded',
  )
  console.log('  all checks passed.')

  // Clear the watchdog AFTER the async teardown — a hung hub.stop() (its awaits free
  // the event loop) should still trip the 30s force-exit rather than hang silently.
  // The synchronous rmSync isn't what the watchdog guards (it can't fire mid-rmSync);
  // it's here so a normal exit clears the timer before the final process.exit(0).
  await hub.stop()
  rmSync(tmp, { recursive: true, force: true })
  clearTimeout(watchdog)

  section('done')
  console.log('  Declarative workflows + surface.me + human: approval — a bar runs on this too.\n')
  process.exit(0)
}

/**
 * Resolve a parked `human:` step and resume — the two-step pattern from
 * `HostInboxService.resolve` (host/src/inbox-service.ts), hand-rolled here so
 * the mechanism is visible. The three invariants that keep it correct:
 *   1. flip pending→resolved FIRST (race guard) — a repeat resolve can't double-wake.
 *   2. resume the CHILD broker before the PARENT workflow — until the child
 *      resumes, the parent's lookup of the child result is still `suspended`.
 *   3. only drop the parent row when it actually finished (it could re-suspend
 *      on another human step).
 */
async function resolveHumanStep(
  hub: Hub,
  store: FileInboxStore,
  parked: Map<string, ParkedRow>,
  itemId: string,
  decision: InboxDecision,
): Promise<TaskResult> {
  const item = await store.get(itemId)
  if (!item) throw new Error(`inbox item '${itemId}' not found`)

  // (1) race guard — pending → resolved before any resume.
  await store.markResolved(itemId, decision)

  // (2) resume the CHILD broker with the decision as its answer.
  const childRow = parked.get(itemId)
  if (!childRow) throw new Error('child broker task was not parked')
  const childTask = JSON.parse(childRow.taskJson) as Task
  await hub.resumeTask(childRow.agentId, childTask, { answer: decision })
  parked.delete(itemId)

  // (3) resume the PARENT workflow run (child strictly before parent).
  if (item.parentKind !== 'workflow' || !item.parent) {
    throw new Error('expected a workflow parent for this demo step')
  }
  const parentRow = parked.get(item.parent.taskId)
  if (!parentRow) throw new Error('parent workflow task was not parked')
  if (parentRow.agentId !== item.parent.by) {
    throw new Error(`parent agent mismatch: ${parentRow.agentId} !== ${item.parent.by}`)
  }
  const parentTask = JSON.parse(parentRow.taskJson) as Task
  const result = await hub.resumeTask(item.parent.by, parentTask, parentRow.state)
  if (result.kind !== 'suspended') parked.delete(item.parent.taskId)
  return result
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
