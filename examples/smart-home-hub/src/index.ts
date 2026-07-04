/**
 * smart-home-hub — a SMALL runnable demo of a smart-home hub.
 *
 * 小米设备经 Home Assistant 接进来 (米家 → ha_xiaomi_home → HA MCP Server →
 * Gotong), 一个家居管家 (home-steward) 跑一条「晚安例程」。它演示的不是「能不能
 * 控制设备」(HA 早就能), 而是 Gotong 加在上面的那一层 **治理**:
 *
 *   可逆的动作 (关灯、空调切睡眠) —— 直接做。
 *   不可逆的物理/安防动作 (锁门、布防) —— 挂起, 等住户在收件箱确认。
 *
 * 两个剧情 (确定性, 无需 API key / 无需真 Home Assistant / 无需小米账号):
 *
 *   [A] 批准 — 晚安例程 → 灯关了、空调切睡眠 (直接) → 跑到「睡前安防确认」挂起 →
 *               住户在 /me 收件箱批准 → 大门锁了、安防布防了。
 *   [B] 拒绝 — 同一条例程 (隔天晚上) → 灯照样关 → 挂起 → 住户拒绝 → secure 步被
 *               跳过 → **门保持不锁** (fail-closed: 拦下一个动作不外溢到别的)。
 *
 * 设备动作这里由确定性 stand-in 服务 (src/standins.ts); 可载入模板里它是挂了
 * Home Assistant MCP server 的 home-steward LlmAgent —— 同一套 hub 接线, 换掉
 * stand-in, 工作流 YAML 和 hub 一个字不用改。
 *
 * Run:  pnpm demo:smart-home-hub
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hub, InMemoryStorage, type ParticipantId, type Task, type TaskResult } from '@gotong/core'
import { FileInboxStore, HumanInboxParticipant, type InboxDecision } from '@gotong/inbox'
import { parseWorkflow, WorkflowRunner } from '@gotong/workflow'

import { HomeStewardStandin } from './standins.js'

const WORKFLOW = fileURLToPath(new URL('../workflows/goodnight-routine.yaml', import.meta.url))

/** In-memory stand-in for identity.suspended_tasks — what a parked task needs to resume. */
interface ParkedRow {
  agentId: ParticipantId
  state: unknown
  taskJson: string
}

async function main(): Promise<void> {
  console.log('\n=== Gotong case: smart-home-hub — 小米经 Home Assistant 的晚安例程 ===\n')

  const tmp = mkdtempSync(join(tmpdir(), 'gotong-smart-home-'))
  const parked = new Map<string, ParkedRow>()
  const inbox = new FileInboxStore(tmp)
  inbox.ensureDirs()

  // A real host parks suspended tasks in identity.suspended_tasks and an inbox
  // resolve wakes them. The demo records them in `parked` and wakes them by hand
  // below — same mechanism, visible in ~30 lines.
  const hub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, by, s) => {
      parked.set(task.id, { agentId: by, state: s.state, taskJson: JSON.stringify(task) })
    },
  })
  await hub.start()

  // The human-inbox broker (serves `gotong.human/v1`) + the deterministic
  // home-steward stand-in (serves home.apply-scene / home.secure).
  hub.register(new HumanInboxParticipant({ store: inbox }))
  const home = new HomeStewardStandin()
  hub.register(home)

  // Load + register the declarative workflow — parsed by the REAL parseWorkflow
  // (the same one the template importer runs), so a broken YAML fails loudly.
  section('[0] load the 晚安例程 workflow (real parseWorkflow)')
  const def = parseWorkflow(readFileSync(WORKFLOW, 'utf8'))
  hub.register(new WorkflowRunner({ definition: def, hub }))
  console.log(`  ${def.id}  (trigger: ${def.trigger.capability}, ${def.steps.length} step(s))`)
  console.log(`  设备初始: ${describeHome(home)}`)

  // --- [A] approve — reversible fires directly, secure runs after approval -----
  section('[A] 批准 — 关灯/空调直接做, 锁门布防经确认后执行')
  const aFired = await runGoodnight(hub)
  if (aFired.kind !== 'suspended') {
    throw new Error(`[A] expected the run to SUSPEND at the lock confirmation, got '${aFired.kind}'`)
  }
  console.log('  晚安例程触发 → 灯/空调可逆动作已做, 跑到「睡前安防确认」挂起等人。')
  console.log(`  挂起时设备: ${describeHome(home)}`)
  const aItem = await onePending(inbox, 'u-resident')
  console.log(`  住户 /me 收件箱: 1 条待办 [${aItem.kind}] "${aItem.title ?? aItem.prompt}"`)
  const aResult = await resolveHumanStep(hub, inbox, parked, aItem.itemId, { kind: 'approval', approved: true })
  const aOut = okOutput(aResult, '[A] resume') as {
    windDown: { actions: string[] }
    approval: { approved: boolean }
    secured: { actions: string[] } | null
  }
  console.log('  住户批准 → 工作流恢复, secure 步执行。')
  console.log(`  完成后设备: ${describeHome(home)}`)
  assert(lockedNow(home) === true, '[A] 批准后大门已锁')
  assert(armedNow(home) === true, '[A] 批准后已布防')
  assert(lightOn(home, 'light.living_room') === false, '[A] 可逆动作直接做: 客厅灯已关')
  assert(aOut.approval.approved === true, "[A] 住户的批准流进了工作流输出")

  // --- [B] reject — same routine, security action is held back (fail-closed) ----
  home.resetToDaytime() // 隔天, 设备回到日间状态 (灯开着、门没锁)。
  section('[B] 拒绝 — 同一例程, 安防动作被拦下, 门保持不锁 (隔天晚上)')
  console.log(`  隔天日间设备: ${describeHome(home)}`)
  const bFired = await runGoodnight(hub)
  if (bFired.kind !== 'suspended') {
    throw new Error(`[B] expected the run to SUSPEND at the lock confirmation, got '${bFired.kind}'`)
  }
  console.log('  晚安例程触发 → 灯/空调照样关, 跑到安防确认挂起。')
  const bItem = await onePending(inbox, 'u-resident')
  const bResult = await resolveHumanStep(hub, inbox, parked, bItem.itemId, { kind: 'approval', approved: false })
  const bOut = okOutput(bResult, '[B] resume') as {
    windDown: { actions: string[] }
    approval: { approved: boolean }
    secured: { actions: string[] } | null
  }
  console.log('  住户拒绝 → secure 步被 `when` 跳过, 不执行任何安防动作。')
  console.log(`  完成后设备: ${describeHome(home)}`)
  assert(lightOn(home, 'light.living_room') === false, '[B] 可逆动作仍照常: 客厅灯已关')
  assert(lockedNow(home) === false, '[B] 拒绝 → 大门保持不锁 (不可逆动作被拦下)')
  assert(armedNow(home) === false, '[B] 拒绝 → 未布防')
  assert(bOut.approval.approved === false, '[B] 拒绝的决定流进了工作流输出')
  assert(bOut.secured == null, '[B] secure 步未产出 (被跳过)')

  // --- self-assertions summary ------------------------------------------------
  section('[verify]')
  assert(aFired.kind === 'suspended' && bFired.kind === 'suspended', '两次例程都在安防步挂起等人')
  assert(aResult.kind === 'ok' && bResult.kind === 'ok', '两次都在确认后恢复并完成')
  const stillPending = await inbox.listPending('u-resident')
  assert(stillPending.length === 0, '收件箱待办都已处理, 无残留')
  console.log('  all checks passed.')

  await hub.stop()
  rmSync(tmp, { recursive: true, force: true })

  section('done')
  console.log('  可逆的直接做, 不可逆的物理动作要人确认 —— 一个被治理的智能家居。\n')
  process.exit(0)
}

/** Dispatch the goodnight routine for the resident (returns the first result — usually suspended). */
function runGoodnight(hub: Hub): Promise<TaskResult> {
  return hub.dispatch({
    from: 'u-resident' as ParticipantId,
    strategy: { kind: 'capability', capabilities: ['home.run-goodnight'] },
    // /me would force payload[resident_id]=the member's own userId; we pass it directly.
    payload: { approver_id: 'u-resident', resident_id: 'u-resident' },
    title: '晚安例程',
  })
}

/**
 * Resolve a parked `human:` step and resume — the two-step pattern from
 * `HostInboxService.resolve` (host/src/inbox-service.ts), hand-rolled here so the
 * mechanism is visible. The invariants that keep it correct:
 *   1. flip pending→resolved FIRST (race guard) — a repeat resolve can't double-wake.
 *   2. resume the CHILD broker before the PARENT workflow — until the child
 *      resumes, the parent's lookup of the child result is still `suspended`.
 *   3. only drop the parent row when it actually finished.
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

async function onePending(store: FileInboxStore, userId: string) {
  const pending = await store.listPending(userId)
  if (pending.length !== 1 || pending[0]!.kind !== 'approval') {
    throw new Error(`expected exactly 1 pending approval for ${userId}, got ${pending.length}`)
  }
  return pending[0]!
}

// --- tiny read helpers over the stand-in's device table ----------------------

function lockedNow(home: HomeStewardStandin): boolean {
  const d = home.devices['lock.front_door']
  return d?.kind === 'lock' ? d.locked : false
}
function armedNow(home: HomeStewardStandin): boolean {
  const d = home.devices['alarm_control_panel.home']
  return d?.kind === 'alarm' ? d.armed : false
}
function lightOn(home: HomeStewardStandin, id: string): boolean {
  const d = home.devices[id]
  return d?.kind === 'light' ? d.on : false
}
function describeHome(home: HomeStewardStandin): string {
  const lr = lightOn(home, 'light.living_room') ? '客厅灯开' : '客厅灯关'
  const lock = lockedNow(home) ? '门已锁' : '门未锁'
  const alarm = armedNow(home) ? '已布防' : '未布防'
  return `${lr} · ${lock} · ${alarm}`
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
