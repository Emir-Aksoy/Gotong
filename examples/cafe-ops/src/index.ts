/**
 * cafe-ops — runnable demo of an ORGANIZATION hub template.
 *
 * Unlike the three personal hubs (coding / research / battle-monk, whose
 * orchestration is a runtime DispatchToolset so their templates carry
 * `workflows: []`), an organization's value is in its FORMAL PROCESSES. So this
 * case finally fills the template's `workflows[]` block with **declarative
 * workflows** and wires up the two org capabilities they lean on:
 *
 *   - surface.me  (Phase 14) — a workflow a member runs for themselves from /me
 *   - human:      (Phase 16) — a step that PARKS until a manager approves it
 *
 * What this demo proves end to end (deterministic, no API key):
 *
 *   [A] staff-onboarding   — a new hire picks a position; the trainer returns
 *                            that position's SOP + norms from the ops manual.
 *                            (member self-service, no approval)
 *   [B] overtime-claim     — a staffer files overtime; the assistant suggests an
 *                            amount per policy; the workflow SUSPENDS at a
 *                            `human:` manager-approval gate; the manager approves
 *                            from their inbox; the run RESUMES and completes.
 *                            (the headline HITL flow — "manage overtime pay")
 *
 * The worker capabilities are served here by deterministic stand-ins
 * (src/standins.ts). In the loadable template they are KB-backed LlmAgents on
 * DeepSeek + mcp-obsidian — same hub wiring, swap and nothing else changes.
 *
 * Run:  pnpm demo:cafe-ops
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hub, InMemoryStorage, type ParticipantId, type Task, type TaskResult } from '@gotong/core'
import { FileInboxStore, HumanInboxParticipant, type InboxDecision } from '@gotong/inbox'
import { parseWorkflow, WorkflowRunner } from '@gotong/workflow'

import { OvertimePolicyStandin, TrainPositionStandin } from './standins.js'

const WORKFLOWS_DIR = fileURLToPath(new URL('../workflows', import.meta.url))

/** In-memory stand-in for identity.suspended_tasks — what a parked task needs to resume. */
interface ParkedRow {
  agentId: ParticipantId
  state: unknown
  taskJson: string
}

async function main(): Promise<void> {
  console.log('\n=== Gotong case: cafe-ops — an organization hub (奶茶 / 咖啡店门店运营) ===\n')

  const tmp = mkdtempSync(join(tmpdir(), 'gotong-cafe-ops-'))
  const parked = new Map<string, ParkedRow>()
  const inbox = new FileInboxStore(tmp)
  inbox.ensureDirs()

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
  // worker stand-ins (serve cafe.train-position / overtime-policy / schedule-draft).
  hub.register(new HumanInboxParticipant({ store: inbox }))
  hub.register(new TrainPositionStandin())
  hub.register(new OvertimePolicyStandin())

  // Load + register the three declarative workflows — parsed by the REAL
  // parseWorkflow (the same one the template importer runs), so a broken
  // workflow YAML fails the demo loudly.
  section('[0] load the declarative workflows (real parseWorkflow)')
  for (const file of ['staff-onboarding.yaml', 'overtime-claim.yaml', 'shift-availability.yaml']) {
    const def = parseWorkflow(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'))
    hub.register(new WorkflowRunner({ definition: def, hub }))
    console.log(`  ${def.id}  (trigger: ${def.trigger.capability}, ${def.steps.length} step(s))`)
  }

  // --- [A] staff onboarding — member self-service, no approval ----------------
  section('[A] 新员工岗位上手 (surface.me 自助, 无审批)')
  const onboard = await hub.dispatch({
    from: 'u-newhire' as ParticipantId,
    strategy: { kind: 'capability', capabilities: ['cafe.onboard-staff'] },
    // /me would force payload[trainee_id]=the member's own userId; we pass it directly.
    payload: { position: 'barista', question: '吧台第一天最容易出错的是什么?', trainee_id: 'u-newhire' },
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

  // --- [B] overtime claim — the HITL headline: suspend → approve → resume -----
  section('[B] 加班申报 + 店长审批 (human: HITL — 挂起 → 店长批 → 恢复)')
  const otFired = await hub.dispatch({
    from: 'u-staff' as ParticipantId,
    strategy: { kind: 'capability', capabilities: ['cafe.claim-overtime'] },
    payload: {
      date: '2026-06-02',
      hours: 3,
      day_kind: 'rest-day', // 周末顶班 = 休息日 → 2 倍 (结合使用者的情况, 不是固定 1.5)
      reason: '周末高峰顶班',
      manager_id: 'u-manager',
      staff_id: 'u-staff',
    },
    title: '加班申报',
  })
  if (otFired.kind !== 'suspended') {
    throw new Error(`overtime: expected the run to SUSPEND at the manager gate, got '${otFired.kind}'`)
  }
  console.log('  店员提交加班 → 工作流跑到店长审批步骤, 挂起等人 (不是失败, 是 parked)')

  // The manager opens their /me inbox and sees one pending approval.
  const pending = await inbox.listPending('u-manager')
  if (pending.length !== 1 || pending[0]!.kind !== 'approval') {
    throw new Error(`overtime: expected 1 pending approval for the manager, got ${pending.length}`)
  }
  const item = pending[0]!
  console.log(`  店长 /me 收件箱: 1 条待办 [${item.kind}] "${item.title ?? item.prompt}"`)

  // Manager approves → two-step resume (child broker before parent workflow).
  const result = await resolveHumanStep(hub, inbox, parked, item.itemId, {
    kind: 'approval',
    approved: true,
  })
  const otOut = okOutput(result, 'overtime resume') as {
    hours: number
    suggestion: { suggestedAmount: number; note: string; dayLabel: string; multiplier: number }
    approval: { approved: boolean }
  }
  console.log(`  店长批了 → 工作流恢复并完成。`)
  console.log(`  建议金额 (助手按政策算, 待店长确认): ${otOut.suggestion.note}`)
  console.log(
    `  最终: ${otOut.hours} 小时 · ${otOut.suggestion.dayLabel} ×${otOut.suggestion.multiplier}, 建议 ¥${otOut.suggestion.suggestedAmount}, approved=${otOut.approval.approved}`,
  )

  // --- [B2] the multiplier adapts to the situation (结合使用者的情况) ----------
  // Same 3 overtime hours, three day kinds → three recommendations. The worker
  // serves cafe.overtime-policy; we probe it directly (the workflow's assess step
  // dispatches the same capability). Money stays deterministic; manager still confirms.
  section('[B2] 同样 3 小时加班, 不同日别 → 不同倍率 (worker 结合情况算)')
  const dayCases = [
    { dayKind: 'normal', amount: 99 }, // 3 × ¥22 × 1.5
    { dayKind: 'rest-day', amount: 132 }, // 3 × ¥22 × 2
    { dayKind: 'public-holiday', amount: 198 }, // 3 × ¥22 × 3
  ] as const
  for (const c of dayCases) {
    const r = await hub.dispatch({
      from: 'u-staff' as ParticipantId,
      strategy: { kind: 'capability', capabilities: ['cafe.overtime-policy'] },
      payload: { date: '2026-06-02', hours: 3, day_kind: c.dayKind },
      title: `加班核算 (${c.dayKind})`,
    })
    const o = okOutput(r, `overtime ${c.dayKind}`) as { dayLabel: string; multiplier: number; suggestedAmount: number }
    console.log(`  ${o.dayLabel}: ×${o.multiplier} → 建议 ¥${o.suggestedAmount}`)
    assert(o.suggestedAmount === c.amount, `3h on ${c.dayKind} → ¥${c.amount}`)
  }

  // --- self-assertions (this demo doubles as a smoke test) --------------------
  section('[verify]')
  assert(onboard.kind === 'ok', 'onboarding completed ok')
  assert(onboardOut.walkthrough.positionTitle === '制饮 (吧台)', 'trainer returned the barista SOP')
  assert(onboardOut.walkthrough.norms.length > 0, 'trainer returned position norms')
  assert(otFired.kind === 'suspended', 'overtime suspended at the human gate')
  assert(result.kind === 'ok', 'overtime resumed to completion after approval')
  assert(otOut.suggestion.suggestedAmount === 132, '周末顶班 3h × ¥22 × 2 (休息日) = ¥132 (结合日别的确定性金额)')
  assert(otOut.approval.approved === true, "manager's approval flowed into the output")
  const stillPending = await inbox.listPending('u-manager')
  assert(stillPending.length === 0, 'the inbox item is resolved, not pending')
  console.log('  all checks passed.')

  await hub.stop()
  rmSync(tmp, { recursive: true, force: true })

  section('done')
  console.log('  Declarative workflows + surface.me + human: approval — an org runs on this.\n')
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

  // (4) resume the CHILD broker with the decision as its answer.
  const childRow = parked.get(itemId)
  if (!childRow) throw new Error('child broker task was not parked')
  const childTask = JSON.parse(childRow.taskJson) as Task
  await hub.resumeTask(childRow.agentId, childTask, { answer: decision })
  parked.delete(itemId)

  // (5) resume the PARENT workflow run (child strictly before parent).
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
