/**
 * warband-club — runnable demo of a COLLABORATION-first organization hub.
 *
 * Where cafe-ops models a storefront's top-down processes (manager approves),
 * warband-club models a hobby club organized around a SHARED RESOURCE: one
 * archive the whole warband reads and writes. The org value here is collaboration
 * — a paint scheme one member files becomes an answer another member gets back.
 *
 * Single-hub shared (the locked decision): all members share this hub's archive;
 * no cross-hub federation. The two org capabilities still carry it:
 *
 *   - surface.me  (Phase 14) — a member contributes / queries from their own /me
 *   - human:      (Phase 16) — a muster proposal parks until the leader confirms
 *
 * What this demo proves end to end (deterministic, no API key):
 *
 *   [A][B] two DIFFERENT members file into the SAME shared archive (a paint
 *          scheme, a battle report) — the shared resource accumulates.
 *   [C]    a THIRD member queries the archive and gets back the first member's
 *          paint scheme — collaboration through the shared resource.
 *   [D]    a member proposes a muster → herald drafts a charter → the run
 *          SUSPENDS at a leader-confirm gate → leader approves → run completes.
 *
 * The worker capabilities are deterministic stand-ins here; in the loadable
 * template they are KB-backed LlmAgents on DeepSeek + mcp-obsidian — same hub
 * wiring, swap and nothing else changes.
 *
 * Run:  pnpm demo:warband-club
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hub, InMemoryStorage, type ParticipantId, type Task, type TaskResult } from '@gotong/core'
import { FileInboxStore, HumanInboxParticipant, type InboxDecision } from '@gotong/inbox'
import { parseWorkflow, WorkflowRunner } from '@gotong/workflow'

import { ArchivistStandin, HeraldStandin } from './standins.js'

const WORKFLOWS_DIR = fileURLToPath(new URL('../workflows', import.meta.url))

interface ParkedRow {
  agentId: ParticipantId
  state: unknown
  taskJson: string
}

async function main(): Promise<void> {
  console.log('\n=== Gotong case: warband-club — a collaboration hub (战团同好会) ===\n')

  const tmp = mkdtempSync(join(tmpdir(), 'gotong-warband-'))
  const archiveDir = mkdtempSync(join(tmpdir(), 'gotong-warband-archive-')) // the SHARED resource
  const parked = new Map<string, ParkedRow>()
  const inbox = new FileInboxStore(tmp)
  inbox.ensureDirs()

  const hub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, by, s) => {
      parked.set(task.id, { agentId: by, state: s.state, taskJson: JSON.stringify(task) })
    },
  })
  await hub.start()

  hub.register(new HumanInboxParticipant({ store: inbox }))
  hub.register(new ArchivistStandin(archiveDir))
  hub.register(new HeraldStandin())

  section('[0] load the declarative workflows (real parseWorkflow)')
  for (const file of ['contribute.yaml', 'consult.yaml', 'muster.yaml']) {
    const def = parseWorkflow(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'))
    hub.register(new WorkflowRunner({ definition: def, hub }))
    console.log(`  ${def.id}  (trigger: ${def.trigger.capability}, ${def.steps.length} step(s))`)
  }

  // --- [A][B] two members contribute into the SAME shared archive -------------
  section('[A][B] 两名兄弟把贡献交进同一个共享档案库 (surface.me 自助)')
  await contribute(hub, 'brother-cobalt', 'paint-scheme', '钴蓝战甲涂装方案', '底漆喷钴蓝, 边缘提亮天蓝, 金属件银漆干扫, 最后哑光罩光保护。')
  await contribute(hub, 'brother-warden', 'battle-report', '东境据点争夺战 战报', '第三连推进东境据点, 重火力压制敌方步兵, 第二回合夺旗, 险胜收场。')
  console.log(`  共享档案库现有 ${readdirSync(archiveDir).length} 份贡献 (全团可查)。`)

  // --- [C] a THIRD member queries the archive → gets the first member's work ---
  section('[C] 第三名兄弟问询档案库 → 检索到别人早先的贡献 (= 合作)')
  const ask = await hub.dispatch({
    from: 'brother-novice' as ParticipantId,
    strategy: { kind: 'capability', capabilities: ['warband.ask'] },
    payload: { question: '钴蓝战甲怎么涂装提亮?', asker_id: 'brother-novice' },
    title: '问询档案库',
  })
  const askOut = okOutput(ask, 'consult') as {
    answer: string
    sources: Array<{ title: string; contributor: string }>
  }
  console.log(`  问: 钴蓝战甲怎么涂装提亮?`)
  console.log(`  答: ${askOut.answer}`)
  console.log(`  来源: ${askOut.sources.map((s) => `${s.title} (${s.contributor})`).join(', ')}`)

  // --- [D] muster proposal — HITL: draft → leader confirm → resume ------------
  section('[D] 提议集结 + 战团长确认 (human: HITL — 挂起 → 战团长批 → 恢复)')
  const muster = await hub.dispatch({
    from: 'brother-warden' as ParticipantId,
    strategy: { kind: 'capability', capabilities: ['warband.propose-muster'] },
    payload: {
      title: '月末对战夜',
      kind: 'battle-night',
      when: '本周六 19:00',
      notes: '1000 点遭遇战, 自带军队',
      leader_id: 'warband-leader',
      proposer_id: 'brother-warden',
    },
    title: '提议集结',
  })
  if (muster.kind !== 'suspended') {
    throw new Error(`muster: expected the run to SUSPEND at the leader gate, got '${muster.kind}'`)
  }
  console.log('  兄弟发起集结 → 传令官拟好章程, 跑到战团长确认步骤, 挂起等人。')

  const pending = await inbox.listPending('warband-leader')
  if (pending.length !== 1 || pending[0]!.kind !== 'approval') {
    throw new Error(`muster: expected 1 pending approval for the leader, got ${pending.length}`)
  }
  console.log(`  战团长 /me 收件箱: 1 条待办 [${pending[0]!.kind}] "${pending[0]!.title ?? pending[0]!.prompt}"`)

  const result = await resolveHumanStep(hub, inbox, parked, pending[0]!.itemId, {
    kind: 'approval',
    approved: true,
  })
  const musterOut = okOutput(result, 'muster resume') as {
    title: string
    draft: { note: string }
    approval?: unknown
    confirm: { approved: boolean }
  }
  console.log(`  战团长批了 → 集结纳入日程。`)
  console.log(`  章程: ${musterOut.draft.note}`)
  console.log(`  最终: 「${musterOut.title}」approved=${musterOut.confirm.approved}`)

  // --- self-assertions (this demo doubles as a smoke test) --------------------
  section('[verify]')
  assert(readdirSync(archiveDir).length === 2, 'two contributions landed in the SHARED archive')
  assert(askOut.sources.length > 0, 'the query found an archive entry')
  assert(
    askOut.sources[0]!.contributor === 'brother-cobalt',
    "the answer came from a DIFFERENT member's contribution (collaboration)",
  )
  assert(muster.kind === 'suspended', 'muster suspended at the leader gate')
  assert(result.kind === 'ok', 'muster resumed to completion after the leader confirmed')
  assert(musterOut.confirm.approved === true, "the leader's confirmation flowed into the output")
  const stillPending = await inbox.listPending('warband-leader')
  assert(stillPending.length === 0, 'the inbox item is resolved, not pending')
  console.log('  all checks passed.')

  await hub.stop()
  rmSync(tmp, { recursive: true, force: true })
  rmSync(archiveDir, { recursive: true, force: true })

  section('done')
  console.log('  A shared archive + surface.me + human: confirm — a club collaborates on this.\n')
  process.exit(0)
}

/** Fire a `warband.contribute` run as a member (the file step writes to the shared archive). */
async function contribute(
  hub: Hub,
  contributorId: string,
  kind: string,
  title: string,
  body: string,
): Promise<void> {
  const r = await hub.dispatch({
    from: contributorId as ParticipantId,
    strategy: { kind: 'capability', capabilities: ['warband.contribute'] },
    payload: { kind, title, body, contributor_id: contributorId },
    title: `贡献: ${title}`,
  })
  const out = okOutput(r, 'contribute') as { filed: { note: string } }
  console.log(`  ${contributorId} 贡献 [${kind}] 「${title}」 → ${out.filed.note}`)
}

/**
 * Resolve a parked `human:` step and resume — the two-step pattern from
 * `HostInboxService.resolve`: flip pending→resolved (race guard), resume the
 * CHILD broker, then the PARENT workflow (child strictly before parent).
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
  await store.markResolved(itemId, decision)

  const childRow = parked.get(itemId)
  if (!childRow) throw new Error('child broker task was not parked')
  await hub.resumeTask(childRow.agentId, JSON.parse(childRow.taskJson) as Task, { answer: decision })
  parked.delete(itemId)

  if (item.parentKind !== 'workflow' || !item.parent) {
    throw new Error('expected a workflow parent for this demo step')
  }
  const parentRow = parked.get(item.parent.taskId)
  if (!parentRow) throw new Error('parent workflow task was not parked')
  if (parentRow.agentId !== item.parent.by) {
    throw new Error(`parent agent mismatch: ${parentRow.agentId} !== ${item.parent.by}`)
  }
  const result = await hub.resumeTask(item.parent.by, JSON.parse(parentRow.taskJson) as Task, parentRow.state)
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
